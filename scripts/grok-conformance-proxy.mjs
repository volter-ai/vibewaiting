#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { execFileSync } from "node:child_process";
import {
  CONFORMANCE_FORMAT_VERSION,
  GROK_UPSTREAM_ORIGIN,
  LaneProtocolState,
  MAX_CONFORMANCE_BODY_BYTES,
  ProtocolViolation,
  ProtocolSymbolMatcher,
  canonicalRequest,
  filterForwardHeaders,
  normalizeTelemetryMeasurements,
  requestKey,
  safeResponseHeaders,
  sha256,
  splitLanePath,
  stableJson,
} from "../dist/grok-conformance.js";

const args = parseArgs(process.argv.slice(2));
const mode = args._[0];
if (!["record", "replay", "verify-live"].includes(mode)) usage("Mode must be record, replay, or verify-live.");
const port = integerArg(args.port, 4319);
const corpusPath = stringArg(args.corpus);
const overwrite = args.overwrite === true;
const task = typeof args.task === "string" ? args.task : "unspecified";
const fixture = typeof args.fixture === "string" ? args.fixture : undefined;
const autoCompactThresholdPercent = optionalPercentArg(args["auto-compact-threshold"]);

if (mode === "record" && existsSync(corpusPath) && !overwrite) {
  usage(`Corpus already exists: ${corpusPath}. Pass --overwrite to replace it.`);
}

const nativeState = new LaneProtocolState();
const browserState = new LaneProtocolState();
const symbolMatcher = new ProtocolSymbolMatcher();
let sequence = 0;
const expectedByKey = new Map();
const expectedControlPlaneOrder = [];
let driverProfile;

