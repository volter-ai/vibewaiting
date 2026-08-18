import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { SessionAttention, SessionAttentionKind } from "./projection.js";

export interface PersistedMessengerState {
  attention: SessionAttention[];
  drafts: Record<string, string>;
}

export interface MessengerPersistence {
  load(): Promise<PersistedMessengerState>;
  save(state: PersistedMessengerState): Promise<void>;
}

const EMPTY: PersistedMessengerState = { attention: [], drafts: {} };
const ATTENTION_KINDS = new Set<SessionAttentionKind>(["unseen", "finished", "failed"]);
const MAX_RECORDS = 500;
const MAX_DRAFT_CHARS = 50_000;
const MAX_PREVIEW_CHARS = 240;

/** Treat this user-owned file as untrusted input: bound every collection and string before use. */
export function readPersistedMessengerState(raw: unknown): PersistedMessengerState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY, drafts: {} };
  const record = raw as Record<string, unknown>;
  const attention: SessionAttention[] = [];
  if (Array.isArray(record["attention"])) {
    for (const candidate of record["attention"].slice(0, MAX_RECORDS)) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const item = candidate as Record<string, unknown>;
      if (typeof item["key"] !== "string" || !ATTENTION_KINDS.has(item["kind"] as SessionAttentionKind)) continue;
      attention.push({
        key: item["key"],
        kind: item["kind"] as SessionAttentionKind,
        ...(typeof item["preview"] === "string" && item["preview"] !== ""
          ? { preview: item["preview"].slice(0, MAX_PREVIEW_CHARS) }
          : {}),
      });
    }
  }
  const drafts: Record<string, string> = {};
  if (record["drafts"] && typeof record["drafts"] === "object" && !Array.isArray(record["drafts"])) {
    for (const [key, value] of Object.entries(record["drafts"] as Record<string, unknown>).slice(0, MAX_RECORDS)) {
      if (key && typeof value === "string" && value !== "") drafts[key] = value.slice(0, MAX_DRAFT_CHARS);
    }
  }
  return { attention, drafts };
}

/** Atomic, private local storage for messenger chrome only—never transcript contents or locators. */
export class FileMessengerPersistence implements MessengerPersistence {
  readonly path: string;

  constructor(path = join(homedir(), ".vibewaiting", "messenger-state-v1.json")) {
    this.path = path;
  }

  async load(): Promise<PersistedMessengerState> {
    try {
      return readPersistedMessengerState(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return { ...EMPTY, drafts: {} };
      throw error;
    }
  }

  async save(state: PersistedMessengerState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }
}
