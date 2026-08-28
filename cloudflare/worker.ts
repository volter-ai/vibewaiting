import {
  MAX_AGENT_STEPS,
  MAX_REQUEST_BYTES,
  MAX_WEB_FETCH_BYTES,
  MAX_WEB_FETCH_REDIRECTS,
  cookieValue,
  isTrustedMutation,
  normalizeWebFetchRedirectUrl,
  normalizeWebFetchUrl,
  normalizeImageMediaRequest,
  normalizeVideoMediaRequest,
  normalizeGrokTelemetryRoute,
  normalizeGrokResponsesRequest,
  positiveTurn,
  sameWebFetchHost,
  validSessionId,
  validUuid,
  type GrokRelayRequestKind,
  type GrokTelemetryRoute,
} from "./security.js";
import {
  createGrokResponsesHeaders,
  createGrokSessionTitleHeaders,
  createGrokSideCallHeaders,
} from "../src/grok-browser-protocol.js";

const AUTH_ORIGIN = "https://auth.x.ai";
const DEVICE_URL = `${AUTH_ORIGIN}/oauth2/device/code`;
const TOKEN_URL = `${AUTH_ORIGIN}/oauth2/token`;
const CHAT_PROXY_ORIGIN = "https://cli-chat-proxy.grok.com";
const RESPONSES_URL = `${CHAT_PROXY_ORIGIN}/v1/responses`;
const USER_URL = `${CHAT_PROXY_ORIGIN}/v1/user?include=subscription`;
const XAI_API_ORIGIN = "https://api.x.ai/v1";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "grok-cli:access",
  "api:access",
  "conversations:read",
  "conversations:write",
  "workspaces:read",
  "workspaces:write",
].join(" ");
const SESSION_COOKIE = "__Host-vw_session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const SESSION_ALARM_MS = SESSION_MAX_AGE_SECONDS * 1_000;
const GLOBAL_DAILY_CHAT_LIMIT = 100;
const USER_DAILY_CHAT_LIMIT = 40;
const GLOBAL_CONCURRENCY_LIMIT = 5;
const USER_CONCURRENCY_LIMIT = 1;
const AUTH_START_DAILY_GLOBAL_LIMIT = 50;
const AUTH_START_DAILY_IP_LIMIT = 5;
const RESERVATION_LEASE_MS = 3 * 60 * 1_000;
const GLOBAL_DAILY_MEDIA_LIMIT = 20;
const USER_DAILY_MEDIA_LIMIT = 5;
const VIDEO_REQUEST_TOKEN_MAX_AGE_MS = 10 * 60 * 1_000;
const MAX_IMAGE_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_VIDEO_RESPONSE_BYTES = 100 * 1024 * 1024;
const MAX_BOOTSTRAP_RESPONSE_BYTES = 1024 * 1024;
const MAX_BUNDLE_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TELEMETRY_BYTES = 512 * 1024;
const TIER_RESTRICTED_UPSELL = "Image generation is a SuperGrok feature and isn't available on the free or X Basic tier. Let the user know they can unlock image and video generation by upgrading to SuperGrok: https://grok.com/supergrok?referrer=grok-build. Do not retry this tool.";

interface Env {
  ASSETS: Fetcher;
  SESSIONS: DurableObjectNamespace;
  RATE_GATE: DurableObjectNamespace;
  AUTH_RATE_LIMITER: RateLimit;
  CHAT_IP_RATE_LIMITER: RateLimit;
  CHAT_USER_RATE_LIMITER: RateLimit;
  INFERENCE_ENABLED: string;
  XAI_CLIENT_VERSION: string;
  XAI_OAUTH_CLIENT_ID: string;
  SESSION_ENCRYPTION_KEY: string;
}

interface DeviceState {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  intervalSeconds: number;
  nextPollAt: number;
}

interface CredentialState {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  userId: string;
  email?: string;
  subscriptionTier?: string;
  teamId?: string;
}

interface SessionState {
  device?: DeviceState;
  credential?: CredentialState;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
  error?: unknown;
  error_description?: unknown;
}

interface RateReservation {
  userKey: string;
  expiresAt: number;
}

interface GateState {
  day: string;
  globalChats: number;
  userChats: Record<string, number>;
  reservations: Record<string, RateReservation>;
  authStarts: number;
  authStartsByIp: Record<string, number>;
  globalMediaStarts: number;
  userMediaStarts: Record<string, number>;
}

interface InternalCredential {
  accessToken: string;
  userId: string;
  email?: string;
  eligible: boolean;
  subscriptionTier?: string;
  teamId?: string;
}

type GrokBootstrapKind = "models" | "settings";
type GrokBundleKind = "archive" | "legacy";

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  responseHeaders.set("Referrer-Policy", "no-referrer");
  return new Response(JSON.stringify(value), { status, headers: responseHeaders });
}

function error(message: string, status: number, retryAfter?: number): Response {
  const headers = retryAfter ? { "Retry-After": String(retryAfter) } : undefined;
  return json({ error: { message } }, status, headers);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sessionCookie(sessionId: string): string {
  return `${SESSION_COOKIE}=${sessionId}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

function expiredSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

function randomSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

function sessionStub(env: Env, sessionId: string): DurableObjectStub {
  return env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
}

function gateStub(env: Env): DurableObjectStub {
  return env.RATE_GATE.get(env.RATE_GATE.idFromName("global-v1"));
}

async function internalJson(stub: DurableObjectStub, path: string, body?: unknown): Promise<Response> {
  if (body === undefined) return stub.fetch(`https://durable.internal${path}`);
  return stub.fetch(`https://durable.internal${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function xaiOAuthHeaders(env: Env): Headers {
  return new Headers({
    "Content-Type": "application/x-www-form-urlencoded",
    "x-grok-client-version": env.XAI_CLIENT_VERSION,
    "x-grok-client-surface": "ui",
    "User-Agent": "vibewaiting-browser/0.1.2",
  });
}

function xaiProxyHeaders(env: Env, token: string, userId?: string): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${token}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-client-version": env.XAI_CLIENT_VERSION,
    "x-grok-client-identifier": "vibewaiting-browser",
    "x-grok-client-mode": "browser",
    "User-Agent": "vibewaiting-browser/0.1.2",
  });
  if (userId) headers.set("x-grok-user-id", userId);
  return headers;
}

function xaiBootstrapHeaders(
  env: Env,
  credential: InternalCredential,
  kind: GrokBootstrapKind,
): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${credential.accessToken}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-client-version": env.XAI_CLIENT_VERSION,
    "x-grok-client-mode": "headless",
    "x-userid": credential.userId,
    Accept: "*/*",
  });
  if (kind === "settings") headers.set("x-grok-client-identifier", "grok-shell");
  if (credential.email) headers.set("x-email", credential.email);
  return headers;
}

function xaiBundleHeaders(
  env: Env,
  credential: InternalCredential,
  kind: GrokBundleKind,
): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${credential.accessToken}`,
    "x-grok-client-version": env.XAI_CLIENT_VERSION,
    "x-grok-client-mode": "headless",
    "x-userid": credential.userId,
    Accept: "*/*",
  });
  if (credential.email) headers.set("x-email", credential.email);
  if (kind === "legacy") {
    headers.set("X-XAI-Token-Auth", "xai-grok-cli");
    headers.set("x-grok-client-identifier", "grok-shell");
  }
  return headers;
}

