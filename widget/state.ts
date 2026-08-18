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
  SessionAttention,
  SessionAttentionKind,
  WidgetHarness,
  WidgetState,
} from "../src/projection.js";
import type { AttachedSession, SessionRow } from "../src/sessions.js";

export type {
  AttachError,
  AttachedSession,
  SessionAttention,
  SessionAttentionKind,
  SessionRow,
  StartupPhase,
  TranscriptEntry,
  TranscriptRole,
  WidgetHarness,
  WidgetState,
};

export const EMPTY_STATE: WidgetState = {
  pill: { tone: "off", label: "connecting…" },
  startup: "connecting",
  transcript: [],
  busy: false,
  operation: null,
  needsInput: false,
  harness: "",
  mode: "none",
  canSend: false,
  canResume: false,
  canBranch: false,
  canAttach: false,
  canDetach: false,
  canOpenTerminal: false,
  strategy: null,
  messaging: null,
  canInterrupt: false,
  canRespond: false,
  workspace: "",
  taskPlan: { source: "none", items: [], residueCount: 0, observedAt: null },
  error: null,
  recoverable: false,
  harnesses: [],
  attention: [],
  sessions: [],
  attached: null,
  owned: null,
  attachError: null,
};

/** Conversation-first navigation: history and compose sit behind the active thread. */
export type View = "list" | "chat" | "new";

/**
 * Choose the screen shown when the collapsed messenger is opened. Unseen conversations must be
 * discoverable from the badge that announced them, so they take precedence over the last local
 * screen. Action required by the currently attached agent is deliberately not folded into this
 * rule: that state should still land directly in its actionable chat.
 */
export function panelLandingView(state: Pick<WidgetState, "attention">, remembered: View): View {
  return state.attention.length > 0 ? "list" : remembered;
}

/** Visual state of the collapsed messenger control. */
export type PillMode = "connecting" | "idle" | "unread" | "working" | "needs-input" | "error";

/** Rest as one messenger line, then grow with a real multiline draft without taking the panel. */
export function composerHeight(scrollHeight: number): number {
  return Math.max(34, Math.min(150, Number.isFinite(scrollHeight) ? scrollHeight : 34));
}

export interface StartupMessage {
  title: string;
  detail: string;
  step: number;
}

export function harnessDisplayName(harness: string): string {
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
const ATTENTION_KINDS = new Set<SessionAttentionKind>(["unseen", "finished", "failed"]);

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
  const { key, harness, name, cwd, title, age, updatedAt, messages, active, live, runtimeStatus } = raw;
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
    runtimeStatus: runtimeStatus === "busy" || runtimeStatus === "idle" ? runtimeStatus : null,
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

function readHarness(raw: unknown): WidgetHarness | null {
  if (!isRecord(raw)) return null;
  const { id, label, startable, installed, reason } = raw;
  if (typeof id !== "string" || id === "" || typeof label !== "string") return null;
  return {
    id,
    label,
    startable: startable === true,
    installed: installed === true,
    reason: typeof reason === "string" ? reason : null,
  };
}

function readAttention(raw: unknown): SessionAttention | null {
  if (!isRecord(raw)) return null;
  const { key, kind } = raw;
  if (typeof key !== "string" || typeof kind !== "string" || !ATTENTION_KINDS.has(kind as SessionAttentionKind)) return null;
  return { key, kind: kind as SessionAttentionKind };
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
    operation: typeof raw["operation"] === "string" ? raw["operation"] : null,
    needsInput: raw["needsInput"] === true,
    harness: typeof raw["harness"] === "string" ? raw["harness"] : "",
    mode: raw["mode"] === "control" || raw["mode"] === "mirror" ? raw["mode"] : "none",
    canSend: raw["canSend"] === true,
    canResume: raw["canResume"] === true,
    canBranch: raw["canBranch"] === true,
    canAttach: raw["canAttach"] === true,
    canDetach: raw["canDetach"] === true,
    canOpenTerminal: raw["canOpenTerminal"] === true,
    strategy: raw["strategy"] === "start" || raw["strategy"] === "resume" || raw["strategy"] === "attach" || raw["strategy"] === "branch"
      ? raw["strategy"]
      : null,
    messaging: raw["messaging"] === "live_peer" ? "live_peer" : null,
    canInterrupt: raw["canInterrupt"] === true,
    canRespond: raw["canRespond"] === true,
    workspace: typeof raw["workspace"] === "string" ? raw["workspace"] : "",
    taskPlan: readTaskPlan(raw["taskPlan"]),
    error: typeof raw["error"] === "string" ? raw["error"] : null,
    recoverable: raw["recoverable"] === true,
    harnesses: Array.isArray(raw["harnesses"])
      ? raw["harnesses"].map(readHarness).filter((h): h is WidgetHarness => h !== null)
      : [],
    attention: Array.isArray(raw["attention"])
      ? raw["attention"].map(readAttention).filter((a): a is SessionAttention => a !== null)
      : [],
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
      runtimeStatus: state.busy ? "busy" : "idle",
    },
    ...state.sessions,
  ];
}

/** Model identifiers are useful metadata, but poor conversation titles. */
function isModelTitle(title: string): boolean {
  return /^(?:claude(?: code)?(?:-|$)|gpt(?:-|$)|o[1-9](?:-|$)|codex(?:-|$)|grok(?:-|$)|gemini(?:-|$)|pi(?:-|$)|opencode(?:-|$))/i.test(
    title.trim(),
  );
}

