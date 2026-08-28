import { createHash } from "node:crypto";

export const CONFORMANCE_FORMAT_VERSION = 2;
export const GROK_UPSTREAM_ORIGIN = "https://cli-chat-proxy.grok.com";
export const MAX_CONFORMANCE_BODY_BYTES = 8 * 1024 * 1024;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const TRANSPORT_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "accept-encoding",
  "accept-language",
  "content-length",
  "host",
  "sec-fetch-mode",
  "user-agent",
]);

const SECRET_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
]);

const IDENTITY_HEADERS = new Set([
  "x-email",
  "x-grok-user-id",
  "x-teamid",
  "x-userid",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

export type ConformanceLane = "native" | "browser";
export type ConformanceMode = "record" | "replay" | "verify-live";

export interface CanonicalRequest {
  method: string;
  path: string;
  query: Array<[string, string]>;
  headers: Record<string, string>;
  body: unknown;
}

export interface RecordedResponse {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
  bodySha256: string;
}

export interface ConformanceRecord {
  kind: "exchange";
  sequence: number;
  key: string;
  request: CanonicalRequest;
  requestSha256: string;
  requestBodyBase64: string;
  requestBodySha256: string;
  response: RecordedResponse;
}

export interface ConformanceManifest {
  kind: "manifest";
  formatVersion: number;
  createdAt: string;
  nativeVersion: string;
  sourceRevision: string;
  task: string;
}

export interface ProtocolDifference {
  pointer: string;
  expected: unknown;
  actual: unknown;
}

const SYMBOL_PATTERN = /^<(identifier|identity):([^:>]+):(\d+)>$/u;

export class ProtocolViolation extends Error {
  readonly differences: ProtocolDifference[];

  constructor(message: string, differences: ProtocolDifference[] = []) {
    super(message);
    this.name = "ProtocolViolation";
    this.differences = differences;
  }
}

export class LaneProtocolState {
  private readonly valuesByField = new Map<string, Map<string, string>>();

  validateAndNormalize(headers: Record<string, string>): Record<string, string> {
    const normalized = { ...headers };
    for (const name of ["x-grok-conv-id", "x-grok-req-id", "x-grok-session-id"]) {
      const value = normalized[name];
      if (value !== undefined) normalized[name] = this.symbolFor("identifier", value, classifyIdentifier(value));
    }
    for (const name of IDENTITY_HEADERS) {
      const value = normalized[name];
      if (value !== undefined) normalized[name] = this.symbolFor("identity", value, "value");
    }
    return normalized;
  }

  normalizePath(path: string): string {
    return path.replace(
      /(?<=\/sessions\/)([^/]+)(?=\/(?:signals|turn-deltas)(?:\/|$))/gu,
      (value) => this.symbolFor("identifier", value, classifyIdentifier(value)),
    );
  }

  normalizeIdentifier(value: string): string {
    return this.symbolFor("identifier", value, classifyIdentifier(value));
  }

  private symbolFor(field: string, value: string, kind: string): string {
    const values = this.valuesByField.get(field) ?? new Map<string, string>();
    this.valuesByField.set(field, values);
    const existing = values.get(value);
    if (existing) return existing;
    const symbol = `<${field}:${kind}:${values.size + 1}>`;
    values.set(value, symbol);
    return symbol;
  }
}

export function splitLanePath(pathname: string): { lane: ConformanceLane; upstreamPath: string } {
  const match = /^\/(native|browser)(\/v1(?:\/.*)?$)/u.exec(pathname);
  if (!match?.[1] || !match[2]) {
    throw new ProtocolViolation("Requests must use /native/v1/* or /browser/v1/*.");
  }
  return { lane: match[1] as ConformanceLane, upstreamPath: match[2] };
}

export function filterForwardHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name) || rawValue === undefined || name === "host") continue;
    result[name] = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
  }
  return result;
}

export function canonicalHeaders(
  headers: Record<string, string | string[] | undefined>,
  state: LaneProtocolState,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (TRANSPORT_HEADERS.has(name) || rawValue === undefined) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
    if (SECRET_HEADERS.has(name)) {
      result[name] = name === "authorization" && /^Bearer\s+\S+$/iu.test(value) ? "<bearer>" : "<redacted>";
    } else if (name === "traceparent") {
      result[name] = "<traceparent>";
    } else {
      result[name] = value;
    }
  }
  return sortObject(state.validateAndNormalize(result));
}

export function canonicalBody(body: Buffer, contentType: string | undefined, state?: LaneProtocolState): unknown {
  if (body.length === 0) return null;
  if (contentType?.toLowerCase().includes("application/json")) {
    try {
      const parsed = sortJson(JSON.parse(body.toString("utf8")) as unknown);
      if (state && isObject(parsed) && typeof parsed.prompt_cache_key === "string") {
        parsed.prompt_cache_key = state.normalizeIdentifier(parsed.prompt_cache_key);
      }
      return parsed;
    } catch {
      throw new ProtocolViolation("A request declared application/json but was not valid JSON.");
    }
  }
  if (contentType?.startsWith("text/") || contentType?.includes("x-www-form-urlencoded")) {
    return body.toString("utf8");
  }
  return { byteLength: body.length, sha256: sha256(body) };
}

