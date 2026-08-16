// The iframe app — ONE panel, the minified-messenger shape: a list of every coding session on the
// machine, and one session's chat behind a tap.
//
//   list  ──tap a row──▶  chat (transcript + composer)
//         ◀──── ‹ back ───
//
// It is bundled into a single self-contained srcdoc document by `widget/build.mjs`
// (`lucarne/widget/build`), so there is no module loading, no network, and no framework CDN inside
// the page it mounts on. Everything it knows arrives as pushed patches; everything it wants goes
// out as one named intent (`send` from the composer, `attach` from a row).
//
// The view is LOCAL state: which screen you are on is not a fact about the machine, so the host is
// never told and a re-push never yanks you between screens. The one crossing point is the attach
// handshake — the list waits for the host to confirm the new session before sliding to the chat.
import { createWidget } from "lucarne/widget/runtime";
import { mountPanel } from "lucarne/widget/preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import {
  ATTACH_ERROR_LINGER_MS,
  attachOutcome,
  isSendKey,
  listRows,
  nearBottom,
  pendingResolved,
  pillFor,
  readWidgetState,
  roleLabel,
  type SessionRow,
  type TranscriptEntry,
  type View,
  type WidgetState,
} from "./state.js";

const NS = "vibewaiting";
const INTENT_QUEUE = "agent";

const widget = createWidget({ ns: NS, version: 1 });

