import type { VirtualFS } from "almostnode";
import {
  GROK_BUILD_SOURCE_REVISION,
  type GrokBuildSessionSnapshot,
} from "./grok-build-agent.js";
import {
  createStorageEnvelope,
  decodeStorageEnvelope,
  deleteStorageKeys,
  ensureStorageHeadroom,
  readStoragePair,
  replaceStoragePrimary,
  rotateStorageValue,
  storageRevision,
} from "./browser-storage-engine.js";

export {
  requestPersistentBrowserStorage,
  type BrowserStorageStatus,
} from "./browser-storage-engine.js";

const PROJECT = "default";
const PROJECT_BACKUP = "default-backup";
const PROJECT_CONFLICT = "default-conflict";
const AGENT_SESSION = "agent-session";
const AGENT_SESSION_BACKUP = "agent-session-backup";
const AGENT_SESSION_CONFLICT = "agent-session-conflict";
const MAX_PROJECT_ENTRIES = 50_000;
const MAX_PROJECT_BYTES = 128 * 1024 * 1024;
const MAX_PROJECT_PATH_LENGTH = 4_096;
const MAX_AGENT_SESSION_BYTES = 32 * 1024 * 1024;
const MAX_AGENT_INPUT_ITEMS = 10_000;

interface SnapshotEntry {
  path: string;
  type: "file" | "directory";
  content?: string;
}

export interface BrowserProjectSnapshot {
  files: SnapshotEntry[];
}

export interface BrowserProjectAutosave {
  schedule(): void;
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

type RecoveryReporter = (message: string) => void;

let projectWriteTail: Promise<void> = Promise.resolve();
let sessionWriteTail: Promise<void> = Promise.resolve();
let projectRevisionKnown = false;
let projectRevision: string | undefined;
let sessionRevisionKnown = false;
let sessionRevision: string | undefined;


function enqueueWrite(queue: "project" | "session", operation: () => Promise<void>): Promise<void> {
  const tail = queue === "project" ? projectWriteTail : sessionWriteTail;
  const run = tail.then(operation, operation);
  const settled = run.then(() => undefined, () => undefined);
  if (queue === "project") projectWriteTail = settled;
  else sessionWriteTail = settled;
  return run;
}


async function loadRecoverable<T>(
  primaryKey: string,
  backupKey: string,
  validate: (candidate: unknown) => T,
  reportRecovery?: RecoveryReporter,
  setRevision?: (revision: string | undefined) => void,
): Promise<T | undefined> {
  const stored = await readStoragePair(primaryKey, backupKey);
  if (stored.primary === undefined) {
    if (stored.backup === undefined) {
      setRevision?.(undefined);
      return undefined;
    }
  } else {
    try {
      const value = await decodeStorageEnvelope(stored.primary, validate);
      setRevision?.(storageRevision(stored.primary));
      return value;
    } catch (cause) {
      if (stored.backup === undefined) throw cause;
    }
  }
  const recovered = await decodeStorageEnvelope(stored.backup, validate);
  reportRecovery?.("The latest browser save was invalid, so the previous verified save was restored.");
  await replaceStoragePrimary(primaryKey, stored.backup);
  setRevision?.(storageRevision(stored.backup));
  return recovered;
}

function validatePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_PROJECT_PATH_LENGTH
    || !path.startsWith("/") || path.includes("\0") || path.includes("//")) return false;
  return path === "/" || path.slice(1).split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

export function validateBrowserProject(candidate: unknown): BrowserProjectSnapshot {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
    || !Array.isArray((candidate as BrowserProjectSnapshot).files)) {
    throw new Error("Saved browser project has an invalid shape.");
  }
  const files = (candidate as BrowserProjectSnapshot).files;
  if (files.length > MAX_PROJECT_ENTRIES) throw new Error(`Saved browser project exceeds ${MAX_PROJECT_ENTRIES} entries.`);
  const paths = new Set<string>();
  let decodedBytes = 0;
  for (const entry of files) {
    if (!entry || typeof entry !== "object" || !validatePath(entry.path)
      || (entry.type !== "file" && entry.type !== "directory") || paths.has(entry.path)) {
      throw new Error("Saved browser project contains an invalid or duplicate entry.");
    }
    paths.add(entry.path);
    if (entry.type === "directory") {
      if (entry.content !== undefined) throw new Error("Saved browser project directory contains file data.");
      continue;
    }
    if (entry.content !== undefined && (typeof entry.content !== "string"
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(entry.content))) {
      throw new Error("Saved browser project contains invalid file data.");
    }
    const content = entry.content ?? "";
    const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
    decodedBytes += Math.floor(content.length * 3 / 4) - padding;
    if (decodedBytes > MAX_PROJECT_BYTES) throw new Error(`Saved browser project exceeds ${MAX_PROJECT_BYTES} bytes.`);
  }
  return candidate as BrowserProjectSnapshot;
}

function validateAgentSession(candidate: unknown): GrokBuildSessionSnapshot {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Saved Grok session has an invalid shape.");
  }
  const snapshot = candidate as Partial<GrokBuildSessionSnapshot>;
  const validInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
  if (snapshot.version !== 1 || snapshot.sourceRevision !== GROK_BUILD_SOURCE_REVISION
    || typeof snapshot.sessionId !== "string" || snapshot.sessionId.length > 128
    || typeof snapshot.requestId !== "string" || snapshot.requestId.length > 128
    || !validInteger(snapshot.promptIndex) || typeof snapshot.titleCreated !== "boolean"
    || !Array.isArray(snapshot.input) || snapshot.input.length > MAX_AGENT_INPUT_ITEMS
    || (snapshot.estimatedTokens !== undefined && !validInteger(snapshot.estimatedTokens))
    || (snapshot.measuredInputBytes !== undefined && !validInteger(snapshot.measuredInputBytes))
    || (snapshot.compactionCount !== undefined && !validInteger(snapshot.compactionCount))) {
    throw new Error("Saved Grok session contains invalid fields.");
  }
  const serialized = JSON.stringify(snapshot);
  if (new TextEncoder().encode(serialized).byteLength > MAX_AGENT_SESSION_BYTES) {
    throw new Error(`Saved Grok session exceeds ${MAX_AGENT_SESSION_BYTES} bytes.`);
  }
  return candidate as GrokBuildSessionSnapshot;
}


