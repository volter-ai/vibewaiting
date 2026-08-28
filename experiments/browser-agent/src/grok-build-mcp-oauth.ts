export interface McpOAuthMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  issuer?: string;
  scopesSupported?: string[];
  responseTypesSupported?: string[];
  codeChallengeMethodsSupported?: string[];
  tokenEndpointAuthMethodsSupported?: string[];
  authorizationResponseIssParameterSupported?: boolean;
}

export interface McpOAuthCredentials {
  clientId: string;
  clientSecret?: string;
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
  tokenReceivedAt?: number;
  grantedScopes: string[];
  metadata: McpOAuthMetadata;
  redirectUri: string;
}

export interface McpOAuthCredentialStore {
  load(key: string): Promise<McpOAuthCredentials | undefined>;
  save(key: string, credentials: McpOAuthCredentials): Promise<void>;
  clear(key: string): Promise<void>;
}

export interface McpOAuthAuthorizationResult {
  code: string;
  state: string;
  issuer?: string;
}

export interface GrokBuildMcpOAuthOptions {
  credentialStore: McpOAuthCredentialStore;
  /** Browser UI owns opening the URL and securely receiving the redirect. */
  authorize?: (authorizationUrl: string, signal: AbortSignal) => Promise<McpOAuthAuthorizationResult>;
  interactive?: boolean;
  clientId?: string;
  clientSecret?: string;
  scopes?: readonly string[];
  redirectUri?: string;
  discoveryTimeoutMs?: number;
}

interface OAuthTokenPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

const DISCOVERY_PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
const REFRESH_BUFFER_SECONDS = 30;

/** RFC 8414/9728 + DCR/PKCE browser OAuth manager, mirroring native auth order. */
export class GrokBuildMcpOAuthClient {
  private readonly key: string;
  private pending: Promise<string | undefined> | undefined;

  constructor(
    private readonly serverName: string,
    private readonly serverUrl: string,
    private readonly options: GrokBuildMcpOAuthOptions,
    private readonly fetchImpl: typeof fetch,
    private readonly configuredHeaders: Readonly<Record<string, string>> = {},
  ) {
    this.key = `${serverName}:${new URL(serverUrl).toString()}`;
  }

  async accessToken(signal: AbortSignal, force = false): Promise<string | undefined> {
    if (this.pending && !force) return this.pending;
    const operation = this.prepare(signal, force);
    this.pending = operation;
    try {
      return await operation;
    } finally {
      if (this.pending === operation) this.pending = undefined;
    }
  }

  async invalidate(): Promise<void> {
    await this.options.credentialStore.clear(this.key);
  }

  private async prepare(signal: AbortSignal, force: boolean): Promise<string | undefined> {
    let stored = await this.options.credentialStore.load(this.key);
    if (stored && !force) {
      if (tokenIsUsable(stored)) return stored.accessToken;
      if (stored.refreshToken) {
        try {
          stored = await this.refresh(stored, signal);
          return stored.accessToken;
        } catch {
          // Native falls through to interactive authorization after refresh failure.
        }
      }
    }

    let metadata: McpOAuthMetadata;
    try {
      metadata = stored?.metadata ?? await withTimeout(
        this.discover(signal),
        this.options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
        signal,
      );
    } catch (error) {
      if ((this.options.interactive ?? this.options.authorize !== undefined)) return undefined;
      if (await this.acceptsAnonymous(signal)) return undefined;
      throw new Error(`MCP server '${this.serverName}': Auth required (non-interactive session; authenticate in the browser or set an Authorization header)`, { cause: error });
    }

    if (!(this.options.interactive ?? this.options.authorize !== undefined) || !this.options.authorize) {
      throw new Error(`MCP server '${this.serverName}' supports OAuth but has no usable stored token; interactive authorization is required.`);
    }
    const redirectUri = this.options.redirectUri;
    if (!redirectUri) throw new Error(`MCP OAuth redirectUri is required for '${this.serverName}'.`);
    const scopes = selectScopes(this.options.scopes, metadata.scopesSupported);
    let clientId = this.options.clientId ?? stored?.clientId;
    let clientSecret = this.options.clientSecret ?? stored?.clientSecret;
    if (!clientId) {
      const registered = await registerClient(metadata, redirectUri, scopes, this.fetchImpl, signal);
      clientId = registered.clientId;
      clientSecret = registered.clientSecret;
    }
    if (metadata.responseTypesSupported && !metadata.responseTypesSupported.includes("code")) {
      throw new Error("OAuth authorization server does not support the code response type.");
    }

    const verifier = randomBase64Url(32);
    const challenge = await sha256Base64Url(verifier);
    const state = randomBase64Url(32);
    const authorization = new URL(metadata.authorizationEndpoint);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("client_id", clientId);
    authorization.searchParams.set("redirect_uri", redirectUri);
    authorization.searchParams.set("state", state);
    authorization.searchParams.set("code_challenge", challenge);
    authorization.searchParams.set("code_challenge_method", "S256");
    authorization.searchParams.set("resource", this.serverUrl);
    if (scopes.length) authorization.searchParams.set("scope", scopes.join(" "));

    const callback = await this.options.authorize(authorization.toString(), signal);
    if (callback.state !== state) throw new Error("MCP OAuth callback state mismatch.");
    validateIssuer(metadata, callback.issuer);
    const token = await exchangeToken(metadata, {
      grant_type: "authorization_code",
      code: callback.code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: this.serverUrl,
    }, clientId, clientSecret, this.fetchImpl, signal);
    const credentials = credentialsFromToken(token, {
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      metadata,
      redirectUri,
      fallbackScopes: scopes,
    });
    await this.options.credentialStore.save(this.key, credentials);
    return credentials.accessToken;
  }