function decodeJwtIdentity(idToken: string | undefined): { userId?: string; email?: string } {
  if (!idToken) return {};
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return {};
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as Record<string, unknown>;
    const userId = stringValue(claims.sub);
    const email = stringValue(claims.email);
    return { ...(userId ? { userId } : {}), ...(email ? { email } : {}) };
  } catch {
    return {};
  }
}

async function readLimitedBody(request: Request): Promise<string> {
  const declared = Number.parseInt(request.headers.get("Content-Length") ?? "0", 10);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw new Error("Request body is too large.");
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) throw new Error("Request body is too large.");
  return body;
}

async function readLimitedResponse(response: Response, maximum = MAX_WEB_FETCH_BYTES): Promise<Uint8Array> {
  const declared = Number.parseInt(response.headers.get("Content-Length") ?? "0", 10);
  if (Number.isFinite(declared) && declared > maximum) {
    throw new Error(`Response exceeds maximum size of ${maximum} bytes`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new Error(`Response exceeds maximum size of ${maximum} bytes`);
      chunks.push(value);
    }
  } catch (cause) {
    await reader.cancel(cause).catch(() => undefined);
    throw cause;
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function mediaSessionId(request: Request): string {
  return validUuid(request.headers.get("x-browser-agent-session")) ?? crypto.randomUUID();
}

function xaiMediaHeaders(token: string, sessionId: string): Headers {
  return new Headers({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "x-grok-session-id": sessionId,
  });
}

function isMediaTierRestricted(tier: string | undefined): boolean {
  return !tier || /^(?:free|x basic)$/iu.test(tier.trim());
}

async function mediaSigningKey(env: Env): Promise<CryptoKey> {
  const raw = fromBase64Url(env.SESSION_ENCRYPTION_KEY);
  return crypto.subtle.importKey("raw", raw.buffer as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function createVideoRequestToken(env: Env, requestId: string, userId: string): Promise<string> {
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({ requestId, userId, expiresAt: Date.now() + VIDEO_REQUEST_TOKEN_MAX_AGE_MS })));
  const signature = await crypto.subtle.sign("HMAC", await mediaSigningKey(env), new TextEncoder().encode(payload));
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}

async function verifyVideoRequestToken(env: Env, token: unknown, userId: string): Promise<string | undefined> {
  if (typeof token !== "string" || token.length > 2_000) return undefined;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return undefined;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await mediaSigningKey(env),
      fromBase64Url(signature).buffer as ArrayBuffer,
      new TextEncoder().encode(payload),
    );
    if (!valid) return undefined;
    const value = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as Record<string, unknown>;
    return typeof value.requestId === "string"
      && /^[A-Za-z0-9_-]{1,256}$/u.test(value.requestId)
      && value.userId === userId
      && typeof value.expiresAt === "number"
      && value.expiresAt > Date.now()
      ? value.requestId
      : undefined;
  } catch {
    return undefined;
  }
}

function proxyMetadata(request: Request): {
  conversationId: string;
  requestId: string;
  sessionId: string;
  turn: number;
} {
  const conversationId = validUuid(request.headers.get("x-browser-agent-conversation")) ?? crypto.randomUUID();
  const sessionId = validUuid(request.headers.get("x-browser-agent-session")) ?? conversationId;
  return {
    conversationId,
    requestId: validUuid(request.headers.get("x-browser-agent-request")) ?? crypto.randomUUID(),
    sessionId,
    turn: positiveTurn(request.headers.get("x-browser-agent-turn")),
  };
}

function validSideCallId(value: string | null, prefix: "turn-summary" | "xai-turn-summary" | "xai-compact"): string | undefined {
  const suffix = value?.slice(prefix.length + 1) ?? "";
  return value?.startsWith(`${prefix}-`) && validUuid(suffix) ? value : undefined;
}

function grokResponseHeaders(
  request: Request,
  env: Env,
  token: string,
  userId: string,
  kind: GrokRelayRequestKind,
  model: string,
): Headers {
  const metadata = proxyMetadata(request);
  const headers = new Headers(kind === "session-title"
    ? createGrokSessionTitleHeaders({ bearerToken: token, clientVersion: env.XAI_CLIENT_VERSION, model })
    : kind === "turn-summary" ? createGrokSideCallHeaders({
        conversationId: validSideCallId(request.headers.get("x-browser-agent-conversation"), "turn-summary") ?? `turn-summary-${crypto.randomUUID()}`,
        requestId: validSideCallId(request.headers.get("x-browser-agent-request"), "xai-turn-summary") ?? `xai-turn-summary-${crypto.randomUUID()}`,
        sessionId: metadata.sessionId,
      }, {
        bearerToken: token,
        clientVersion: env.XAI_CLIENT_VERSION,
        userId,
        traceparent: createTraceparent(),
        model,
      }) : kind === "compaction" ? createGrokSideCallHeaders({
        conversationId: metadata.conversationId,
        requestId: validSideCallId(request.headers.get("x-browser-agent-request"), "xai-compact") ?? `xai-compact-${crypto.randomUUID()}`,
        sessionId: metadata.sessionId,
      }, {
        bearerToken: token,
        clientVersion: env.XAI_CLIENT_VERSION,
        userId,
        traceparent: createTraceparent(),
        model,
      }) : createGrokResponsesHeaders({
        conversationId: metadata.conversationId,
        requestId: metadata.requestId,
        sessionId: metadata.sessionId,
        promptIndex: metadata.turn,
      }, {
        bearerToken: token,
        clientVersion: env.XAI_CLIENT_VERSION,
        userId,
        traceparent: createTraceparent(),
        model,
      }));
  headers.set("User-Agent", `grok-shell/${env.XAI_CLIENT_VERSION}`);
  return headers;
}

