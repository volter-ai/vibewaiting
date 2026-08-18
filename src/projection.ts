// The one PURE seam: a Supercode controller snapshot → the compact state pushed into the widget.
//
// Every push crosses `WidgetHost.push` → CDP → postMessage → the iframe, on EVERY controller
// revision, so this is the module that decides what a coding session costs to mirror into a page.
// It is bounded on both axes (entry count and per-entry characters) and holds no references into
// the snapshot's own objects, so nothing here can grow with the length of an agent session.
//
// Pure by contract: no clock, no I/O, no controller access. Everything it needs is in the snapshot
// argument, which is what makes it the thing the tests can pin.
import type {
  ConversationEntry,
  SupercodeClientSnapshot,
} from "@volter-ai-dev/supercode-client";
import type { JsonValue } from "@volter-ai-dev/supercode-harness-sdk";
import type { AttachedSession, SessionRow } from "./sessions.js";

/** The four tones `lucarne/widget/runtime`'s shell renders on the pill (`Tone` in runtime.ts). */
export type PillTone = "live" | "warn" | "dead" | "off";

export interface WidgetPill {
  tone: PillTone;
  label: string;
}

export type SessionAttentionKind = "unseen" | "finished" | "failed";

export interface SessionAttention {
  key: string;
  kind: SessionAttentionKind;
}

export interface WidgetHarness {
  id: string;
  label: string;
  startable: boolean;
  installed: boolean;
  reason: string | null;
}

/** Daemon bootstrap milestones shown explicitly so a quiet network wait never reads as a freeze. */
export type StartupPhase = "connecting" | "starting" | "discovering" | "ready";

/**
 * The transcript's roles. The first four are Supercode's own message roles; the last three name the
 * non-message conversation entries the controller keeps distinct (`ToolEntry`/`ReasoningEntry`/…),
 * because collapsing a tool call into "assistant said" is exactly the loss the client package's
 * projection exists to avoid.
 */
export type TranscriptRole =
  | "system"
  | "user"
  | "assistant"
  | "tool"
  | "reasoning"
  | "request"
  | "notice";

export interface TranscriptContext {
  id?: string;
  kind?: string;
  label: string;
  detail: string;
}

export interface TranscriptRequestOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | "other";
}

export interface TranscriptRequest {
  requestId: Extract<ConversationEntry, { kind: "request" }>["requestId"];
  requestKind: string;
  payloadText: string;
  options: TranscriptRequestOption[];
  cancellable: boolean;
  status: "pending" | "responded";
  resolution: { optionId: string | null; name: string; kind: string } | null;
}

export interface TranscriptEntry {
  /** The controller's own stable entry id — the widget keys rows on it, so a streaming entry updates in place. */
  id: string;
  role: TranscriptRole;
  text: string;
  /**
   * Epoch milliseconds when the harness recorded this entry, or `null`. The controller's
   * `ConversationEntry` carries NO timestamp field (see the package's `index.d.ts`); the only honest
   * source is the harness's own `metadata`, which not every harness writes — hence nullable, never
   * a fabricated `Date.now()`.
   */
  ts: number | null;
  /** True when `text` was cut to `maxEntryChars` — the widget marks the row rather than lying about length. */
  truncated: boolean;
  /** Tool name, kept separate from its output so the widget can render real tool chrome. */
  label?: string;
  /** Tool input and output stay separate so a completed call does not erase what was invoked. */
  arguments?: string;
  resultText?: string;
  /** Native tool lifecycle, when this is a tool row. */
  status?: "pending" | "completed" | "error";
  /** Whether a reasoning row is still growing. */
  streaming?: boolean;
  /** Structured approval/input request data, retained for VGAI-parity request cards. */
  request?: TranscriptRequest;
  /** Harness notice code, kept distinct from its human-readable text. */
  code?: string;
  /** Typed prompt context used by the work-plan/header projection. */
  context?: TranscriptContext[];
}

export interface TranscriptTaskPlanItem {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "cancelled" | "unknown";
  nativeStatus?: string;
  blockedBy?: string[];
}

export interface TranscriptTaskPlan {
  source: "codex-update-plan" | "claude-tasks" | "opencode-todos" | "none";
  items: TranscriptTaskPlanItem[];
  residueCount: number;
  observedAt: number | null;
}

