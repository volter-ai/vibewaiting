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
  canonicalOtlpTraceExport,
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
const replayTimingScale = optionalPositiveNumberArg(args["timing-scale"], 1);

if (mode === "record" && existsSync(corpusPath) && !overwrite) {
  usage(`Corpus already exists: ${corpusPath}. Pass --overwrite to replace it.`);
}

const nativeState = new LaneProtocolState();
const browserState = new LaneProtocolState();
const symbolMatcher = new ProtocolSymbolMatcher();
let sequence = 0;
const expectedByKey = new Map();
const expectedControlPlaneOrder = [];
const expectedTraceResources = new Map();
const expectedTraceSpans = [];
const observedTraceResources = new Map();
const observedTraceSpans = [];
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
  for (const exchange of expectedByKey.get("POST /v1/traces") ?? []) {
    collectTraceSemantics(exchange.request.body, expectedTraceResources, expectedTraceSpans);
  }
  expectedControlPlaneOrder.push(...[...expectedByKey.values()]
    .flat()
    .filter((exchange) => exchange.key !== "POST /v1/traces")
    .sort((left, right) => left.sequence - right.sequence));
  driverProfile = buildDriverProfile(corpusPath);
  const nativeTraceResource = expectedByKey.get("POST /v1/traces")?.[0]?.request?.body?.resource;
  if (nativeTraceResource && typeof nativeTraceResource === "object") {
    driverProfile.telemetryMetadata = {
      clientName: nativeTraceResource["client.name"],
      clientVersion: nativeTraceResource["client.version"],
      serviceVersion: nativeTraceResource["service.version"],
      appEntrypoint: nativeTraceResource["app.entrypoint"],
    };
  }
}

