export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
export const MAX_INPUT_ITEMS = 2_000;
export const MAX_TOOLS = 64;
export const MAX_REQUEST_TEXT_CHARS = 6_000_000;
export const MAX_AGENT_STEPS = 100;
export const MAX_WEB_FETCH_URL_BYTES = 2_000;
export const MAX_WEB_FETCH_BYTES = 10 * 1024 * 1024;
export const MAX_WEB_FETCH_REDIRECTS = 10;
export const MAX_MANAGED_MCP_CALL_ID_CHARS = 256;
export const MAX_MANAGED_MCP_CATALOG_CALL_IDS = 256;
export const MAX_MEDIA_PROMPT_CHARS = 20_000;
export const MAX_MEDIA_REFERENCE_CHARS = 11 * 1024 * 1024;

const WEB_FETCH_DOMAINS = [
  "x.ai", "console.x.ai", "docs.x.ai", "api.x.ai",
  "docs.python.org", "en.cppreference.com", "docs.oracle.com", "learn.microsoft.com",
  "developer.mozilla.org", "go.dev", "pkg.go.dev", "www.php.net", "docs.swift.org",
  "kotlinlang.org", "ruby-doc.org", "doc.rust-lang.org", "docs.rs", "www.typescriptlang.org",
  "react.dev", "angular.io", "vuejs.org", "nextjs.org", "expressjs.com", "nodejs.org",
  "bun.sh", "jquery.com", "getbootstrap.com", "tailwindcss.com", "d3js.org", "threejs.org",
  "redux.js.org", "webpack.js.org", "jestjs.io", "reactrouter.com", "docs.djangoproject.com",
  "flask.palletsprojects.com", "fastapi.tiangolo.com", "pandas.pydata.org", "numpy.org",
  "www.tensorflow.org", "pytorch.org", "scikit-learn.org", "matplotlib.org",
  "requests.readthedocs.io", "jupyter.org", "laravel.com", "symfony.com", "wordpress.org",
  "docs.spring.io", "hibernate.org", "tomcat.apache.org", "gradle.org", "maven.apache.org",
  "asp.net", "dotnet.microsoft.com", "nuget.org", "blazor.net", "reactnative.dev",
  "docs.flutter.dev", "developer.apple.com", "developer.android.com", "keras.io",
  "spark.apache.org", "huggingface.co", "www.kaggle.com", "redis.io", "www.postgresql.org",
  "dev.mysql.com", "www.sqlite.org", "graphql.org", "prisma.io", "docs.aws.amazon.com",
  "cloud.google.com", "kubernetes.io", "www.docker.com", "www.terraform.io", "www.ansible.com",
  "vercel.com/docs", "docs.netlify.com", "devcenter.heroku.com", "cypress.io", "selenium.dev",
  "docs.unity.com", "docs.unrealengine.com", "git-scm.com", "nginx.org", "httpd.apache.org",
] as const;

export type GrokRelayRequestKind = "main" | "session-title" | "turn-summary" | "compaction";
export type GrokTelemetryRoute =
  | { upstreamPath: "/v1/feedback/config"; contentType: "application/json" }
  | { upstreamPath: `/v1/sessions/${string}/signals`; contentType: "application/json" }
  | { upstreamPath: `/v1/sessions/${string}/turn-deltas`; contentType: "application/json" }
  | { upstreamPath: "/v1/traces"; contentType: "application/x-protobuf" };
type JsonObject = Record<string, unknown>;

export type GrokImageMediaRequest =
  | { kind: "generate"; prompt: string; aspectRatio: string }
  | { kind: "edit"; prompt: string; aspectRatio: string; images: string[] };

export interface GrokMediaModelOverrides {
  imageGen?: string;
  imageEdit?: string;
}

export interface GrokWebFetchRemotePolicy {
  allowedDomains?: string[];
  proxyEndpoint?: string;
}

export interface GrokRelayRemoteSettings {
  mediaModels: GrokMediaModelOverrides;
  webFetch: GrokWebFetchRemotePolicy;
}

export interface GrokManagedMcpCallRequest {
  call_id: string;
  arguments: Record<string, unknown>;
}

