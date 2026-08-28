import type { McpOAuthCredentialStore, McpOAuthCredentials } from "./grok-build-mcp-oauth.js";

const DATABASE_NAME = "vibewaiting-grok-mcp-oauth";
const DATABASE_VERSION = 1;
const STORE_NAME = "credentials";

export class GrokBuildMemoryMcpCredentialStore implements McpOAuthCredentialStore {
  private readonly credentials = new Map<string, McpOAuthCredentials>();

  async load(key: string): Promise<McpOAuthCredentials | undefined> {
    const value = this.credentials.get(key);
    return value ? structuredClone(value) : undefined;
  }

  async save(key: string, credentials: McpOAuthCredentials): Promise<void> {
    this.credentials.set(key, structuredClone(credentials));
  }

  async clear(key: string): Promise<void> {
    this.credentials.delete(key);
  }

  clearAll(): void {
    this.credentials.clear();
  }
}

/** Origin-private persistent equivalent of native `$GROK_HOME/mcp_credentials.json`. */
export class GrokBuildIndexedDbMcpCredentialStore implements McpOAuthCredentialStore {
  private readonly memory = new GrokBuildMemoryMcpCredentialStore();
  private databasePromise: Promise<IDBDatabase> | undefined;

  constructor(private readonly factory: IDBFactory | undefined = globalThis.indexedDB) {}

  async load(key: string): Promise<McpOAuthCredentials | undefined> {
    if (!this.factory) return this.memory.load(key);
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const value = await idbRequest<unknown>(transaction.objectStore(STORE_NAME).get(key));
    await idbTransaction(transaction);
    return isMcpOAuthCredentials(value) ? structuredClone(value) : undefined;
  }

  async save(key: string, credentials: McpOAuthCredentials): Promise<void> {
    if (!this.factory) return this.memory.save(key, credentials);
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const existing = await idbRequest<unknown>(store.get(key));
    if (!isMcpOAuthCredentials(existing) || !credentialIsNewer(existing, credentials)) {
      store.put(structuredClone(credentials), key);
    }
    await idbTransaction(transaction);
  }

  async clear(key: string): Promise<void> {
    if (!this.factory) return this.memory.clear(key);
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(key);
    await idbTransaction(transaction);
  }

  async clearAll(): Promise<void> {
    if (!this.factory) return this.memory.clearAll();
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).clear();
    await idbTransaction(transaction);
  }

  private database(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory!.open(DATABASE_NAME, DATABASE_VERSION);
      request.addEventListener("upgradeneeded", () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
      });
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error ?? new Error("Could not open the MCP credential database.")), { once: true });
      request.addEventListener("blocked", () => reject(new Error("The MCP credential database upgrade is blocked by another tab.")), { once: true });
    });
    return this.databasePromise;
  }
}

function credentialIsNewer(existing: McpOAuthCredentials, incoming: McpOAuthCredentials): boolean {
  return existing.tokenReceivedAt !== undefined && incoming.tokenReceivedAt !== undefined
    && existing.tokenReceivedAt > incoming.tokenReceivedAt;
}

function isMcpOAuthCredentials(value: unknown): value is McpOAuthCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.clientId !== "string" || typeof record.accessToken !== "string"
    || typeof record.redirectUri !== "string" || !stringArray(record.grantedScopes)) return false;
  for (const field of ["clientSecret", "refreshToken", "tokenType"] as const) {
    if (record[field] !== undefined && typeof record[field] !== "string") return false;
  }
  for (const field of ["expiresIn", "tokenReceivedAt"] as const) {
    if (record[field] !== undefined && (typeof record[field] !== "number" || !Number.isFinite(record[field]))) return false;
  }
  if (!record.metadata || typeof record.metadata !== "object" || Array.isArray(record.metadata)) return false;
  const metadata = record.metadata as Record<string, unknown>;
  if (typeof metadata.authorizationEndpoint !== "string" || typeof metadata.tokenEndpoint !== "string") return false;
  for (const field of ["registrationEndpoint", "issuer"] as const) {
    if (metadata[field] !== undefined && typeof metadata[field] !== "string") return false;
  }
  for (const field of ["scopesSupported", "responseTypesSupported", "codeChallengeMethodsSupported", "tokenEndpointAuthMethodsSupported"] as const) {
    if (metadata[field] !== undefined && !stringArray(metadata[field])) return false;
  }
  return metadata.authorizationResponseIssParameterSupported === undefined
    || typeof metadata.authorizationResponseIssParameterSupported === "boolean";
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("MCP credential database request failed.")), { once: true });
  });
}

function idbTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("MCP credential database transaction aborted.")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("MCP credential database transaction failed.")), { once: true });
  });
}
