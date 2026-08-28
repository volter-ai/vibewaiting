import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import {
  MAX_WEB_FETCH_BYTES,
  MAX_WEB_FETCH_REDIRECTS,
  normalizeWebFetchRedirectUrl,
  normalizeWebFetchUrl,
  normalizeImageMediaRequest,
  normalizeVideoMediaRequest,
  normalizeGrokTelemetryRoute,
  sameWebFetchHost,
} from "../../cloudflare/security.js";
import {
  GROK_BUILD_MODEL,
  createGrokResponsesHeaders,
  createGrokSessionTitleHeaders,
  createGrokSideCallHeaders,
  type GrokClientIdentifier,
  type GrokClientMode,
  type GrokResponsesRequest,
} from "../../src/grok-browser-protocol.js";

const RESPONSES_PROXY_URL = "https://cli-chat-proxy.grok.com/v1/responses";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_BOOTSTRAP_RESPONSE_BYTES = 1024 * 1024;
const MAX_BUNDLE_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TELEMETRY_BYTES = 1024 * 1024;

interface StoredCredential {
  key?: unknown;
  email?: unknown;
  user_id?: unknown;
  expires_at?: unknown;
}

export interface GrokCredential {
  token: string;
  email?: string;
  userId?: string;
  expiresAt?: string;
}

export interface GrokRelayMetadata {
  conversationId: string;
  requestId: string;
  sessionId: string;
  turnIndex: number;
}

export interface GrokRelayOptions {
  authFile?: string;
  clientVersion?: string;
  fetch?: typeof globalThis.fetch;
  upstreamBaseUrl?: string;
  mediaBaseUrl?: string;
}

export type GrokRelayRequestKind = "main" | "session-title" | "turn-summary" | "compaction";
type GrokBootstrapKind = "user" | "models" | "settings" | "managed-mcp" | "billing";
type GrokBundleKind = "archive" | "legacy";
type GrokRelayRequest = GrokResponsesRequest | Omit<GrokResponsesRequest, "prompt_cache_key">;

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function grokClientModeFromRequest(request: IncomingMessage): GrokClientMode {
  return request.headers["x-browser-agent-client-mode"] === "interactive" ? "interactive" : "headless";
}

function grokClientIdentifierFromRequest(request: IncomingMessage): GrokClientIdentifier {
  return request.headers["x-browser-agent-client-identifier"] === "grok-pager" ? "grok-pager" : "grok-shell";
}