function createTraceparent(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `00-${hex(bytes.slice(0, 16))}-${hex(bytes.slice(16))}-01`;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function requireEdgeLimit(limiter: RateLimit, key: string): Promise<boolean> {
  const result = await limiter.limit({ key });
  return result.success;
}

async function routeDeviceStart(request: Request, env: Env): Promise<Response> {
  const ipHash = await sha256(clientIp(request));
  if (!(await requireEdgeLimit(env.AUTH_RATE_LIMITER, `start:${ipHash}`))) {
    return error("Too many sign-in attempts. Try again in a minute.", 429, 60);
  }
  const gate = await internalJson(gateStub(env), "/auth-start", { ipKey: ipHash });
  if (!gate.ok) return new Response(gate.body, gate);

  const oldId = cookieValue(request.headers.get("Cookie"), SESSION_COOKIE);
  if (validSessionId(oldId)) await internalJson(sessionStub(env, oldId), "/logout", {});

  const sessionId = randomSessionId();
  const response = await internalJson(sessionStub(env, sessionId), "/device/start", {});
  const headers = new Headers(response.headers);
  headers.set("Set-Cookie", sessionCookie(sessionId));
  return new Response(response.body, { status: response.status, headers });
}

async function routeSession(request: Request, env: Env, action: "poll" | "status" | "logout"): Promise<Response> {
  const sessionId = cookieValue(request.headers.get("Cookie"), SESSION_COOKIE);
  if (!validSessionId(sessionId)) return error("No Grok sign-in session was found.", 401);
  if (action === "poll") {
    const ipHash = await sha256(clientIp(request));
    if (!(await requireEdgeLimit(env.AUTH_RATE_LIMITER, `poll:${ipHash}`))) {
      return error("Sign-in polling is too fast.", 429, 10);
    }
  }
  const response = await internalJson(sessionStub(env, sessionId), `/${action}`, action === "status" ? undefined : {});
  const headers = new Headers(response.headers);
  if (action === "logout") headers.set("Set-Cookie", expiredSessionCookie());
  return new Response(response.body, { status: response.status, headers });
}

async function routeWebFetch(request: Request, env: Env): Promise<Response> {
  const sessionId = cookieValue(request.headers.get("Cookie"), SESSION_COOKIE);
  if (!validSessionId(sessionId)) return error("Connect a Grok subscription before using web_fetch.", 401);
  let current: URL;
  try {
    const payload = JSON.parse(await readLimitedBody(request)) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("web_fetch requires a JSON object");
    const record = payload as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "url")) throw new Error("web_fetch accepts only a url field");
    current = normalizeWebFetchUrl(record.url);
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : "Invalid web_fetch request.", 400);
  }

  const ipHash = await sha256(clientIp(request));
  if (!(await requireEdgeLimit(env.CHAT_IP_RATE_LIMITER, `fetch:${ipHash}`))) {
    return error("This network has reached the per-minute web_fetch limit.", 429, 60);
  }
  const credentialResponse = await internalJson(sessionStub(env, sessionId), "/credential");
  if (!credentialResponse.ok) return new Response(credentialResponse.body, credentialResponse);
  const credential = await credentialResponse.json<{ userId: string; eligible: boolean }>();
  if (!credential.eligible) return error("This Grok account does not have an active eligible subscription.", 403);
  const userKey = await sha256(credential.userId);
  if (!(await requireEdgeLimit(env.CHAT_USER_RATE_LIMITER, `fetch:${userKey}`))) {
    return error("This Grok account has reached the per-minute web_fetch limit.", 429, 60);
  }

  const originalHost = current.hostname;
  try {
    for (let redirects = 0; redirects <= MAX_WEB_FETCH_REDIRECTS; redirects += 1) {
      const upstream = await fetch(current, {
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
            return json({
              kind: "cross-host-redirect",
              originalHost: current.hostname,
              redirectUrl: next.toString(),
            });
          }
          current = next;
          continue;
        }
      }
      const body = await readLimitedResponse(upstream);
      return new Response(body.buffer as ArrayBuffer, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": upstream.headers.get("Content-Type") ?? "text/html",
          "X-Content-Type-Options": "nosniff",
          "X-Vibewaiting-Web-Fetch-Kind": "content",
          "X-Vibewaiting-Web-Fetch-Status": String(upstream.status),
          "X-Vibewaiting-Web-Fetch-Url": encodeURIComponent(current.toString()),
        },
      });
    }
    throw new Error(`Too many redirects (maximum ${MAX_WEB_FETCH_REDIRECTS})`);
  } catch (cause) {
    console.error("web_fetch_failed", originalHost, cause instanceof Error ? cause.message : "unknown");
    return error(cause instanceof Error ? cause.message : "web_fetch failed", 502);
  }
}

async function requireMediaCredential(request: Request, env: Env): Promise<{
  session: DurableObjectStub;
  credential: InternalCredential;
} | Response> {
  if (env.INFERENCE_ENABLED !== "true") return error("Grok inference is temporarily disabled.", 503);
  const sessionId = cookieValue(request.headers.get("Cookie"), SESSION_COOKIE);
  if (!validSessionId(sessionId)) return error("Connect a Grok subscription before using Imagine.", 401);
  const session = sessionStub(env, sessionId);
  const credentialResponse = await internalJson(session, "/credential");
  if (!credentialResponse.ok) return new Response(credentialResponse.body, credentialResponse);
  const credential = await credentialResponse.json<InternalCredential>();
  if (!credential.eligible) return error("This Grok account does not have an active eligible subscription.", 403);
  return { session, credential };
}

async function acquireMediaStart(request: Request, env: Env, userId: string): Promise<Response | undefined> {
  const ipHash = await sha256(clientIp(request));
  if (!(await requireEdgeLimit(env.CHAT_IP_RATE_LIMITER, `media:${ipHash}`))) {
    return error("This network has reached the per-minute Imagine limit.", 429, 60);
  }
  const userKey = await sha256(userId);
  if (!(await requireEdgeLimit(env.CHAT_USER_RATE_LIMITER, `media:${userKey}`))) {
    return error("This Grok account has reached the per-minute Imagine limit.", 429, 60);
  }
  const gate = await internalJson(gateStub(env), "/acquire-media", { userKey });
  return gate.ok ? undefined : new Response(gate.body, gate);
}

async function mediaUpstream(
  session: DurableObjectStub,
  credential: InternalCredential,
  env: Env,
  url: string,
  init: (accessToken: string) => RequestInit,
): Promise<Response> {
  let upstream = await fetch(url, init(credential.accessToken));
  if (upstream.status !== 401) return upstream;
  await upstream.body?.cancel().catch(() => undefined);
  const refreshed = await internalJson(session, "/refresh", {});
  if (!refreshed.ok) return error("The Grok session expired. Sign in again.", 401);
  const next = await refreshed.json<InternalCredential>();
  upstream = await fetch(url, init(next.accessToken));
  return upstream;
}

async function routeImageMedia(request: Request, env: Env): Promise<Response> {
  let body: ReturnType<typeof normalizeImageMediaRequest>;
  try {
    body = normalizeImageMediaRequest(JSON.parse(await readLimitedBody(request)) as unknown);
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : "Invalid image generation request.", 400);
  }
  const authenticated = await requireMediaCredential(request, env);
  if (authenticated instanceof Response) return authenticated;
  const { session, credential } = authenticated;
  if (isMediaTierRestricted(credential.subscriptionTier)) {
    return json({ tierRestricted: true, message: TIER_RESTRICTED_UPSELL });
  }
  const limited = await acquireMediaStart(request, env, credential.userId);
  if (limited) return limited;

  const sessionId = mediaSessionId(request);
  const endpoint = body.kind === "generate" ? `${XAI_API_ORIGIN}/images/generations` : `${XAI_API_ORIGIN}/images/edits`;
  const payload: Record<string, unknown> = {
    model: "grok-imagine-image-quality",
    prompt: body.prompt,
    n: 1,
    resolution: "1k",
    response_format: "b64_json",
  };
  if (body.kind === "generate") {
    payload.aspect_ratio = body.aspectRatio;
  } else if (body.images.length === 1) {
    payload.image = { url: body.images[0] };
  } else {
    payload.images = body.images.map((url) => ({ url }));
    payload.aspect_ratio = body.aspectRatio;
  }
  const serialized = JSON.stringify(payload);
  try {
    const upstream = await mediaUpstream(session, credential, env, endpoint, (token) => ({
      method: "POST",
      headers: xaiMediaHeaders(token, sessionId),
      body: serialized,
      signal: AbortSignal.timeout(300_000),
    }));
    const raw = await readLimitedResponse(upstream, MAX_IMAGE_RESPONSE_BYTES);
    const text = new TextDecoder().decode(raw);
    if (!upstream.ok) {
      const preview = [...text].slice(0, 200).join("");
      return error(`${body.kind === "generate" ? "Image generation" : "Image edit"} failed with HTTP ${upstream.status}: ${preview}`, upstream.status);
    }
    const parsed = JSON.parse(text) as { data?: Array<{ b64_json?: unknown }> };
    const b64Json = parsed.data?.[0]?.b64_json;
    if (typeof b64Json !== "string" || b64Json.length === 0) return error("Image generation returned no image data.", 502);
    return json({ b64Json });
  } catch (cause) {
    console.error("imagine_image_failed", cause instanceof Error ? cause.message : "unknown");
    return error(cause instanceof Error ? cause.message : "Image generation failed.", 502);
  }
}

