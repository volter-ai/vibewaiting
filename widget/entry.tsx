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
import MarkdownIt from "markdown-it";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
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
  startupMessage,
  type SessionRow,
  type TranscriptEntry,
  type View,
  type WidgetState,
} from "./state.js";
import {
  activeWorkContext,
  compactToolTarget,
  conversationBlocks,
  toolCategory,
  toolGroupSummary,
  toolLabel,
  toolTarget,
  type ToolCategory,
} from "./presentation.js";

const NS = "vibewaiting";
const INTENT_QUEUE = "agent";

const widget = createWidget({ ns: NS, version: 1 });

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });
const defaultLinkOpen = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, env, self): string => {
  const token = tokens[index];
  token?.attrSet("target", "_blank");
  token?.attrSet("rel", "noreferrer noopener");
  return defaultLinkOpen
    ? defaultLinkOpen(tokens, index, options, env, self)
    : self.renderToken(tokens, index, options);
};

function MarkdownContent({ value }: { value: string }): JSX.Element {
  const html = useMemo(() => markdown.render(value), [value]);
  return <div class="vw-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function categoryGlyph(category: ToolCategory): string {
  if (category === "read") return "▤";
  if (category === "search") return "⌕";
  if (category === "edit") return "✎";
  if (category === "command") return ">_";
  if (category === "test") return "◇";
  if (category === "web") return "◎";
  if (category === "agent") return "♙";
  return "◆";
}

function ToolRow({ entry, workspace }: { entry: TranscriptEntry; workspace: string }): JSX.Element {
  const status = entry.status ?? "completed";
  const category = toolCategory(entry);
  const fullTarget = toolTarget(entry.arguments);
  const target = compactToolTarget(fullTarget, workspace);
  const details = Boolean(entry.arguments || entry.resultText);
  return (
    <details class={`vw-tool-row vw-tool-${status}`}>
      <summary class="vw-tool-row-head">
        <span class="vw-tool-glyph" aria-hidden="true">{categoryGlyph(category)}</span>
        <span class="vw-tool-name">{toolLabel(entry.label)}</span>
        {target ? <span class="vw-tool-target" title={fullTarget}>{target}</span> : null}
        <span class="vw-spacer" />
        <span class="vw-tool-state" aria-label={status}>{status === "pending" ? "◌" : status === "error" ? "×" : "✓"}</span>
      </summary>
      {details ? (
        <div class="vw-tool-detail">
          {entry.arguments ? <pre class="vw-tool-code"><b>Input</b>{"\n"}{entry.arguments}</pre> : null}
          {entry.resultText ? <pre class={`vw-tool-code vw-tool-result${status === "error" ? " vw-danger" : ""}`}><b>Output</b>{"\n"}{entry.resultText}{entry.truncated ? "\n[truncated]" : ""}</pre> : null}
        </div>
      ) : null}
    </details>
  );
}

function ToolGroup({ tools, workspace }: { tools: TranscriptEntry[]; workspace: string }): JSX.Element {
  const important = tools.some((tool) => {
    const category = toolCategory(tool);
    return tool.status === "pending" || category === "edit" || category === "test";
  });
  const [expanded, setExpanded] = useState(important);
  useEffect(() => {
    if (important) setExpanded(true);
  }, [important]);
  const completed = tools.filter((tool) => tool.status === "completed").length;
  const hasError = tools.some((tool) => tool.status === "error");
  return (
    <details
      class="vw-tool-group"
      open={expanded}
      onToggle={(event): void => setExpanded(event.currentTarget.open)}
    >
      <summary class="vw-tool-group-head">
        <span class={`vw-fold-mark${expanded ? " vw-open" : ""}`}>›</span>
        <strong>{toolGroupSummary(tools)}</strong>
        <span class="vw-spacer" />
        <span class={hasError ? "vw-danger" : ""}>{completed}/{tools.length}</span>
      </summary>
      {expanded ? <div>{tools.map((tool) => <ToolRow key={tool.id} entry={tool} workspace={workspace} />)}</div> : null}
    </details>
  );
}

function RequestCard({ entry, canRespond }: { entry: TranscriptEntry; canRespond: boolean }): JSX.Element {
  const request = entry.request;
  if (!request) return <div class="vw-notice">{entry.text}</div>;
  if (request.status === "responded") {
    return <div class="vw-request-done">✓ Request answered · {request.resolution?.name ?? request.requestKind}</div>;
  }
  const respond = (optionId: string | null): void => {
    widget.sendIntent(INTENT_QUEUE, { action: "respond", requestId: request.requestId, optionId });
  };
  return (
    <section class="vw-request-card" aria-label={`${request.requestKind} needs input`}>
      <strong>Agent needs input</strong>
      <span class="vw-request-kind">{request.requestKind}</span>
      {request.payloadText && request.payloadText !== "{}" ? <pre>{request.payloadText}</pre> : null}
      <div class="vw-request-actions">
        {request.options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            class={option.kind.startsWith("reject") ? "vw-request-reject" : ""}
            disabled={!canRespond}
            onClick={(): void => respond(option.optionId)}
          >
            {option.name}
          </button>
        ))}
        {request.cancellable ? <button type="button" disabled={!canRespond} onClick={(): void => respond(null)}>Cancel</button> : null}
      </div>
    </section>
  );
}