export function credentialFromAuthJson(authJson: unknown): GrokCredential {
  if (!authJson || typeof authJson !== "object" || Array.isArray(authJson)) {
    throw new Error("Grok auth.json must contain an object of credentials.");
  }

  const records = Object.values(authJson as Record<string, StoredCredential>);
  const record = records.find((candidate) => stringValue(candidate?.key));
  const token = stringValue(record?.key);
  if (!record || !token) throw new Error("No usable Grok session credential was found.");

  const email = stringValue(record.email);
  const userId = stringValue(record.user_id);
  const expiresAt = stringValue(record.expires_at);
  return {
    token,
    ...(email ? { email } : {}),
    ...(userId ? { userId } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

export async function readGrokCredential(authFile: string): Promise<GrokCredential> {
  const contents = await readFile(authFile, "utf8");
  return credentialFromAuthJson(JSON.parse(contents) as unknown);
}

function validUuid(value: string | undefined): string | undefined {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ? value
    : undefined;
}

function validMainRequestId(value: string | undefined): string | undefined {
  if (validUuid(value)) return value;
  for (const prefix of ["task-completed-", "subagent-completed-", "scheduler-fired-", "notifications-"] as const) {
    if (value?.startsWith(prefix) && validUuid(value.slice(prefix.length))) return value;
  }
  if (/^workflow-completed-wf_[0-9a-f]{32}-\d+$/iu.test(value ?? "")) return value;
  if (/^plan-resume-\d{13}$/u.test(value ?? "")) return value;
  return undefined;
}

function validSideCallId(
  value: string | undefined,
  prefix: "turn-summary" | "xai-turn-summary" | "xai-compact",
): string | undefined {
  const suffix = value?.slice(prefix.length + 1);
  return value?.startsWith(`${prefix}-`) && validUuid(suffix) ? value : undefined;
}

function positiveTurn(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

export function relayMetadataFromHeaders(headers: IncomingMessage["headers"]): GrokRelayMetadata {
  const conversationId = validUuid(headers["x-browser-agent-conversation"] as string | undefined) ?? randomUUID();
  return {
    conversationId,
    requestId: validMainRequestId(headers["x-browser-agent-request"] as string | undefined) ?? randomUUID(),
    sessionId: validUuid(headers["x-browser-agent-session"] as string | undefined) ?? conversationId,
    turnIndex: positiveTurn(headers["x-browser-agent-turn"] as string | undefined),
  };
}

function sideCallMetadataFromHeaders(
  headers: IncomingMessage["headers"],
  requestKind: "turn-summary" | "compaction",
): GrokRelayMetadata {
  const sessionId = validUuid(headers["x-browser-agent-session"] as string | undefined) ?? randomUUID();
  const summary = requestKind === "turn-summary";
  return {
    conversationId: summary
      ? validSideCallId(headers["x-browser-agent-conversation"] as string | undefined, "turn-summary") ?? `turn-summary-${randomUUID()}`
      : validUuid(headers["x-browser-agent-conversation"] as string | undefined) ?? sessionId,
    requestId: validSideCallId(
      headers["x-browser-agent-request"] as string | undefined,
      summary ? "xai-turn-summary" : "xai-compact",
    ) ?? `${summary ? "xai-turn-summary" : "xai-compact"}-${randomUUID()}`,
    sessionId,
    turnIndex: 1,
  };
}

function compactionAtFromHeaders(headers: IncomingMessage["headers"]): number | null | undefined {
  const raw = headers["x-browser-agent-compaction-at"] as string | undefined;
  if (raw === undefined) return undefined;
  if (raw === "omit") return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 10_000_000) {
    throw new Error("The Grok compaction token threshold is invalid.");
  }
  return parsed;
}

function compactionsRemainingFromHeaders(headers: IncomingMessage["headers"]): number | null | undefined {
  const raw = headers["x-browser-agent-compactions-remaining"] as string | undefined;
  if (raw === undefined) return undefined;
  if (raw === "omit") return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 255) {
    throw new Error("The Grok compactions-remaining value is invalid.");
  }
  return parsed;
}

function wasCompacted(headers: IncomingMessage["headers"]): boolean {
  const parsed = Number(headers["x-browser-agent-compacted"] as string | undefined);
  return Number.isSafeInteger(parsed) && parsed > 0;
}

export function normalizeGrokRequest(
  body: unknown,
  requestKind: GrokRelayRequestKind = "main",
): GrokRelayRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("The Grok relay request must be a JSON object.");
  }
  const request = body as Record<string, unknown>;
  const allowed = new Set([
    "include", "input", "max_output_tokens", "model", "prompt_cache_key", "reasoning",
    "store", "stream", "temperature", "text", "tool_choice", "tools", "top_p",
  ]);
  const unknown = Object.keys(request).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Unsupported Grok Responses fields: ${unknown.join(", ")}.`);
  if (![GROK_BUILD_MODEL, "grok-4.5"].includes(String(request.model)) || request.store !== false || request.stream !== true) {
    throw new Error("The Grok relay permits only the pinned streaming Grok Build Responses profile.");
  }
  if (!Array.isArray(request.include) || request.include.length !== 1 || request.include[0] !== "reasoning.encrypted_content") {
    throw new Error("The Grok relay requires encrypted reasoning replay.");
  }
  if (!Array.isArray(request.input) || request.input.length === 0 || request.input.length > 2_000) {
    throw new Error("The Grok relay requires between 1 and 2,000 Responses input items.");
  }
  if (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.length > 64)) {
    throw new Error("The Grok relay permits at most 64 tools.");
  }
  if (requestKind === "session-title") {
    if ("prompt_cache_key" in request) {
      throw new Error("A Grok session-title request must not contain prompt_cache_key.");
    }
    if (request.max_output_tokens !== 100 || request.temperature !== 1) {
      throw new Error("A Grok session-title request must use the native title sampling profile.");
    }
    const tools = request.tools;
    if (!Array.isArray(tools) || tools.length !== 1 || !tools[0] || typeof tools[0] !== "object"
      || (tools[0] as Record<string, unknown>).name !== "session_title") {
      throw new Error("A Grok session-title request must contain only the session_title tool.");
    }
  } else if (typeof request.prompt_cache_key !== "string" || request.prompt_cache_key.length === 0) {
    throw new Error("A foreground Grok request requires prompt_cache_key.");
  }
  return structuredClone(request) as unknown as GrokRelayRequest;
}

export function grokUpstreamHeaders(
  credential: GrokCredential,
  metadata: GrokRelayMetadata,
  clientVersion = "1.0.5",
  requestKind: GrokRelayRequestKind = "main",
  model = GROK_BUILD_MODEL,
  compactionAtTokens?: number | null,
  clientMode: GrokClientMode = "headless",
  clientIdentifier: GrokClientIdentifier = "grok-shell",
  compactionsRemaining?: number | null,
): Headers {
  const headers = new Headers(requestKind === "session-title"
    ? createGrokSessionTitleHeaders({ bearerToken: credential.token, clientVersion, model, clientMode })
    : requestKind === "turn-summary" || requestKind === "compaction" ? createGrokSideCallHeaders({
        conversationId: metadata.conversationId,
        requestId: metadata.requestId,
        sessionId: metadata.sessionId,
      }, {
        bearerToken: credential.token,
        clientVersion,
        traceparent: createTraceparent(),
        ...(credential.userId ? { userId: credential.userId } : {}),
        model,
        clientMode,
        clientIdentifier,
        ...(compactionAtTokens !== undefined ? { compactionAtTokens } : {}),
        ...(compactionsRemaining !== undefined ? { compactionsRemaining } : {}),
      }) : createGrokResponsesHeaders({
        conversationId: metadata.conversationId,
        requestId: metadata.requestId,
        sessionId: metadata.sessionId,
        promptIndex: metadata.turnIndex,
      }, {
        bearerToken: credential.token,
        clientVersion,
        traceparent: createTraceparent(),
        ...(credential.userId ? { userId: credential.userId } : {}),
        model,
        clientMode,
        clientIdentifier,
        ...(compactionAtTokens !== undefined ? { compactionAtTokens } : {}),
        ...(compactionsRemaining !== undefined ? { compactionsRemaining } : {}),
      }));
  headers.set("User-Agent", `grok-shell/${clientVersion}`);
  return headers;
}

export function grokBootstrapHeaders(
  credential: GrokCredential,
  kind: GrokBootstrapKind,
  clientVersion = "1.0.5",
  clientMode: GrokClientMode = "headless",
): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${credential.token}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-client-version": clientVersion,
    ...(kind === "managed-mcp" ? {} : { "x-grok-client-mode": clientMode }),
    Accept: "*/*",
  });
  if (credential.userId && kind !== "user" && kind !== "managed-mcp") headers.set("x-userid", credential.userId);
  if (credential.email && (kind === "models" || kind === "settings")) headers.set("x-email", credential.email);
  if (kind === "settings") headers.set("x-grok-client-identifier", "grok-shell");
  return headers;
}

export function grokBundleHeaders(
  credential: GrokCredential,
  kind: GrokBundleKind,
  clientVersion = "1.0.5",
  clientMode: GrokClientMode = "headless",
): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${credential.token}`,
    "x-grok-client-version": clientVersion,
    "x-grok-client-mode": clientMode,
    Accept: "*/*",
  });
  if (credential.userId) headers.set("x-userid", credential.userId);
  if (credential.email) headers.set("x-email", credential.email);
  if (kind === "legacy") {
    headers.set("X-XAI-Token-Auth", "xai-grok-cli");
    headers.set("x-grok-client-identifier", "grok-shell");
  }
  return headers;
}