export type GrokVideoMediaRequest =
  | { kind: "image-to-video"; prompt: string; duration: 6 | 10; resolution: "480p" | "720p"; image: string }
  | {
      kind: "reference-to-video";
      prompt: string;
      duration: number;
      aspectRatio: string;
      resolution: "480p" | "720p";
      images: string[];
      voices: string[];
    };

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Extract only bounded opaque call IDs from the authenticated xAI catalog. */
export function managedMcpCatalogCallIds(value: unknown): string[] {
  if (!isObject(value) || !Array.isArray(value.tools)) return [];
  const ids: string[] = [];
  for (const tool of value.tools) {
    if (!isObject(tool) || typeof tool.call_id !== "string"
      || tool.call_id.length === 0 || tool.call_id.length > MAX_MANAGED_MCP_CALL_ID_CHARS
      || /[\u0000-\u001f\u007f]/u.test(tool.call_id)) continue;
    if (!ids.includes(tool.call_id)) ids.push(tool.call_id);
    if (ids.length >= MAX_MANAGED_MCP_CATALOG_CALL_IDS) break;
  }
  return ids;
}

/** Browser input is constrained to a call ID issued by xAI for this session. */
export function normalizeGrokManagedMcpCallRequest(
  value: unknown,
  allowedCallIds: readonly string[],
): GrokManagedMcpCallRequest {
  if (!isObject(value) || Object.keys(value).some((key) => key !== "call_id" && key !== "arguments")) {
    throw new Error("Managed MCP call must contain only call_id and arguments.");
  }
  if (typeof value.call_id !== "string" || !allowedCallIds.includes(value.call_id)) {
    throw new Error("Managed MCP call_id was not issued in this session's catalog.");
  }
  if (!isObject(value.arguments)) throw new Error("Managed MCP arguments must be a JSON object.");
  return { call_id: value.call_id, arguments: structuredClone(value.arguments) };
}

/** Native ignores empty string overrides and otherwise uses the remote slug verbatim. */
export function parseGrokMediaModelOverrides(value: unknown): GrokMediaModelOverrides {
  if (!isObject(value)) return {};
  const imageGen = typeof value.image_gen_model_override === "string"
    && value.image_gen_model_override.length > 0
    && value.image_gen_model_override.length <= 256
    ? value.image_gen_model_override : undefined;
  const imageEdit = typeof value.image_edit_model_override === "string"
    && value.image_edit_model_override.length > 0
    && value.image_edit_model_override.length <= 256
    ? value.image_edit_model_override : undefined;
  return {
    ...(imageGen ? { imageGen } : {}),
    ...(imageEdit ? { imageEdit } : {}),
  };
}

/** Sanitizes the remote settings that affect relay-owned behavior. */
export function parseGrokRelayRemoteSettings(value: unknown): GrokRelayRemoteSettings {
  const record = isObject(value) ? value : {};
  const allowedDomains = Array.isArray(record.web_fetch_allowed_domains)
    && record.web_fetch_allowed_domains.length <= 256
    && record.web_fetch_allowed_domains.every((entry) => typeof entry === "string" && entry.length <= 512)
    ? [...record.web_fetch_allowed_domains] as string[] : undefined;
  const proxyEndpoint = typeof record.web_fetch_proxy === "string"
    && record.web_fetch_proxy.length > 0
    && record.web_fetch_proxy.length <= MAX_WEB_FETCH_URL_BYTES
    ? record.web_fetch_proxy : undefined;
  return {
    mediaModels: parseGrokMediaModelOverrides(record),
    webFetch: {
      ...(allowedDomains ? { allowedDomains } : {}),
      ...(proxyEndpoint ? { proxyEndpoint } : {}),
    },
  };
}

export function grokImageMediaModel(overrides: GrokMediaModelOverrides, kind: GrokImageMediaRequest["kind"]): string {
  return (kind === "generate" ? overrides.imageGen : overrides.imageEdit) ?? "grok-imagine-image-quality";
}

const IMAGE_ASPECT_RATIOS = new Set([
  "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2",
  "19.5:9", "9:19.5", "20:9", "9:20", "auto",
]);
const VIDEO_ASPECT_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]);

function exactKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !accepted.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
}

function mediaString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw new Error(`${field} must be a${allowEmpty ? "" : " non-empty"} string`);
  if (field === "prompt" && value.length > MAX_MEDIA_PROMPT_CHARS) throw new Error(`prompt exceeds ${MAX_MEDIA_PROMPT_CHARS} characters`);
  return value;
}