  private async refresh(stored: McpOAuthCredentials, signal: AbortSignal): Promise<McpOAuthCredentials> {
    const token = await exchangeToken(stored.metadata, {
      grant_type: "refresh_token",
      refresh_token: stored.refreshToken!,
      client_id: stored.clientId,
      resource: this.serverUrl,
      ...(stored.grantedScopes.length ? { scope: stored.grantedScopes.join(" ") } : {}),
    }, stored.clientId, stored.clientSecret, this.fetchImpl, signal);
    const refreshed = credentialsFromToken(token, {
      clientId: stored.clientId,
      ...(stored.clientSecret ? { clientSecret: stored.clientSecret } : {}),
      metadata: stored.metadata,
      redirectUri: stored.redirectUri,
      fallbackScopes: stored.grantedScopes,
      ...(stored.refreshToken ? { fallbackRefreshToken: stored.refreshToken } : {}),
    });
    await this.options.credentialStore.save(this.key, refreshed);
    return refreshed;
  }

  private async discover(signal: AbortSignal): Promise<McpOAuthMetadata> {
    const resource = new URL(this.serverUrl);
    const resourceMetadata = await discoverResourceMetadata(resource, this.fetchImpl, signal);
    if (resourceMetadata) {
      if (!resourceIdentifiersMatch(this.serverUrl, resourceMetadata.resource)) throw new Error("Protected resource metadata resource mismatch.");
      const candidates = [resourceMetadata.authorization_server, ...(resourceMetadata.authorization_servers ?? [])].filter((value): value is string => typeof value === "string" && value.length > 0);
      for (const candidate of candidates) {
        const url = new URL(candidate, resource);
        if (!allowedAuthorizationMetadataUrl(url)) continue;
        const metadata = await discoverAuthorizationMetadata(url, this.fetchImpl, signal);
        if (metadata) {
          const scopesSupported = resourceMetadata.scopes_supported ?? metadata.scopesSupported;
          return { ...metadata, ...(scopesSupported ? { scopesSupported } : {}) };
        }
      }
    }
    const direct = await discoverAuthorizationMetadata(resource, this.fetchImpl, signal);
    if (direct) return direct;
    throw new Error("No authorization support detected");
  }

  private async acceptsAnonymous(signal: AbortSignal): Promise<boolean> {
    try {
      const headers = new Headers(this.configuredHeaders);
      headers.delete("Authorization");
      headers.set("Content-Type", "application/json");
      headers.set("Accept", "application/json, text/event-stream");
      const response = await this.fetchImpl(this.serverUrl, { method: "POST", headers, body: "{}", signal, redirect: "manual", credentials: "omit" });
      if ([401, 403, 407].includes(response.status) || (response.status >= 300 && response.status < 400) || response.status >= 500) return false;
      return true;
    } catch {
      return false;
    }
  }
}