async function boundedUpstreamBody(upstream: Response, maximum: number): Promise<Buffer> {
  const declared = Number(upstream.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > maximum) throw new Error(`Grok upstream response exceeds ${maximum} bytes.`);
  if (!upstream.body) return Buffer.alloc(0);
  const reader = upstream.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximum) {
      await reader.cancel();
      throw new Error(`Grok upstream response exceeds ${maximum} bytes.`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, length);
}

async function proxyBootstrap(
  response: ServerResponse,
  credential: GrokCredential,
  fetchImpl: typeof globalThis.fetch,
  upstreamBaseUrl: string | undefined,
  kind: GrokBootstrapKind,
  clientVersion: string | undefined,
  clientMode: GrokClientMode,
): Promise<void> {
  const base = (upstreamBaseUrl ?? "https://cli-chat-proxy.grok.com/v1").replace(/\/$/u, "");
  const path = kind === "managed-mcp" ? "mcp/tools/list"
    : kind === "billing" ? "billing?format=credits" : kind;
  const upstream = await fetchImpl(`${base}/${path}`, {
    headers: grokBootstrapHeaders(credential, kind, clientVersion, clientMode),
    signal: AbortSignal.timeout(5_000),
  });
  const body = Buffer.from(await upstream.arrayBuffer());
  if (body.byteLength > MAX_BOOTSTRAP_RESPONSE_BYTES) throw new Error(`Grok ${kind} response is too large.`);
  response.statusCode = upstream.status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", upstream.headers.get("Content-Type") ?? "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  const etag = upstream.headers.get("ETag");
  if (etag) response.setHeader("ETag", etag);
  response.end(body);
}