function mediaReference(value: unknown): string {
  const reference = mediaString(value, "image reference");
  if (reference.length > MAX_MEDIA_REFERENCE_CHARS) throw new Error("image reference is too large");
  if (reference.startsWith("https://")) {
    const url = new URL(reference);
    if (url.username || url.password) throw new Error("image reference URLs containing credentials are not allowed");
    return reference;
  }
  if (!/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]*={0,2}$/iu.test(reference)) {
    throw new Error("image reference must be an HTTPS URL or base64 image data URL");
  }
  return reference;
}

function mediaReferences(value: unknown, field: string, maximum?: number): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (maximum !== undefined && value.length > maximum) throw new Error(`${field} must contain at most ${maximum} entries`);
  return value.map(mediaReference);
}

function mediaDuration(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`duration must be a whole number between ${minimum} and ${maximum}`);
  }
  return value;
}

/** Strict native Imagine request envelope accepted by the credential relay. */
export function normalizeImageMediaRequest(value: unknown): GrokImageMediaRequest {
  if (!isObject(value)) throw new Error("image generation requires a JSON object");
  const kind = value.kind;
  const prompt = mediaString(value.prompt, "prompt", true);
  const aspectRatio = mediaString(value.aspectRatio, "aspectRatio");
  if (!IMAGE_ASPECT_RATIOS.has(aspectRatio)) throw new Error("unsupported image aspect ratio");
  if (kind === "generate") {
    exactKeys(value, ["kind", "prompt", "aspectRatio"], "image generation request");
    return { kind, prompt, aspectRatio };
  }
  if (kind === "edit") {
    exactKeys(value, ["kind", "prompt", "aspectRatio", "images"], "image edit request");
    const images = mediaReferences(value.images, "images");
    if (images.length === 0) throw new Error("image edit requires at least one reference image");
    return { kind, prompt, aspectRatio, images };
  }
  throw new Error("unsupported image generation kind");
}

/** Strict native video-start envelope accepted by the credential relay. */
export function normalizeVideoMediaRequest(value: unknown): GrokVideoMediaRequest {
  if (!isObject(value)) throw new Error("video generation requires a JSON object");
  const kind = value.kind;
  const prompt = mediaString(value.prompt, "prompt", true);
  const resolution = value.resolution;
  if (resolution !== "480p" && resolution !== "720p") throw new Error("resolution must be 480p or 720p");
  if (kind === "image-to-video") {
    exactKeys(value, ["kind", "prompt", "duration", "resolution", "image"], "image-to-video request");
    const duration = mediaDuration(value.duration, 6, 10);
    if (duration !== 6 && duration !== 10) throw new Error("image-to-video duration must be 6 or 10 seconds");
    return { kind, prompt, duration, resolution, image: mediaReference(value.image) };
  }
  if (kind === "reference-to-video") {
    exactKeys(value, ["kind", "prompt", "duration", "aspectRatio", "resolution", "images", "voices"], "reference-to-video request");
    if (!prompt.trim()) throw new Error("prompt must not be empty");
    const duration = mediaDuration(value.duration, 1, 15);
    const aspectRatio = mediaString(value.aspectRatio, "aspectRatio");
    if (!VIDEO_ASPECT_RATIOS.has(aspectRatio)) throw new Error("unsupported video aspect ratio");
    const images = mediaReferences(value.images, "images", 7);
    if (!Array.isArray(value.voices) || value.voices.length > 3 || value.voices.some((voice) => typeof voice !== "string" || !voice.trim())) {
      throw new Error("voices must contain at most 3 non-empty voice identifiers");
    }
    const voices = value.voices as string[];
    if (images.length === 0 && voices.length === 0) throw new Error("at least one image or voice reference is required");
    return { kind, prompt, duration, aspectRatio, resolution, images, voices };
  }
  throw new Error("unsupported video generation kind");
}

function countText(value: unknown, depth = 0): number {
  if (depth > 32) throw new Error("The Responses request is too deeply nested.");
  if (typeof value === "string") return value.length;
  if (value === null || typeof value === "number" || typeof value === "boolean") return 0;
  if (Array.isArray(value)) return value.reduce((total, item) => total + countText(item, depth + 1), 0);
  if (isObject(value)) return Object.entries(value).reduce((total, [key, item]) => total + key.length + countText(item, depth + 1), 0);
  throw new Error("Responses requests may contain JSON values only.");
}

