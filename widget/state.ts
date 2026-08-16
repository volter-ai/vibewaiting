// The panel's own pure logic, kept out of the view so it can be tested in node.
//
// The iframe receives whatever the host pushed, shallow-merged by `lucarne/widget/runtime` into one
// accumulating `state` object typed `unknown` — so the FIRST thing the panel does is re-establish
// the shape defensively (a page reload re-mounts the widget before any push has landed, and the
// runtime hands that empty accumulator straight to `render`).
import type { TranscriptEntry, TranscriptRole, WidgetState } from "../src/projection.js";
import type { AttachedSession, SessionRow } from "../src/sessions.js";

export type { AttachedSession, SessionRow, TranscriptEntry, TranscriptRole, WidgetState };

export const EMPTY_STATE: WidgetState = {
  pill: { tone: "off", label: "connecting…" },
  transcript: [],
  busy: false,
  harness: "",
  canSend: false,
  error: null,
  sessions: [],
  attached: null,
};

/** The messenger's two views: the session list (root) and one session's transcript. */
export type View = "list" | "chat";

const TONES = new Set(["live", "warn", "dead", "off"]);
const ROLES = new Set<string>(["system", "user", "assistant", "tool", "reasoning", "request", "notice"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function readEntry(raw: unknown): TranscriptEntry | null {
  if (!isRecord(raw)) return null;
  const { id, role, text, ts, truncated } = raw;
  if (typeof id !== "string" || typeof text !== "string") return null;
  if (typeof role !== "string" || !ROLES.has(role)) return null;
  return {
    id,
    role: role as TranscriptRole,
    text,
    ts: typeof ts === "number" ? ts : null,
    truncated: truncated === true,
  };
}

function readSessionRow(raw: unknown): SessionRow | null {
  if (!isRecord(raw)) return null;
  const { key, harness, name, cwd, title, age, updatedAt, messages, active } = raw;
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
  };
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
    transcript,
    busy: raw["busy"] === true,
    harness: typeof raw["harness"] === "string" ? raw["harness"] : "",
    canSend: raw["canSend"] === true,
    error: typeof raw["error"] === "string" ? raw["error"] : null,
    sessions: Array.isArray(raw["sessions"])
      ? raw["sessions"].map(readSessionRow).filter((s): s is SessionRow => s !== null)
      : [],
    attached: readAttached(raw["attached"]),
  };
}

/**
 * The rows the list shows.
 *
 * Discovery's rows, plus one for the session the panel is ALREADY on when discovery has not seen it
 * yet — a session the daemon just started has no persisted file until its first turn, and without
 * this its own chat would be unreachable from the list that is supposed to contain everything. Its
 * key is `""`, which is how the view knows to open it locally instead of asking the host to attach.
 */
export function listRows(state: WidgetState): SessionRow[] {
  const attached = state.attached;
  if (attached === null || attached.key !== "") return state.sessions;
  return [
    {
      key: "",
      harness: attached.harness,
      name: attached.name,
      cwd: attached.cwd,
      title: attached.title,
      age: "",
      updatedAt: null,
      messages: null,
      active: true,
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