async function routeVideoStart(request: Request, env: Env): Promise<Response> {
  let body: ReturnType<typeof normalizeVideoMediaRequest>;
  try {
    body = normalizeVideoMediaRequest(JSON.parse(await readLimitedBody(request)) as unknown);
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : "Invalid video generation request.", 400);
  }
  const authenticated = await requireMediaCredential(request, env);
  if (authenticated instanceof Response) return authenticated;
  const { session, credential } = authenticated;
  if (isMediaTierRestricted(credential.subscriptionTier)) {
    return json({ tierRestricted: true, message: TIER_RESTRICTED_UPSELL });
  }
  const limited = await acquireMediaStart(request, env, credential.userId);
  if (limited) return limited;

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
  const serialized = JSON.stringify(payload);
  const sessionId = mediaSessionId(request);
  try {
    const upstream = await mediaUpstream(session, credential, env, `${XAI_API_ORIGIN}/videos/generations`, (token) => ({
      method: "POST",
      headers: xaiMediaHeaders(token, sessionId),
      body: serialized,
      signal: AbortSignal.timeout(60_000),
    }));
    const raw = await readLimitedResponse(upstream, 128 * 1024);
    const text = new TextDecoder().decode(raw);
    if (!upstream.ok) return error(`Video generation failed with HTTP ${upstream.status}: ${[...text].slice(0, 500).join("")}`, upstream.status);
    const parsed = JSON.parse(text) as { request_id?: unknown };
    if (typeof parsed.request_id !== "string" || !parsed.request_id) return error("No request_id received from the video generation API.", 502);
    return json({ requestToken: await createVideoRequestToken(env, parsed.request_id, credential.userId) });
  } catch (cause) {
    console.error("imagine_video_start_failed", cause instanceof Error ? cause.message : "unknown");
    return error(cause instanceof Error ? cause.message : "Video generation failed.", 502);
  }
}