/** Enforce the native Grok Build Responses envelope without rewriting it. */
export function normalizeGrokResponsesRequest(
  value: unknown,
  requestKind: GrokRelayRequestKind = "main",
): JsonObject {
  if (!isObject(value)) throw new Error("The Grok relay request must be a JSON object.");
  const allowed = new Set([
    "include", "input", "max_output_tokens", "model", "prompt_cache_key", "reasoning",
    "store", "stream", "temperature", "text", "tool_choice", "tools", "top_p",
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Unsupported Grok Responses fields: ${unknown.join(", ")}.`);
  const modelAllowed = requestKind === "session-title"
    ? value.model === "grok-4.6"
    : value.model === "grok-4.6" || value.model === "grok-4.5";
  if (!modelAllowed || value.store !== false || value.stream !== true) {
    throw new Error("The Grok relay permits only the pinned streaming Grok Build Responses profile.");
  }
  if (!Array.isArray(value.include) || value.include.length !== 1 || value.include[0] !== "reasoning.encrypted_content") {
    throw new Error("The Grok relay requires encrypted reasoning replay.");
  }
  if (!Array.isArray(value.input) || value.input.length === 0 || value.input.length > MAX_INPUT_ITEMS) {
    throw new Error(`The Grok relay requires between 1 and ${MAX_INPUT_ITEMS.toLocaleString()} input items.`);
  }
  if (!isObject(value.reasoning) || value.reasoning.summary !== "concise") {
    throw new Error("The Grok relay requires the native concise reasoning summary profile.");
  }
  if (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.length > MAX_TOOLS)) {
    throw new Error(`The Grok relay permits at most ${MAX_TOOLS} tools.`);
  }
  if (countText(value) > MAX_REQUEST_TEXT_CHARS) {
    throw new Error(`Responses request text exceeds ${MAX_REQUEST_TEXT_CHARS.toLocaleString()} characters.`);
  }

  if (requestKind === "session-title") {
    if ("prompt_cache_key" in value) throw new Error("A session-title request must not contain prompt_cache_key.");
    if (value.max_output_tokens !== 100 || value.temperature !== 1) {
      throw new Error("A session-title request must use the native title sampling profile.");
    }
    const tools = value.tools;
    if (!Array.isArray(tools) || tools.length !== 1 || !isObject(tools[0]) || tools[0].name !== "session_title") {
      throw new Error("A session-title request must contain only the session_title tool.");
    }
  } else if (typeof value.prompt_cache_key !== "string" || value.prompt_cache_key.length === 0) {
    throw new Error("A foreground Grok request requires prompt_cache_key.");
  }
  if (requestKind === "compaction" && (value.temperature !== 1 || value.tool_choice !== "auto")) {
    throw new Error("A compaction request must use the native temperature and tool-choice profile.");
  }
  return structuredClone(value);
}

export function isTrustedMutation(request: Request): boolean {
  const target = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin !== target.origin || origin === "null") return false;
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  return fetchSite === null || fetchSite === "same-origin";
}

export function cookieValue(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const entry of cookieHeader.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    if (entry.slice(0, separator).trim() === name) return entry.slice(separator + 1).trim();
  }
  return undefined;
}

export function validSessionId(value: string | undefined): value is string {
  return Boolean(value && /^[A-Za-z0-9_-]{43}$/u.test(value));
}

export function validUuid(value: string | null): string | undefined {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ? value
    : undefined;
}

export function validGrokRequestId(value: string | null): string | undefined {
  if (validUuid(value)) return value ?? undefined;
  for (const prefix of ["task-completed-", "subagent-completed-", "scheduler-fired-", "notifications-"] as const) {
    if (value?.startsWith(prefix) && validUuid(value.slice(prefix.length))) return value;
  }
  if (/^workflow-completed-wf_[0-9a-f]{32}-\d+$/iu.test(value ?? "")) return value ?? undefined;
  if (/^plan-resume-\d{13}$/u.test(value ?? "")) return value ?? undefined;
  return undefined;
}

/** Fixed xAI telemetry surface; no arbitrary upstream path can cross the relay. */
export function normalizeGrokTelemetryRoute(pathname: string, method: string): GrokTelemetryRoute | undefined {
  if (method === "GET" && pathname === "/api/grok/feedback/config") {
    return { upstreamPath: "/v1/feedback/config", contentType: "application/json" };
  }
  if (method === "POST" && pathname === "/api/grok/traces") {
    return { upstreamPath: "/v1/traces", contentType: "application/x-protobuf" };
  }
  if (method !== "POST") return;
  const match = pathname.match(/^\/api\/grok\/sessions\/([^/]+)\/(signals|turn-deltas)$/u);
  const sessionId = validUuid(match?.[1] ?? null);
  if (!sessionId || (match?.[2] !== "signals" && match?.[2] !== "turn-deltas")) return;
  return {
    upstreamPath: `/v1/sessions/${sessionId}/${match[2]}`,
    contentType: "application/json",
  };
}

export function positiveTurn(value: string | null): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_AGENT_STEPS ? parsed : 1;
}

function normalizedWebFetchHost(host: string): string {
  const lower = host.trim().replace(/\.+$/u, "").toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

/** Native web_fetch URL upgrade and default domain policy, before any network I/O. */
function normalizeWebFetchUrlWithPolicy(raw: unknown, enforceDomain: boolean, allowedDomains: readonly string[] = WEB_FETCH_DOMAINS): URL {
  if (typeof raw !== "string" || raw.length === 0) throw new Error("url must be a non-empty string");
  if (new TextEncoder().encode(raw).length > MAX_WEB_FETCH_URL_BYTES) {
    throw new Error(`URL exceeds maximum length of ${MAX_WEB_FETCH_URL_BYTES}`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme: ${url.protocol.replace(/:$/u, "")}`);
  }
  if (url.username || url.password) throw new Error("URLs containing credentials are not allowed");
  if (!url.hostname.includes(".")) throw new Error(`Single-label hostname is not allowed: ${url.hostname}`);
  if (url.protocol === "http:") url.protocol = "https:";
  const host = normalizedWebFetchHost(url.hostname);
  if (blockedWebFetchHost(host)) throw new Error(`web_fetch host is not public: ${host}`);
  if (!enforceDomain) return url;
  const matching = allowedDomains.find((entry) => {
    const slash = entry.indexOf("/");
    const allowedHost = normalizedWebFetchHost(slash < 0 ? entry : entry.slice(0, slash));
    if (host !== allowedHost) return false;
    if (slash < 0) return true;
    const prefix = entry.slice(slash).replace(/\/+$/u, "").toLowerCase();
    const path = url.pathname.toLowerCase();
    return path === prefix || path.startsWith(`${prefix}/`);
  });
  if (!matching) throw new Error(`domain ${host} is not in the allowed domains list`);
  return url;
}

