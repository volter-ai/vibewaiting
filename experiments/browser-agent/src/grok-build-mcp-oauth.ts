import {
  coordinateGrokBuildMcpAuthorization,
  createGrokBuildMcpClientAssertion,
} from "./grok-build-mcp-oauth-browser.js";
import {
  discoverGrokBuildMcpOAuthMetadata,
  OAuthNoAuthorizationSupport,
  validateAuthorizationMetadata,
} from "./grok-build-mcp-oauth-discovery.js";

export { isPublicIpAddress } from "./grok-build-mcp-oauth-discovery.js";

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
  clientCredentials?:
    | { clientId: string; clientSecret: string; scopes?: readonly string[]; resource?: string; method?: "client_secret_post" }
    | { clientId: string; signingKey: CryptoKey | JsonWebKey; algorithm: "RS256" | "RS384" | "RS512" | "ES256" | "ES384"; scopes?: readonly string[]; resource?: string; tokenEndpointAudience?: string; method: "private_key_jwt" };
  /** Required for cross-origin AS hosts: resolve through the relay; every returned IP must be public. */
  resolveAuthorizationHostname?: (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;
  /** Override for tests/custom runtimes. Browser default uses Web Locks when available. */
  coordinateAuthorization?: <T>(key: string, signal: AbortSignal, operation: () => Promise<T>) => Promise<T>;
}

interface OAuthTokenPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

class McpOAuthTokenExchangeError extends Error {
  constructor(message: string, readonly transient: boolean, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "McpOAuthTokenExchangeError";
  }
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
const REFRESH_BUFFER_SECONDS = 30;

/** RFC 8414/9728 + DCR/PKCE browser OAuth manager, mirroring native auth order. */
export class GrokBuildMcpOAuthClient {
  private readonly key: string;
  private pending: Promise<string | undefined> | undefined;
  private requiredScopes: string[] = [];
  private noAuthorizationSupport = false;

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
    if (this.noAuthorizationSupport && !force) return undefined;
    if (force) this.noAuthorizationSupport = false;
    if (this.pending && !force) return this.pending;
    const run = () => this.prepare(signal, force, false);
    const operation = (this.options.coordinateAuthorization ?? coordinateGrokBuildMcpAuthorization)(this.key, signal, run);
    this.pending = operation;
    try {
      return await operation;
    } finally {
      if (this.pending === operation) this.pending = undefined;
    }
  }

  /** Native `force_reauth(true)`: a user gesture may escalate even a transient refresh failure. */
  async forceReauth(signal: AbortSignal): Promise<string | undefined> {
    this.noAuthorizationSupport = false;
    const operation = this.prepare(signal, true, true);
    // A user-triggered auth replaces this tab's automatic waiter instead of
    // joining it. Native similarly evicts the in-process dedup entry when the
    // explicit auth trigger carries `force = true`.
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

  requireScopes(scopes: readonly string[]): void {
    this.requiredScopes = [...new Set([...this.requiredScopes, ...scopes])];
  }

  private async prepare(signal: AbortSignal, force: boolean, userTriggered: boolean): Promise<string | undefined> {
    let stored = await this.options.credentialStore.load(this.key);
    if (stored) {
      const current = stored;
      if (!force && tokenIsUsable(current)) return current.accessToken;
      const needsExpandedScopes = this.requiredScopes.some((scope) => !current.grantedScopes.includes(scope));
      if (current.refreshToken && !needsExpandedScopes) {
        try {
          stored = await this.refresh(current, signal);
          return stored.accessToken;
        } catch (error) {
          // Native automatic tool retries do not open a consent window for a
          // network/proxy blip. Terminal refresh rejection still escalates.
          if (force && !userTriggered && isTransientTokenExchangeFailure(error)) throw error;
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
      // Native rmcp distinguishes a reachable server with no RFC 8414/9728
      // metadata from an inconclusive discovery failure. Only the latter uses
      // the anonymous POST tie-break.
      if (error instanceof OAuthNoAuthorizationSupport) {
        this.noAuthorizationSupport = true;
        return undefined;
      }
      if ((this.options.interactive ?? this.options.authorize !== undefined)) return undefined;
      if (await this.acceptsAnonymous(signal)) return undefined;
      throw new Error(`MCP server '${this.serverName}': Auth required (non-interactive session; authenticate in the browser or set an Authorization header)`, { cause: error });
    }

    await validateAuthorizationMetadata(metadata, new URL(this.serverUrl), this.options.resolveAuthorizationHostname, signal);
    const scopes = [...new Set([...selectScopes(this.options.scopes, metadata.scopesSupported), ...this.requiredScopes])];
    if (this.options.clientCredentials) {
      const configured = this.options.clientCredentials;
      const fields: Record<string, string> = {
        grant_type: "client_credentials",
        client_id: configured.clientId,
        ...(configured.scopes?.length ? { scope: configured.scopes.join(" ") } : scopes.length ? { scope: scopes.join(" ") } : {}),
        resource: configured.resource ?? this.serverUrl,
      };
      let clientSecret: string | undefined;
      if (configured.method === "private_key_jwt") {
        fields.client_assertion_type = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
        fields.client_assertion = await createGrokBuildMcpClientAssertion(configured, metadata.tokenEndpoint);
      } else clientSecret = configured.clientSecret;
      const token = await exchangeToken(metadata, fields, configured.clientId, clientSecret, this.fetchImpl, signal);
      const credentials = credentialsFromToken(token, { clientId: configured.clientId, ...(clientSecret ? { clientSecret } : {}), metadata, redirectUri: "", fallbackScopes: [...(configured.scopes ?? scopes)] });
      await this.options.credentialStore.save(this.key, credentials);
      this.requiredScopes = [];
      return credentials.accessToken;
    }
    if (!(this.options.interactive ?? this.options.authorize !== undefined) || !this.options.authorize) {
      throw new Error(`MCP server '${this.serverName}' supports OAuth but has no usable stored token; interactive authorization is required.`);
    }
    const redirectUri = this.options.redirectUri;
    if (!redirectUri) throw new Error(`MCP OAuth redirectUri is required for '${this.serverName}'.`);
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
    this.requiredScopes = [];
    return credentials.accessToken;
  }

  private async refresh(stored: McpOAuthCredentials, signal: AbortSignal): Promise<McpOAuthCredentials> {
    await validateAuthorizationMetadata(stored.metadata, new URL(this.serverUrl), this.options.resolveAuthorizationHostname, signal);
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
    return discoverGrokBuildMcpOAuthMetadata(
      this.serverUrl,
      this.fetchImpl,
      this.options.resolveAuthorizationHostname,
      signal,
    );
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
  let response: Response;
  try {
    response = await fetchImpl(metadata.tokenEndpoint, { method: "POST", headers, body, signal, redirect: "error", credentials: "omit" });
  } catch (cause) {
    throw new McpOAuthTokenExchangeError("OAuth token request failed.", true, cause);
  }
  const token = await response.json().catch(() => ({})) as OAuthTokenPayload;
  if (!response.ok || typeof token.access_token !== "string") {
    const oauthCode = typeof token.error === "string" ? token.error : undefined;
    const description = typeof token.error_description === "string" ? token.error_description : undefined;
    const detail = oauthCode ? `: ${oauthCode}${description ? `: ${description}` : ""}` : "";
    throw new McpOAuthTokenExchangeError(
      `OAuth token exchange failed with HTTP ${response.status}${detail}.`,
      !oauthCode,
    );
  }
  return token;
}

function isTransientTokenExchangeFailure(error: unknown): boolean {
  return error instanceof McpOAuthTokenExchangeError && error.transient;
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
