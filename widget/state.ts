// The panel's own pure logic, kept out of the view so it can be tested in node.
//
// The iframe receives whatever the host pushed, shallow-merged by `lucarne/widget/runtime` into one
// accumulating `state` object typed `unknown` — so the FIRST thing the panel does is re-establish
// the shape defensively (a page reload re-mounts the widget before any push has landed, and the
// runtime hands that empty accumulator straight to `render`).
import type { TranscriptEntry, TranscriptRole, WidgetState } from "../src/projection.js";

export type { TranscriptEntry, TranscriptRole, WidgetState };

export const EMPTY_STATE: WidgetState = {
  pill: { tone: "off", label: "connecting…" },
  transcript: [],
  busy: false,
  harness: "",
  canSend: false,
  error: null,
};

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
  };
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
