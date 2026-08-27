import type { VirtualFS } from "almostnode";
import type { GrokBuildSessionSnapshot } from "./grok-build-agent.js";

const DATABASE = "vibewaiting-browser-agent";
const STORE = "projects";
const PROJECT = "default";
const AGENT_SESSION = "agent-session";

interface SnapshotEntry {
  path: string;
  type: "file" | "directory";
  content?: string;
}

export interface BrowserProjectSnapshot {
  files: SnapshotEntry[];
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the browser project database."));
  });
}

async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = operation(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Browser project storage failed."));
      tx.onabort = () => reject(tx.error ?? new Error("Browser project storage was aborted."));
    });
  } finally {
    db.close();
  }
}

export async function loadBrowserProject(): Promise<BrowserProjectSnapshot | undefined> {
  return transaction("readonly", (store) => store.get(PROJECT)) as Promise<BrowserProjectSnapshot | undefined>;
}

export async function saveBrowserProject(vfs: VirtualFS): Promise<void> {
  const snapshot = vfs.toSnapshot() as BrowserProjectSnapshot;
  await transaction("readwrite", (store) => store.put(snapshot, PROJECT));
}

export async function clearBrowserProject(): Promise<void> {
  await transaction("readwrite", (store) => store.delete(PROJECT));
}

export async function loadBrowserAgentSession(): Promise<GrokBuildSessionSnapshot | undefined> {
  return transaction("readonly", (store) => store.get(AGENT_SESSION)) as Promise<GrokBuildSessionSnapshot | undefined>;
}

export async function saveBrowserAgentSession(snapshot: GrokBuildSessionSnapshot): Promise<void> {
  await transaction("readwrite", (store) => store.put(snapshot, AGENT_SESSION));
}

export async function clearBrowserAgentSession(): Promise<void> {
  await transaction("readwrite", (store) => store.delete(AGENT_SESSION));
}

export function restoreBrowserProject(vfs: VirtualFS, snapshot: BrowserProjectSnapshot): void {
  clearVirtualFileSystem(vfs);
  const entries = [...snapshot.files].sort((left, right) => {
    const depth = (value: string): number => value.split("/").length;
    return depth(left.path) - depth(right.path) || left.path.localeCompare(right.path);
  });
  for (const entry of entries) {
    if (entry.path === "/") continue;
    if (entry.type === "directory") {
      vfs.mkdirSync(entry.path, { recursive: true });
      continue;
    }
    const binary = atob(entry.content || "");
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parent = entry.path.slice(0, entry.path.lastIndexOf("/")) || "/";
    vfs.mkdirSync(parent, { recursive: true });
    vfs.writeFileSync(entry.path, bytes);
  }
}

export function clearVirtualFileSystem(vfs: VirtualFS, path = "/", preserve: readonly string[] = []): void {
  for (const name of vfs.readdirSync(path)) {
    const child = path === "/" ? `/${name}` : `${path}/${name}`;
    if (preserve.includes(child)) continue;
    if (vfs.statSync(child).isDirectory()) {
      clearVirtualFileSystem(vfs, child, preserve);
      if (vfs.readdirSync(child).length === 0) vfs.rmdirSync(child);
    } else {
      vfs.unlinkSync(child);
    }
  }
}

export function autosaveBrowserProject(vfs: VirtualFS, onError: (error: unknown) => void): () => void {
  let timer: number | undefined;
  const schedule = (): void => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      void saveBrowserProject(vfs).catch(onError);
    }, 250);
  };
  vfs.on("change", schedule);
  vfs.on("delete", schedule);
  return schedule;
}
