// The iframe app — ONE panel ("Agent"): the live transcript, the composer, and the pill.
//
// It is bundled into a single self-contained srcdoc document by `widget/build.mjs`
// (`lucarne/widget/build`), so there is no module loading, no network, and no framework CDN inside
// the page it mounts on. Everything it knows arrives as pushed patches; everything it wants goes
// out as one named intent.
import { createWidget } from "lucarne/widget/runtime";
import { mountPanel } from "lucarne/widget/preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import {
  isSendKey,
  nearBottom,
  pendingResolved,
  readWidgetState,
  roleLabel,
  type TranscriptEntry,
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

function AgentPanel({ state }: { state: unknown }): JSX.Element {
  const s = readWidgetState(state);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);

  // The pending echo clears as soon as the real transcript carries the prompt.
  useEffect(() => {
    if (pending !== null && pendingResolved(pending, s.transcript)) setPending(null);
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

  const empty = s.transcript.length === 0 && pending === null;

  return (
    <div class="vw">
      <div class="vw-scroll" ref={scroller} onScroll={onScroll}>
        {empty ? (
          <div class="vw-empty">
            {s.error ?? (s.harness ? `${s.harness} is listening. Say something.` : "Waiting for a coding session…")}
          </div>
        ) : null}
        {s.transcript.map((entry) => (
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
      {s.error !== null && !empty ? <div class="vw-error">{s.error}</div> : null}
      <div class="vw-composer">
        <textarea
          class="vw-input"
          rows={2}
          placeholder={s.busy ? "The agent is working — queue the next prompt…" : "Ask your agent…"}
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

// The last tone the host reported — the shell asks for it whenever it redraws the pill's dot.
let lastTone: WidgetState["pill"]["tone"] = "off";

widget.registerPanel({
  id: "agent",
  title: "Agent",
  render: mountPanel(AgentPanel),
  default: true,
  indicator: () => lastTone,
});

// The pill is shell chrome, not panel content — it is the one thing visible while the panel is closed.
widget.onPatch((patch) => {
  if (!isRecord(patch) || !("pill" in patch)) return;
  const { pill } = readWidgetState(patch);
  lastTone = pill.tone;
  widget.setPill({ tone: pill.tone, label: pill.label });
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