function boundedResponseStream(response: Response, maximum: number): ReadableStream<Uint8Array> {
  if (!response.body) return new ReadableStream({ start(controller) { controller.close(); } });
  const reader = response.body.getReader();
  let received = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) return controller.close();
        received += value.byteLength;
        if (received > maximum) {
          await reader.cancel("video response too large").catch(() => undefined);
          return controller.error(new Error(`Video response exceeds ${maximum} bytes`));
        }
        controller.enqueue(value);
      } catch (cause) {
        controller.error(cause);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

async function routeVideoPoll(request: Request, env: Env): Promise<Response> {
  let token: unknown;
  try {
    const parsed = JSON.parse(await readLimitedBody(request)) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).some((key) => key !== "requestToken")) {
      throw new Error("video poll accepts only a requestToken field");
    }
    token = parsed.requestToken;
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : "Invalid video poll request.", 400);
  }
  const authenticated = await requireMediaCredential(request, env);
  if (authenticated instanceof Response) return authenticated;
  const { session, credential } = authenticated;
  const requestId = await verifyVideoRequestToken(env, token, credential.userId);
  if (!requestId) return error("The video generation request token is invalid or expired.", 403);
  const sessionId = mediaSessionId(request);
  try {
    const upstream = await mediaUpstream(session, credential, env, `${XAI_API_ORIGIN}/videos/${encodeURIComponent(requestId)}`, (accessToken) => ({
      method: "GET",
      headers: xaiMediaHeaders(accessToken, sessionId),
      signal: AbortSignal.timeout(30_000),
    }));
    const raw = await readLimitedResponse(upstream, 256 * 1024);
    const text = new TextDecoder().decode(raw);
    if (!upstream.ok && upstream.status !== 202) return error(`Video poll failed with HTTP ${upstream.status}: ${[...text].slice(0, 200).join("")}`, upstream.status);
    const parsed = JSON.parse(text) as { status?: unknown; video?: { url?: unknown } };
    if (parsed.status === "failed") return error(`Video generation failed on the server (request_id=${requestId}): ${[...text].slice(0, 300).join("")}`, 502);
    if (parsed.status === "expired") return error(`Video generation request expired (request_id=${requestId}).`, 410);
    if (parsed.status !== "done") return json({ status: "pending" }, 202);
    const videoUrl = parsed.video?.url;
    if (typeof videoUrl !== "string" || !videoUrl) return error("Video generation completed but no download URL was returned.", 502);
    const url = new URL(videoUrl);
    if (url.protocol !== "https:" || url.username || url.password) return error("Video generation returned an unsafe download URL.", 502);
    const video = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    if (!video.ok) return error(`Video download failed (HTTP ${video.status})`, 502);
    const declared = Number.parseInt(video.headers.get("Content-Length") ?? "0", 10);
    if (Number.isFinite(declared) && declared > MAX_VIDEO_RESPONSE_BYTES) return error("Video response is too large.", 502);
    return new Response(boundedResponseStream(video, MAX_VIDEO_RESPONSE_BYTES), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "video/mp4",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (cause) {
    console.error("imagine_video_poll_failed", cause instanceof Error ? cause.message : "unknown");
    return error(cause instanceof Error ? cause.message : "Video polling failed.", 502);
  }
}

async function routeResponses(request: Request, env: Env): Promise<Response> {
  if (env.INFERENCE_ENABLED !== "true") return error("Grok inference is temporarily disabled.", 503);
  const sessionId = cookieValue(request.headers.get("Cookie"), SESSION_COOKIE);
  if (!validSessionId(sessionId)) return error("Connect a Grok subscription before running the agent.", 401);

  const ipHash = await sha256(clientIp(request));
  if (!(await requireEdgeLimit(env.CHAT_IP_RATE_LIMITER, ipHash))) {
    return error("This network has reached the per-minute Grok limit.", 429, 60);
  }

  const session = sessionStub(env, sessionId);
  let credentialResponse = await internalJson(session, "/credential");
  if (!credentialResponse.ok) return new Response(credentialResponse.body, credentialResponse);
  let credential = await credentialResponse.json<{ accessToken: string; userId: string; eligible: boolean }>();
  if (!credential.eligible) return error("This Grok account does not have an active eligible subscription.", 403);

  const userKey = await sha256(credential.userId);
  if (!(await requireEdgeLimit(env.CHAT_USER_RATE_LIMITER, userKey))) {
    return error("This Grok account has reached the per-minute agent limit.", 429, 60);
  }

  const requestKind: GrokRelayRequestKind = request.headers.get("x-browser-agent-request-kind") === "session-title"
    ? "session-title"
    : request.headers.get("x-browser-agent-request-kind") === "turn-summary"
      ? "turn-summary"
      : request.headers.get("x-browser-agent-request-kind") === "compaction" ? "compaction" : "main";
  const metadata = proxyMetadata(request);
  let body: Record<string, unknown>;
  try {
    body = normalizeGrokResponsesRequest(JSON.parse(await readLimitedBody(request)) as unknown, requestKind);
    if (requestKind === "main" && body.prompt_cache_key !== metadata.sessionId) {
      throw new Error("The prompt_cache_key must equal the relay session ID.");
    }
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : "Invalid request body.", 400);
  }

  const reservationId = crypto.randomUUID();
  const reservation = await internalJson(gateStub(env), "/acquire-chat", { userKey, reservationId });
  if (!reservation.ok) return new Response(reservation.body, reservation);

  const release = async (): Promise<void> => {
    await internalJson(gateStub(env), "/release-chat", { reservationId });
  };
  try {
    const requestBody = JSON.stringify(body);
    let upstream = await fetch(RESPONSES_URL, {
      method: "POST",
      headers: grokResponseHeaders(request, env, credential.accessToken, credential.userId, requestKind, String(body.model)),
      body: requestBody,
      signal: AbortSignal.timeout(120_000),
    });
    if (upstream.status === 401) {
      await upstream.body?.cancel().catch(() => undefined);
      credentialResponse = await internalJson(session, "/refresh", {});
      if (!credentialResponse.ok) return error("The Grok session expired. Sign in again.", 401);
      credential = await credentialResponse.json<{ accessToken: string; userId: string; eligible: boolean }>();
      upstream = await fetch(RESPONSES_URL, {
        method: "POST",
        headers: grokResponseHeaders(request, env, credential.accessToken, credential.userId, requestKind, String(body.model)),
        body: requestBody,
        signal: AbortSignal.timeout(120_000),
      });
    }
    const responseHeaders = new Headers({
      "Content-Type": upstream.headers.get("Content-Type") ?? "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    for (const name of ["x-grok-model", "x-request-id", "x-grok-context-window"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    if (!upstream.body) {
      await release();
      return new Response(null, { status: upstream.status, headers: responseHeaders });
    }
    return new Response(releaseAfterStream(upstream.body, release), {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (cause) {
    await release();
    console.error("grok_upstream_failed", cause instanceof Error ? cause.message : "unknown");
    return error("The Grok service did not complete the request.", 502);
  }
}

async function routeBootstrap(request: Request, env: Env, kind: GrokBootstrapKind): Promise<Response> {
  const sessionId = cookieValue(request.headers.get("Cookie"), SESSION_COOKIE);
  if (!validSessionId(sessionId)) return error("Connect a Grok subscription before loading Grok Build settings.", 401);
  const session = sessionStub(env, sessionId);
  let credentialResponse = await internalJson(session, "/credential");
  if (!credentialResponse.ok) return new Response(credentialResponse.body, credentialResponse);
  let credential = await credentialResponse.json<InternalCredential>();
  if (!credential.eligible) return error("This Grok account does not have an active eligible subscription.", 403);

  const userKey = await sha256(credential.userId);
  if (!(await requireEdgeLimit(env.CHAT_USER_RATE_LIMITER, `bootstrap:${userKey}`))) {
    return error("This Grok account has reached the per-minute startup limit.", 429, 60);
  }

  const upstreamUrl = `${CHAT_PROXY_ORIGIN}/v1/${kind}`;
  try {
    let upstream = await fetch(upstreamUrl, {
      headers: xaiBootstrapHeaders(env, credential, kind),
      signal: AbortSignal.timeout(5_000),
    });
    if (upstream.status === 401) {
      await upstream.body?.cancel().catch(() => undefined);
      credentialResponse = await internalJson(session, "/refresh", {});
      if (!credentialResponse.ok) return error("The Grok session expired. Sign in again.", 401);
      credential = await credentialResponse.json<InternalCredential>();
      upstream = await fetch(upstreamUrl, {
        headers: xaiBootstrapHeaders(env, credential, kind),
        signal: AbortSignal.timeout(5_000),
      });
    }
    const body = await readLimitedResponse(upstream, MAX_BOOTSTRAP_RESPONSE_BYTES);
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    const etag = upstream.headers.get("ETag");
    if (etag) headers.set("ETag", etag);
    return new Response(body.buffer as ArrayBuffer, { status: upstream.status, headers });
  } catch (cause) {
    console.error("grok_bootstrap_failed", kind, cause instanceof Error ? cause.message : "unknown");
    return error(`The Grok ${kind} request did not complete.`, 502);
  }
}

async function routeBundle(request: Request, env: Env, kind: GrokBundleKind): Promise<Response> {
  const sessionId = cookieValue(request.headers.get("Cookie"), SESSION_COOKIE);
  if (!validSessionId(sessionId)) return error("Connect a Grok subscription before loading the Grok Build bundle.", 401);
  const session = sessionStub(env, sessionId);
  let credentialResponse = await internalJson(session, "/credential");
  if (!credentialResponse.ok) return new Response(credentialResponse.body, credentialResponse);
  let credential = await credentialResponse.json<InternalCredential>();
  if (!credential.eligible) return error("This Grok account does not have an active eligible subscription.", 403);

  const userKey = await sha256(credential.userId);
  if (!(await requireEdgeLimit(env.CHAT_USER_RATE_LIMITER, `bootstrap:${userKey}`))) {
    return error("This Grok account has reached the per-minute startup limit.", 429, 60);
  }

  const path = kind === "archive" ? "bundle/archive" : "subagents/bundle";
  const timeout = kind === "archive" ? 30_000 : 10_000;
  try {
    let upstream = await fetch(`${CHAT_PROXY_ORIGIN}/v1/${path}`, {
      headers: xaiBundleHeaders(env, credential, kind),
      signal: AbortSignal.timeout(timeout),
    });
    if (upstream.status === 401) {
      await upstream.body?.cancel().catch(() => undefined);
      credentialResponse = await internalJson(session, "/refresh", {});
      if (!credentialResponse.ok) return error("The Grok session expired. Sign in again.", 401);
      credential = await credentialResponse.json<InternalCredential>();
      upstream = await fetch(`${CHAT_PROXY_ORIGIN}/v1/${path}`, {
        headers: xaiBundleHeaders(env, credential, kind),
        signal: AbortSignal.timeout(timeout),
      });
    }
    const body = await readLimitedResponse(upstream, MAX_BUNDLE_RESPONSE_BYTES);
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Content-Type": upstream.headers.get("Content-Type")
        ?? (kind === "archive" ? "application/gzip" : "application/json; charset=utf-8"),
      "X-Content-Type-Options": "nosniff",
    });
    return new Response(body.buffer as ArrayBuffer, { status: upstream.status, headers });
  } catch (cause) {
    console.error("grok_bundle_failed", kind, cause instanceof Error ? cause.message : "unknown");
    return error(`The Grok bundle ${kind} request did not complete.`, 502);
  }
}

async function routeTelemetry(request: Request, env: Env, route: GrokTelemetryRoute): Promise<Response> {
  const cookieSessionId = cookieValue(request.headers.get("Cookie"), SESSION_COOKIE);
  if (!validSessionId(cookieSessionId)) return error("Connect a Grok subscription before sending Grok telemetry.", 401);
  const ipHash = await sha256(clientIp(request));
  if (!(await requireEdgeLimit(env.CHAT_IP_RATE_LIMITER, `telemetry:${ipHash}`))) {
    return error("This network has reached the per-minute telemetry limit.", 429, 60);
  }
  const session = sessionStub(env, cookieSessionId);
  let credentialResponse = await internalJson(session, "/credential");
  if (!credentialResponse.ok) return new Response(credentialResponse.body, credentialResponse);
  let credential = await credentialResponse.json<InternalCredential>();
  if (!credential.eligible) return error("This Grok account does not have an active eligible subscription.", 403);
  const userKey = await sha256(credential.userId);
  if (!(await requireEdgeLimit(env.CHAT_USER_RATE_LIMITER, `telemetry:${userKey}`))) {
    return error("This Grok account has reached the per-minute telemetry limit.", 429, 60);
  }

  let body: Uint8Array | undefined;
  if (request.method === "POST") {
    const declared = Number.parseInt(request.headers.get("Content-Length") ?? "0", 10);
    if (Number.isFinite(declared) && declared > MAX_TELEMETRY_BYTES) return error("Telemetry payload is too large.", 413);
    body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength > MAX_TELEMETRY_BYTES) return error("Telemetry payload is too large.", 413);
    if (route.contentType === "application/json") {
      try {
        const value: unknown = JSON.parse(new TextDecoder().decode(body));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Telemetry payload must be a JSON object.");
      } catch (cause) {
        return error(cause instanceof Error ? cause.message : "Telemetry payload is invalid.", 400);
      }
    }
  }

  const upstreamUrl = `${CHAT_PROXY_ORIGIN}${route.upstreamPath}`;
  const makeRequest = (current: InternalCredential): RequestInit => {
    const traced = !route.upstreamPath.endsWith("/turn-deltas");
    const headers = new Headers({
      Authorization: `Bearer ${current.accessToken}`,
      Accept: "*/*",
      "X-XAI-Token-Auth": "xai-grok-cli",
      "x-grok-client-version": env.XAI_CLIENT_VERSION,
      "x-grok-client-mode": "headless",
      ...(traced ? { traceparent: createTraceparent(), tracestate: "" } : {}),
    });
    if (request.method === "POST") headers.set("Content-Type", route.contentType);
    if (route.upstreamPath === "/v1/traces") {
      headers.set("x-userid", current.userId);
      if (current.teamId) headers.set("x-teamid", current.teamId);
    }
    return {
      method: request.method,
      headers,
      ...(body ? { body: body.slice().buffer } : {}),
      signal: AbortSignal.timeout(15_000),
    };
  };

  try {
    let upstream = await fetch(upstreamUrl, makeRequest(credential));
    if (upstream.status === 401) {
      await upstream.body?.cancel().catch(() => undefined);
      credentialResponse = await internalJson(session, "/refresh", {});
      if (!credentialResponse.ok) return error("The Grok session expired. Sign in again.", 401);
      credential = await credentialResponse.json<InternalCredential>();
      upstream = await fetch(upstreamUrl, makeRequest(credential));
    }
    const responseBody = await readLimitedResponse(upstream, MAX_TELEMETRY_BYTES);
    return new Response(responseBody.buffer as ArrayBuffer, {
      status: upstream.status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": upstream.headers.get("Content-Type") ?? (route.contentType === "application/json" ? "application/json; charset=utf-8" : "application/x-protobuf"),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (cause) {
    console.error("grok_telemetry_failed", route.upstreamPath, cause instanceof Error ? cause.message : "unknown");
    return error("The Grok telemetry request did not complete.", 502);
  }
}

function releaseAfterStream(stream: ReadableStream<Uint8Array>, release: () => Promise<void>): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let released = false;
  const finish = async (): Promise<void> => {
    if (released) return;
    released = true;
    await release();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          await finish();
        } else {
          controller.enqueue(value);
        }
      } catch (cause) {
        controller.error(cause);
        await finish();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      await finish();
    },
  });
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const mutation = request.method !== "GET" && request.method !== "HEAD";
  if (mutation && !isTrustedMutation(request)) return error("Cross-origin requests are not allowed.", 403);
  const telemetryRoute = normalizeGrokTelemetryRoute(url.pathname, request.method);
  const expectedContentType = telemetryRoute?.contentType ?? "application/json";
  if (mutation && request.headers.get("Content-Type")?.split(";", 1)[0] !== expectedContentType) {
    return error(`Requests must use ${expectedContentType}.`, 415);
  }

  if (url.pathname === "/api/auth/device/start" && request.method === "POST") return routeDeviceStart(request, env);
  if (url.pathname === "/api/auth/device/poll" && request.method === "POST") return routeSession(request, env, "poll");
  if (url.pathname === "/api/auth/status" && request.method === "GET") return routeSession(request, env, "status");
  if (url.pathname === "/api/auth/logout" && request.method === "POST") return routeSession(request, env, "logout");
  if (url.pathname === "/api/grok/models" && request.method === "GET") return routeBootstrap(request, env, "models");
  if (url.pathname === "/api/grok/settings" && request.method === "GET") return routeBootstrap(request, env, "settings");
  if (url.pathname === "/api/grok/bundle/archive" && request.method === "GET") return routeBundle(request, env, "archive");
  if (url.pathname === "/api/grok/subagents/bundle" && request.method === "GET") return routeBundle(request, env, "legacy");
  if (url.pathname === "/api/grok/responses" && request.method === "POST") return routeResponses(request, env);
  if (url.pathname === "/api/grok/web-fetch" && request.method === "POST") return routeWebFetch(request, env);
  if (url.pathname === "/api/grok/media/image" && request.method === "POST") return routeImageMedia(request, env);
  if (url.pathname === "/api/grok/media/video/start" && request.method === "POST") return routeVideoStart(request, env);
  if (url.pathname === "/api/grok/media/video/poll" && request.method === "POST") return routeVideoPoll(request, env);
  if (telemetryRoute) return routeTelemetry(request, env, telemetryRoute);
  return error("API route not found.", 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

export class GrokSession implements DurableObject {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  private async encryptionKey(): Promise<CryptoKey> {
    const raw = fromBase64Url(this.env.SESSION_ENCRYPTION_KEY);
    if (raw.byteLength !== 32) throw new Error("SESSION_ENCRYPTION_KEY must encode exactly 32 bytes.");
    return crypto.subtle.importKey("raw", raw.buffer as ArrayBuffer, "AES-GCM", false, ["encrypt", "decrypt"]);
  }

  private async load(): Promise<SessionState> {
    const envelope = await this.state.storage.get<string>("session");
    if (!envelope) return {};
    const [version, ivValue, ciphertextValue] = envelope.split(".");
    if (version !== "v1" || !ivValue || !ciphertextValue) throw new Error("Invalid encrypted session state.");
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64Url(ivValue).buffer as ArrayBuffer,
        additionalData: new TextEncoder().encode(this.state.id.toString()),
      },
      await this.encryptionKey(),
      fromBase64Url(ciphertextValue).buffer as ArrayBuffer,
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as SessionState;
  }

  private async save(value: SessionState): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(this.state.id.toString()) },
      await this.encryptionKey(),
      plaintext,
    );
    await this.state.storage.put("session", `v1.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`);
    await this.state.storage.setAlarm(Date.now() + SESSION_ALARM_MS);
  }

  private async fetchUser(accessToken: string, fallback: { userId?: string; email?: string }): Promise<Partial<CredentialState>> {
    try {
      const response = await fetch(USER_URL, {
        headers: xaiProxyHeaders(this.env, accessToken),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return fallback;
      const user = await response.json<Record<string, unknown>>();
      const userId = stringValue(user.userId) ?? fallback.userId;
      const email = stringValue(user.email) ?? fallback.email;
      const subscriptionTier = stringValue(user.subscriptionTier);
      const teamId = stringValue(user.teamId) ?? stringValue(user.team_id)
        ?? (user.team && typeof user.team === "object" && !Array.isArray(user.team)
          ? stringValue((user.team as Record<string, unknown>).id)
          : undefined);
      return {
        ...(userId ? { userId } : {}),
        ...(email ? { email } : {}),
        ...(subscriptionTier ? { subscriptionTier } : {}),
        ...(teamId ? { teamId } : {}),
      };
    } catch {
      return fallback;
    }
  }

  private async exchange(params: URLSearchParams): Promise<{ response: Response; tokens?: TokenResponse }> {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: xaiOAuthHeaders(this.env),
      body: params,
      signal: AbortSignal.timeout(15_000),
    });
    const tokens = await response.json<TokenResponse>().catch(() => ({}));
    return { response, tokens };
  }

  private async refresh(session: SessionState): Promise<CredentialState | undefined> {
    const current = session.credential;
    if (!current?.refreshToken) return undefined;
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: this.env.XAI_OAUTH_CLIENT_ID,
    });
    const { response, tokens } = await this.exchange(params);
    const accessToken = stringValue(tokens?.access_token);
    if (!response.ok || !accessToken) return undefined;
    const expiresIn = numberValue(tokens?.expires_in);
    const refreshToken = stringValue(tokens?.refresh_token) ?? current.refreshToken;
    const credential: CredentialState = {
      ...current,
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(expiresIn ? { expiresAt: Date.now() + expiresIn * 1_000 } : {}),
    };
    session.credential = credential;
    await this.save(session);
    return credential;
  }

  private safeCredential(credential: CredentialState): InternalCredential {
    return {
      accessToken: credential.accessToken,
      userId: credential.userId,
      ...(credential.email ? { email: credential.email } : {}),
      eligible: Boolean(credential.subscriptionTier && credential.subscriptionTier !== "Free"),
      ...(credential.subscriptionTier ? { subscriptionTier: credential.subscriptionTier } : {}),
      ...(credential.teamId ? { teamId: credential.teamId } : {}),
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/device/start" && request.method === "POST") {
      const params = new URLSearchParams({
        client_id: this.env.XAI_OAUTH_CLIENT_ID,
        scope: OAUTH_SCOPES,
        referrer: "vibewaiting-browser",
      });
      try {
        const response = await fetch(DEVICE_URL, {
          method: "POST",
          headers: xaiOAuthHeaders(this.env),
          body: params,
          signal: AbortSignal.timeout(15_000),
        });
        const payload: Record<string, unknown> = await response.json<Record<string, unknown>>().catch(() => ({}));
        if (!response.ok) return error("xAI did not start the device sign-in flow.", 502);
        const deviceCode = stringValue(payload.device_code);
        const userCode = stringValue(payload.user_code);
        const verificationUri = stringValue(payload.verification_uri);
        const verificationUriComplete = stringValue(payload.verification_uri_complete);
        const expiresIn = numberValue(payload.expires_in) ?? 600;
        const intervalSeconds = Math.max(1, numberValue(payload.interval) ?? 5);
        if (!deviceCode || !userCode || !verificationUri || !/^[A-Z0-9-]+$/u.test(userCode)) {
          return error("xAI returned an invalid device sign-in response.", 502);
        }
        for (const candidate of [verificationUri, verificationUriComplete]) {
          if (candidate && new URL(candidate).protocol !== "https:") return error("xAI returned an unsafe sign-in URL.", 502);
        }
        const now = Date.now();
        const device: DeviceState = {
          deviceCode,
          userCode,
          verificationUri,
          ...(verificationUriComplete ? { verificationUriComplete } : {}),
          expiresAt: now + expiresIn * 1_000,
          intervalSeconds,
          nextPollAt: now + intervalSeconds * 1_000,
        };
        await this.save({ device });
        return json({
          status: "pending",
          userCode,
          verificationUri,
          verificationUriComplete: verificationUriComplete ?? null,
          expiresAt: device.expiresAt,
          intervalSeconds,
        });
      } catch (cause) {
        console.error("device_start_failed", cause instanceof Error ? cause.message : "unknown");
        return error("xAI device sign-in is temporarily unavailable.", 502);
      }
    }

    if (url.pathname === "/poll" && request.method === "POST") {
      const session = await this.load();
      const device = session.device;
      if (!device) return error("No device sign-in is pending.", 409);
      const now = Date.now();
      if (now >= device.expiresAt) return error("The device sign-in code expired.", 410);
      if (now < device.nextPollAt) return error("Wait before checking sign-in again.", 429, Math.ceil((device.nextPollAt - now) / 1_000));
      device.nextPollAt = now + device.intervalSeconds * 1_000;
      await this.save(session);
      const params = new URLSearchParams({
        grant_type: DEVICE_GRANT,
        device_code: device.deviceCode,
        client_id: this.env.XAI_OAUTH_CLIENT_ID,
      });
      const { response, tokens } = await this.exchange(params);
      if (!response.ok) {
        const code = stringValue(tokens?.error);
        if (code === "authorization_pending") return json({ status: "pending", intervalSeconds: device.intervalSeconds }, 202);
        if (code === "slow_down") {
          device.intervalSeconds += 5;
          device.nextPollAt = Date.now() + device.intervalSeconds * 1_000;
          await this.save(session);
          return json({ status: "pending", intervalSeconds: device.intervalSeconds }, 202);
        }
        if (code === "access_denied") return error("The xAI sign-in request was denied.", 403);
        if (code === "expired_token") return error("The device sign-in code expired.", 410);
        return error("xAI did not complete device sign-in.", 502);
      }
      const accessToken = stringValue(tokens?.access_token);
      if (!accessToken) return error("xAI returned no access token.", 502);
      const fallback = decodeJwtIdentity(stringValue(tokens?.id_token));
      const identity = await this.fetchUser(accessToken, fallback);
      if (!identity.userId) return error("xAI returned no stable account identity.", 502);
      const expiresIn = numberValue(tokens?.expires_in);
      const refreshToken = stringValue(tokens?.refresh_token);
      const credential: CredentialState = {
        accessToken,
        userId: identity.userId,
        ...(refreshToken ? { refreshToken } : {}),
        ...(expiresIn ? { expiresAt: Date.now() + expiresIn * 1_000 } : {}),
        ...(identity.email ? { email: identity.email } : {}),
        ...(identity.subscriptionTier ? { subscriptionTier: identity.subscriptionTier } : {}),
        ...(identity.teamId ? { teamId: identity.teamId } : {}),
      };
      await this.save({ credential });
      return json({
        status: "authenticated",
        email: credential.email ?? null,
        subscriptionTier: credential.subscriptionTier ?? null,
        eligible: Boolean(credential.subscriptionTier && credential.subscriptionTier !== "Free"),
      });
    }

    if (url.pathname === "/status" && request.method === "GET") {
      const session = await this.load();
      const credential = session.credential;
      if (!credential) return json({ authenticated: false });
      return json({
        authenticated: true,
        email: credential.email ?? null,
        subscriptionTier: credential.subscriptionTier ?? null,
        eligible: Boolean(credential.subscriptionTier && credential.subscriptionTier !== "Free"),
      });
    }

    if ((url.pathname === "/credential" || url.pathname === "/refresh") && (request.method === "GET" || request.method === "POST")) {
      const session = await this.load();
      let credential = session.credential;
      if (!credential) return error("The Grok session is not authenticated.", 401);
      if (url.pathname === "/refresh" || (credential.expiresAt && credential.expiresAt <= Date.now() + 60_000)) {
        credential = await this.refresh(session);
        if (!credential) return error("The Grok session could not be refreshed.", 401);
      }
      return json(this.safeCredential(credential));
    }

    if (url.pathname === "/logout" && request.method === "POST") {
      await this.state.storage.deleteAll();
      return json({ authenticated: false });
    }
    return error("Session route not found.", 404);
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}

