const DATABASE = "vibewaiting-browser-agent";
const STORE = "projects";
const STORAGE_VERSION = 1;

export interface BrowserStorageStatus {
  persisted: boolean;
  usage?: number;
  quota?: number;
}

export interface StoredEnvelope<T> {
  storageVersion: 1;
  savedAt: number;
  checksum: string;
  payload: T;
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open the browser project database."));
    request.onblocked = () => reject(new Error("Browser project storage is blocked by another open tab."));
  });
}

function transactionError(tx: IDBTransaction, fallback: string): Error {
  return tx.error ?? new Error(fallback);
}

export async function readStoragePair(primaryKey: string, backupKey: string): Promise<{ primary: unknown; backup: unknown }> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const primaryRequest = store.get(primaryKey);
      const backupRequest = store.get(backupKey);
      let primary: unknown;
      let backup: unknown;
      primaryRequest.onsuccess = () => { primary = primaryRequest.result; };
      backupRequest.onsuccess = () => { backup = backupRequest.result; };
      tx.oncomplete = () => resolve({ primary, backup });
      tx.onerror = () => reject(transactionError(tx, "Browser project storage failed."));
      tx.onabort = () => reject(transactionError(tx, "Browser project storage was aborted."));
    });
  } finally {
    db.close();
  }
}

export function storageRevision(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<StoredEnvelope<unknown>>;
  return candidate.storageVersion === STORAGE_VERSION && typeof candidate.checksum === "string"
    ? candidate.checksum
    : undefined;
}

export async function rotateStorageValue(
  primaryKey: string,
  backupKey: string,
  conflictKey: string,
  value: unknown,
  expected: { known: boolean; revision?: string },
): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const current = store.get(primaryKey);
      let conflict = false;
      current.onsuccess = () => {
        if (expected.known && storageRevision(current.result) !== expected.revision) {
          conflict = true;
          store.put(value, conflictKey);
          return;
        }
        if (current.result !== undefined) store.put(current.result, backupKey);
        store.put(value, primaryKey);
      };
      tx.oncomplete = () => conflict
        ? reject(new Error("Browser project storage changed in another tab; this tab did not overwrite it, and its latest save was preserved as a conflict copy."))
        : resolve();
      tx.onerror = () => reject(transactionError(tx, "Browser project storage failed."));
      tx.onabort = () => reject(transactionError(tx, "Browser project storage was aborted."));
    });
  } finally {
    db.close();
  }
}

export async function replaceStoragePrimary(primaryKey: string, value: unknown): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, primaryKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(transactionError(tx, "Browser project storage failed."));
      tx.onabort = () => reject(transactionError(tx, "Browser project storage was aborted."));
    });
  } finally {
    db.close();
  }
}

export async function deleteStorageKeys(...keys: string[]): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const key of keys) store.delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(transactionError(tx, "Browser project storage failed."));
      tx.onabort = () => reject(transactionError(tx, "Browser project storage was aborted."));
    });
  } finally {
    db.close();
  }
}

async function checksum(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export async function createStorageEnvelope<T>(payload: T): Promise<StoredEnvelope<T>> {
  return {
    storageVersion: STORAGE_VERSION,
    savedAt: Date.now(),
    checksum: await checksum(JSON.stringify(payload)),
    payload,
  };
}

export async function decodeStorageEnvelope<T>(value: unknown, validate: (candidate: unknown) => T): Promise<T> {
  if (value && typeof value === "object" && !Array.isArray(value)
    && (value as Partial<StoredEnvelope<T>>).storageVersion === STORAGE_VERSION) {
    const stored = value as Partial<StoredEnvelope<T>>;
    if (typeof stored.checksum !== "string" || stored.payload === undefined
      || await checksum(JSON.stringify(stored.payload)) !== stored.checksum) {
      throw new Error("Saved browser data failed its integrity check.");
    }
    return validate(stored.payload);
  }
  return validate(value);
}

export async function ensureStorageHeadroom(serializedBytes: number): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return;
  try {
    const estimate = await navigator.storage.estimate();
    if (estimate.quota !== undefined && estimate.usage !== undefined
      && serializedBytes > Math.max(0, estimate.quota - estimate.usage)) {
      throw new DOMException("The browser does not have enough storage quota for this project save.", "QuotaExceededError");
    }
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "QuotaExceededError") throw cause;
  }
}

export async function requestPersistentBrowserStorage(): Promise<BrowserStorageStatus> {
  if (typeof navigator === "undefined" || !navigator.storage) return { persisted: false };
  const alreadyPersisted = await navigator.storage.persisted?.().catch(() => false) ?? false;
  const persisted = alreadyPersisted || await navigator.storage.persist?.().catch(() => false) || false;
  const estimate: StorageEstimate = await navigator.storage.estimate?.().catch(() => ({})) ?? {};
  return {
    persisted,
    ...(estimate.usage !== undefined ? { usage: estimate.usage } : {}),
    ...(estimate.quota !== undefined ? { quota: estimate.quota } : {}),
  };
}