export async function loadBrowserProject(reportRecovery?: RecoveryReporter): Promise<BrowserProjectSnapshot | undefined> {
  await projectWriteTail;
  return loadRecoverable(PROJECT, PROJECT_BACKUP, validateBrowserProject, reportRecovery, (revision) => {
    projectRevisionKnown = true;
    projectRevision = revision;
  });
}

export async function loadBrowserProjectConflict(): Promise<BrowserProjectSnapshot | undefined> {
  await projectWriteTail;
  const stored = await readStoragePair(PROJECT_CONFLICT, PROJECT_CONFLICT);
  return stored.primary === undefined ? undefined : decodeStorageEnvelope(stored.primary, validateBrowserProject);
}

export async function saveBrowserProject(vfs: VirtualFS): Promise<void> {
  const snapshot = validateBrowserProject(vfs.toSnapshot());
  return enqueueWrite("project", async () => {
    const stored = await createStorageEnvelope(snapshot);
    await ensureStorageHeadroom(new TextEncoder().encode(JSON.stringify(stored)).byteLength);
    await rotateStorageValue(PROJECT, PROJECT_BACKUP, PROJECT_CONFLICT, stored, {
      known: projectRevisionKnown,
      ...(projectRevision !== undefined ? { revision: projectRevision } : {}),
    });
    projectRevisionKnown = true;
    projectRevision = stored.checksum;
  });
}

export async function clearBrowserProject(): Promise<void> {
  return enqueueWrite("project", async () => {
    await deleteStorageKeys(PROJECT, PROJECT_BACKUP, PROJECT_CONFLICT);
    projectRevisionKnown = true;
    projectRevision = undefined;
  });
}

export async function loadBrowserAgentSession(reportRecovery?: RecoveryReporter): Promise<GrokBuildSessionSnapshot | undefined> {
  await sessionWriteTail;
  return loadRecoverable(AGENT_SESSION, AGENT_SESSION_BACKUP, validateAgentSession, reportRecovery, (revision) => {
    sessionRevisionKnown = true;
    sessionRevision = revision;
  });
}

export async function loadBrowserAgentSessionConflict(): Promise<GrokBuildSessionSnapshot | undefined> {
  await sessionWriteTail;
  const stored = await readStoragePair(AGENT_SESSION_CONFLICT, AGENT_SESSION_CONFLICT);
  return stored.primary === undefined ? undefined : decodeStorageEnvelope(stored.primary, validateAgentSession);
}

export async function saveBrowserAgentSession(snapshot: GrokBuildSessionSnapshot): Promise<void> {
  const validated = validateAgentSession(structuredClone(snapshot));
  return enqueueWrite("session", async () => {
    const stored = await createStorageEnvelope(validated);
    await ensureStorageHeadroom(new TextEncoder().encode(JSON.stringify(stored)).byteLength);
    await rotateStorageValue(AGENT_SESSION, AGENT_SESSION_BACKUP, AGENT_SESSION_CONFLICT, stored, {
      known: sessionRevisionKnown,
      ...(sessionRevision !== undefined ? { revision: sessionRevision } : {}),
    });
    sessionRevisionKnown = true;
    sessionRevision = stored.checksum;
  });
}

export async function clearBrowserAgentSession(): Promise<void> {
  return enqueueWrite("session", async () => {
    await deleteStorageKeys(AGENT_SESSION, AGENT_SESSION_BACKUP, AGENT_SESSION_CONFLICT);
    sessionRevisionKnown = true;
    sessionRevision = undefined;
  });
}

export function restoreBrowserProject(vfs: VirtualFS, snapshot: BrowserProjectSnapshot): void {
  const validated = validateBrowserProject(snapshot);
  clearVirtualFileSystem(vfs);
  const entries = [...validated.files].sort((left, right) => {
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

export function autosaveBrowserProject(
  vfs: VirtualFS,
  onError: (error: unknown) => void,
  save: (current: VirtualFS) => Promise<void> = saveBrowserProject,
): BrowserProjectAutosave {
  let timer: number | undefined;
  let dirty = false;
  let running: Promise<void> | undefined;

  const drain = async (): Promise<void> => {
    if (running) return running;
    const operation = (async () => {
      while (dirty) {
        dirty = false;
        try {
          await save(vfs);
        } catch (cause) {
          onError(cause);
        }
      }
    })();
    running = operation;
    try {
      await operation;
    } finally {
      if (running === operation) running = undefined;
      if (!dirty && timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    }
  };

  const flush = async (): Promise<void> => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
    await drain();
    if (dirty) await drain();
  };

  const schedule = (): void => {
    dirty = true;
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      void drain();
    }, 250);
  };
  vfs.on("change", schedule);
  vfs.on("delete", schedule);
  return {
    schedule,
    flush,
    async dispose() {
      vfs.off("change", schedule);
      vfs.off("delete", schedule);
      await flush();
    },
  };
}
