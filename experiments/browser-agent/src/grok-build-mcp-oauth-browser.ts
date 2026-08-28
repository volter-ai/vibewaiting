export interface GrokBuildMcpPrivateKeyJwtConfig {
  clientId: string;
  signingKey: CryptoKey | JsonWebKey;
  algorithm: "RS256" | "RS384" | "RS512" | "ES256" | "ES384";
  tokenEndpointAudience?: string;
}

export async function createGrokBuildMcpClientAssertion(
  config: GrokBuildMcpPrivateKeyJwtConfig,
  tokenEndpoint: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: config.algorithm, typ: "JWT" })));
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({
    iss: config.clientId, sub: config.clientId, aud: config.tokenEndpointAudience ?? tokenEndpoint,
    jti: base64Url(crypto.getRandomValues(new Uint8Array(24))), iat: now, exp: now + 300,
  })));
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const hash = config.algorithm.endsWith("256") ? "SHA-256" : config.algorithm.endsWith("384") ? "SHA-384" : "SHA-512";
  const isRsa = config.algorithm.startsWith("RS");
  const importAlgorithm: RsaHashedImportParams | EcKeyImportParams = isRsa
    ? { name: "RSASSA-PKCS1-v1_5", hash }
    : { name: "ECDSA", namedCurve: config.algorithm === "ES256" ? "P-256" : "P-384" };
  const key = config.signingKey instanceof CryptoKey
    ? config.signingKey
    : await crypto.subtle.importKey("jwk", config.signingKey, importAlgorithm, false, ["sign"]);
  const signAlgorithm: AlgorithmIdentifier | EcdsaParams = isRsa ? "RSASSA-PKCS1-v1_5" : { name: "ECDSA", hash };
  const signature = new Uint8Array(await crypto.subtle.sign(signAlgorithm, key, data));
  return `${header}.${payload}.${base64Url(signature)}`;
}

export async function coordinateGrokBuildMcpAuthorization<T>(
  key: string,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  const locks = globalThis.navigator?.locks;
  return locks ? await locks.request(`grok-mcp-oauth:${key}`, { mode: "exclusive", signal }, operation) : await operation();
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