function timeLabel(ts: number | null): string {
  if (ts === null) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Row({ entry, pending }: { entry: TranscriptEntry; pending?: boolean }): JSX.Element {
  return (
    <div class={`vw-row vw-${entry.role}${pending ? " vw-pending" : ""}`}>
      <div class="vw-meta">
        <span class="vw-role">{roleLabel(entry.role)}</span>
        {entry.ts !== null ? <span class="vw-time">{timeLabel(entry.ts)}</span> : null}
        {pending ? <span class="vw-time">sending…</span> : null}
      </div>
      <div class="vw-text">
        {entry.text}
        {entry.truncated ? <span class="vw-cut"> [truncated]</span> : null}
      </div>
    </div>
  );
}

/** The secondary line: what the session IS, in the order the harness actually knows it. */
function subtitle(row: SessionRow): string {
  const parts: string[] = [];
  if (row.title !== "" && row.title !== row.name) parts.push(row.title);
  if (row.messages !== null) parts.push(`${row.messages} msg${row.messages === 1 ? "" : "s"}`);
  if (parts.length === 0) parts.push(row.cwd);
  return parts.join(" · ");
}

function SessionListRow({
  row,
  opening,
  error,
  onOpen,
}: {
  row: SessionRow;
  opening: boolean;
  /** The last attach failure for THIS row, shown in place of its subtitle until it clears. */
  error: string | null;
  onOpen: () => void;
}): JSX.Element {
  // The dot is LIVENESS — is anyone working in this session right now — and nothing else. Which
  // session the panel is following is said by the row highlight and the chevron, because a dot that
  // lit for exactly one row read as "every other session is dead" (which is what it was saying).
  return (
    <button
      class={`vw-srow${row.active ? " vw-active" : ""}`}
      type="button"
      onClick={onOpen}
      title={`${row.harness} · ${row.cwd}${row.live ? " · active now" : ""}`}
    >
      <span class={`vw-dot${row.live ? " vw-live" : ""}`} title={row.live ? "active now" : "idle"} />
      <span class="vw-scol">
        <span class="vw-sline">
          <span class="vw-sname">{row.name || row.title}</span>
          {row.active ? (
            <span class="vw-follow" title="the panel is following this session">
              › following
            </span>
          ) : null}
          <span class="vw-sage">{opening ? "opening…" : row.age}</span>
        </span>
        {error !== null ? (
          <span class="vw-ssub vw-sfail" title={error}>
            {error}
          </span>
        ) : (
          <span class="vw-ssub">
            <span class="vw-sharness">{row.harness}</span>
            {subtitle(row) !== "" ? <span class="vw-sdetail">{subtitle(row)}</span> : null}
          </span>
        )}
      </span>
    </button>
  );
}

function SessionList({
  state,
  awaiting,
  failure,
  onOpen,
}: {
  state: WidgetState;
  awaiting: string | null;
  /** The attach that failed, still worth showing under its row. */
  failure: { key: string; message: string } | null;
  onOpen: (row: SessionRow) => void;
}): JSX.Element {
  const rows = listRows(state);
  return (
    <div class="vw-list">
      {rows.length === 0 ? (
        <div class="vw-empty">{state.error ?? "Looking for coding sessions…"}</div>
      ) : null}
      {rows.map((row) => (
        <SessionListRow
          key={row.key}
          row={row}
          opening={awaiting === row.key}
          error={failure !== null && failure.key === row.key ? failure.message : null}
          onOpen={(): void => onOpen(row)}
        />
      ))}
    </div>
  );
}

function Chat({ state, onBack }: { state: WidgetState; onBack: () => void }): JSX.Element {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);

  // The pending echo clears as soon as the real transcript carries the prompt.
  useEffect(() => {
    if (pending !== null && pendingResolved(pending, state.transcript)) setPending(null);
  });

  // Auto-scroll AFTER layout, and only when the reader hadn't scrolled up to read something.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const onScroll = (): void => {
    const el = scroller.current;
    if (el) stick.current = nearBottom(el);
  };

  const send = (): void => {
    const text = draft.trim();
    if (text === "") return;
    widget.sendIntent(INTENT_QUEUE, { action: "send", text });
    setPending(text);
    setDraft("");
    stick.current = true;
  };

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>): void => {
    if (!isSendKey(e)) return;
    e.preventDefault();
    send();
  };

  const empty = state.transcript.length === 0 && pending === null;
  const attached = state.attached;
  // Read-only is the controller's own honest capability for a session someone else is driving; the
  // composer says so rather than offering a send that can only fail.
  const readOnly = attached !== null && !state.canSend;

  return (
    <div class="vw-chat">
      <div class="vw-head">
        <button class="vw-back" type="button" onClick={onBack} title="All sessions">
          ‹
        </button>
        <span class="vw-hname">{attached?.name ?? state.harness ?? ""}</span>
        <span class="vw-hsub">{attached?.harness ?? ""}</span>
        {readOnly ? <span class="vw-ro">read-only</span> : null}
      </div>
      <div class="vw-scroll" ref={scroller} onScroll={onScroll}>
        {empty ? (
          <div class="vw-empty">
            {state.error ?? (state.harness ? `${state.harness} is listening. Say something.` : "No transcript yet.")}
          </div>
        ) : null}
        {state.transcript.map((entry) => (
          <Row key={entry.id} entry={entry} />
        ))}
        {pending !== null ? (
          <Row
            key="vw-pending"
            entry={{ id: "vw-pending", role: "user", text: pending, ts: null, truncated: false }}
            pending
          />
        ) : null}
      </div>
      {state.error !== null && !empty ? <div class="vw-error">{state.error}</div> : null}
      <div class="vw-composer">
        <textarea
          class="vw-input"
          rows={2}
          placeholder={
            readOnly
              ? "Someone else is driving this session — mirroring it read-only."
              : state.busy
                ? "The agent is working — queue the next prompt…"
                : "Ask your agent…"
          }
          value={draft}
          onInput={(e): void => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={onKeyDown}
        />
        <div class="vw-composer-foot">
          <span class="vw-hint">
            <kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline
          </span>
          <button class="vw-send" onClick={send} disabled={draft.trim() === ""}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function MessengerPanel({ state }: { state: unknown }): JSX.Element {
  const s = readWidgetState(state);
  const [view, setView] = useState<View>("list");
  const [awaiting, setAwaiting] = useState<string | null>(null);
  // The failure is copied into local state on arrival so the row can stop showing it without the
  // host having to retract anything — the host's `attachError` is a fact about the last attach and
  // stays true until the next one.
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);

  // The awaited attach settled — either into that session's chat, or into a reason under its row.
  useEffect(() => {
    const outcome = attachOutcome(awaiting, s.attached, s.attachError);
    if (outcome === "attached") {
      setAwaiting(null);
      setFailure(null);
      setView("chat");
    } else if (outcome === "failed" && s.attachError !== null) {
      setAwaiting(null);
      setFailure(s.attachError);
    }
  });

  // …and the reason fades on its own, so a stale failure never becomes permanent furniture.
  useEffect(() => {
    if (failure === null) return undefined;
    const timer = setTimeout(() => setFailure(null), ATTACH_ERROR_LINGER_MS);
    return () => clearTimeout(timer);
  }, [failure]);

  const open = (row: SessionRow): void => {
    setFailure(null);
    // The keyless row IS the attached session (see `listRows`) — nothing to ask the host for.
    if (row.key === "") {
      setView("chat");
      return;
    }
    widget.sendIntent(INTENT_QUEUE, { action: "attach", key: row.key });
    setAwaiting(row.key);
  };

  if (view === "chat") {
    return (
      <Chat
        state={s}
        onBack={(): void => {
          setView("list");
        }}
      />
    );
  }
  return <SessionList state={s} awaiting={awaiting} failure={failure} onOpen={open} />;
}

// The last tone the host reported — the shell asks for it whenever it redraws the pill's dot.
let lastTone: WidgetState["pill"]["tone"] = "off";
let sessionCount = 0;

widget.registerPanel({
  id: "agent",
  title: "Sessions",
  render: mountPanel(MessengerPanel),
  default: true,
  indicator: () => lastTone,
  badge: () => sessionCount,
});

// The pill is shell chrome, not panel content — it is the one thing visible while the panel is closed.
widget.onPatch((patch) => {
  if (!isRecord(patch) || !("pill" in patch)) return;
  const state = readWidgetState(patch);
  const pill = pillFor(state);
  lastTone = pill.tone;
  sessionCount = state.sessions.length;
  widget.setPill({ tone: pill.tone, label: pill.label });
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
