// The second PURE seam: discovered session descriptors → the compact row list pushed to the panel.
//
// Global discovery (`discover({ limit })` with no workspace) is what answers "why don't I see all
// my ongoing sessions?" — it returns every harness's persisted sessions across every workspace. This
// module turns those descriptors into something a 300px-wide panel can render, and mints the key the
// panel sends back on click.
//
// Pure by contract, exactly like `projection.ts`: no clock, no `os.homedir()`, no I/O. `now` and
// `home` are PARAMETERS — a relative age computed from an ambient clock is untestable, and a
// fabricated timestamp reads as fact in the UI.
import { sessionFingerprint } from "@volter-ai-dev/supercode-client";
import type { SessionDescriptor, SessionLocator } from "@volter-ai-dev/supercode-harness-sdk";

/** How many rows cross the wire, however many sessions the box has accumulated. */
export const MAX_SESSION_ROWS = 30;

export interface SessionRow {
  /** Stable across pushes and across daemon restarts — the panel echoes it back to attach. */
  key: string;
  harness: string;
  /** The workspace's own folder name — the one thing that identifies a session at a glance. */
  name: string;
  /** The full workspace path with `$HOME` folded to `~` (tooltip / second line). */
  cwd: string;
  /** The session's own title, else its model, else a short session id — never empty. */
  title: string;
  /** Relative age of `updated_at_ms` against the caller's `now`, or `""` when the harness recorded none. */
  age: string;
  updatedAt: number | null;
  messages: number | null;
  /** True for the session the Agent panel is currently showing. */
  active: boolean;
}

/** Which session the Agent panel is on, in the only terms both a descriptor and a snapshot carry. */
export interface ActiveSessionRef {
  harness: string;
  sessionId: string | null;
}

/** What the Agent panel's header says it is following. */
export interface AttachedSession {
  /** The row key, or `""` when the active session has not appeared in discovery yet (a just-started one). */
  key: string;
  harness: string;
  name: string;
  cwd: string;
  title: string;
}

/**
 * FNV-1a over the controller package's own locator fingerprint.
 *
 * The fingerprint is the sanctioned identity string (harness + native id + storage path/selector), but
 * it is deliberately REVERSIBLE — the client README says a view persists the opaque identity, never
 * the fingerprint. Hashing keeps absolute paths out of the page while staying synchronous, which
 * `sessionReconnectIdentity` (SHA-256, async) is not; the daemon holds the reversible mapping.
 */
export function sessionKey(locator: SessionLocator): string {
  const text = sessionFingerprint(locator);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${locator.harness}-${hash.toString(16).padStart(8, "0")}`;
}

/** True when a discovered descriptor IS the session the given controller has active. */
export function matchesActive(descriptor: SessionDescriptor, active: ActiveSessionRef | null | undefined): boolean {
  if (!active || active.sessionId === null) return false;
  return descriptor.locator.harness === active.harness && descriptor.locator.session_id === active.sessionId;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * A compact relative age. `null` in → `""` out: a session whose store recorded no mtime gets no age
 * rather than an invented one. A future timestamp (clock skew between stores) reads as "now".
 */
export function relativeAge(updatedAtMs: number | null | undefined, now: number): string {
  if (typeof updatedAtMs !== "number" || !Number.isFinite(updatedAtMs) || updatedAtMs <= 0) return "";
  const delta = now - updatedAtMs;
  if (delta < MINUTE) return "now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < WEEK) return `${Math.floor(delta / DAY)}d ago`;
  return `${Math.floor(delta / WEEK)}w ago`;
}

/** `$HOME/volter/app` → `~/volter/app`. Anything outside home is left exactly as it is. */
export function shortCwd(cwd: string | null | undefined, home: string): string {
  if (typeof cwd !== "string" || cwd === "") return "";
  const root = home.endsWith("/") ? home.slice(0, -1) : home;
  if (root !== "" && (cwd === root || cwd.startsWith(`${root}/`))) return `~${cwd.slice(root.length)}`;
  return cwd;
}

/** The last path segment — the folder name a human recognizes. `""` for an unknown workspace. */
export function workspaceName(cwd: string | null | undefined): string {
  if (typeof cwd !== "string" || cwd === "") return "";
  const parts = cwd.split("/").filter(Boolean);
  return parts.at(-1) ?? "/";
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

export interface SessionProjectionOptions {
  /** Epoch ms the ages are measured against. Required — see the module doc. */
  now: number;
  /** The home directory folded to `~`. Default `""` (fold nothing). */
  home?: string;
  /** The session the Agent panel is showing, so its row can be marked. */
  active?: ActiveSessionRef | null;
  /** Row cap. Default `MAX_SESSION_ROWS`. */
  max?: number;
}

/** One descriptor → one row. Exported for the test that pins a single row's shape. */
export function projectSession(
  descriptor: SessionDescriptor,
  options: SessionProjectionOptions,
): SessionRow {
  const home = options.home ?? "";
  const cwd = shortCwd(descriptor.cwd, home);
  return {
    key: sessionKey(descriptor.locator),
    harness: descriptor.locator.harness,
    name: workspaceName(descriptor.cwd) || "no workspace",
    cwd,
    title: firstNonEmpty(descriptor.title, descriptor.model, descriptor.locator.session_id.slice(0, 8)),
    age: relativeAge(descriptor.updated_at_ms, options.now),
    updatedAt: descriptor.updated_at_ms,
    messages: descriptor.message_count,
    active: matchesActive(descriptor, options.active),
  };
}

/**
 * The pushed list: freshest first, deduplicated by key, capped. Discovery already sorts by mtime,
 * but the order is re-imposed here because the panel's meaning depends on it and a transport's
 * ordering is not a contract this module gets to assume.
 */
export function projectSessions(
  descriptors: readonly SessionDescriptor[],
  options: SessionProjectionOptions,
): SessionRow[] {
  const max = options.max ?? MAX_SESSION_ROWS;
  const seen = new Set<string>();
  const rows: SessionRow[] = [];
  for (const descriptor of [...descriptors].sort((a, b) => (b.updated_at_ms ?? 0) - (a.updated_at_ms ?? 0))) {
    const row = projectSession(descriptor, options);
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    rows.push(row);
    if (rows.length >= max) break;
  }
  return rows;
}

/**
 * What the Agent panel's header shows. A session the daemon just started has not been persisted (so
 * no row exists yet) — that case falls back to the workspace the controller is actually running in,
 * which is a fact we hold, rather than dropping the header.
 */
export function attachmentFor(
  active: ActiveSessionRef | null | undefined,
  rows: readonly SessionRow[],
  fallbackWorkspace: string,
  home: string,
): AttachedSession | null {
  if (!active || active.harness === "") return null;
  const row = rows.find((r) => r.active);
  if (row) return { key: row.key, harness: row.harness, name: row.name, cwd: row.cwd, title: row.title };
  return {
    key: "",
    harness: active.harness,
    name: workspaceName(fallbackWorkspace) || "no workspace",
    cwd: shortCwd(fallbackWorkspace, home),
    title: "",
  };
}