export function canonicalRequest(
  method: string,
  url: URL,
  upstreamPath: string,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
  state: LaneProtocolState,
): CanonicalRequest {
  const canonical = canonicalBody(body, singleHeader(headers["content-type"]), state);
  normalizeTelemetryMeasurements(upstreamPath, canonical);
  return {
    method: method.toUpperCase(),
    path: state.normalizePath(upstreamPath),
    query: [...url.searchParams.entries()].sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv)),
    headers: canonicalHeaders(headers, state),
    body: canonical,
  };
}

/** Preserve telemetry structure/counters while removing values that necessarily change on replay. */
export function normalizeTelemetryMeasurements(path: string, body: unknown): void {
  if (!isObject(body) || !/^\/v1\/sessions\/[^/]+\/(?:signals|turn-deltas)$/u.test(path)) return;
  const volatile = new Set([
    "avgItlMeanMs", "avgResponseTimeMs", "avgTimeToFirstTokenMs", "itlMaxMs", "itlMeanMs",
    "itlP50Ms", "itlP99Ms", "lastItlP50Ms", "lastItlP99Ms", "maxTimeToFirstTokenMs",
    "minTimeToFirstTokenMs", "sessionDurationSeconds", "timeToFirstTokenMs", "totalResponseTimeMs",
    "turnDurationMs", "worstItlMaxMs",
  ]);
  for (const key of volatile) {
    if (key in body) body[key] = "<measurement>";
  }
  if (typeof body.requestId === "string") body.requestId = "<request-id>";
}

export function requestKey(request: Pick<CanonicalRequest, "method" | "path">): string {
  return `${request.method} ${request.path}`;
}

export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function diffProtocol(expected: unknown, actual: unknown, pointer = "", output: ProtocolDifference[] = []): ProtocolDifference[] {
  if (output.length >= 50) return output;
  if (Object.is(expected, actual)) return output;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      diffProtocol(expected[index], actual[index], `${pointer}/${index}`, output);
    }
    return output;
  }
  if (isObject(expected) && isObject(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) {
      diffProtocol(expected[key], actual[key], `${pointer}/${escapePointer(key)}`, output);
    }
    return output;
  }
  output.push({ pointer: pointer || "/", expected, actual });
  return output;
}

export function assertProtocolMatch(expected: CanonicalRequest, actual: CanonicalRequest): void {
  new ProtocolSymbolMatcher().assertMatch(expected, actual);
}

/**
 * Align dynamic native/browser symbols by their reuse relationships rather
 * than by the order in which each lane happened to first observe them.
 */
export class ProtocolSymbolMatcher {
  private expectedToActual = new Map<string, string>();
  private actualToExpected = new Map<string, string>();

  assertMatch(expected: CanonicalRequest, actual: CanonicalRequest): void {
    const expectedToActual = new Map(this.expectedToActual);
    const actualToExpected = new Map(this.actualToExpected);
    const alignedActual = alignSymbols(expected, actual, expectedToActual, actualToExpected);
    const differences = diffProtocol(expected, alignedActual);
    if (differences.length > 0) {
      throw new ProtocolViolation("Browser Grok diverged from the native Grok Build corpus.", differences);
    }
    this.expectedToActual = expectedToActual;
    this.actualToExpected = actualToExpected;
  }
}

export function safeResponseHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name) || SECRET_HEADERS.has(name) || rawValue === undefined) continue;
    result[name] = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
  }
  return sortObject(result);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function sortObject(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function classifyIdentifier(value: string): "uuid" | "ulid" | "opaque" {
  if (UUID_PATTERN.test(value)) return "uuid";
  if (ULID_PATTERN.test(value)) return "ulid";
  return "opaque";
}

function alignSymbols(
  expected: unknown,
  actual: unknown,
  expectedToActual: Map<string, string>,
  actualToExpected: Map<string, string>,
): unknown {
  if (typeof expected === "string" && typeof actual === "string") {
    const expectedSymbol = SYMBOL_PATTERN.exec(expected);
    const actualSymbol = SYMBOL_PATTERN.exec(actual);
    if (!expectedSymbol || !actualSymbol || expectedSymbol[1] !== actualSymbol[1] || expectedSymbol[2] !== actualSymbol[2]) {
      return actual;
    }
    const mappedActual = expectedToActual.get(expected);
    const mappedExpected = actualToExpected.get(actual);
    if ((mappedActual && mappedActual !== actual) || (mappedExpected && mappedExpected !== expected)) return actual;
    expectedToActual.set(expected, actual);
    actualToExpected.set(actual, expected);
    return expected;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    return actual.map((value, index) => alignSymbols(expected[index], value, expectedToActual, actualToExpected));
  }
  if (isObject(expected) && isObject(actual)) {
    return Object.fromEntries(Object.entries(actual).map(([key, value]) => [
      key,
      alignSymbols(expected[key], value, expectedToActual, actualToExpected),
    ]));
  }
  return actual;
}