function isOpaqueSessionTitle(title: string): boolean {
  const value = title.trim();
  return /^(?:[a-f0-9]{8,}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value);
}

/** The messenger row's primary label: a real conversation title first, otherwise its project. */
export function sessionDisplayName(row: Pick<SessionRow, "name" | "title">): string {
  const title = row.title.trim();
  const name = row.name.trim();
  if (title !== "" && title !== name && !isModelTitle(title) && !isOpaqueSessionTitle(title)) return title;
  return name || title || "Untitled chat";
}

/** Compact metadata that distinguishes repeated conversations without burying the useful title. */
export function sessionDetail(row: Pick<SessionRow, "name" | "title" | "cwd" | "messages">): string {
  const primary = sessionDisplayName(row);
  const parts: string[] = [];
  if (row.name.trim() !== "" && row.name.trim() !== primary) parts.push(row.name.trim());
  if (row.title.trim() !== "" && row.title.trim() !== primary) parts.push(row.title.trim());
  if (row.messages !== null) parts.push(`${row.messages} msg${row.messages === 1 ? "" : "s"}`);
  if (parts.length === 0 && row.cwd.trim() !== "") parts.push(row.cwd.trim());
  return parts.join(" · ");
}

/** Local, instant chat-list search; no new discovery/load RPC is needed. */
export function filterSessionRows(rows: readonly SessionRow[], query: string): SessionRow[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return [...rows];
  return rows.filter((row) =>
    [row.name, row.title, row.cwd, row.harness]
      .join("\n")
      .toLocaleLowerCase()
      .includes(needle),
  );
}

export function attentionFor(state: WidgetState, key: string): SessionAttentionKind | null {
  return state.attention.find((item) => item.key === key)?.kind ?? null;
}

export type SessionActivity = "needs-input" | "failed" | "working" | "finished" | "unseen" | "recent" | "idle";

/** One honest state vocabulary shared by the launcher and the conversation list. */
export function sessionActivity(state: WidgetState, row: SessionRow): SessionActivity {
  if (row.active && state.needsInput) return "needs-input";
  if (row.active && state.error) return "failed";
  if (row.active && state.busy) return "working";
  const attention = attentionFor(state, row.key);
  if (attention) return attention;
  if (row.runtimeStatus === "busy") return "working";
  return row.live ? "recent" : "idle";
}

const ACTIVITY_PRIORITY: Record<SessionActivity, number> = {
  "needs-input": 0,
  failed: 1,
  working: 2,
  finished: 3,
  unseen: 4,
  recent: 5,
  idle: 6,
};

/** Attention first, then the selected chat, then actual recency—matching a mature inbox. */
export function orderedSessionRows(state: WidgetState): SessionRow[] {
  return [...listRows(state)].sort((left, right) => {
    const delta = ACTIVITY_PRIORITY[sessionActivity(state, left)] - ACTIVITY_PRIORITY[sessionActivity(state, right)];
    if (delta !== 0) return delta;
    if (left.active !== right.active) return left.active ? -1 : 1;
    return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
  });
}

export function activityLabel(activity: SessionActivity): string {
  if (activity === "needs-input") return "Needs input";
  if (activity === "failed") return "Failed";
  if (activity === "working") return "Working";
  if (activity === "finished") return "Finished";
  if (activity === "unseen") return "New activity";
  if (activity === "recent") return "Recent";
  return "";
}

export function operationLabel(operation: string | null): string | null {
  if (!operation) return null;
  const labels: Record<string, string> = {
    refresh: "Refreshing chats…",
    observe: "Opening chat…",
    start: "Starting agent…",
    send: "Sending…",
    interrupt: "Stopping…",
    respond: "Responding…",
    resume: "Resuming chat…",
    attach: "Connecting live…",
    branch: "Starting fork…",
  };
  return labels[operation] ?? `${operation.charAt(0).toUpperCase()}${operation.slice(1)}…`;
}

export function messageTime(timestamp: number | null): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(timestamp);
}

/** Has the host confirmed the attach behind the immediate, transcript-free opening surface? */
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

/** Progressive copy for a real attach that may need to load and normalize a large transcript. */
export function openingMessage(elapsedMs: number): string {
  if (elapsedMs < 4_000) return "Opening";
  if (elapsedMs < 12_000) return "Loading transcript";
  return "Still loading";
}

/**
 * The shell pill — the one thing visible while the widget is closed. It stays quiet at rest and
 * expands only for work, input, errors, or genuinely unseen activity.
 */
export function pillFor(state: WidgetState): WidgetState["pill"] {
  const harness = harnessDisplayName(state.attached?.harness ?? state.harness);
  if (state.startup !== "ready") return { tone: "off", label: state.pill.label || "Connecting" };
  if (state.needsInput) return { tone: "warn", label: `${harness || "Agent"} needs input` };
  if (state.error) return { tone: "dead", label: `${harness || "Agent"} needs attention` };
  if (state.busy) return { tone: "live", label: `${harness || "Agent"} is working` };
  if (state.attention.length > 0) {
    const count = state.attention.length;
    return { tone: "warn", label: `${count} unread chat${count === 1 ? "" : "s"}` };
  }
  return { tone: "off", label: "Agent chats" };
}

/** Keep unread idle chats compact; expand only when the current agent has actionable live state. */
export function pillModeFor(state: WidgetState): PillMode {
  if (state.startup !== "ready") return "connecting";
  if (state.needsInput) return "needs-input";
  if (state.error) return "error";
  if (state.busy) return "working";
  if (state.attention.length > 0) return "unread";
  return "idle";
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