interface ResourceMetadata {
  resource?: string;
  authorization_server?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

async function discoverResourceMetadata(base: URL, fetchImpl: typeof fetch, signal: AbortSignal): Promise<ResourceMetadata | undefined> {
  const candidates = [base.toString(), ...wellKnownPaths(base.pathname, "oauth-protected-resource").map((path) => new URL(path, base).toString())];
  for (const candidate of [...new Set(candidates)]) {
    const response = await discoveryGet(candidate, fetchImpl, signal).catch(() => undefined);
    if (!response) continue;
    if (response.status === 401) {
      const metadataUrl = parseWwwAuthenticate(response.headers.get("WWW-Authenticate") ?? "", base);
      if (metadataUrl) {
        const metadataResponse = await discoveryGet(metadataUrl.toString(), fetchImpl, signal).catch(() => undefined);
        if (metadataResponse?.ok) return await metadataResponse.json() as ResourceMetadata;
      }
    } else if (response.ok) {
      const parsed = await response.clone().json().catch(() => undefined) as ResourceMetadata | undefined;
      if (parsed?.resource) return parsed;
    }
  }
  return undefined;
}

async function discoverAuthorizationMetadata(base: URL, fetchImpl: typeof fetch, signal: AbortSignal): Promise<McpOAuthMetadata | undefined> {
  const paths = base.pathname.includes("/.well-known/") ? [base.toString()] : generateDiscoveryUrls(base).map(String);
  for (const path of paths) {
    const response = await discoveryGet(path, fetchImpl, signal).catch(() => undefined);
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

async function registerClient(metadata: McpOAuthMetadata, redirectUri: string, scopes: string[], fetchImpl: typeof fetch, signal: AbortSignal): Promise<{ clientId: string; clientSecret?: string }> {
  if (!metadata.registrationEndpoint) throw new Error("Dynamic client registration not supported");
  const response = await fetchImpl(metadata.registrationEndpoint, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal, redirect: "follow", credentials: "omit",
    body: JSON.stringify({ client_name: "Grok", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none", response_types: ["code"], ...(scopes.length ? { scope: scopes.join(" ") } : {}), application_type: "native" }),
  });
  const raw = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof raw.client_id !== "string") throw new Error(`Dynamic client registration failed with HTTP ${response.status}.`);
  return { clientId: raw.client_id, ...(typeof raw.client_secret === "string" && raw.client_secret ? { clientSecret: raw.client_secret } : {}) };
}

async function exchangeToken(metadata: McpOAuthMetadata, fields: Record<string, string>, clientId: string, clientSecret: string | undefined, fetchImpl: typeof fetch, signal: AbortSignal): Promise<OAuthTokenPayload> {
  const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" });
  const body = new URLSearchParams(fields);
  const methods = metadata.tokenEndpointAuthMethodsSupported;
  if (clientSecret && methods?.includes("client_secret_basic") && !methods.includes("client_secret_post")) {
    headers.set("Authorization", `Basic ${btoa(`${clientId}:${clientSecret}`)}`);
    body.delete("client_id");
  } else if (clientSecret) body.set("client_secret", clientSecret);
  const response = await fetchImpl(metadata.tokenEndpoint, { method: "POST", headers, body, signal, redirect: "error", credentials: "omit" });
  const token = await response.json().catch(() => ({})) as OAuthTokenPayload;
  if (!response.ok || typeof token.access_token !== "string") throw new Error(`OAuth token exchange failed with HTTP ${response.status}.`);
  return token;
}

function credentialsFromToken(token: OAuthTokenPayload, input: { clientId: string; clientSecret?: string; metadata: McpOAuthMetadata; redirectUri: string; fallbackScopes: string[]; fallbackRefreshToken?: string }): McpOAuthCredentials {
  const scopes = typeof token.scope === "string" ? token.scope.split(/\s+/u).filter(Boolean) : input.fallbackScopes;
  return {
    clientId: input.clientId,
    ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
    accessToken: token.access_token as string,
    ...(typeof token.refresh_token === "string" ? { refreshToken: token.refresh_token } : input.fallbackRefreshToken ? { refreshToken: input.fallbackRefreshToken } : {}),
    ...(typeof token.token_type === "string" ? { tokenType: token.token_type } : {}),
    ...(typeof token.expires_in === "number" ? { expiresIn: token.expires_in } : {}),
    tokenReceivedAt: Math.floor(Date.now() / 1_000),
    grantedScopes: scopes,
    metadata: input.metadata,
    redirectUri: input.redirectUri,
  };
}

function tokenIsUsable(credentials: McpOAuthCredentials): boolean {
  if (credentials.expiresIn === undefined || credentials.tokenReceivedAt === undefined) return true;
  return credentials.expiresIn - (Math.floor(Date.now() / 1_000) - credentials.tokenReceivedAt) >= REFRESH_BUFFER_SECONDS;
}

function validateIssuer(metadata: McpOAuthMetadata, received: string | undefined): void {
  if (metadata.authorizationResponseIssParameterSupported && !received) throw new Error(`Authorization server response missing required issuer: expected ${metadata.issuer ?? "unknown"}`);
  if (received && metadata.issuer && received !== metadata.issuer) throw new Error(`Authorization server issuer mismatch: expected ${metadata.issuer}, received ${received}`);
}

function selectScopes(configured: readonly string[] | undefined, supported: string[] | undefined): string[] {
  const scopes = configured?.length ? [...configured] : [...(supported ?? [])];
  if (scopes.length && supported?.includes("offline_access") && !scopes.includes("offline_access")) scopes.push("offline_access");
  return scopes;
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
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (/^(?:127\.|10\.|192\.168\.|169\.254\.|0\.)/u.test(host)) return false;
  const private172 = /^172\.(\d+)\./u.exec(host);
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return false;
  return true;
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

function randomBase64Url(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return base64Url(value);
}

async function sha256Base64Url(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("OAuth discovery timed out")), { once: true });
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })]);
  } finally {
    globalThis.clearTimeout(timer);
  }
}
