import type { McpOAuthMetadata } from "./grok-build-mcp-oauth.js";

const DISCOVERY_PROTOCOL_VERSION = "2024-11-05";

export type McpAuthorizationHostnameResolver = (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;

export class OAuthNoAuthorizationSupport extends Error {
  constructor() {
    super("No authorization support detected");
    this.name = "OAuthNoAuthorizationSupport";
  }
}

interface OAuthDiscoveryProbe {
  responses: number;
  lastError?: unknown;
}

interface ResourceMetadata {
  resource?: string;
  authorization_server?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

export async function discoverGrokBuildMcpOAuthMetadata(
  serverUrl: string,
  fetchImpl: typeof fetch,
  resolver: McpAuthorizationHostnameResolver | undefined,
  signal: AbortSignal,
): Promise<McpOAuthMetadata> {
  const resource = new URL(serverUrl);
  const probe: OAuthDiscoveryProbe = { responses: 0 };
  const resourceMetadata = await discoverResourceMetadata(resource, fetchImpl, signal, probe);
  if (resourceMetadata) {
    if (!resourceIdentifiersMatch(serverUrl, resourceMetadata.resource)) throw new Error("Protected resource metadata resource mismatch.");
    const candidates = [resourceMetadata.authorization_server, ...(resourceMetadata.authorization_servers ?? [])]
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    for (const candidate of candidates) {
      const url = new URL(candidate, resource);
      if (!allowedAuthorizationMetadataUrl(url)) continue;
      await validateAuthorizationUrl(url, resource, resolver, signal);
      const metadata = await discoverAuthorizationMetadata(url, fetchImpl, signal, probe);
      if (metadata) {
        const scopesSupported = resourceMetadata.scopes_supported ?? metadata.scopesSupported;
        return { ...metadata, ...(scopesSupported ? { scopesSupported } : {}) };
      }
    }
  }
  const direct = await discoverAuthorizationMetadata(resource, fetchImpl, signal, probe);
  if (direct) return direct;
  if (probe.responses > 0) throw new OAuthNoAuthorizationSupport();
  throw probe.lastError instanceof Error ? probe.lastError : new Error("OAuth discovery failed");
}

export async function validateAuthorizationMetadata(
  metadata: McpOAuthMetadata,
  resource: URL,
  resolver: McpAuthorizationHostnameResolver | undefined,
  signal: AbortSignal,
): Promise<void> {
  for (const value of [metadata.authorizationEndpoint, metadata.tokenEndpoint, metadata.registrationEndpoint]) {
    if (value) await validateAuthorizationUrl(new URL(value), resource, resolver, signal);
  }
}

async function validateAuthorizationUrl(url: URL, resource: URL, resolver: McpAuthorizationHostnameResolver | undefined, signal: AbortSignal): Promise<void> {
  if (!allowedAuthorizationMetadataUrl(url)) throw new Error(`Unsafe OAuth authorization-server URL '${url.toString()}'.`);
  if (url.origin === resource.origin) return;
  if (!resolver) throw new Error(`Cross-origin OAuth server '${url.origin}' requires relay-backed DNS validation.`);
  const addresses = await resolver(url.hostname, signal);
  if (addresses.length === 0 || addresses.some((address) => !isPublicIpAddress(address))) throw new Error(`OAuth server '${url.hostname}' resolved to a non-public address.`);
}

async function discoverResourceMetadata(base: URL, fetchImpl: typeof fetch, signal: AbortSignal, probe: OAuthDiscoveryProbe): Promise<ResourceMetadata | undefined> {
  const candidates = [base.toString(), ...wellKnownPaths(base.pathname, "oauth-protected-resource").map((path) => new URL(path, base).toString())];
  for (const candidate of [...new Set(candidates)]) {
    const response = await trackedDiscoveryGet(candidate, fetchImpl, signal, probe);
    if (!response) continue;
    if (response.status === 401) {
      const metadataUrl = parseWwwAuthenticate(response.headers.get("WWW-Authenticate") ?? "", base);
      if (metadataUrl) {
        const metadataResponse = await trackedDiscoveryGet(metadataUrl.toString(), fetchImpl, signal, probe);
        if (metadataResponse?.ok) return await metadataResponse.json() as ResourceMetadata;
      }
    } else if (response.ok) {
      const parsed = await response.clone().json().catch(() => undefined) as ResourceMetadata | undefined;
      if (parsed?.resource) return parsed;
    }
  }
  return undefined;
}

async function discoverAuthorizationMetadata(base: URL, fetchImpl: typeof fetch, signal: AbortSignal, probe: OAuthDiscoveryProbe): Promise<McpOAuthMetadata | undefined> {
  const paths = base.pathname.includes("/.well-known/") ? [base.toString()] : generateDiscoveryUrls(base).map(String);
  for (const path of paths) {
    const response = await trackedDiscoveryGet(path, fetchImpl, signal, probe);
    if (!response?.ok) continue;
    const raw = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (typeof raw?.authorization_endpoint !== "string" || typeof raw.token_endpoint !== "string") continue;
    return {
      authorizationEndpoint: raw.authorization_endpoint,
      tokenEndpoint: raw.token_endpoint,
      ...(typeof raw.registration_endpoint === "string" ? { registrationEndpoint: raw.registration_endpoint } : {}),
      ...(typeof raw.issuer === "string" ? { issuer: raw.issuer } : {}),
      ...(stringArray(raw.scopes_supported) ? { scopesSupported: stringArray(raw.scopes_supported)! } : {}),
      ...(stringArray(raw.response_types_supported) ? { responseTypesSupported: stringArray(raw.response_types_supported)! } : {}),
      ...(stringArray(raw.code_challenge_methods_supported) ? { codeChallengeMethodsSupported: stringArray(raw.code_challenge_methods_supported)! } : {}),
      ...(stringArray(raw.token_endpoint_auth_methods_supported) ? { tokenEndpointAuthMethodsSupported: stringArray(raw.token_endpoint_auth_methods_supported)! } : {}),
      ...(typeof raw.authorization_response_iss_parameter_supported === "boolean" ? { authorizationResponseIssParameterSupported: raw.authorization_response_iss_parameter_supported } : {}),
    };
  }
  return undefined;
}

async function trackedDiscoveryGet(url: string, fetchImpl: typeof fetch, signal: AbortSignal, probe: OAuthDiscoveryProbe): Promise<Response | undefined> {
  try {
    const response = await discoveryGet(url, fetchImpl, signal);
    probe.responses += 1;
    return response;
  } catch (error) {
    probe.lastError = error;
    return undefined;
  }
}

async function discoveryGet(url: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<Response> {
  let current = new URL(url);
  for (let redirect = 0; redirect < 10; redirect += 1) {
    const response = await fetchImpl(current, { headers: { "MCP-Protocol-Version": DISCOVERY_PROTOCOL_VERSION }, signal, redirect: "manual", credentials: "omit" });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("Location");
    if (!location) return response;
    const next = new URL(location, current);
    if (next.origin !== current.origin || !["http:", "https:"].includes(next.protocol)) throw new Error("OAuth discovery redirect to non-same-origin URL rejected.");
    current = next;
  }
  throw new Error("OAuth discovery exceeded 10 redirects");
}

function wellKnownPaths(path: string, resource: string): string[] {
  const trimmed = path.replace(/^\/+|\/+$/gu, "");
  const canonical = `/.well-known/${resource}`;
  return trimmed ? [`${canonical}/${trimmed}`, `/${trimmed}/.well-known/${resource}`, canonical] : [canonical];
}

function generateDiscoveryUrls(base: URL): URL[] {
  const trimmed = base.pathname.replace(/^\/+|\/+$/gu, "");
  const paths = trimmed
    ? [`/.well-known/oauth-authorization-server/${trimmed}`, `/.well-known/openid-configuration/${trimmed}`, `/${trimmed}/.well-known/openid-configuration`, "/.well-known/oauth-authorization-server"]
    : ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"];
  return [...new Set(paths)].map((path) => new URL(path, base));
}

function parseWwwAuthenticate(header: string, base: URL): URL | undefined {
  const match = /resource_metadata\s*=\s*(?:"((?:\\.|[^"])*)"|([^,;\s]+))/iu.exec(header);
  const value = (match?.[1] ?? match?.[2])?.replace(/\\(.)/gu, "$1");
  if (!value) return undefined;
  const url = new URL(value, base);
  return url.origin === base.origin ? url : undefined;
}

function allowedAuthorizationMetadataUrl(url: URL): boolean {
  if (!["http:", "https:"].includes(url.protocol)) return false;
  const host = url.hostname.replace(/\.$/u, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (isIpLiteral(host) && !isPublicIpAddress(host)) return false;
  const private172 = /^172\.(\d+)\./u.exec(host);
  return !(private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31);
}

function isIpLiteral(host: string): boolean { return /^\[?[0-9a-f:.]+\]?$/iu.test(host); }

export function isPublicIpAddress(input: string): boolean {
  const host = input.replace(/^\[|\]$/gu, "").toLowerCase();
  if (host.includes(":")) {
    if (host === "::" || host === "::1" || /^f[cd]/u.test(host) || /^fe[89ab]/u.test(host) || /^ff/u.test(host)) return false;
    if (/^2001:db8(?::|$)/u.test(host) || /^100:(?:0*:){0,3}/u.test(host)) return false;
    const mapped = /^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/u.exec(host)?.[1];
    return mapped ? isPublicIpAddress(mapped) : /^[0-9a-f:]+$/u.test(host);
  }
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a = 0, b = 0] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 2 || b === 88 || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  return !(a === 203 && b === 0);
}

function resourceIdentifiersMatch(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  if (expected === actual) return true;
  const expectedUrl = new URL(expected);
  const actualUrl = new URL(actual);
  const expectedRoot = expectedUrl.pathname === "/" && !expectedUrl.search && !expectedUrl.hash;
  const actualRoot = actualUrl.pathname === "/" && !actualUrl.search && !actualUrl.hash;
  return (expectedRoot || actualRoot) && expected.replace(/\/$/u, "") === actual.replace(/\/$/u, "");
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}
