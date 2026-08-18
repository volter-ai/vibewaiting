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
  filterSessionRows,
  harnessDisplayName,
  isSendKey,
  listRows,
  nearBottom,
  pendingResolved,
  pillFor,
  readWidgetState,
  roleLabel,
  sessionDetail,
  sessionDisplayName,
  openingMessage,
  startupMessage,
  type SessionRow,
  type TranscriptEntry,
  type View,
  type WidgetState,
} from "./state.js";
import {
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
  // Historical edits/tests are useful on demand, but opening every old activity group turns a
  // conversation into a build log. Only the work happening NOW expands itself.
  const important = tools.some((tool) => tool.status === "pending");
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

function SessionListRow({
  row,
  openingLabel,
  error,
  onOpen,
}: {
  row: SessionRow;
  openingLabel: string | null;
  /** The last attach failure for THIS row, shown in place of its subtitle until it clears. */
  error: string | null;
  onOpen: () => void;
}): JSX.Element {
  const opening = openingLabel !== null;
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
          <span class="vw-sname">{sessionDisplayName(row)}</span>
          {row.active ? (
            <span class="vw-follow" title="the panel is following this session">
              › following
            </span>
          ) : null}
          <span class="vw-sage">
            {opening ? <><span class="vw-spinner vw-spinner-small" aria-hidden="true" />{openingLabel}</> : row.age}
          </span>
        </span>
        {error !== null ? (
          <span class="vw-ssub vw-sfail" title={error}>
            {error}
          </span>
        ) : (
          <span class="vw-ssub">
            <span class="vw-sharness">{harnessDisplayName(row.harness)}</span>
            {sessionDetail(row) !== "" ? <span class="vw-sdetail">{sessionDetail(row)}</span> : null}
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
  now,
  failure,
  query,
  onQuery,
  onOpen,
}: {
  state: WidgetState;
  awaiting: { key: string; startedAt: number } | null;
  now: number;
  /** The attach that failed, still worth showing under its row. */
  failure: { key: string; message: string } | null;
  query: string;
  onQuery: (query: string) => void;
  onOpen: (row: SessionRow) => void;
}): JSX.Element {
  const allRows = listRows(state);
  const rows = filterSessionRows(allRows, query);
  const loading = state.startup !== "ready";
  return (
    <div class="vw-list">
      {loading ? <StartupStatus state={state} compact={rows.length > 0} /> : null}
      {!loading && allRows.length > 4 ? (
        <label class="vw-search">
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            aria-label="Search chats"
            placeholder="Search chats"
            value={query}
            onInput={(event): void => onQuery(event.currentTarget.value)}
          />
          <small role="status" aria-label={`${rows.length} chats`}>{rows.length}</small>
        </label>
      ) : null}
      {!loading && rows.length === 0 ? (
        <div class="vw-empty">{query.trim() ? "No chats match your search." : state.error ?? "No coding chats found."}</div>
      ) : null}
      {rows.map((row) => (
        <SessionListRow
          key={row.key}
          row={row}
          openingLabel={awaiting?.key === row.key ? openingMessage(now - awaiting.startedAt) : null}
          error={failure !== null && failure.key === row.key ? failure.message : null}
          onOpen={(): void => onOpen(row)}
        />
      ))}
    </div>
  );
}

interface RememberedChat {
  draft: string;
  pending: string | null;
  queued: string[];
  scrollTop: number | null;
  stick: boolean;
}

const rememberedChats = new Map<string, RememberedChat>();
const rememberedUi: { view: View; query: string } = { view: "list", query: "" };
let mountedChatKey: string | null = null;

function chatMemoryKey(state: WidgetState): string {
  return state.attached?.key || `${state.harness}:${state.workspace}`;
}

function chatMemory(state: WidgetState): RememberedChat {
  const key = chatMemoryKey(state);
  let memory = rememberedChats.get(key);
  if (!memory) {
    memory = { draft: "", pending: null, queued: [], scrollTop: null, stick: true };
    rememberedChats.set(key, memory);
  }
  return memory;
}

function Chat({ state, onBack }: { state: WidgetState; onBack: () => void }): JSX.Element {
  const memory = chatMemory(state);
  const memoryKey = chatMemoryKey(state);
  const [draft, setDraft] = useState(memory.draft);
  const [pending, setPending] = useState<string | null>(memory.pending);
  const [queued, setQueued] = useState<string[]>(memory.queued);
  const scroller = useRef<HTMLDivElement | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const stick = useRef(memory.stick);
  const restoredScroll = useRef(false);
  const focusedComposer = useRef(false);

  useEffect(() => {
    memory.draft = draft;
    memory.pending = pending;
    memory.queued = queued;
  }, [draft, memory, pending, queued]);

  useEffect(() => {
    mountedChatKey = memoryKey;
    return () => {
      if (mountedChatKey === memoryKey) mountedChatKey = null;
    };
  }, [memoryKey]);

  // The pending echo clears as soon as the real transcript carries the prompt.
  useEffect(() => {
    if (pending !== null && pendingResolved(pending, state.transcript)) {
      memory.pending = null;
      setPending(null);
    }
  });

  useEffect(() => {
    if (state.busy || !state.canSend || pending !== null || queued.length === 0) return;
    const [next, ...rest] = queued;
    if (!next) return;
    memory.queued = rest;
    setQueued(rest);
    widget.sendIntent(INTENT_QUEUE, { action: "send", text: next });
    memory.pending = next;
    setPending(next);
    stick.current = true;
  }, [state.busy, state.canSend, pending, queued]);

  // Auto-scroll AFTER layout, and only when the reader hadn't scrolled up to read something.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (!restoredScroll.current) {
      el.scrollTop = memory.scrollTop ?? el.scrollHeight;
      restoredScroll.current = true;
      return;
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  });

  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [draft]);

  useEffect(() => {
    if (focusedComposer.current || !state.canSend || state.startup !== "ready") return;
    textarea.current?.focus();
    focusedComposer.current = true;
  }, [state.canSend, state.startup]);

  const onScroll = (): void => {
    const el = scroller.current;
    if (el) {
      stick.current = nearBottom(el);
      memory.stick = stick.current;
      memory.scrollTop = el.scrollTop;
    }
  };

  const send = (): void => {
    const text = draft.trim();
    if (text === "") return;
    if (state.busy) {
      setQueued((messages) => {
        const next = [...messages, text];
        memory.queued = next;
        return next;
      });
      setDraft("");
      return;
    }
    if (!state.canSend) return;
    widget.sendIntent(INTENT_QUEUE, { action: "send", text });
    memory.pending = text;
    setPending(text);
    setDraft("");
    stick.current = true;
    memory.stick = true;
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
        <button class="vw-back" type="button" onClick={onBack} title="All chats" aria-label="Back to chats">
          ‹
        </button>
        <span class="vw-hname">{attached ? sessionDisplayName(attached) : harnessDisplayName(state.harness)}</span>
        <span class="vw-hsub">{harnessDisplayName(attached?.harness ?? state.harness)}</span>
        {readOnly ? <span class="vw-ro">read-only</span> : null}
      </div>
      <div class="vw-scroll" ref={scroller} onScroll={onScroll} tabIndex={0} aria-label="Conversation">
        {empty && state.startup !== "ready" ? <StartupStatus state={state} /> : null}
        {empty && state.startup === "ready" ? (
          <div class="vw-empty">{state.error ?? (state.harness ? `${harnessDisplayName(state.harness)} is listening. Say something.` : "No transcript yet.")}</div>
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
        {state.busy ? (
          <div class="vw-typing" role="status" aria-label={`${harnessDisplayName(state.harness)} is working`}>
            <span class="vw-typing-mark" aria-hidden="true">✦</span>
            <span class="vw-typing-dots" aria-hidden="true"><i /><i /><i /></span>
            <span>{harnessDisplayName(state.harness)} is working</span>
          </div>
        ) : null}
      </div>
      {state.error !== null && !empty ? <div class="vw-error">{state.error}</div> : null}
      <div class="vw-composer">
        {queued.length ? (
          <div class="vw-queue" role="status">
            <strong>{queued.length} queued</strong>
            {queued.map((message, index) => <div key={`${index}:${message}`}><span>{message}</span><button type="button" aria-label={`Remove queued message ${index + 1}`} onClick={(): void => setQueued((items) => {
              const next = items.filter((_, itemIndex) => itemIndex !== index);
              memory.queued = next;
              return next;
            })}>×</button></div>)}
          </div>
        ) : null}
        {readOnly ? (
          <div class="vw-readonly" aria-label="Read-only chat">
            <span aria-hidden="true">◉</span>
            <span><strong>Read-only</strong> · controlled in another agent window</span>
          </div>
        ) : (
          <div class="vw-envelope">
            <textarea
              ref={textarea}
              class="vw-input"
              rows={2}
              aria-label={`Message ${harnessDisplayName(attached?.harness ?? state.harness ?? "agent")}`}
              placeholder={state.startup !== "ready" ? "Connecting…" : state.busy ? "Queue a follow-up…" : "Ask your agent…"}
              value={draft}
              disabled={state.mode !== "control" && !state.canSend}
              onInput={(e): void => {
                const value = (e.currentTarget as HTMLTextAreaElement).value;
                memory.draft = value;
                setDraft(value);
              }}
              onKeyDown={onKeyDown}
            />
            <div class="vw-composer-foot">
              <span class="vw-agent-id">{harnessDisplayName(attached?.harness ?? state.harness)}</span>
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
  const [view, setView] = useState<View>(() => rememberedUi.view === "chat" && s.attached !== null ? "chat" : "list");
  const [query, setQuery] = useState(rememberedUi.query);
  const [awaiting, setAwaiting] = useState<{ key: string; startedAt: number } | null>(null);
  const [openingNow, setOpeningNow] = useState(() => Date.now());
  // The failure is copied into local state on arrival so the row can stop showing it without the
  // host having to retract anything — the host's `attachError` is a fact about the last attach and
  // stays true until the next one.
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);

  useEffect(() => {
    rememberedUi.view = view;
    rememberedUi.query = query;
  }, [query, view]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") widget.close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // The awaited attach settled — either into that session's chat, or into a reason under its row.
  useEffect(() => {
    const outcome = attachOutcome(awaiting?.key ?? null, s.attached, s.attachError);
    if (outcome === "attached") {
      setAwaiting(null);
      setFailure(null);
      setView("chat");
    } else if (outcome === "failed" && s.attachError !== null) {
      setAwaiting(null);
      setFailure(s.attachError);
    }
  });

  useEffect(() => {
    if (awaiting === null) return undefined;
    setOpeningNow(Date.now());
    const timer = setInterval(() => setOpeningNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [awaiting]);

  // …and the reason fades on its own, so a stale failure never becomes permanent furniture.
  useEffect(() => {
    if (failure === null) return undefined;
    const timer = setTimeout(() => setFailure(null), ATTACH_ERROR_LINGER_MS);
    return () => clearTimeout(timer);
  }, [failure]);

  const open = (row: SessionRow): void => {
    setFailure(null);
    if (s.attached?.key === row.key) {
      setView("chat");
      return;
    }
    // The keyless row is the daemon-owned runtime before its first persisted turn. While we are
    // already on it there is nothing to ask; from a mirror, releasing that mirror restores it.
    if (row.key === "") {
      if (s.attached?.key === "") {
        setView("chat");
      } else {
        widget.sendIntent(INTENT_QUEUE, { action: "release" });
        setAwaiting({ key: "", startedAt: Date.now() });
      }
      return;
    }
    widget.sendIntent(INTENT_QUEUE, { action: "attach", key: row.key });
    setAwaiting({ key: row.key, startedAt: Date.now() });
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
  return (
    <SessionList
      state={s}
      awaiting={awaiting}
      now={openingNow}
      failure={failure}
      query={query}
      onQuery={setQuery}
      onOpen={open}
    />
  );
}

// The last tone the host reported — the shell asks for it whenever it redraws the pill's dot.
let lastTone: WidgetState["pill"]["tone"] = "off";
widget.registerPanel({
  id: "agent",
  title: "Chats",
  render: mountPanel(MessengerPanel),
  default: true,
  indicator: () => lastTone,
  // A total-session count looks exactly like an unread badge. We do not have unread semantics yet,
  // so showing no badge is more honest and calmer than a permanent red-herring count.
  badge: () => 0,
});

/**
 * Preact panel content is unmounted while Lucarne draws the collapsed pill. Keep the queue alive at
 * module scope so a follow-up advances when the agent becomes idle even if the messenger is still
 * minimized (the mounted Chat component owns the same transition while it is visible).
 */
function advanceMinimizedQueue(state: WidgetState): void {
  const key = chatMemoryKey(state);
  if (mountedChatKey === key) return;
  const memory = rememberedChats.get(key);
  if (!memory) return;
  if (memory.pending !== null && pendingResolved(memory.pending, state.transcript)) memory.pending = null;
  if (state.busy || !state.canSend || memory.pending !== null) return;
  const next = memory.queued.shift();
  if (!next) return;
  memory.pending = next;
  memory.stick = true;
  widget.sendIntent(INTENT_QUEUE, { action: "send", text: next });
}

// The pill is shell chrome, not panel content — it is the one thing visible while the panel is closed.
widget.onPatch((patch) => {
  if (!isRecord(patch) || !("pill" in patch)) return;
  const state = readWidgetState(patch);
  advanceMinimizedQueue(state);
  const pill = pillFor(state);
  lastTone = pill.tone;
  widget.setPill({ tone: pill.tone, label: pill.label });
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