/**
 * The last attach that FAILED, named by the row key the panel echoed in.
 *
 * An attach can fail for reasons that belong to the session, not to us — the real one that started
 * this: `cannot reconstruct lossless Claude continuation: … missing parentUuid`. The daemon used to
 * log that and push nothing, which left the tapped row saying "opening…" forever. The key is what
 * lets the panel decide the failure is about the row it is waiting on, rather than showing a stale
 * error against some other session.
 */
export interface AttachError {
  key: string;
  message: string;
}

export interface WidgetState {
  pill: WidgetPill;
  /** Current daemon bootstrap milestone. `ready` means the normal session state owns the UI. */
  startup: StartupPhase;
  transcript: TranscriptEntry[];
  /** A turn is in flight (running / interrupting / reconciling) — the composer shows it, never blocks on it. */
  busy: boolean;
  /** The controller operation currently crossing the host boundary, when one exists. */
  operation: string | null;
  /** A native approval or choice is waiting for this conversation. */
  needsInput: boolean;
  /** The active harness id (`claude-code`, `codex`, …), or `""` when nothing is selected yet. */
  harness: string;
  /** Controller lifecycle mode; unlike `canSend`, this does not temporarily change while a turn runs. */
  mode: "none" | "control" | "mirror";
  /** The controller's own honest capability; the composer uses it to prevent guaranteed refusals. */
  canSend: boolean;
  /** True only while the active controlled runtime can accept a native interrupt. */
  canInterrupt: boolean;
  /** True while a pending native request can be answered from this controller. */
  canRespond: boolean;
  /** Workspace used only to compact absolute tool targets in the presentation layer. */
  workspace: string;
  /** Normalized native plan (Codex/Claude/OpenCode) rendered above the transcript. */
  taskPlan: TranscriptTaskPlan;
  /** The controller's last structured error message, or `null`. */
  error: string | null;
  /** Whether retrying the last controller failure is meaningful. */
  recoverable: boolean;
  /** Harnesses available for a lazy-created new chat. */
  harnesses: WidgetHarness[];
  /** Durable attention is owned by the daemon, not inferred from a red inventory badge in the page. */
  attention: SessionAttention[];
  /**
   * Every live/recent coding session on this machine, freshest first — the Sessions panel's whole
   * content. It does NOT come from the snapshot (which only knows the active controller's own
   * workspace): the daemon discovers globally and merges it in, so `project` fills an empty list and
   * never a guessed one.
   */
  sessions: SessionRow[];
  /** Which session the Agent panel is showing, for its header. Merged in by the daemon, same as `sessions`. */
  attached: AttachedSession | null;
  /** The runtime this daemon owns, retained even while the panel temporarily mirrors another session. */
  owned: AttachedSession | null;
  /**
   * Why the last attach did not happen, or `null`. Merged in by the daemon (it owns attaching);
   * cleared the moment another attach is attempted and on any attach that succeeds.
   */
  attachError: AttachError | null;
}

export interface ProjectionOptions {
  /** How many trailing conversation entries to push. Default `DEFAULT_MAX_ENTRIES`. */
  maxEntries?: number;
  /** How many characters of each entry's text to push. Default `DEFAULT_MAX_ENTRY_CHARS`. */
  maxEntryChars?: number;
}

export const DEFAULT_MAX_ENTRIES = 120;
export const DEFAULT_MAX_ENTRY_CHARS = 16_000;
/** The pill is one line of chrome — a long error message is cut here, not in the shell. */
export const MAX_PILL_LABEL_CHARS = 72;
/** An attach failure is one line under a 300px-wide row — a stack-trace-length message is cut here. */
export const MAX_ATTACH_ERROR_CHARS = 200;