function MessageRow({ entry, pending }: { entry: TranscriptEntry; pending?: boolean | undefined }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard?.writeText(entry.text).then(() => setCopied(true)).catch(() => undefined);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <article class={`vw-message vw-${entry.role}${pending ? " vw-pending" : ""}`} aria-label={pending ? "user message sending" : `${roleLabel(entry.role)} message`}>
      <MarkdownContent value={entry.text} />
      {entry.truncated ? <span class="vw-cut">[truncated]</span> : null}
      {entry.role === "assistant" ? <button class="vw-copy" type="button" aria-label={copied ? "Response copied" : "Copy response"} onClick={copy}>{copied ? "✓" : "Copy"}</button> : null}
      {pending ? <span class="vw-sending">sending…</span> : null}
    </article>
  );
}

function TranscriptRow({ entry, pending, canRespond }: { entry: TranscriptEntry; pending?: boolean | undefined; canRespond: boolean }): JSX.Element | null {
  if (entry.role === "system") return null;
  if (entry.role === "reasoning") {
    return (
      <details class="vw-reasoning" open={entry.streaming === true || undefined}>
        <summary><span class="vw-fold-mark">›</span>{entry.streaming ? "Thinking…" : "Reasoning"}</summary>
        <div class="vw-reasoning-body">{entry.text}{entry.truncated ? <span class="vw-cut"> [truncated]</span> : null}</div>
      </details>
    );
  }
  if (entry.role === "request") return <RequestCard entry={entry} canRespond={canRespond} />;
  if (entry.role === "notice") return <div class="vw-notice">{entry.text}</div>;
  if (entry.role === "tool") return <ToolRow entry={entry} workspace="" />;
  return <MessageRow entry={entry} pending={pending} />;
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
      class={`vw-srow${row.active ? " vw-active" : ""}${opening ? " vw-srow-opening" : ""}`}
      type="button"
      onClick={onOpen}
      aria-busy={opening}
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
          <span class="vw-sage">
            {opening ? <><span class="vw-spinner vw-spinner-small" aria-hidden="true" />Opening</> : row.age}
          </span>
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

function StartupStatus({ state, compact = false }: { state: WidgetState; compact?: boolean }): JSX.Element {
  const copy = startupMessage(state.startup, state.harness);
  return (
    <section class={`vw-startup${compact ? " vw-startup-compact" : ""}`} role="status" aria-live="polite" aria-busy="true">
      <span class="vw-startup-orbit" aria-hidden="true"><span /></span>
      <span class="vw-startup-copy">
        <strong>{copy.title}</strong>
        <span>{copy.detail}</span>
      </span>
      <span class="vw-startup-track" aria-hidden="true">
        {[0, 1, 2].map((step) => (
          <span key={step} class={step < copy.step ? "vw-step-done" : step === copy.step ? "vw-step-current" : ""} />
        ))}
      </span>
    </section>
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
  const loading = state.startup !== "ready";
  return (
    <div class="vw-list">
      {loading ? <StartupStatus state={state} compact={rows.length > 0} /> : null}
      {!loading && rows.length === 0 ? <div class="vw-empty">{state.error ?? "No coding sessions found."}</div> : null}
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

function WorkPlan({ state }: { state: WidgetState }): JSX.Element | null {
  const work = activeWorkContext(state.transcript);
  if (!work && state.taskPlan.source === "none") return null;
  return (
    <section class="vw-work-plan" aria-label="Work plan">
      {work ? <div class="vw-working-on"><span>Working on</span><strong>{work.label}</strong></div> : null}
      {state.taskPlan.items.length ? (
        <div class="vw-plan-items">
          {state.taskPlan.items.map((item) => {
            const glyph = item.status === "completed" ? "✓" : item.status === "in_progress" ? "●" : item.status === "cancelled" ? "×" : "○";
            return <div key={item.id} class={`vw-plan-item vw-plan-${item.status}`}><span aria-hidden="true">{glyph}</span><span>{item.title}</span></div>;
          })}
        </div>
      ) : null}
    </section>
  );
}

function Chat({ state, onBack }: { state: WidgetState; onBack: () => void }): JSX.Element {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [queued, setQueued] = useState<string[]>([]);
  const scroller = useRef<HTMLDivElement | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const stick = useRef(true);

  // The pending echo clears as soon as the real transcript carries the prompt.
  useEffect(() => {
    if (pending !== null && pendingResolved(pending, state.transcript)) setPending(null);
  });

  useEffect(() => {
    if (state.busy || !state.canSend || pending !== null || queued.length === 0) return;
    const [next, ...rest] = queued;
    if (!next) return;
    setQueued(rest);
    widget.sendIntent(INTENT_QUEUE, { action: "send", text: next });
    setPending(next);
    stick.current = true;
  }, [state.busy, state.canSend, pending, queued]);

  // Auto-scroll AFTER layout, and only when the reader hadn't scrolled up to read something.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [draft]);

  const onScroll = (): void => {
    const el = scroller.current;
    if (el) stick.current = nearBottom(el);
  };

  const send = (): void => {
    const text = draft.trim();
    if (text === "") return;
    if (state.busy) {
      setQueued((messages) => [...messages, text]);
      setDraft("");
      return;
    }
    if (!state.canSend) return;
    widget.sendIntent(INTENT_QUEUE, { action: "send", text });
    setPending(text);
    setDraft("");
    stick.current = true;
  };

  const interrupt = (): void => {
    widget.sendIntent(INTENT_QUEUE, { action: "interrupt" });
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
  const readOnly = state.mode === "mirror" && !state.canSend;
  const blocks = conversationBlocks(state.transcript);

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
      <WorkPlan state={state} />
      <div class="vw-scroll" ref={scroller} onScroll={onScroll}>
        {empty && state.startup !== "ready" ? <StartupStatus state={state} /> : null}
        {empty && state.startup === "ready" ? (
          <div class="vw-empty">{state.error ?? (state.harness ? `${state.harness} is listening. Say something.` : "No transcript yet.")}</div>
        ) : null}
        {blocks.map((block) =>
          block.kind === "tool-group"
            ? <ToolGroup key={block.id} tools={block.tools} workspace={state.workspace} />
            : <TranscriptRow key={block.id} entry={block.entry} canRespond={state.canRespond} />,
        )}
        {pending !== null ? (
          <TranscriptRow
            key="vw-pending"
            entry={{ id: "vw-pending", role: "user", text: pending, ts: null, truncated: false }}
            pending
            canRespond={false}
          />
        ) : null}
        {state.busy ? <div class="vw-working" role="status"><span class="vw-spinner" />Working…</div> : null}
      </div>
      {state.error !== null && !empty ? <div class="vw-error">{state.error}</div> : null}
      <div class="vw-composer">
        {queued.length ? (
          <div class="vw-queue" role="status">
            <strong>{queued.length} queued</strong>
            {queued.map((message, index) => <div key={`${index}:${message}`}><span>{message}</span><button type="button" aria-label={`Remove queued message ${index + 1}`} onClick={(): void => setQueued((items) => items.filter((_, itemIndex) => itemIndex !== index))}>×</button></div>)}
          </div>
        ) : null}
        {readOnly ? (
          <div class="vw-mirror-card">
            <strong>Live mirror</strong>
            <span>Someone else is controlling this session. You can follow its transcript here without interrupting it.</span>
            <button type="button" onClick={onBack}>Choose another session</button>
          </div>
        ) : (
          <div class="vw-envelope">
            <textarea
              ref={textarea}
              class="vw-input"
              rows={2}
              aria-label={`Message ${attached?.harness ?? state.harness ?? "agent"}`}
              placeholder={state.startup !== "ready" ? "Connecting…" : state.busy ? "Queue a follow-up…" : "Ask your agent…"}
              value={draft}
              disabled={state.mode !== "control" && !state.canSend}
              onInput={(e): void => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
              onKeyDown={onKeyDown}
            />
            <div class="vw-composer-foot">
              <span class="vw-agent-id">{attached?.harness ?? state.harness}</span>
              <span class="vw-actions">
                {state.busy ? <button class="vw-stop" type="button" aria-label="Stop agent" onClick={interrupt} disabled={!state.canInterrupt}>■</button> : null}
                <button class="vw-send" type="button" aria-label={state.busy ? "Queue message" : "Send message"} onClick={send} disabled={draft.trim() === "" || (!state.busy && !state.canSend)}>
                  {state.busy ? "+" : "↑"}
                </button>
              </span>
            </div>
          </div>
        )}
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
    // The keyless row is the daemon-owned runtime before its first persisted turn. While we are
    // already on it there is nothing to ask; from a mirror, releasing that mirror restores it.
    if (row.key === "") {
      if (s.attached?.key === "") {
        setView("chat");
      } else {
        widget.sendIntent(INTENT_QUEUE, { action: "release" });
        setAwaiting("");
      }
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
