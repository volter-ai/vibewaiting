import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { SessionAttention, SessionAttentionKind } from "./projection.js";

export interface PersistedMessengerState {
  attention: SessionAttention[];
  /** Last native conversation boundary already incorporated into attention. */
  observedCursors: Record<string, string>;
  drafts: Record<string, string>;
  preferredLaunchModes: Record<string, "headless" | "terminal">;
}

export interface MessengerPersistence {
  load(): Promise<PersistedMessengerState>;
  save(state: PersistedMessengerState): Promise<void>;
}

const EMPTY: PersistedMessengerState = { attention: [], observedCursors: {}, drafts: {}, preferredLaunchModes: {} };
const ATTENTION_KINDS = new Set<SessionAttentionKind>(["unseen", "finished", "failed"]);
const MAX_RECORDS = 500;
const MAX_DRAFT_CHARS = 50_000;
const MAX_PREVIEW_CHARS = 240;

/** Treat this user-owned file as untrusted input: bound every collection and string before use. */
export function readPersistedMessengerState(raw: unknown): PersistedMessengerState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY, observedCursors: {}, drafts: {}, preferredLaunchModes: {} };
  const record = raw as Record<string, unknown>;
  const hasCursorLedger = record["observedCursors"] !== undefined;
  const attention: SessionAttention[] = [];
  if (Array.isArray(record["attention"])) {
    for (const candidate of record["attention"].slice(0, MAX_RECORDS)) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const item = candidate as Record<string, unknown>;
      if (typeof item["key"] !== "string" || !ATTENTION_KINDS.has(item["kind"] as SessionAttentionKind)) continue;
      // Counts written before the cursor ledger measured changing previews,
      // not native message boundaries. Preserve the attention event while
      // deliberately discarding that false precision during migration.
      const unreadCount = !hasCursorLedger
        ? 1
        : Number.isSafeInteger(item["unreadCount"])
        ? Math.max(1, Math.min(999, item["unreadCount"] as number))
        : 1;
      attention.push({
        key: item["key"],
        kind: item["kind"] as SessionAttentionKind,
        unreadCount,
        ...(Number.isSafeInteger(item["afterMessages"]) && (item["afterMessages"] as number) >= 0
          ? { afterMessages: item["afterMessages"] as number }
          : {}),
        ...(typeof item["preview"] === "string" && item["preview"] !== ""
          ? { preview: item["preview"].slice(0, MAX_PREVIEW_CHARS) }
          : {}),
      });
    }
  }
  const observedCursors: Record<string, string> = {};
  if (record["observedCursors"] && typeof record["observedCursors"] === "object" && !Array.isArray(record["observedCursors"])) {
    for (const [key, value] of Object.entries(record["observedCursors"] as Record<string, unknown>).slice(0, MAX_RECORDS)) {
      if (key && key.length <= 200 && typeof value === "string" && value.length <= 200) observedCursors[key] = value;
    }
  }
  const drafts: Record<string, string> = {};
  if (record["drafts"] && typeof record["drafts"] === "object" && !Array.isArray(record["drafts"])) {
    for (const [key, value] of Object.entries(record["drafts"] as Record<string, unknown>).slice(0, MAX_RECORDS)) {
      if (key && typeof value === "string" && value !== "") drafts[key] = value.slice(0, MAX_DRAFT_CHARS);
    }
  }
  const preferredLaunchModes: Record<string, "headless" | "terminal"> = {};
  if (record["preferredLaunchModes"] && typeof record["preferredLaunchModes"] === "object" && !Array.isArray(record["preferredLaunchModes"])) {
    for (const [key, value] of Object.entries(record["preferredLaunchModes"] as Record<string, unknown>).slice(0, MAX_RECORDS)) {
      if (key && key.length <= 200 && (value === "headless" || value === "terminal")) preferredLaunchModes[key] = value;
    }
  }
  return { attention, observedCursors, drafts, preferredLaunchModes };
}

/** Atomic, private local storage for messenger chrome only—never transcript contents or locators. */
export class FileMessengerPersistence implements MessengerPersistence {
  readonly path: string;

  constructor(path = join(homedir(), ".vibewaiting", "messenger-state-v2.json")) {
    this.path = path;
  }

  async load(): Promise<PersistedMessengerState> {
    try {
      return readPersistedMessengerState(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return { ...EMPTY, observedCursors: {}, drafts: {}, preferredLaunchModes: {} };
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