export function normalizeWebFetchUrl(raw: unknown, allowedDomains?: readonly string[]): URL {
  return normalizeWebFetchUrlWithPolicy(raw, true, allowedDomains);
}

export function normalizeWebFetchRedirectUrl(raw: unknown): URL {
  return normalizeWebFetchUrlWithPolicy(raw, false);
}

export function sameWebFetchHost(left: URL, right: URL): boolean {
  return left.hostname === right.hostname;
}

function blockedWebFetchHost(host: string): boolean {
  if (host.includes(":") || /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/u.test(host)) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return true;
  const [first = 0, second = 0] = octets;
  return first === 0 || first === 10 || first === 127 || first >= 224
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19));
}

/** Validate an xAI-issued media URL before the relay performs a server-side download. */
export function normalizeVideoDownloadUrl(raw: unknown): URL {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_WEB_FETCH_URL_BYTES) {
    throw new Error("Video download URL is invalid");
  }
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Video download URL must use credential-free HTTPS");
  }
  const host = url.hostname.toLowerCase().replace(/\.+$/u, "");
  if (!host.includes(".") || host.includes(":")
    || /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/u.test(host)) {
    throw new Error("Video download URL host is not public");
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) throw new Error("Video download URL host is invalid");
    const [first = 0, second = 0] = octets;
    if (first === 0 || first === 10 || first === 127 || first >= 224
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 198 && (second === 18 || second === 19))) {
      throw new Error("Video download URL host is not public");
    }
  }
  return url;
}
