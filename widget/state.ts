// The panel's own pure logic, kept out of the view so it can be tested in node.
//
// The iframe receives whatever the host pushed, shallow-merged by `lucarne/widget/runtime` into one
// accumulating `state` object typed `unknown` — so the FIRST thing the panel does is re-establish
// the shape defensively (a page reload re-mounts the widget before any push has landed, and the
// runtime hands that empty accumulator straight to `render`).
import type {
  AttachError,
  TranscriptContext,
  TranscriptEntry,
  TranscriptRequest,
  TranscriptRole,
  StartupPhase,
  TranscriptTaskPlan,
  WidgetState,
} from "../src/projection.js";
import type { AttachedSession, SessionRow } from "../src/sessions.js";

export type { AttachError, AttachedSession, SessionRow, StartupPhase, TranscriptEntry, TranscriptRole, WidgetState };

export const EMPTY_STATE: WidgetState = {
  pill: { tone: "off", label: "connecting…" },
  startup: "connecting",
  transcript: [],
  busy: false,
  harness: "",
  mode: "none",
  canSend: false,
  canInterrupt: false,
  canRespond: false,
  workspace: "",
  taskPlan: { source: "none", items: [], residueCount: 0, observedAt: null },
  error: null,
  sessions: [],
  attached: null,
  owned: null,
  attachError: null,
};

/** The messenger's two views: the session list (root) and one session's transcript. */
export type View = "list" | "chat";

export interface StartupMessage {
  title: string;
  detail: string;
  step: number;
}

function harnessDisplayName(harness: string): string {
  const known: Record<string, string> = {
    "claude-code": "Claude Code",
    codex: "Codex",
    opencode: "OpenCode",
    pi: "Pi",
    grok: "Grok",
  };
  return known[harness] ?? harness;
}

/** Human copy for each real bootstrap milestone; the step feeds the small visual progress track. */
export function startupMessage(phase: StartupPhase, harness: string): StartupMessage {
  switch (phase) {
    case "connecting":
      return {
        title: "Connecting to coding agents",
        detail: "Checking installed harnesses and their capabilities.",
        step: 0,
      };
    case "starting":
      return {
        title: harness ? `Starting ${harnessDisplayName(harness)}` : "Starting your coding agent",
        detail: "Opening a controlled session in this workspace.",
        step: 1,
      };
    case "discovering":
      return {
        title: "Loading recent sessions",
        detail: "Scanning Claude, Codex, OpenCode, Pi, and Grok.",
        step: 2,
      };
    case "ready":
      return { title: "Ready", detail: "Coding sessions are up to date.", step: 3 };
  }
}