/** The metadata keys a harness may record an entry's time under, in the order we trust them. */
const TIMESTAMP_KEYS = ["timestamp", "ts", "time", "created_at", "createdAt", "date"] as const;

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}…`, truncated: true };
}

/** Copy controller-owned JSON before crossing the projection seam. */
function cloneJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, cloneJsonValue(nested)]),
    );
  }
  return value;
}

/**
 * Read an epoch-ms timestamp out of a harness's own metadata, accepting the three encodings that
 * actually occur (epoch ms, epoch seconds, ISO-8601). Returns `null` rather than guessing — an
 * invented timestamp reads as fact in the UI.
 */
export function timestampFromMetadata(metadata: Record<string, string> | undefined): number | null {
  if (!metadata) return null;
  for (const key of TIMESTAMP_KEYS) {
    const raw = metadata[key];
    if (raw === undefined || raw === "") continue;
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) continue;
      // A 10-digit value is epoch SECONDS (through the year 2286); anything larger is already ms.
      return n < 1e11 ? n * 1000 : n;
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Build the pushed attach failure, cut to one row's worth of text. The daemon's one door to it. */
export function toAttachError(key: string, message: string): AttachError {
  return { key, message: truncate(message.trim(), MAX_ATTACH_ERROR_CHARS).text };
}

function requestText(entry: Extract<ConversationEntry, { kind: "request" }>): string {
  const options = entry.options.map((o) => o.name).filter(Boolean).join(" / ");
  const resolved = entry.resolution ? ` → ${entry.resolution.name}` : "";
  return options ? `${entry.requestKind}: ${options}${resolved}` : `${entry.requestKind}${resolved}`;
}

/**
 * One conversation entry → one transcript row, or `null` when the row should not be shown.
 * `visibility: "context"` messages are the one thing dropped — the client package classifies them
 * exactly so a product can hide the harness's injected scaffolding without deleting it upstream.
 */
export function projectEntry(entry: ConversationEntry, maxEntryChars: number): TranscriptEntry | null {
  let role: TranscriptRole;
  let raw: string;
  let ts: number | null = null;
  let detail: Pick<
    TranscriptEntry,
    "label" | "arguments" | "resultText" | "status" | "streaming" | "request" | "code" | "context"
  > = {};
  switch (entry.kind) {
    case "message":
      if (entry.visibility === "context") return null;
      role = entry.role;
      raw = entry.text;
      ts = timestampFromMetadata(entry.metadata);
      if (entry.context?.length) {
        detail = {
          ...detail,
          context: entry.context.map((item) => ({
            ...(item.id ? { id: item.id } : {}),
            ...(item.kind ? { kind: item.kind } : {}),
            label: item.label,
            detail: item.detail,
          })),
        };
      }
      break;
    case "tool":
      role = "tool";
      raw = entry.status === "pending" ? (entry.arguments ?? "").trim() : entry.resultText.trim();
      ts = timestampFromMetadata(entry.metadata);
      {
        const projectedArguments = truncate((entry.arguments ?? "").trim(), maxEntryChars);
        const projectedResult = truncate(entry.resultText.trim(), maxEntryChars);
        detail = {
          label: entry.name ?? "tool",
          status: entry.status,
          arguments: projectedArguments.text,
          resultText: projectedResult.text,
        };
        const projected = truncate(raw ?? "", maxEntryChars);
        return {
          id: entry.id,
          role,
          text: projected.text,
          ts,
          truncated: projectedArguments.truncated || projectedResult.truncated,
          ...detail,
        };
      }
    case "reasoning":
      role = "reasoning";
      raw = entry.text;
      detail = { streaming: entry.streaming };
      break;
    case "request":
      role = "request";
      raw = requestText(entry);
      {
        const payload = truncate(JSON.stringify(entry.payload, null, 2), maxEntryChars);
        detail = {
          request: {
            requestId: cloneJsonValue(entry.requestId),
            requestKind: entry.requestKind,
            payloadText: payload.text,
            options: entry.options.map((option) => ({ ...option })),
            cancellable: entry.cancellable,
            status: entry.status,
            resolution: entry.resolution ? { ...entry.resolution } : null,
          },
        };
        const projected = truncate(raw ?? "", maxEntryChars);
        return {
          id: entry.id,
          role,
          text: projected.text,
          ts,
          truncated: projected.truncated || payload.truncated,
          ...detail,
        };
      }
    case "notice":
      role = "notice";
      raw = entry.text || entry.code;
      detail = { code: entry.code };
      break;
  }
  const { text, truncated } = truncate(raw ?? "", maxEntryChars);
  return { id: entry.id, role, text, ts, truncated, ...detail };
}

/** The trailing window of renderable rows — capped AFTER context messages are dropped, so hidden scaffolding never eats the window. */
export function projectTranscript(
  conversation: readonly ConversationEntry[],
  options: ProjectionOptions = {},
): TranscriptEntry[] {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxEntryChars = options.maxEntryChars ?? DEFAULT_MAX_ENTRY_CHARS;
  const rows: TranscriptEntry[] = [];
  // Walk backwards so the cap costs O(maxEntries) regardless of how long the session is.
  for (let i = conversation.length - 1; i >= 0 && rows.length < maxEntries; i -= 1) {
    const entry = conversation[i];
    if (!entry) continue;
    const row = projectEntry(entry, maxEntryChars);
    if (row) rows.push(row);
  }
  rows.reverse();
  return rows;
}

/** True while a turn is in flight — `reconciling` counts, because input is still disabled upstream. */
export function isBusy(snapshot: SupercodeClientSnapshot): boolean {
  return snapshot.turn.state !== "idle";
}

/**
 * The status pill. Ordered by what the human most needs to know: the transport being down beats a
 * structured error, which beats the turn state, which beats the connection mode.
 */
export function derivePill(snapshot: SupercodeClientSnapshot): WidgetPill {
  const harness = snapshot.activeHarness ?? "agent";
  const label = (text: string): string => truncate(text, MAX_PILL_LABEL_CHARS).text;

  if (snapshot.availability === "loading") return { tone: "off", label: label("connecting…") };
  if (snapshot.availability === "unavailable") {
    return { tone: "dead", label: label(snapshot.error?.message ?? "supercode unavailable") };
  }
  if (snapshot.availability === "error") {
    return { tone: "dead", label: label(snapshot.error?.message ?? "supercode error") };
  }
  if (snapshot.error) return { tone: "warn", label: label(snapshot.error.message) };

  switch (snapshot.turn.state) {
    case "running":
      return { tone: "live", label: label(`${harness} working…`) };
    case "interrupting":
      return { tone: "warn", label: label("interrupting…") };
    case "reconciling":
      return { tone: "live", label: label("syncing…") };
    case "idle":
      break;
  }

  if (snapshot.connection.mode === "none") return { tone: "off", label: label("no session") };
  if (snapshot.connection.mode === "mirror") {
    if (snapshot.connection.messaging === "live_peer") return { tone: "live", label: label(`${harness} live`) };
    return { tone: "warn", label: label(`${harness} (read-only)`) };
  }
  return { tone: "live", label: label(`${harness} ready`) };
}

/**
 * Controller snapshot → the exact object pushed to the widget. Pure; safe to call on every revision.
 *
 * `sessions`/`attached`/`attachError` come out EMPTY: they are machine-wide facts the daemon holds
 * (global discovery, which controller is active, how the last attach went), not snapshot facts, and
 * this function has no business inventing them. `src/daemon.ts` merges them over this result.
 */
export function project(snapshot: SupercodeClientSnapshot, options: ProjectionOptions = {}): WidgetState {
  return {
    pill: derivePill(snapshot),
    startup: "ready",
    transcript: projectTranscript(snapshot.conversation, options),
    busy: isBusy(snapshot),
    operation: snapshot.operation,
    needsInput: snapshot.requests.some((request) => request.status === "pending"),
    harness: snapshot.activeHarness ?? "",
    mode: snapshot.connection.mode,
    canSend: snapshot.availableActions.send,
    canInterrupt: snapshot.availableActions.interrupt,
    canRespond: snapshot.availableActions.respond,
    workspace: snapshot.workspace,
    taskPlan: {
      source: snapshot.taskPlan.source,
      items: snapshot.taskPlan.items.map((item) => ({
        ...item,
        ...(item.blockedBy ? { blockedBy: [...item.blockedBy] } : {}),
      })),
      residueCount: snapshot.taskPlan.residue.length,
      observedAt: snapshot.taskPlan.observedAt,
    },
    error: snapshot.error?.message ?? null,
    recoverable: snapshot.error?.recoverable === true,
    harnesses: snapshot.harnesses.map((harness) => ({
      id: harness.id,
      label: harness.display_name,
      startable: harness.availableActions.start,
      installed: harness.installed,
      reason: harness.reason,
    })),
    attention: [],
    sessions: [],
    attached: null,
    owned: null,
    attachError: null,
  };
}
