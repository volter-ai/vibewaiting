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
import { conversationPreviewText, sessionFingerprint } from "@volter-ai-dev/supercode-client";
import type { SessionDescriptor, SessionLocator } from "@volter-ai-dev/supercode-harness-sdk";

/** How many rows cross the wire, however many sessions the box has accumulated. */
export const MAX_SESSION_ROWS = 30;

/**
 * How recently a session's store must have been written for the row to read as LIVE.
 *
 * Some harnesses expose `live_status`; others only expose the session store's timestamp. Recency is
 * the conservative fallback for those older/no-status descriptors. The UI labels it "Recent", not
 * "active now": a fresh file is evidence of activity, not proof that a process is still running.
 * Five minutes is wide enough to cover a long turn without calling yesterday's session recent.
 */
export const LIVENESS_WINDOW_MS = 5 * 60_000;

export interface SessionRow {
  /** Stable across pushes and across daemon restarts — the panel echoes it back to attach. */
  key: string;
  harness: string;
  /** The workspace's own folder name — the one thing that identifies a session at a glance. */
  name: string;
  /** The full workspace path with `$HOME` folded to `~` (tooltip / second line). */
  cwd: string;
  /** Harness-provided topic, or a stable workspace/session identity — never empty. */
  title: string;
  /** Latest human-visible conversation message, independently projected from the topic. */
  preview: string;
  /** Relative age of the rendered preview message, falling back to session recency when unavailable. */
  age: string;
  /** Timestamp of the rendered preview message; independent from session-store recency. */
  previewUpdatedAt: number | null;
  updatedAt: number | null;
  messages: number | null;
  /** True for the session the Agent panel is currently showing. */
  active: boolean;
  /** True when the store was written within `LIVENESS_WINDOW_MS` of the caller's `now` — see `isLive`. */
  live: boolean;
  /** Process-proven state; busy/idle require a finer harness signal and never come from file recency. */
  runtimeStatus: "running" | "busy" | "idle" | null;
}

/** Which session the Agent panel is on, in the only terms both a descriptor and a snapshot carry. */
export interface ActiveSessionRef {
  harness: string;
  sessionId: string | null;
}

interface NormalizedActivity {
  presence: "persisted" | "running" | "shutting_down";
  turn: "unknown" | "idle" | "working" | "needs_input";
}

function runtimeStatus(descriptor: SessionDescriptor): SessionRow["runtimeStatus"] {
  const activity = (descriptor as SessionDescriptor & { activity?: NormalizedActivity | null }).activity;
  if (activity) {
    if (activity.presence === "persisted") return null;
    if (activity.turn === "working") return "busy";
    if (activity.turn === "idle" || activity.turn === "needs_input") return "idle";
    return "running";
  }
  return descriptor.live_status === "running" || descriptor.live_status === "busy" || descriptor.live_status === "idle"
    ? descriptor.live_status
    : null;
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

/**
 * Is this session one someone is working in right now?
 *
 * Recency of the harness's own store, against the caller's `now` (see `LIVENESS_WINDOW_MS`). This is
 * deliberately separate from the descriptor's explicit `live_status`. A store with no recorded
 * mtime is not recent; clock skew reads as recent, matching `relativeAge`'s "now".
 */
export function isLive(updatedAtMs: number | null | undefined, now: number): boolean {
  if (typeof updatedAtMs !== "number" || !Number.isFinite(updatedAtMs) || updatedAtMs <= 0) return false;
  return now - updatedAtMs <= LIVENESS_WINDOW_MS;
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

function compactTopic(value: string | null | undefined): string {
  if (!value) return "";
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= 72) return text;
  const prefix = text.slice(0, 71);
  const boundary = prefix.lastIndexOf(" ");
  return `${prefix.slice(0, boundary >= 40 ? boundary : 71).trimEnd()}…`;
}

function messengerTitle(descriptor: SessionDescriptor): string {
  const nativeTitle = descriptor.title?.trim() ?? "";
  const workspace = workspaceName(descriptor.cwd);
  const nativeIsWorkspace = nativeTitle === workspace || nativeTitle === descriptor.cwd;
  if (nativeTitle && !nativeIsWorkspace) return compactTopic(nativeTitle);
  if (descriptor.locator.harness !== "claude-code" && descriptor.locator.harness !== "codex") {
    return firstNonEmpty(nativeTitle, workspace, descriptor.locator.session_id.slice(0, 8));
  }
  const openingUserMessages = (descriptor.preview_candidates ?? []).filter(
    (candidate) => candidate.role === undefined || candidate.role === "user",
  );
  return compactTopic(conversationPreviewText(openingUserMessages)) || "Untitled chat";
}

function previewMessage(descriptor: SessionDescriptor): { text: string; updatedAt: number | null } | null {
  for (const candidate of descriptor.latest_message_candidates ?? []) {
    const text = conversationPreviewText([candidate]);
    if (!text) continue;
    const rawTimestamp = candidate.metadata?.timestamp;
    const parsedTimestamp = typeof rawTimestamp === "string" ? Date.parse(rawTimestamp) : Number.NaN;
    return {
      text,
      updatedAt: Number.isFinite(parsedTimestamp) && parsedTimestamp > 0 ? parsedTimestamp : null,
    };
  }
  return null;
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
  /** Keep the caller's order instead of applying the default newest-first sort. */
  preserveOrder?: boolean;
}

/** One descriptor → one row. Exported for the test that pins a single row's shape. */
export function projectSession(
  descriptor: SessionDescriptor,
  options: SessionProjectionOptions,
): SessionRow {
  const home = options.home ?? "";
  const cwd = shortCwd(descriptor.cwd, home);
  const preview = previewMessage(descriptor);
  const previewUpdatedAt = preview?.updatedAt ?? null;
  return {
    key: sessionKey(descriptor.locator),
    harness: descriptor.locator.harness,
    name: workspaceName(descriptor.cwd) || "no workspace",
    cwd,
    title: messengerTitle(descriptor),
    preview: preview?.text ?? "",
    age: relativeAge(previewUpdatedAt ?? descriptor.updated_at_ms, options.now),
    previewUpdatedAt,
    updatedAt: descriptor.updated_at_ms,
    messages: descriptor.message_count,
    active: matchesActive(descriptor, options.active),
    live: isLive(descriptor.updated_at_ms, options.now),
    runtimeStatus: runtimeStatus(descriptor),
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
  const ordered = options.preserveOrder
    ? descriptors
    : [...descriptors].sort((a, b) => (b.updated_at_ms ?? 0) - (a.updated_at_ms ?? 0));
  for (const descriptor of ordered) {
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