const TONES = new Set(["live", "warn", "dead", "off"]);
const ROLES = new Set<string>(["system", "user", "assistant", "tool", "reasoning", "request", "notice"]);
const STARTUP_PHASES = new Set<StartupPhase>(["connecting", "starting", "discovering", "ready"]);
const REQUEST_OPTION_KINDS = new Set(["allow_once", "allow_always", "reject_once", "reject_always", "other"]);
const TASK_PLAN_SOURCES = new Set(["codex-update-plan", "claude-tasks", "opencode-todos", "none"]);
const TASK_PLAN_STATUSES = new Set(["pending", "in_progress", "completed", "cancelled", "unknown"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isJsonValue(value: unknown): value is TranscriptRequest["requestId"] {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function readContext(raw: unknown): TranscriptContext[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const context: TranscriptContext[] = [];
  for (const candidate of raw) {
    if (!isRecord(candidate)) continue;
    const { id, kind, label, detail } = candidate;
    if (typeof label !== "string" || typeof detail !== "string") continue;
    context.push({ ...(typeof id === "string" ? { id } : {}), ...(typeof kind === "string" ? { kind } : {}), label, detail });
  }
  return context.length ? context : undefined;
}

function readRequest(raw: unknown): TranscriptRequest | undefined {
  if (!isRecord(raw)) return undefined;
  const { requestId, requestKind, payloadText, options, cancellable, status, resolution } = raw;
  if (!isJsonValue(requestId) || typeof requestKind !== "string" || typeof payloadText !== "string") return undefined;
  if (!Array.isArray(options) || (status !== "pending" && status !== "responded")) return undefined;
  const parsedOptions: TranscriptRequest["options"] = [];
  for (const candidate of options) {
    if (!isRecord(candidate)) continue;
    const { optionId, name, kind } = candidate;
    if (typeof optionId !== "string" || typeof name !== "string") continue;
    if (!REQUEST_OPTION_KINDS.has(String(kind))) continue;
    parsedOptions.push({ optionId, name, kind: kind as TranscriptRequest["options"][number]["kind"] });
  }
  let parsedResolution: TranscriptRequest["resolution"] = null;
  if (isRecord(resolution) && typeof resolution.name === "string" && typeof resolution.kind === "string") {
    parsedResolution = {
      optionId: typeof resolution.optionId === "string" ? resolution.optionId : null,
      name: resolution.name,
      kind: resolution.kind,
    };
  }
  return {
    requestId,
    requestKind,
    payloadText,
    options: parsedOptions,
    cancellable: cancellable === true,
    status,
    resolution: parsedResolution,
  };
}

function readEntry(raw: unknown): TranscriptEntry | null {
  if (!isRecord(raw)) return null;
  const { id, role, text, ts, truncated, label, arguments: argumentsText, resultText, status, streaming, request, code, context } = raw;
  if (typeof id !== "string" || typeof text !== "string") return null;
  if (typeof role !== "string" || !ROLES.has(role)) return null;
  const entry: TranscriptEntry = {
    id,
    role: role as TranscriptRole,
    text,
    ts: typeof ts === "number" ? ts : null,
    truncated: truncated === true,
  };
  if (role === "tool") {
    if (typeof label === "string" && label !== "") entry.label = label;
    if (typeof argumentsText === "string") entry.arguments = argumentsText;
    if (typeof resultText === "string") entry.resultText = resultText;
    if (status === "pending" || status === "completed" || status === "error") entry.status = status;
  }
  if (role === "reasoning" && typeof streaming === "boolean") entry.streaming = streaming;
  if (role === "request") {
    const parsed = readRequest(request);
    if (parsed) entry.request = parsed;
  }
  if (role === "notice" && typeof code === "string") entry.code = code;
  if (role === "user" || role === "assistant" || role === "system") {
    const parsed = readContext(context);
    if (parsed) entry.context = parsed;
  }
  return entry;
}

function readTaskPlan(raw: unknown): TranscriptTaskPlan {
  if (!isRecord(raw)) return EMPTY_STATE.taskPlan;
  const source = raw["source"];
  const items: TranscriptTaskPlan["items"] = [];
  if (Array.isArray(raw["items"])) {
    for (const candidate of raw["items"]) {
      if (!isRecord(candidate)) continue;
      const { id, title, status, nativeStatus, blockedBy } = candidate;
      if (typeof id !== "string" || typeof title !== "string") continue;
      if (!TASK_PLAN_STATUSES.has(String(status))) continue;
      items.push({
        id,
        title,
        status: status as TranscriptTaskPlan["items"][number]["status"],
        ...(typeof nativeStatus === "string" ? { nativeStatus } : {}),
        ...(Array.isArray(blockedBy) && blockedBy.every((item) => typeof item === "string")
          ? { blockedBy: blockedBy as string[] }
          : {}),
      });
    }
  }
  return {
    source: typeof source === "string" && TASK_PLAN_SOURCES.has(source)
      ? (source as TranscriptTaskPlan["source"])
      : "none",
    items,
    residueCount: typeof raw["residueCount"] === "number" ? raw["residueCount"] : 0,
    observedAt: typeof raw["observedAt"] === "number" ? raw["observedAt"] : null,
  };
}

function readSessionRow(raw: unknown): SessionRow | null {
  if (!isRecord(raw)) return null;
  const { key, harness, name, cwd, title, age, updatedAt, messages, active, live } = raw;
  if (typeof key !== "string" || key === "") return null;
  if (typeof harness !== "string") return null;
  return {
    key,
    harness,
    name: typeof name === "string" ? name : "",
    cwd: typeof cwd === "string" ? cwd : "",
    title: typeof title === "string" ? title : "",
    age: typeof age === "string" ? age : "",
    updatedAt: typeof updatedAt === "number" ? updatedAt : null,
    messages: typeof messages === "number" ? messages : null,
    active: active === true,
    live: live === true,
  };
}

/** The host's report of a failed attach, or `null` — a patch without one leaves no stale error behind. */
function readAttachError(raw: unknown): AttachError | null {
  if (!isRecord(raw)) return null;
  const { key, message } = raw;
  if (typeof key !== "string" || typeof message !== "string" || message === "") return null;
  return { key, message };
}

function readAttached(raw: unknown): AttachedSession | null {
  if (!isRecord(raw)) return null;
  const { key, harness, name, cwd, title } = raw;
  if (typeof harness !== "string" || harness === "") return null;
  return {
    key: typeof key === "string" ? key : "",
    harness,
    name: typeof name === "string" ? name : "",
    cwd: typeof cwd === "string" ? cwd : "",
    title: typeof title === "string" ? title : "",
  };
}

/** Normalize the merged patch accumulator into a `WidgetState` — never throws, never renders `undefined`. */
export function readWidgetState(raw: unknown): WidgetState {
  if (!isRecord(raw)) return EMPTY_STATE;
  const pillRaw = isRecord(raw["pill"]) ? raw["pill"] : {};
  const tone = pillRaw["tone"];
  const label = pillRaw["label"];
  const transcript = Array.isArray(raw["transcript"])
    ? raw["transcript"].map(readEntry).filter((e): e is TranscriptEntry => e !== null)
    : [];
  return {
    pill: {
      tone: typeof tone === "string" && TONES.has(tone) ? (tone as WidgetState["pill"]["tone"]) : "off",
      label: typeof label === "string" ? label : "",
    },
    startup: typeof raw["startup"] === "string" && STARTUP_PHASES.has(raw["startup"] as StartupPhase)
      ? (raw["startup"] as StartupPhase)
      : "connecting",
    transcript,
    busy: raw["busy"] === true,
    harness: typeof raw["harness"] === "string" ? raw["harness"] : "",
    mode: raw["mode"] === "control" || raw["mode"] === "mirror" ? raw["mode"] : "none",
    canSend: raw["canSend"] === true,
    canInterrupt: raw["canInterrupt"] === true,
    canRespond: raw["canRespond"] === true,
    workspace: typeof raw["workspace"] === "string" ? raw["workspace"] : "",
    taskPlan: readTaskPlan(raw["taskPlan"]),
    error: typeof raw["error"] === "string" ? raw["error"] : null,
    sessions: Array.isArray(raw["sessions"])
      ? raw["sessions"].map(readSessionRow).filter((s): s is SessionRow => s !== null)
      : [],
    attached: readAttached(raw["attached"]),
    owned: readAttached(raw["owned"]),
    attachError: readAttachError(raw["attachError"]),
  };
}

/**
 * The rows the list shows.
 *
 * Discovery's rows, plus the daemon-owned runtime when discovery has not seen it yet. A brand-new
 * runtime has no persisted file until its first turn; keeping it here even while a foreign mirror
 * is open is what makes "return to my chat" possible. Its key is `""`, which the view turns into a
 * target-free `release` intent when a mirror currently owns the panel.
 */
export function listRows(state: WidgetState): SessionRow[] {
  const owned = state.owned;
  if (owned === null || owned.key !== "") return state.sessions;
  return [
    {
      key: "",
      harness: owned.harness,
      name: owned.name,
      cwd: owned.cwd,
      title: owned.title,
      age: "",
      updatedAt: null,
      messages: null,
      active: state.attached?.key === "",
      // The panel is attached to it right now — nothing is more live than that, and there is no
      // descriptor to read a timestamp from.
      live: true,
    },
    ...state.sessions,
  ];
}

/**
 * Has the host confirmed the attach this panel asked for? The list marks the tapped row as opening
 * until it has, and only then does the messenger slide to the chat view — a view that switched on
 * the click would show the PREVIOUS session's transcript under the new session's name.
 */
export function attachSettled(awaitingKey: string | null, attached: AttachedSession | null): boolean {
  if (awaitingKey === null || attached === null) return false;
  return attached.key === awaitingKey;
}

/** What happened to the attach the list is waiting on. `"waiting"` covers "nothing asked for" too. */
export type AttachOutcome = "waiting" | "attached" | "failed";

/**
 * The awaited attach, settled — the ONE place "opening…" is allowed to end.
 *
 * It ends two ways, and a row that can only end the happy way is the black hole this exists to
 * close: before the host reported failures, a session that could not be reconstructed left its row
 * saying "opening…" for as long as the panel was open. Success wins over a failure carrying the
 * same key (the host clears the error on the attempt that succeeds, so that pairing is stale), and
 * a failure about a DIFFERENT row is not this row's news.
 */
export function attachOutcome(
  awaitingKey: string | null,
  attached: AttachedSession | null,
  attachError: AttachError | null,
): AttachOutcome {
  if (awaitingKey === null) return "waiting";
  if (attachSettled(awaitingKey, attached)) return "attached";
  if (attachError !== null && attachError.key === awaitingKey) return "failed";
  return "waiting";
}

/**
 * How long a failed attach stays under its row before the list goes quiet again. Long enough to
 * read a two-line reason, short enough that it is gone by the time you come back to the panel.
 */
export const ATTACH_ERROR_LINGER_MS = 8000;

/**
 * The shell pill — the one thing visible while the widget is closed. It reports the attached
 * session's status when there is one, and otherwise how many sessions are waiting to be opened
 * (which is the only useful thing to say when nothing is attached).
 */
export function pillFor(state: WidgetState): WidgetState["pill"] {
  if (state.attached !== null) return state.pill;
  const count = state.sessions.length;
  if (count === 0) return state.pill;
  return { tone: state.pill.tone, label: `${count} session${count === 1 ? "" : "s"}` };
}

/** Enter sends; Shift+Enter is a newline; an IME composition commit is never a send. */
export function isSendKey(e: { key: string; shiftKey: boolean; isComposing?: boolean }): boolean {
  return e.key === "Enter" && !e.shiftKey && e.isComposing !== true;
}

/**
 * Should the transcript auto-scroll? Only when the reader is already at (or within a line or two of)
 * the bottom — scrolling up to read something must not be yanked away by the next streamed delta.
 */
export function nearBottom(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  slackPx = 48,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slackPx;
}

/**
 * A sent prompt is queued in the page and drained by the host on its own tick (~1.2s), so the panel
 * shows the user's line as PENDING until the real transcript carries it. Resolved when a user row
 * with that exact text has arrived — matching on text, because the controller mints the row's id.
 */
export function pendingResolved(pending: string | null, transcript: readonly TranscriptEntry[]): boolean {
  if (pending === null) return true;
  return transcript.some((e) => e.role === "user" && e.text.trim() === pending.trim());
}

/** The short label drawn on a transcript row. */
export function roleLabel(role: TranscriptRole): string {
  switch (role) {
    case "assistant":
      return "agent";
    case "reasoning":
      return "thinking";
    case "request":
      return "asks";
    default:
      return role;
  }
}