if (mode === "record") {
  const manifest = {
    kind: "manifest",
    formatVersion: CONFORMANCE_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    nativeVersion: commandOutput("grok", ["--version"]),
    sourceRevision: commandOutput("git", ["-C", "/tmp/xai-grok-build-source", "rev-parse", "HEAD"]),
    task,
    ...(fixture ? { fixture } : {}),
    ...(autoCompactThresholdPercent !== undefined ? { autoCompactThresholdPercent } : {}),
  };
  writeFileSync(corpusPath, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", mode: 0o600 });
} else {
  loadCorpus(corpusPath, expectedByKey);
  expectedControlPlaneOrder.push(...[...expectedByKey.values()]
    .flat()
    .filter((exchange) => exchange.key !== "POST /v1/traces")
    .sort((left, right) => left.sequence - right.sequence));
  driverProfile = buildDriverProfile(corpusPath);
}

const server = createServer(async (request, response) => {
  try {
    const localUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    setCors(response);
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (localUrl.pathname === "/__conformance__/driver-profile") {
      if (mode === "record") throw new ProtocolViolation("Driver profiles are available only in replay modes.");
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.end(JSON.stringify(driverProfile));
      return;
    }
    if (localUrl.pathname === "/__conformance__/assert-foreground-complete") {
      if (mode === "record") throw new ProtocolViolation("Completion assertions are available only in replay modes.");
      assertQueuesComplete(response, (exchange) =>
        exchange.key === "POST /v1/responses"
        && exchange.request?.headers?.["x-grok-turn-idx"] !== undefined,
      "foreground corpus");
      return;
    }
    if (localUrl.pathname === "/__conformance__/assert-model-complete") {
      if (mode === "record") throw new ProtocolViolation("Completion assertions are available only in replay modes.");
      assertQueuesComplete(response, (exchange) => exchange.key === "POST /v1/responses", "model-request corpus");
      return;
    }
    if (localUrl.pathname === "/__conformance__/assert-control-plane-complete") {
      if (mode === "record") throw new ProtocolViolation("Completion assertions are available only in replay modes.");
      assertQueuesComplete(response, (exchange) => exchange.key !== "POST /v1/traces", "non-OTLP control-plane corpus");
      return;
    }
    if (localUrl.pathname === "/__conformance__/assert-complete") {
      if (mode === "record") throw new ProtocolViolation("Completion assertions are available only in replay modes.");
      assertQueuesComplete(response, () => true, "complete native corpus");
      return;
    }
    const { lane, upstreamPath } = splitLanePath(localUrl.pathname);
    if (mode === "record" && lane !== "native") throw new ProtocolViolation("Record mode accepts native Grok Build traffic only.");
    if (mode !== "record" && lane !== "browser") throw new ProtocolViolation(`${mode} mode accepts Browser Grok traffic only.`);
    const body = await readBody(request);
    const state = lane === "native" ? nativeState : browserState;
    const canonical = canonicalRequest(request.method ?? "GET", localUrl, upstreamPath, request.headers, body, state);

    if (mode !== "record") {
      const queue = expectedByKey.get(requestKey(canonical));
      const expected = requestKey(canonical) === "POST /v1/traces"
        ? queue?.[0]
        : expectedControlPlaneOrder[0];
      if (!expected) throw new ProtocolViolation(`No native exchange remains for ${requestKey(canonical)}.`);
      if (expected.key !== requestKey(canonical)) {
        throw new ProtocolViolation(
          `Browser Grok reordered the native control plane: expected ${expected.key} (sequence ${expected.sequence}) before ${requestKey(canonical)}.`,
        );
      }
      symbolMatcher.assertMatch(expected.request, canonical);
      queue.shift();
      if (expected.key !== "POST /v1/traces") expectedControlPlaneOrder.shift();
      if (mode === "replay") {
        sendRecorded(response, expected.response);
        log("replay_match", { sequence: expected.sequence, key: expected.key });
        return;
      }
    }

    const requestSequence = mode === "record" ? ++sequence : undefined;
    await forwardAndCapture(request, response, localUrl, upstreamPath, body, canonical, requestSequence);
  } catch (cause) {
    const violation = cause instanceof ProtocolViolation ? cause : new ProtocolViolation(cause instanceof Error ? cause.message : String(cause));
    response.statusCode = 409;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(JSON.stringify({ error: "grok_protocol_violation", message: violation.message, differences: violation.differences }));
    log("protocol_violation", { message: violation.message, differences: violation.differences });
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({
    ready: true,
    mode,
    port,
    corpus: corpusPath,
    nativeBaseUrl: `http://127.0.0.1:${port}/native/v1`,
    browserBaseUrl: `http://127.0.0.1:${port}/browser/v1`,
  })}\n`);
});

function forwardAndCapture(incoming, outgoing, localUrl, upstreamPath, body, canonical, recordSequence) {
  return new Promise((resolve, reject) => {
    const upstreamUrl = new URL(`${upstreamPath}${localUrl.search}`, GROK_UPSTREAM_ORIGIN);
    const headers = filterForwardHeaders(incoming.headers);
    headers.host = upstreamUrl.host;
    headers["content-length"] = String(body.length);
    const upstream = httpsRequest(upstreamUrl, { method: incoming.method, headers }, (upstreamResponse) => {
      outgoing.statusCode = upstreamResponse.statusCode ?? 502;
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value !== undefined && !["connection", "transfer-encoding"].includes(name)) outgoing.setHeader(name, value);
      }
      const chunks = [];
      let bytes = 0;
      upstreamResponse.on("data", (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_CONFORMANCE_BODY_BYTES) {
          upstream.destroy(new Error("Upstream response exceeded the conformance body limit."));
          return;
        }
        chunks.push(buffer);
        outgoing.write(buffer);
      });
      upstreamResponse.on("end", () => {
        outgoing.end();
        if (recordSequence !== undefined) {
          const responseBody = Buffer.concat(chunks);
          const exchange = {
            kind: "exchange",
            sequence: recordSequence,
            key: requestKey(canonical),
            request: canonical,
            requestSha256: sha256(stableJson(canonical)),
            requestBodyBase64: body.toString("base64"),
            requestBodySha256: sha256(body),
            response: {
              status: upstreamResponse.statusCode ?? 502,
              headers: safeResponseHeaders(upstreamResponse.headers),
              bodyBase64: responseBody.toString("base64"),
              bodySha256: sha256(responseBody),
            },
          };
          appendFileSync(corpusPath, `${JSON.stringify(exchange)}\n`, { encoding: "utf8", mode: 0o600 });
          log("recorded", { sequence: exchange.sequence, key: exchange.key, responseBytes: responseBody.length });
        } else {
          log("verify_live_match", { key: requestKey(canonical), status: upstreamResponse.statusCode ?? 502 });
        }
        resolve();
      });
      upstreamResponse.on("error", reject);
    });
    upstream.on("error", reject);
    if (body.length > 0) upstream.write(body);
    upstream.end();
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_CONFORMANCE_BODY_BYTES) {
        reject(new ProtocolViolation("Request exceeded the conformance body limit."));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function loadCorpus(path, output) {
  if (!existsSync(path)) usage(`Corpus does not exist: ${path}`);
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const manifest = lines.shift();
  if (manifest?.kind !== "manifest" || manifest.formatVersion !== CONFORMANCE_FORMAT_VERSION) {
    usage("Corpus manifest is missing or uses an unsupported format.");
  }
  const exchanges = lines.sort((a, b) => a.sequence - b.sequence);
  for (const exchange of exchanges) {
    if (exchange.kind !== "exchange") usage("Corpus contains an invalid record.");
    const actualHash = sha256(stableJson(exchange.request));
    if (actualHash !== exchange.requestSha256) usage(`Corpus request integrity check failed at sequence ${exchange.sequence}.`);
    // Recorded format-v2 requests predate replay-time clock abstraction. Keep
    // the signed corpus bytes intact for integrity verification, then apply
    // the same canonical projection used for the live browser lane.
    normalizeTelemetryMeasurements(exchange.request?.path ?? "", exchange.request?.body);
    // Early format-v2 corpora predate path UUID symbolization for turn deltas.
    // Normalize after integrity verification so those recordings remain strict-
    // replayable against the current lane relationship matcher.
    if (/^\/v1\/sessions\/[0-9a-f-]{36}\/turn-deltas$/iu.test(exchange.request?.path ?? "")) {
      exchange.request.path = exchange.request.path.replace(/(?<=\/sessions\/)[^/]+(?=\/turn-deltas$)/u, "<identifier:uuid:1>");
      exchange.key = requestKey(exchange.request);
    }
    // Early format-v2 corpora kept this UUID literal even though the same
    // session identity was symbolized in headers. Normalize that relationship.
    if (typeof exchange.request?.body?.prompt_cache_key === "string"
      && typeof exchange.request?.headers?.["x-grok-session-id"] === "string") {
      exchange.request.body.prompt_cache_key = exchange.request.headers["x-grok-session-id"];
    }
    const requestBody = Buffer.from(exchange.requestBodyBase64, "base64");
    if (sha256(requestBody) !== exchange.requestBodySha256) usage(`Corpus request body integrity check failed at sequence ${exchange.sequence}.`);
    const responseBody = Buffer.from(exchange.response.bodyBase64, "base64");
    if (sha256(responseBody) !== exchange.response.bodySha256) usage(`Corpus response integrity check failed at sequence ${exchange.sequence}.`);
    const queue = output.get(exchange.key) ?? [];
    queue.push(exchange);
    output.set(exchange.key, queue);
  }
}

function buildDriverProfile(path) {
  const records = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const manifest = records.find((record) => record.kind === "manifest");
  const exchanges = records
    .filter((record) => record.kind === "exchange")
    .sort((a, b) => a.sequence - b.sequence);
  const foreground = exchanges.filter((exchange) =>
    exchange.key === "POST /v1/responses"
    && Array.isArray(exchange.request?.body?.input)
    && exchange.request?.headers?.["x-grok-turn-idx"] !== undefined
  );
  if (foreground.length === 0) usage("Corpus has no foreground Responses exchange.");
  const initial = foreground[0].request.body;
  const compaction = exchanges.find((exchange) => {
    if (exchange.key !== "POST /v1/responses" || !Array.isArray(exchange.request?.body?.input)) return false;
    const content = exchange.request.body.input.at(-1)?.content;
    return typeof content === "string" && content.startsWith("Your task is to produce a faithful, concise summary");
  });
  const startupSource = compaction?.request?.body ?? initial;
  const startupItems = compaction
    ? startupSource.input.slice(0, -1)
    : initial.input;
  const postCompaction = compaction
    ? foreground.find((exchange) => exchange.sequence > compaction.sequence)
    : undefined;
  const compactedItems = postCompaction?.request?.body?.input ?? [];
  const summaryCarrier = compactedItems.find((item) =>
    item?.role === "user"
    && typeof item.content === "string"
    && item.content.startsWith("This session is being continued from a previous conversation")
  );
  const hintStart = summaryCarrier?.content?.indexOf("\n\nFull verbatim rollouts of previous segments");
  const compactionTranscriptHint = Number.isSafeInteger(hintStart) && hintStart >= 0
    ? summaryCarrier.content.slice(hintStart)
    : undefined;
  const compactionSystemReminder = compactedItems.find((item) =>
    item?.role === "user"
    && typeof item.content === "string"
    && item.content.startsWith("<system-reminder>\n##")
  )?.content;
  const seenOutputs = new Set();
  const toolResults = [];
  for (const exchange of foreground.slice(1)) {
    for (const item of exchange.request.body.input) {
      if (item?.type !== "function_call_output" || typeof item.call_id !== "string" || seenOutputs.has(item.call_id)) continue;
      seenOutputs.add(item.call_id);
      toolResults.push({ callId: item.call_id, output: typeof item.output === "string" ? item.output : JSON.stringify(item.output) });
    }
  }
  const title = exchanges.find((exchange) =>
    exchange.key === "POST /v1/responses"
    && Array.isArray(exchange.request?.body?.input)
    && exchange.request.body.prompt_cache_key === undefined
  );
  const turnSummaryRequests = exchanges.filter((exchange) =>
    exchange.key === "POST /v1/responses"
    && exchange.request?.body?.prompt_cache_key !== undefined
    && exchange.request?.headers?.["x-grok-turn-idx"] === undefined
    && exchange !== compaction
  ).length;
  const signalExchanges = exchanges.filter((exchange) => exchange.key.includes("/signals"));
  const periodicSignalAssistantCounts = signalExchanges.slice(1, -1).flatMap((exchange) =>
    Number.isSafeInteger(exchange.request?.body?.assistantMessageCount)
      ? [exchange.request.body.assistantMessageCount]
      : []
  );
  const nativeWorkspacePath = extractWorkspacePath(initial.input);
  const initialFiles = extractInitialWorkspaceFiles(foreground, nativeWorkspacePath);
  return {
    formatVersion: CONFORMANCE_FORMAT_VERSION,
    task: extractUserQuery(title?.request?.body?.input) ?? "",
    startupItems,
    tools: startupSource.tools ?? initial.tools,
    toolResults,
    foregroundRequests: foreground.length,
    modelRequests: exchanges.filter((exchange) => exchange.key === "POST /v1/responses").length,
    bundleArchiveRequests: exchanges.filter((exchange) => exchange.key === "GET /v1/bundle/archive").length,
    ...(periodicSignalAssistantCounts.length > 0 ? { periodicSignalAssistantCounts } : {}),
    turnSummaryRequests,
    reasoningEffort: initial.reasoning?.effort,
    nativeWorkspacePath,
    ...(initialFiles.length > 0 ? { initialFiles } : {}),
    fixture: manifest?.fixture,
    autoCompactThresholdPercent: manifest?.autoCompactThresholdPercent,
    ...(compactionTranscriptHint ? { compactionTranscriptHint } : {}),
    ...(compactionSystemReminder ? { compactionSystemReminder } : {}),
  };
}

function extractInitialWorkspaceFiles(foreground, nativeWorkspacePath) {
  const calls = new Map();
  const orderedCallIds = [];
  const outputs = new Map();
  for (const exchange of foreground) {
    for (const item of exchange.request?.body?.input ?? []) {
      if (item?.type === "function_call" && typeof item.call_id === "string" && !calls.has(item.call_id)) {
        calls.set(item.call_id, item);
        orderedCallIds.push(item.call_id);
      }
      if (item?.type === "function_call_output" && typeof item.call_id === "string" && !outputs.has(item.call_id)) {
        outputs.set(item.call_id, typeof item.output === "string" ? item.output : JSON.stringify(item.output));
      }
    }
  }

  const files = new Map();
  for (const callId of orderedCallIds) {
    const call = calls.get(callId);
    if (!call || !isReadOnlyWorkspaceInspection(call)) break;
    if (call.name !== "read_file") continue;
    let args;
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch {
      continue;
    }
    const target = args?.target_file;
    if (typeof target !== "string" || args.offset !== undefined || args.limit !== undefined) continue;
    const relative = workspaceRelativePath(target, nativeWorkspacePath);
    const output = outputs.get(callId);
    if (!relative || typeof output !== "string" || !/^\d+→/u.test(output)) continue;
    files.set(relative, unnumberFullRead(output));
  }
  return [...files].map(([path, content]) => ({ path, content }));
}

function isReadOnlyWorkspaceInspection(call) {
  if (["list_dir", "read_file", "grep"].includes(call.name)) return true;
  if (call.name !== "run_terminal_command") return false;
  try {
    const { command } = JSON.parse(call.arguments || "{}");
    if (typeof command !== "string") return false;
    return command.split(/&&|\|\||;/u).every((part) =>
      /^\s*(?:ls|find|cat|head|tail|pwd|git\s+(?:status|log|diff)|node\s+--check)\b/u.test(part));
  } catch {
    return false;
  }
}

function workspaceRelativePath(target, workspacePath) {
  const normalizedTarget = target.replaceAll("\\\\", "/");
  const normalizedRoot = workspacePath.replaceAll("\\\\", "/").replace(/\/$/u, "");
  if (normalizedTarget === normalizedRoot || !normalizedTarget.startsWith(`${normalizedRoot}/`)) return;
  return `/${normalizedTarget.slice(normalizedRoot.length + 1)}`;
}

function unnumberFullRead(output) {
  return output.split("\n").map((line, index) => {
    const prefix = `${index + 1}→`;
    return line.startsWith(prefix) ? line.slice(prefix.length) : line;
  }).join("\n");
}

function extractUserQuery(items) {
  const content = items?.find((item) => item?.role === "user")?.content;
  if (typeof content !== "string") return;
  return content.match(/^<user_query>\n([\s\S]*)\n<\/user_query>$/u)?.[1];
}

function extractWorkspacePath(items) {
  for (const item of items ?? []) {
    if (item?.role !== "user" || typeof item.content !== "string") continue;
    const match = item.content.match(/(?:^|\n)Workspace Path: ([^\n]+)(?:\n|$)/u);
    if (match?.[1]) return match[1];
  }
  return "/";
}

function assertQueuesComplete(response, predicate, label) {
  const remaining = [...expectedByKey.entries()]
    .map(([key, queue]) => ({ key, remaining: queue.filter(predicate).length }))
    .filter(({ remaining }) => remaining > 0);
  if (remaining.length > 0) {
    throw new ProtocolViolation(`Browser Grok stopped before consuming the ${label}.`, [
      { pointer: "/remaining", expected: [], actual: remaining },
    ]);
  }
  response.statusCode = 204;
  response.end();
  log("corpus_complete", { label });
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, x-browser-agent-conversation, x-browser-agent-request, x-browser-agent-request-kind, x-browser-agent-session, x-browser-agent-turn");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function sendRecorded(response, recorded) {
  response.statusCode = recorded.status;
  for (const [name, value] of Object.entries(recorded.headers)) {
    if (!["content-length", "transfer-encoding", "connection"].includes(name)) response.setHeader(name, value);
  }
  response.end(Buffer.from(recorded.bodyBase64, "base64"));
}

function parseArgs(values) {
  const result = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      result._.push(value);
      continue;
    }
    const [name, inline] = value.slice(2).split("=", 2);
    if (inline !== undefined) result[name] = inline;
    else if (values[index + 1] && !values[index + 1].startsWith("--")) result[name] = values[++index];
    else result[name] = true;
  }
  return result;
}

function stringArg(value) {
  if (typeof value !== "string" || value.length === 0) usage("--corpus PATH is required.");
  return value;
}

function integerArg(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) usage("--port must be a valid TCP port.");
  return parsed;
}

function optionalPercentArg(value) {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100) usage("--auto-compact-threshold must be 0..100.");
  return parsed;
}

function commandOutput(command, values) {
  try {
    return execFileSync(command, values, { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function usage(message) {
  process.stderr.write(`${message}\nUsage: grok-conformance-proxy <record|replay|verify-live> --corpus PATH [--port 4319] [--task TEXT] [--fixture NAME] [--auto-compact-threshold 0..100] [--overwrite]\n`);
  process.exit(2);
}

function log(event, details) {
  process.stderr.write(`${JSON.stringify({ event, ...details })}\n`);
}