async function proxyBundle(
  response: ServerResponse,
  credential: GrokCredential,
  fetchImpl: typeof globalThis.fetch,
  upstreamBaseUrl: string | undefined,
  kind: GrokBundleKind,
  clientVersion: string | undefined,
  clientMode: GrokClientMode,
): Promise<void> {
  const base = (upstreamBaseUrl ?? "https://cli-chat-proxy.grok.com/v1").replace(/\/$/u, "");
  const path = kind === "archive" ? "bundle/archive" : "subagents/bundle";
  const upstream = await fetchImpl(`${base}/${path}`, {
    headers: grokBundleHeaders(credential, kind, clientVersion, clientMode),
    signal: AbortSignal.timeout(kind === "archive" ? 30_000 : 10_000),
  });
  const body = await boundedUpstreamBody(upstream, MAX_BUNDLE_RESPONSE_BYTES);
  response.statusCode = upstream.status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", upstream.headers.get("Content-Type") ?? (kind === "archive" ? "application/gzip" : "application/json; charset=utf-8"));
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(body);
}

async function proxyTelemetry(
  request: IncomingMessage,
  response: ServerResponse,
  credential: GrokCredential,
  fetchImpl: typeof globalThis.fetch,
  upstreamBaseUrl: string | undefined,
  clientVersion: string | undefined,
  route: NonNullable<ReturnType<typeof normalizeGrokTelemetryRoute>>,
  clientMode: GrokClientMode,
): Promise<void> {
  const body = request.method === "POST" ? await readBody(request) : undefined;
  if (body && body.byteLength > MAX_TELEMETRY_BYTES) throw new Error("The Grok telemetry payload exceeded 1 MiB.");
  if (body && route.contentType === "application/json") {
    const value: unknown = JSON.parse(body.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The Grok telemetry payload must be a JSON object.");
  }
  const origin = (upstreamBaseUrl ?? "https://cli-chat-proxy.grok.com").replace(/\/v1\/?$/u, "").replace(/\/$/u, "");
  const traceExport = route.upstreamPath === "/v1/traces";
  const traced = !traceExport && !route.upstreamPath.endsWith("/turn-deltas");
  const headers = new Headers({
    Authorization: `Bearer ${credential.token}`,
    Accept: "*/*",
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-client-version": clientVersion ?? "1.0.5",
    ...(traceExport ? {} : { "x-grok-client-mode": clientMode }),
    ...(traced ? { traceparent: createTraceparent(), tracestate: "" } : {}),
    ...(route.upstreamPath === "/v1/traces" && credential.userId ? { "x-userid": credential.userId } : {}),
    ...(body ? { "Content-Type": route.contentType } : {}),
  });
  const upstream = await fetchImpl(`${origin}${route.upstreamPath}`, {
    method: request.method ?? "GET",
    headers,
    ...(body ? { body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const responseBody = await boundedUpstreamBody(upstream, MAX_TELEMETRY_BYTES);
  response.statusCode = upstream.status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", upstream.headers.get("Content-Type") ?? (route.contentType === "application/json" ? "application/json; charset=utf-8" : route.contentType));
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(responseBody);
}

function authFileFromEnvironment(explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.GROK_AUTH_FILE) return resolve(process.env.GROK_AUTH_FILE);
  if (process.env.GROK_HOME) return resolve(process.env.GROK_HOME, "auth.json");
  throw new Error("Set GROK_HOME or GROK_AUTH_FILE before starting the Grok relay.");
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("The Grok relay request exceeded 8 MiB.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function localMediaHeaders(credential: GrokCredential, request: IncomingMessage): Headers {
  const sessionId = validUuid(request.headers["x-browser-agent-session"] as string | undefined) ?? randomUUID();
  return new Headers({
    Authorization: `Bearer ${credential.token}`,
    "Content-Type": "application/json",
    "x-grok-session-id": sessionId,
  });
}

async function proxyImageMedia(
  request: IncomingMessage,
  response: ServerResponse,
  credential: GrokCredential,
  fetchImpl: typeof globalThis.fetch,
  mediaBaseUrl: string,
): Promise<void> {
  const body = normalizeImageMediaRequest(JSON.parse((await readBody(request)).toString("utf8")) as unknown);
  const payload: Record<string, unknown> = {
    model: "grok-imagine-image-quality",
    prompt: body.prompt,
    n: 1,
    resolution: "1k",
    response_format: "b64_json",
  };
  if (body.kind === "generate") payload.aspect_ratio = body.aspectRatio;
  else if (body.images.length === 1) payload.image = { url: body.images[0] };
  else {
    payload.images = body.images.map((url) => ({ url }));
    payload.aspect_ratio = body.aspectRatio;
  }
  const upstream = await fetchImpl(`${mediaBaseUrl}/${body.kind === "generate" ? "images/generations" : "images/edits"}`, {
    method: "POST",
    headers: localMediaHeaders(credential, request),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300_000),
  });
  const text = await upstream.text();
  if (!upstream.ok) throw new Error(`${body.kind === "generate" ? "Image generation" : "Image edit"} failed with HTTP ${upstream.status}: ${[...text].slice(0, 200).join("")}`);
  const parsed = JSON.parse(text) as { data?: Array<{ b64_json?: unknown }> };
  const b64Json = parsed.data?.[0]?.b64_json;
  if (typeof b64Json !== "string" || !b64Json) throw new Error("Image generation returned no image data.");
  json(response, 200, { b64Json });
}

async function proxyVideoStart(
  request: IncomingMessage,
  response: ServerResponse,
  credential: GrokCredential,
  fetchImpl: typeof globalThis.fetch,
  mediaBaseUrl: string,
): Promise<void> {
  const body = normalizeVideoMediaRequest(JSON.parse((await readBody(request)).toString("utf8")) as unknown);
  const payload: Record<string, unknown> = {
    model: "grok-imagine-video-1.5",
    prompt: body.prompt,
    duration: body.duration,
    resolution: body.resolution,
  };
  if (body.kind === "image-to-video") payload.image = { url: body.image };
  else {
    payload.aspect_ratio = body.aspectRatio;
    if (body.images.length > 0) payload.reference_images = body.images.map((url) => ({ url }));
    if (body.voices.length > 0) payload.reference_audios = body.voices.map((voice_id) => ({ voice_id }));
  }
  const upstream = await fetchImpl(`${mediaBaseUrl}/videos/generations`, {
    method: "POST",
    headers: localMediaHeaders(credential, request),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await upstream.text();
  if (!upstream.ok) throw new Error(`Video generation failed with HTTP ${upstream.status}: ${[...text].slice(0, 500).join("")}`);
  const parsed = JSON.parse(text) as { request_id?: unknown };
  if (typeof parsed.request_id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(parsed.request_id)) {
    throw new Error("No request_id received from the video generation API.");
  }
  json(response, 200, { requestToken: parsed.request_id });
}

async function proxyVideoPoll(
  request: IncomingMessage,
  response: ServerResponse,
  credential: GrokCredential,
  fetchImpl: typeof globalThis.fetch,
  mediaBaseUrl: string,
): Promise<void> {
  const body = JSON.parse((await readBody(request)).toString("utf8")) as Record<string, unknown>;
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "requestToken")
    || typeof body.requestToken !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(body.requestToken)) {
    throw new Error("video poll requires a valid requestToken");
  }
  const upstream = await fetchImpl(`${mediaBaseUrl}/videos/${encodeURIComponent(body.requestToken)}`, {
    headers: localMediaHeaders(credential, request),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await upstream.text();
  if (!upstream.ok && upstream.status !== 202) throw new Error(`Video poll failed with HTTP ${upstream.status}: ${[...text].slice(0, 200).join("")}`);
  const parsed = JSON.parse(text) as { status?: unknown; video?: { url?: unknown } };
  if (parsed.status !== "done") {
    if (parsed.status === "failed") throw new Error(`Video generation failed on the server: ${[...text].slice(0, 300).join("")}`);
    if (parsed.status === "expired") throw new Error("Video generation request expired.");
    return json(response, 202, { status: "pending" });
  }
  if (typeof parsed.video?.url !== "string") throw new Error("Video generation completed but no download URL was returned.");
  const url = new URL(parsed.video.url);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Video generation returned an unsafe download URL.");
  const video = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
  if (!video.ok) throw new Error(`Video download failed (HTTP ${video.status})`);
  const bytes = Buffer.from(await video.arrayBuffer());
  if (bytes.byteLength > 100 * 1024 * 1024) throw new Error("Video response is too large.");
  response.statusCode = 200;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "video/mp4");
  response.end(bytes);
}

async function proxyWebFetch(
  request: IncomingMessage,
  response: ServerResponse,
  fetchImpl: typeof globalThis.fetch,
): Promise<void> {
  const payload = JSON.parse((await readBody(request)).toString("utf8")) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("web_fetch requires a JSON object");
  const record = payload as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "url")) throw new Error("web_fetch accepts only a url field");
  let current = normalizeWebFetchUrl(record.url);
  for (let redirects = 0; redirects <= MAX_WEB_FETCH_REDIRECTS; redirects += 1) {
    const upstream = await fetchImpl(current, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "text/markdown,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": "Mozilla/5.0 (compatible; grok-agent/1.0; +https://x.ai)",
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get("Location");
      if (location) {
        if (redirects === MAX_WEB_FETCH_REDIRECTS) throw new Error(`Too many redirects (maximum ${MAX_WEB_FETCH_REDIRECTS})`);
        const next = normalizeWebFetchRedirectUrl(new URL(location, current).toString());
        if (!sameWebFetchHost(current, next)) {
          json(response, 200, { kind: "cross-host-redirect", originalHost: current.hostname, redirectUrl: next.toString() });
          return;
        }
        current = next;
        continue;
      }
    }
    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.byteLength > MAX_WEB_FETCH_BYTES) throw new Error(`Response exceeds maximum size of ${MAX_WEB_FETCH_BYTES} bytes`);
    response.statusCode = 200;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", upstream.headers.get("Content-Type") ?? "text/html");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Vibewaiting-Web-Fetch-Kind", "content");
    response.setHeader("X-Vibewaiting-Web-Fetch-Status", String(upstream.status));
    response.setHeader("X-Vibewaiting-Web-Fetch-Url", encodeURIComponent(current.toString()));
    response.end(body);
    return;
  }
  throw new Error(`Too many redirects (maximum ${MAX_WEB_FETCH_REDIRECTS})`);
}

export function createGrokRelay(options: GrokRelayOptions = {}): Plugin {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return {
    name: "browser-agent-grok-relay",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const path = request.url?.split("?", 1)[0];
        if (path === "/api/grok/status" && request.method === "GET") {
          try {
            const credential = await readGrokCredential(authFileFromEnvironment(options.authFile));
            json(response, 200, {
              authenticated: true,
              email: credential.email ?? null,
              expiresAt: credential.expiresAt ?? null,
            });
          } catch (error) {
            json(response, 503, {
              authenticated: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return;
        }
        if (["/api/grok/user", "/api/grok/models", "/api/grok/settings", "/api/grok/mcp/tools/list", "/api/grok/billing"].includes(path ?? "")) {
          if (request.method !== "GET") return json(response, 405, { error: { message: "Method not allowed." } });
          try {
            const credential = await readGrokCredential(authFileFromEnvironment(options.authFile));
            await proxyBootstrap(
              response,
              credential,
              fetchImpl,
              options.upstreamBaseUrl ?? process.env.GROK_CONFORMANCE_BASE_URL,
              path === "/api/grok/user" ? "user"
                : path === "/api/grok/models" ? "models"
                  : path === "/api/grok/settings" ? "settings"
                    : path === "/api/grok/mcp/tools/list" ? "managed-mcp" : "billing",
              options.clientVersion ?? process.env.GROK_CLIENT_VERSION,
              grokClientModeFromRequest(request),
            );
          } catch (error) {
            json(response, 502, { error: { message: error instanceof Error ? error.message : String(error) } });
          }
          return;
        }
        if (path === "/api/grok/bundle/archive" || path === "/api/grok/subagents/bundle") {
          if (request.method !== "GET") return json(response, 405, { error: { message: "Method not allowed." } });
          try {
            const credential = await readGrokCredential(authFileFromEnvironment(options.authFile));
            await proxyBundle(
              response,
              credential,
              fetchImpl,
              options.upstreamBaseUrl ?? process.env.GROK_CONFORMANCE_BASE_URL,
              path.endsWith("/archive") ? "archive" : "legacy",
              options.clientVersion ?? process.env.GROK_CLIENT_VERSION,
              grokClientModeFromRequest(request),
            );
          } catch (error) {
            json(response, 502, { error: { message: error instanceof Error ? error.message : String(error) } });
          }
          return;
        }
        if (path === "/api/grok/web-fetch") {
          if (request.method !== "POST") return json(response, 405, { error: { message: "Method not allowed." } });
          try {
            await proxyWebFetch(request, response, fetchImpl);
          } catch (error) {
            json(response, 502, { error: { message: error instanceof Error ? error.message : String(error) } });
          }
          return;
        }
        if (path === "/api/grok/media/image" || path === "/api/grok/media/video/start" || path === "/api/grok/media/video/poll") {
          if (request.method !== "POST") return json(response, 405, { error: { message: "Method not allowed." } });
          try {
            const credential = await readGrokCredential(authFileFromEnvironment(options.authFile));
            const mediaBaseUrl = (options.mediaBaseUrl ?? "https://api.x.ai/v1").replace(/\/$/u, "");
            if (path === "/api/grok/media/image") {
              await proxyImageMedia(request, response, credential, fetchImpl, mediaBaseUrl);
            } else if (path === "/api/grok/media/video/start") {
              await proxyVideoStart(request, response, credential, fetchImpl, mediaBaseUrl);
            } else {
              await proxyVideoPoll(request, response, credential, fetchImpl, mediaBaseUrl);
            }
          } catch (error) {
            json(response, 502, { error: { message: error instanceof Error ? error.message : String(error) } });
          }
          return;
        }
        const telemetryRoute = path ? normalizeGrokTelemetryRoute(path, request.method ?? "") : undefined;
        if (telemetryRoute) {
          try {
            const credential = await readGrokCredential(authFileFromEnvironment(options.authFile));
            await proxyTelemetry(request, response, credential, fetchImpl, options.upstreamBaseUrl ?? process.env.GROK_CONFORMANCE_BASE_URL, options.clientVersion ?? process.env.GROK_CLIENT_VERSION, telemetryRoute, grokClientModeFromRequest(request));
          } catch (error) {
            json(response, 502, { error: { message: error instanceof Error ? error.message : String(error) } });
          }
          return;
        }
        if (path !== "/api/grok/responses") return next();
        if (request.method !== "POST") return json(response, 405, { error: { message: "Method not allowed." } });

        const startedAt = Date.now();
        const requestKind: GrokRelayRequestKind = request.headers["x-browser-agent-request-kind"] === "session-title"
          ? "session-title"
          : request.headers["x-browser-agent-request-kind"] === "turn-summary" ? "turn-summary"
          : request.headers["x-browser-agent-request-kind"] === "compaction" ? "compaction" : "main";
        const metadata = requestKind === "turn-summary" || requestKind === "compaction"
          ? sideCallMetadataFromHeaders(request.headers, requestKind)
          : relayMetadataFromHeaders(request.headers);
        try {
          const credential = await readGrokCredential(authFileFromEnvironment(options.authFile));
          const body = normalizeGrokRequest(
            JSON.parse((await readBody(request)).toString("utf8")) as unknown,
            requestKind,
          );
          if (requestKind === "main" && "prompt_cache_key" in body && body.prompt_cache_key !== metadata.sessionId) {
            throw new Error("The prompt_cache_key must equal the relay session ID.");
          }
          const upstreamBaseUrl = options.upstreamBaseUrl ?? process.env.GROK_CONFORMANCE_BASE_URL;
          const endpoint = upstreamBaseUrl
            ? `${upstreamBaseUrl.replace(/\/$/u, "")}/responses`
            : RESPONSES_PROXY_URL;
          const upstream = await fetchImpl(endpoint, {
            method: "POST",
            headers: grokUpstreamHeaders(
              credential,
              metadata,
              options.clientVersion ?? process.env.GROK_CLIENT_VERSION,
              requestKind,
              body.model,
              wasCompacted(request.headers)
                ? null
                : compactionAtFromHeaders(request.headers),
              grokClientModeFromRequest(request),
              grokClientIdentifierFromRequest(request),
              compactionsRemainingFromHeaders(request.headers),
            ),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120_000),
          });
          response.statusCode = upstream.status;
          for (const name of ["content-type", "cache-control", "x-grok-model", "x-request-id"]) {
            const value = upstream.headers.get(name);
            if (value) response.setHeader(name, value);
          }
          if (upstream.body) {
            Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0]).pipe(response);
          }
          else response.end();
          console.info("[grok-relay]", JSON.stringify({
            conversationId: metadata.conversationId,
            requestKind,
            turn: metadata.turnIndex,
            status: upstream.status,
            durationMs: Date.now() - startedAt,
          }));
        } catch (error) {
          console.error("[grok-relay]", error instanceof Error ? error.message : String(error));
          json(response, 502, { error: { message: error instanceof Error ? error.message : String(error) } });
        }
      });
    },
  };
}

function createTraceparent(): string {
  return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}