const server = createServer(async (request, response) => {
  try {
    const requestStartedAt = performance.now();
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
      assertTraceSemanticsComplete();
      assertQueuesComplete(response, (exchange) => exchange.key !== "POST /v1/traces", "complete native corpus");
      return;
    }
    const { lane, upstreamPath } = splitLanePath(localUrl.pathname);
    if (mode === "record" && lane !== "native") throw new ProtocolViolation("Record mode accepts native Grok Build traffic only.");
    if (mode !== "record" && lane !== "browser") throw new ProtocolViolation(`${mode} mode accepts Browser Grok traffic only.`);
    const body = await readBody(request);
    const state = lane === "native" ? nativeState : browserState;
    const canonical = canonicalRequest(request.method ?? "GET", localUrl, upstreamPath, request.headers, body, state);

    if (mode !== "record") {
      if (requestKey(canonical) === "POST /v1/traces") {
        collectTraceSemantics(canonical.body, observedTraceResources, observedTraceSpans);
        if (mode === "replay") {
          const recorded = expectedByKey.get("POST /v1/traces")?.[0]?.response;
          if (!recorded) throw new ProtocolViolation("Native corpus contains no OTLP trace response.");
          await sendRecorded(response, recorded, requestStartedAt);
          log("trace_semantics_observed", { spans: canonical.body?.spans?.length ?? 0 });
          return;
        }
        await forwardAndCapture(request, response, localUrl, upstreamPath, body, canonical, undefined, requestStartedAt);
        return;
      }
      const queue = expectedByKey.get(requestKey(canonical));
      const expected = expectedControlPlaneOrder[0];
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
        await sendRecorded(response, expected.response, requestStartedAt);
        log("replay_match", { sequence: expected.sequence, key: expected.key });
        return;
      }
    }

    const requestSequence = mode === "record" ? ++sequence : undefined;
    await forwardAndCapture(request, response, localUrl, upstreamPath, body, canonical, requestSequence, requestStartedAt);
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

function forwardAndCapture(incoming, outgoing, localUrl, upstreamPath, body, canonical, recordSequence, requestStartedAt) {
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
      const timedChunks = [];
      let bytes = 0;
      upstreamResponse.on("data", (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_CONFORMANCE_BODY_BYTES) {
          upstream.destroy(new Error("Upstream response exceeded the conformance body limit."));
          return;
        }
        chunks.push(buffer);
        timedChunks.push({ atMs: elapsedMs(requestStartedAt), bodyBase64: buffer.toString("base64") });
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
              timing: { endedAtMs: elapsedMs(requestStartedAt), chunks: timedChunks },
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
    if (exchange.key === "POST /v1/traces") exchange.request.body = canonicalOtlpTraceExport(requestBody);
    const responseBody = Buffer.from(exchange.response.bodyBase64, "base64");
    if (sha256(responseBody) !== exchange.response.bodySha256) usage(`Corpus response integrity check failed at sequence ${exchange.sequence}.`);
    validateRecordedTiming(exchange);
    const queue = output.get(exchange.key) ?? [];
    queue.push(exchange);
    output.set(exchange.key, queue);
  }
}

function collectTraceSemantics(trace, resources, spans) {
  if (!trace || typeof trace !== "object" || !Array.isArray(trace.spans) || !trace.resource || typeof trace.resource !== "object") {
    throw new ProtocolViolation("Canonical OTLP trace semantics were malformed.");
  }
  const resourceKey = stableJson(trace.resource);
  resources.set(resourceKey, (resources.get(resourceKey) ?? 0) + 1);
  spans.push(...trace.spans);
}

function assertTraceSemanticsComplete() {
  const expectedResources = [...expectedTraceResources.keys()].sort();
  const observedResources = [...observedTraceResources.keys()].sort();
  const expectedSpans = [...expectedTraceSpans].sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  const observedSpans = [...observedTraceSpans].sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  const differences = [];
  if (stableJson(expectedResources) !== stableJson(observedResources)) {
    differences.push({ pointer: "/trace/resources", expected: expectedResources, actual: observedResources });
  }
  if (stableJson(expectedSpans) !== stableJson(observedSpans)) {
    differences.push({
      pointer: "/trace/spans",
      expected: summarizeSemanticSpans(expectedSpans),
      actual: summarizeSemanticSpans(observedSpans),
    });
  }
  if (differences.length > 0) throw new ProtocolViolation("Browser Grok OTLP semantics diverged from native Grok Build.", differences);
}

function summarizeSemanticSpans(spans) {
  const counts = new Map();
  for (const span of spans) {
    const key = stableJson(span);
    const current = counts.get(key) ?? { count: 0, span };
    current.count += 1;
    counts.set(key, current);
  }
  return [...counts.values()].sort((left, right) => stableJson(left.span).localeCompare(stableJson(right.span)));
}

function validateRecordedTiming(exchange) {
  const timing = exchange.response?.timing;
  if (timing === undefined) return;
  if (!Array.isArray(timing.chunks) || !Number.isSafeInteger(timing.endedAtMs) || timing.endedAtMs < 0) {
    usage(`Corpus response timing is invalid at sequence ${exchange.sequence}.`);
  }
  let priorAt = 0;
  const chunks = [];
  for (const chunk of timing.chunks) {
    if (!Number.isSafeInteger(chunk?.atMs) || chunk.atMs < priorAt || chunk.atMs > timing.endedAtMs || typeof chunk.bodyBase64 !== "string") {
      usage(`Corpus response chunk timing is invalid at sequence ${exchange.sequence}.`);
    }
    priorAt = chunk.atMs;
    chunks.push(Buffer.from(chunk.bodyBase64, "base64"));
  }
  if (sha256(Buffer.concat(chunks)) !== exchange.response.bodySha256) {
    usage(`Corpus timed response chunks failed integrity check at sequence ${exchange.sequence}.`);
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
  const allForeground = exchanges.filter((exchange) =>
    exchange.key === "POST /v1/responses"
    && Array.isArray(exchange.request?.body?.input)
    && exchange.request?.headers?.["x-grok-turn-idx"] !== undefined
  );
  if (allForeground.length === 0) usage("Corpus has no foreground Responses exchange.");
  const rootSessionId = allForeground[0].request.headers?.["x-grok-session-id"];
  const foreground = allForeground.filter((exchange) =>
    exchange.request?.headers?.["x-grok-session-id"] === rootSessionId
  );
  const initial = foreground[0].request.body;
  const compaction = exchanges.find((exchange) => {
    if (exchange.key !== "POST /v1/responses" || !Array.isArray(exchange.request?.body?.input)) return false;
    if (exchange.request?.headers?.["x-grok-session-id"] !== rootSessionId) return false;
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
    && exchange.request?.headers?.["x-grok-session-id"] === rootSessionId
    && exchange.request?.body?.prompt_cache_key !== undefined
    && exchange.request?.headers?.["x-grok-turn-idx"] === undefined
    && exchange !== compaction
  ).length;
  const signalExchanges = exchanges.filter((exchange) => exchange.key.includes("/signals"));
  const postInitialSignalBillingRequests = exchanges.filter((exchange) =>
    exchange.key === "GET /v1/billing"
    && exchange.sequence > (signalExchanges[0]?.sequence ?? Number.MAX_SAFE_INTEGER)
  ).length;
  const nativeLongPausesCount = signalExchanges.reduce((maximum, exchange) =>
    Math.max(maximum, Number.isSafeInteger(exchange.request?.body?.longPausesCount) ? exchange.request.body.longPausesCount : 0), 0);
  const periodicSignalAssistantCounts = signalExchanges.slice(1).flatMap((exchange) =>
    Number.isSafeInteger(exchange.request?.body?.assistantMessageCount)
      ? [exchange.request.body.assistantMessageCount]
      : []
  );
  const finalSignal = signalExchanges.at(-1)?.request?.body;
  const clientMode = initial?.headers?.["x-grok-client-mode"]
    ?? foreground[0]?.request?.headers?.["x-grok-client-mode"]
    ?? "headless";
  const clientType = signalExchanges[0]?.request?.body?.clientType ?? "agent";
  const nativeWorkspacePath = extractWorkspacePath(initial.input);
  const initialFiles = extractInitialWorkspaceFiles(allForeground, nativeWorkspacePath);
  const asynchronousReminders = extractAsynchronousReminders(foreground);
  const subagentLanes = buildSubagentLanes(allForeground, exchanges, rootSessionId, nativeWorkspacePath);
  const telemetryMetadata = nativeTelemetryMetadata(manifest?.nativeVersion, clientMode, clientType);
  return {
    formatVersion: CONFORMANCE_FORMAT_VERSION,
    task: extractUserQuery(title?.request?.body?.input) ?? "",
    startupItems,
    tools: startupSource.tools ?? initial.tools,
    toolResults,
    foregroundRequests: foreground.length,
    modelRequests: exchanges.filter((exchange) => exchange.key === "POST /v1/responses").length,
    clientMode,
    clientType,
    telemetryMetadata,
    bundleArchiveRequests: exchanges.filter((exchange) => exchange.key === "GET /v1/bundle/archive").length,
    ...(periodicSignalAssistantCounts.length > 0 ? { periodicSignalAssistantCounts } : {}),
    ...(nativeLongPausesCount > 0 ? { nativeLongPausesCount } : {}),
    ...(Number.isSafeInteger(finalSignal?.totalTurns) && Number.isSafeInteger(finalSignal?.userMessageCount)
      ? { finalSignalCounts: { totalTurns: finalSignal.totalTurns, userMessageCount: finalSignal.userMessageCount } }
      : {}),
    turnSummaryRequests,
    ...(postInitialSignalBillingRequests > 0 ? { postInitialSignalBillingRequests } : {}),
    reasoningEffort: initial.reasoning?.effort,
    nativeWorkspacePath,
    ...(initialFiles.length > 0 ? { initialFiles } : {}),
    ...(asynchronousReminders.length > 0 ? { asynchronousReminders } : {}),
    ...(subagentLanes.length > 0 ? { subagentLanes } : {}),
    fixture: manifest?.fixture,
    autoCompactThresholdPercent: manifest?.autoCompactThresholdPercent,
    ...(compactionTranscriptHint ? { compactionTranscriptHint } : {}),
    ...(compactionSystemReminder ? { compactionSystemReminder } : {}),
  };
}

function nativeTelemetryMetadata(nativeVersion, clientMode, clientType) {
  const parsed = typeof nativeVersion === "string"
    ? /^grok\s+([^\s]+)\s+\(([^)]+)\)/u.exec(nativeVersion)
    : undefined;
  const clientVersion = parsed?.[1] ?? "1.0.5";
  const revision = parsed?.[2] ?? "unknown";
  return {
    clientName: clientMode === "interactive" ? "grok-pager" : "grok-shell",
    clientVersion,
    serviceVersion: `${clientVersion} (${revision})`,
    appEntrypoint: clientType === "tui" ? "tui" : "agent",
  };
}

function buildSubagentLanes(allForeground, exchanges, rootSessionId, nativeWorkspacePath) {
  const titleRequests = exchanges.filter((exchange) =>
    exchange.key === "POST /v1/responses"
    && Array.isArray(exchange.request?.body?.input)
    && exchange.request?.body?.prompt_cache_key === undefined
  );
  const groups = new Map();
  for (const exchange of allForeground) {
    const sessionId = exchange.request?.headers?.["x-grok-session-id"];
    if (!sessionId || sessionId === rootSessionId) continue;
    const group = groups.get(sessionId) ?? [];
    group.push(exchange);
    groups.set(sessionId, group);
  }
  const consumedTitles = new Set();
  return [...groups.values()]
    .sort((left, right) => left[0].sequence - right[0].sequence)
    .map((foreground) => {
      const initialExchange = foreground[0];
      const initial = initialExchange.request.body;
      const task = extractPlainUserQuery(initial.input) ?? "";
      const title = [...titleRequests].sort((left, right) =>
        Math.abs(left.sequence - initialExchange.sequence) - Math.abs(right.sequence - initialExchange.sequence)
      ).find((exchange) =>
        !consumedTitles.has(exchange)
        && extractUserQuery(exchange.request?.body?.input) === task
      );
      if (title) consumedTitles.add(title);
      return {
        task,
        startupItems: initial.input,
        tools: initial.tools ?? [],
        toolResults: extractToolResults(foreground),
        foregroundRequests: foreground.length,
        reasoningEffort: initial.reasoning?.effort,
        nativeWorkspacePath,
        enableSessionTitle: Boolean(title),
        ...(title ? { sessionTitleTiming: title.sequence < initialExchange.sequence
          ? "before-first-sample"
          : "after-first-sample-start" } : {}),
      };
    });
}

function extractToolResults(foreground) {
  const seenOutputs = new Set();
  const toolResults = [];
  for (const exchange of foreground.slice(1)) {
    for (const item of exchange.request.body.input) {
      if (item?.type !== "function_call_output" || typeof item.call_id !== "string" || seenOutputs.has(item.call_id)) continue;
      seenOutputs.add(item.call_id);
      toolResults.push({ callId: item.call_id, output: typeof item.output === "string" ? item.output : JSON.stringify(item.output) });
    }
  }
  return toolResults;
}

function extractAsynchronousReminders(foreground) {
  const seen = new Map();
  const reminders = [];
  for (let requestIndex = 0; requestIndex < foreground.length; requestIndex += 1) {
    const counts = new Map();
    for (const item of foreground[requestIndex]?.request?.body?.input ?? []) {
      if (item?.role !== "user" || typeof item.content !== "string" || !isAsynchronousReminder(item.content)) continue;
      counts.set(item.content, (counts.get(item.content) ?? 0) + 1);
    }
    for (const [content, count] of counts) {
      const prior = seen.get(content) ?? 0;
      for (let occurrence = prior; occurrence < count; occurrence += 1) reminders.push({ beforeForegroundRequest: requestIndex, content });
      if (count > prior) seen.set(content, count);
    }
  }
  return reminders;
}

function isAsynchronousReminder(content) {
  return content.startsWith("<system-reminder>\n")
    && /(?:While you were idle, \d+ background subagents? completed|Background subagent "|Background task "|Monitor "|monitor events? from|background workflow run stopped)/iu.test(content);
}

function extractInitialWorkspaceFiles(foreground, nativeWorkspacePath) {
  const bySession = new Map();
  for (const exchange of foreground) {
    const sessionId = exchange.request?.headers?.["x-grok-session-id"] ?? "<unknown>";
    const lane = bySession.get(sessionId) ?? [];
    lane.push(exchange);
    bySession.set(sessionId, lane);
  }
  const files = new Map();
  for (const lane of bySession.values()) {
    for (const [path, content] of extractInitialWorkspaceFilesFromLane(lane, nativeWorkspacePath)) {
      if (!files.has(path)) files.set(path, content);
    }
  }
  return [...files].map(([path, content]) => ({ path, content }));
}

function extractInitialWorkspaceFilesFromLane(foreground, nativeWorkspacePath) {
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
  const initialCallIds = [];
  for (const callId of orderedCallIds) {
    const call = calls.get(callId);
    if (!call || !isReadOnlyWorkspaceInspection(call)) break;
    initialCallIds.push(callId);
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
  for (const callId of initialCallIds) {
    const call = calls.get(callId);
    if (call?.name !== "list_dir") continue;
    const output = outputs.get(callId);
    if (typeof output !== "string") continue;
    for (const relative of listedWorkspaceFiles(output, nativeWorkspacePath)) {
      if (!files.has(relative)) files.set(relative, "");
    }
  }
  return files;
}

function listedWorkspaceFiles(output, nativeWorkspacePath) {
  const files = [];
  const directories = [];
  for (const line of output.split("\n")) {
    const match = /^(\s*)-\s+(.+)$/u.exec(line);
    if (!match) continue;
    const depth = Math.floor(match[1].length / 2);
    const raw = match[2].trim();
    const directory = raw.endsWith("/");
    const name = raw.replace(/\/$/u, "");
    const parent = directories[Math.max(0, depth - 1)] ?? nativeWorkspacePath;
    const absolute = name.startsWith("/") ? name : `${parent.replace(/\/$/u, "")}/${name}`;
    directories.length = depth + 1;
    if (directory) directories[depth] = absolute;
    else {
      const relative = workspaceRelativePath(absolute, nativeWorkspacePath);
      if (relative) files.push(relative);
    }
  }
  return files;
}

function isReadOnlyWorkspaceInspection(call) {
  // Todo state is session-local and does not mutate the workspace. Allowing it
  // here lets diagnostic corpora establish a checklist before their initial
  // read-only file discovery without disabling real browser execution.
  if (call.name === "todo_write") return true;
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
  if (!normalizedTarget.startsWith("/") && !normalizedTarget.split("/").includes("..")) {
    return `/${normalizedTarget.replace(/^\.\//u, "")}`;
  }
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

function extractPlainUserQuery(items) {
  const content = items?.findLast((item) => item?.role === "user")?.content;
  return typeof content === "string" ? content : undefined;
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

async function sendRecorded(response, recorded, requestStartedAt) {
  response.statusCode = recorded.status;
  for (const [name, value] of Object.entries(recorded.headers)) {
    if (!["content-length", "transfer-encoding", "connection"].includes(name)) response.setHeader(name, value);
  }
  if (!Array.isArray(recorded.timing?.chunks) || recorded.timing.chunks.length === 0) {
    response.end(Buffer.from(recorded.bodyBase64, "base64"));
    return;
  }
  for (const chunk of recorded.timing.chunks) {
    const targetMs = Number(chunk.atMs) * replayTimingScale;
    const remainingMs = targetMs - elapsedMs(requestStartedAt);
    if (remainingMs > 0) await delay(remainingMs);
    response.write(Buffer.from(chunk.bodyBase64, "base64"));
  }
  const endRemainingMs = Number(recorded.timing.endedAtMs) * replayTimingScale - elapsedMs(requestStartedAt);
  if (endRemainingMs > 0) await delay(endRemainingMs);
  response.end();
}

function elapsedMs(startedAt) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.min(120_000, Math.max(0, ms))));
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

function optionalPositiveNumberArg(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) usage("--timing-scale must be greater than 0 and no more than 100.");
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
  process.stderr.write(`${message}\nUsage: grok-conformance-proxy <record|replay|verify-live> --corpus PATH [--port 4319] [--task TEXT] [--fixture NAME] [--auto-compact-threshold 0..100] [--timing-scale NUMBER] [--overwrite]\n`);
  process.exit(2);
}

function log(event, details) {
  process.stderr.write(`${JSON.stringify({ event, ...details })}\n`);
}