export class RateGate implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  private currentDay(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private async load(): Promise<GateState> {
    const current = await this.state.storage.get<GateState>("gate");
    const day = this.currentDay();
    if (current?.day === day) return current;
    return {
      day,
      globalChats: 0,
      userChats: {},
      reservations: {},
      authStarts: 0,
      authStartsByIp: {},
      globalMediaStarts: 0,
      userMediaStarts: {},
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body: Record<string, unknown> = request.method === "POST"
      ? await request.json<Record<string, unknown>>().catch(() => ({}))
      : {};
    const gate = await this.load();
    gate.globalMediaStarts ??= 0;
    gate.userMediaStarts ??= {};
    const now = Date.now();
    gate.reservations = Object.fromEntries(Object.entries(gate.reservations).filter(([, lease]) => lease.expiresAt > now));

    if (url.pathname === "/auth-start") {
      const ipKey = stringValue(body.ipKey);
      if (!ipKey) return error("Invalid authentication limiter key.", 400);
      const ipCount = gate.authStartsByIp[ipKey] ?? 0;
      if (gate.authStarts >= AUTH_START_DAILY_GLOBAL_LIMIT || ipCount >= AUTH_START_DAILY_IP_LIMIT) {
        return error("The daily sign-in safety limit has been reached.", 429, 3600);
      }
      gate.authStarts += 1;
      gate.authStartsByIp[ipKey] = ipCount + 1;
      await this.state.storage.put("gate", gate);
      return json({ allowed: true });
    }

    if (url.pathname === "/acquire-chat") {
      const userKey = stringValue(body.userKey);
      const reservationId = stringValue(body.reservationId);
      if (!userKey || !reservationId) return error("Invalid rate reservation.", 400);
      const userCount = gate.userChats[userKey] ?? 0;
      const leases = Object.values(gate.reservations);
      const userConcurrency = leases.filter((lease) => lease.userKey === userKey).length;
      if (gate.globalChats >= GLOBAL_DAILY_CHAT_LIMIT) return error("The service-wide daily Grok limit has been reached.", 429, 3600);
      if (userCount >= USER_DAILY_CHAT_LIMIT) return error("This Grok account has reached its daily agent limit.", 429, 3600);
      if (leases.length >= GLOBAL_CONCURRENCY_LIMIT) return error("The Grok relay is at its concurrency limit. Try again shortly.", 429, 10);
      if (userConcurrency >= USER_CONCURRENCY_LIMIT) return error("This Grok account already has an agent request running.", 429, 10);
      gate.globalChats += 1;
      gate.userChats[userKey] = userCount + 1;
      gate.reservations[reservationId] = { userKey, expiresAt: now + RESERVATION_LEASE_MS };
      await this.state.storage.put("gate", gate);
      return json({ allowed: true, userRemaining: USER_DAILY_CHAT_LIMIT - userCount - 1, globalRemaining: GLOBAL_DAILY_CHAT_LIMIT - gate.globalChats });
    }

    if (url.pathname === "/acquire-media") {
      const userKey = stringValue(body.userKey);
      if (!userKey) return error("Invalid media limiter key.", 400);
      const userCount = gate.userMediaStarts[userKey] ?? 0;
      if (gate.globalMediaStarts >= GLOBAL_DAILY_MEDIA_LIMIT) return error("The service-wide daily Imagine relay limit has been reached.", 429, 3600);
      if (userCount >= USER_DAILY_MEDIA_LIMIT) return error("This Grok account has reached its daily Imagine relay limit.", 429, 3600);
      gate.globalMediaStarts += 1;
      gate.userMediaStarts[userKey] = userCount + 1;
      await this.state.storage.put("gate", gate);
      return json({
        allowed: true,
        userRemaining: USER_DAILY_MEDIA_LIMIT - userCount - 1,
        globalRemaining: GLOBAL_DAILY_MEDIA_LIMIT - gate.globalMediaStarts,
      });
    }

    if (url.pathname === "/release-chat") {
      const reservationId = stringValue(body.reservationId);
      if (reservationId) delete gate.reservations[reservationId];
      await this.state.storage.put("gate", gate);
      return json({ released: true });
    }
    return error("Rate gate route not found.", 404);
  }
}

export const SECURITY_LIMITS = {
  maxAgentSteps: MAX_AGENT_STEPS,
  globalDailyChats: GLOBAL_DAILY_CHAT_LIMIT,
  userDailyChats: USER_DAILY_CHAT_LIMIT,
  globalConcurrency: GLOBAL_CONCURRENCY_LIMIT,
  userConcurrency: USER_CONCURRENCY_LIMIT,
  globalDailyMediaStarts: GLOBAL_DAILY_MEDIA_LIMIT,
  userDailyMediaStarts: USER_DAILY_MEDIA_LIMIT,
} as const;
