// The iframe app — ONE panel in the minimized-messenger shape: the active conversation opens
// first, with the machine-wide inbox and new-chat composer one tap away.
//
//   inbox  ──tap a row──▶  opening ──host confirms──▶ chat
//     ▲                         │                         │
//     └─────────────────────────┴────── ‹ back ──────────┘
//
// It is bundled into a single self-contained srcdoc document by `widget/build.mjs`
// (`lucarne/widget/build`), so there is no module loading, no network, and no framework CDN inside
// the page it mounts on. Everything it knows arrives as pushed patches; everything it wants goes
// out as one named intent (`send` from the composer, `attach` from a row).
//
// The view is LOCAL state: which screen you are on is not a fact about the machine, so the host is
// never told and a re-push never yanks you between screens. Attach begins an immediate loading
// surface; the old transcript is never shown under the new conversation's name.
import { createWidget } from "lucarne/widget/runtime";
import { mountPanel } from "lucarne/widget/preact";
import MarkdownIt from "markdown-it";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { render as renderPreact } from "preact";
import type { JSX } from "preact";
import {
  ATTACH_ERROR_LINGER_MS,
  attachOutcome,
  attachSettled,
  filterSessionRows,
  harnessDisplayName,
  isSendKey,
  nearBottom,
  orderedSessionRows,
  operationLabel,
  pendingResolved,
  pillFor,
  pillModeFor,
  readWidgetState,
  roleLabel,
  activityLabel,
  attentionFor,
  messageTime,
  sessionActivity,
  sessionDetail,
  sessionDisplayName,
  openingMessage,
  startupMessage,
  type SessionRow,
  type PillMode,
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
import { HarnessLogo, hasHarnessLogo } from "./harness-logo.js";

const NS = "vibewaiting";
const INTENT_QUEUE = "agent";

const widget = createWidget({ ns: NS, version: 1 });

// CSS viewport units inside the widget describe the iframe itself. While collapsed that viewport
// is only the launcher's size, so `100vw` creates a circular trap: a 46px iframe asks the host for
// a 46px panel and can never grow. A srcdoc iframe inherits the embedding page's origin; read that
// real viewport when available, clamp the messenger to it, and let Lucarne's normal size handshake
// fit the host to the resulting fixed dimensions.
function syncPanelViewport(requestResize = true): void {
  let pageWidth = 420 + 16;
  let pageHeight = 480 + 16;
  try {
    pageWidth = window.parent.innerWidth;
    pageHeight = window.parent.innerHeight;
  } catch {
    // A stricter embed still gets the safe desktop dimensions below.
  }
  // Preserve a real 16px margin on BOTH axes after the host's own border is added. Subtracting
  // only the right/bottom inset made a 390px viewport produce a 376px outer panel at right:16,
  // which placed its left rim at -2px and visibly clipped the mobile widget.
  const width = Math.max(240, Math.min(420, pageWidth - 32));
  const height = Math.max(280, Math.min(480, pageHeight - 32));
  document.documentElement.style.setProperty("--vw-panel-width", `${width}px`);
  document.documentElement.style.setProperty("--vw-panel-height", `${height}px`);
  if (requestResize) widget.requestResize();
}

syncPanelViewport(false);
try {
  const pageWindow = window.parent;
  const onPageResize = (): void => syncPanelViewport();
  pageWindow.addEventListener("resize", onPageResize);
  window.addEventListener("unload", () => pageWindow.removeEventListener("resize", onPageResize), { once: true });
} catch {
  // Cross-origin embedders simply retain the fallback dimensions.
}

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

function MessageRow({
  entry,
  pending,
  failed,
  onRetry,
}: {
  entry: TranscriptEntry;
  pending?: boolean | undefined;
  failed?: boolean | undefined;
  onRetry?: (() => void) | undefined;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard?.writeText(entry.text).then(() => setCopied(true)).catch(() => undefined);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <article class={`vw-message vw-${entry.role}${pending ? " vw-pending" : ""}${failed ? " vw-message-failed" : ""}`} aria-label={failed ? "user message failed" : pending ? "user message sending" : `${roleLabel(entry.role)} message`}>
      <MarkdownContent value={entry.text} />
      {entry.truncated ? <span class="vw-cut">[truncated]</span> : null}
      {entry.role === "assistant" ? <button class="vw-copy" type="button" aria-label={copied ? "Response copied" : "Copy response"} onClick={copy}>{copied ? "✓" : "Copy"}</button> : null}
      {entry.ts !== null ? <time class="vw-message-time" dateTime={new Date(entry.ts).toISOString()}>{messageTime(entry.ts)}</time> : null}
      {pending && !failed ? <span class="vw-sending">Sending…</span> : null}
      {failed ? <span class="vw-send-failed">Not sent{onRetry ? <button type="button" onClick={onRetry}>Retry</button> : null}</span> : null}
    </article>
  );
}

function TranscriptRow({ entry, pending, failed, onRetry, canRespond }: { entry: TranscriptEntry; pending?: boolean | undefined; failed?: boolean | undefined; onRetry?: (() => void) | undefined; canRespond: boolean }): JSX.Element | null {
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
  return <MessageRow entry={entry} pending={pending} failed={failed} onRetry={onRetry} />;
}

function SessionListRow({
  row,
  activity,
  openingLabel,
  error,
  onOpen,
}: {
  row: SessionRow;
  activity: ReturnType<typeof sessionActivity>;
  openingLabel: string | null;
  /** The last attach failure for THIS row, shown in place of its subtitle until it clears. */
  error: string | null;
  onOpen: () => void;
}): JSX.Element {
  const opening = openingLabel !== null;
  const status = activityLabel(activity);
  return (
    <button
      class={`vw-srow${row.active ? " vw-active" : ""}${opening ? " vw-srow-opening" : ""}`}
      type="button"
      onClick={onOpen}
      aria-busy={opening}
      title={`${harnessDisplayName(row.harness)} · ${row.cwd}${status ? ` · ${status}` : ""}`}
    >
      <HarnessLogo id={row.harness} activity={activity} size={32} />
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
            {status ? <span class="vw-row-status" data-activity={activity}>{status}</span> : <span class="vw-sharness">{harnessDisplayName(row.harness)}</span>}
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
  onNew,
  onClose,
  onOpen,
}: {
  state: WidgetState;
  awaiting: { key: string; startedAt: number } | null;
  now: number;
  /** The attach that failed, still worth showing under its row. */
  failure: { key: string; message: string } | null;
  query: string;
  onQuery: (query: string) => void;
  onNew: () => void;
  onClose: () => void;
  onOpen: (row: SessionRow) => void;
}): JSX.Element {
  const allRows = orderedSessionRows(state);
  const rows = filterSessionRows(allRows, query);
  const loading = state.startup !== "ready";
  return (
    <div class="vw-screen">
      <div class="vw-app-head">
        <span class="vw-head-copy"><strong>Chats</strong><small>{state.attention.length ? `${state.attention.length} unread` : `${allRows.length} recent`}</small></span>
        <button class="vw-icon" type="button" aria-label="New chat" title="New chat" disabled={state.busy || !state.harnesses.some((harness) => harness.startable)} onClick={onNew}>＋</button>
        <button class="vw-icon" type="button" aria-label="Close chat" title="Close chat" onClick={onClose}>×</button>
      </div>
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
            activity={sessionActivity(state, row)}
            openingLabel={awaiting?.key === row.key ? openingMessage(now - awaiting.startedAt) : null}
            error={failure !== null && failure.key === row.key ? failure.message : null}
            onOpen={(): void => onOpen(row)}
          />
        ))}
      </div>
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
const rememberedUi: { view: View; query: string } = { view: "chat", query: "" };
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

function Chat({ state, onBack, onNew, onClose }: { state: WidgetState; onBack: () => void; onNew: () => void; onClose: () => void }): JSX.Element {
  const memory = chatMemory(state);
  const memoryKey = chatMemoryKey(state);
  const [draft, setDraft] = useState(memory.draft);
  const [pending, setPending] = useState<string | null>(memory.pending);
  const [queued, setQueued] = useState<string[]>(memory.queued);
  const scroller = useRef<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const stick = useRef(memory.stick);
  const pinnedUntil = useRef(0);
  const [atBottom, setAtBottom] = useState(memory.stick);
  const restoredScroll = useRef(false);
  const focusedComposer = useRef(false);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const currentAttention = state.attached?.key ? attentionFor(state, state.attached.key) : null;

  useEffect(() => {
    const key = state.attached?.key;
    // A completion can arrive while this exact chat is already open. Acknowledging only on
    // navigation would leave the launcher claiming there is unread work the reader just watched.
    if (key && currentAttention) widget.sendIntent(INTENT_QUEUE, { action: "ack", key });
  }, [currentAttention, state.attached?.key]);

  useEffect(() => {
    if (state.error !== dismissedError) setDismissedError(null);
  }, [state.error]);

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
      pinnedUntil.current = performance.now() + 120;
      restoredScroll.current = true;
      return;
    }
    if (stick.current) {
      pinnedUntil.current = performance.now() + 120;
      el.scrollTop = el.scrollHeight;
    }
  });

  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      if (!stick.current) return;
      pinnedUntil.current = performance.now() + 120;
      el.scrollTop = el.scrollHeight;
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, [memoryKey]);

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
      const bottom = nearBottom(el);
      if (!bottom && performance.now() < pinnedUntil.current) return;
      stick.current = bottom;
      setAtBottom(bottom);
      memory.stick = stick.current;
      memory.scrollTop = el.scrollTop;
    }
  };

  const pin = (): void => {
    const el = scroller.current;
    stick.current = true;
    memory.stick = true;
    setAtBottom(true);
    if (!el) return;
    pinnedUntil.current = performance.now() + 120;
    el.scrollTop = el.scrollHeight;
    memory.scrollTop = el.scrollTop;
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
    pin();
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
  const harnessName = harnessDisplayName(attached?.harness ?? state.harness);
  // Read-only is the controller's own honest capability for a session someone else is driving; the
  // composer says so rather than offering a send that can only fail.
  const readOnly = state.mode === "mirror" && !state.canSend;
  const blocks = conversationBlocks(state.transcript);
  const status = state.needsInput
    ? "Needs input"
    : state.busy
      ? "Working"
      : readOnly
        ? "Read-only"
        : "Ready";
  const op = operationLabel(state.operation);
  const visibleError = state.error !== null && state.error !== dismissedError ? state.error : null;
  const headerTitle = attached ? sessionDisplayName(attached) : harnessName || "Agent chat";
  const headerStatus = state.startup === "ready"
    ? `${harnessName || "Coding agent"} · ${status}`
    : startupMessage(state.startup, state.harness).title;

  return (
    <div class="vw-chat">
      <div class="vw-app-head vw-chat-head">
        <button class="vw-icon" type="button" onClick={onBack} title="All chats" aria-label="Back to chats">
          ‹
        </button>
        <HarnessLogo id={attached?.harness ?? state.harness} size={28} />
        <span class="vw-head-copy">
          <strong>{headerTitle}</strong>
          <small data-state={state.needsInput ? "needs-input" : state.busy ? "working" : readOnly ? "mirror" : "ready"}>{headerStatus}</small>
        </span>
        <button class="vw-icon" type="button" aria-label="New chat" title="New chat" disabled={state.busy || !state.harnesses.some((harness) => harness.startable)} onClick={onNew}>＋</button>
        <button class="vw-icon" type="button" aria-label="Close chat" title="Close chat" onClick={onClose}>×</button>
      </div>
      {op ? <div class="vw-operation" role="status"><span class="vw-spinner vw-spinner-small" aria-hidden="true" />{op}</div> : null}
      {visibleError ? (
        <div class="vw-error" role="alert">
          <span>{visibleError}</span>
          {state.recoverable ? <button type="button" onClick={(): void => { widget.sendIntent(INTENT_QUEUE, { action: "refresh" }); }}>Retry</button> : null}
          <button type="button" aria-label="Dismiss agent error" onClick={(): void => setDismissedError(visibleError)}>×</button>
        </div>
      ) : null}
      <div class="vw-scroll" ref={scroller} onScroll={onScroll} tabIndex={0} aria-label="Conversation">
        <div ref={content}>
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
              failed={state.error !== null && !state.busy}
              onRetry={(): void => {
                memory.pending = null;
                setPending(null);
                memory.draft = pending;
                setDraft(pending);
                textarea.current?.focus();
              }}
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
      </div>
      {!atBottom ? <button class="vw-latest" type="button" onClick={pin}>↓ Latest</button> : null}
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

let rememberedNewDraft = "";
let rememberedNewHarness = "";

function NewChat({
  state,
  onBack,
  onClose,
  onStarted,
}: {
  state: WidgetState;
  onBack: () => void;
  onClose: () => void;
  onStarted: () => void;
}): JSX.Element {
  const startable = state.harnesses.filter((harness) => harness.startable);
  const initialHarness = rememberedNewHarness || startable.find((item) => item.id === state.harness)?.id || startable[0]?.id || "";
  const [harness, setHarness] = useState(initialHarness);
  const [draft, setDraft] = useState(rememberedNewDraft);
  const [starting, setStarting] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => textarea.current?.focus(), []);
  useEffect(() => {
    rememberedNewHarness = harness;
    rememberedNewDraft = draft;
  }, [draft, harness]);
  useEffect(() => {
    if (!starting) return;
    if (pendingResolved(starting, state.transcript) || (state.mode === "control" && state.harness === harness && state.busy)) {
      rememberedNewDraft = "";
      setDraft("");
      onStarted();
    } else if (state.error && !state.operation && !state.busy) {
      setStarting(null);
    }
  }, [harness, onStarted, starting, state.busy, state.error, state.harness, state.mode, state.operation, state.transcript]);

  const send = (): void => {
    const text = draft.trim();
    if (!text || !harness || starting) return;
    setStarting(text);
    widget.sendIntent(INTENT_QUEUE, { action: "new", harness, text });
  };

  return (
    <div class="vw-chat vw-new-chat">
      <div class="vw-app-head">
        <button class="vw-icon" type="button" aria-label="Cancel new chat" title="Back" onClick={onBack}>‹</button>
        <span class="vw-head-copy"><strong>New chat</strong><small>No session is created until you send</small></span>
        <button class="vw-icon" type="button" aria-label="Close chat" title="Close chat" onClick={onClose}>×</button>
      </div>
      <div class="vw-new-body">
        <span class="vw-new-mark" aria-hidden="true">✦</span>
        <strong>What should the agent build or fix?</strong>
        <span>Choose a coding harness and send the first message.</span>
      </div>
      {state.error && starting ? <div class="vw-error" role="alert"><span>{state.error}</span></div> : null}
      <div class="vw-composer">
      <div class="vw-new-picker">
          <HarnessLogo id={harness} size={24} />
          <label for="vw-new-harness">Coding harness</label>
          <select id="vw-new-harness" value={harness} disabled={Boolean(starting)} onChange={(event): void => setHarness(event.currentTarget.value)}>
            {state.harnesses.map((item) => <option key={item.id} value={item.id} disabled={!item.startable}>{item.label}{item.startable ? "" : " · unavailable"}</option>)}
          </select>
        </div>
        <div class="vw-envelope">
          <textarea
            ref={textarea}
            class="vw-input"
            rows={3}
            aria-label="Message coding agent"
            placeholder={startable.length ? "What should the agent do?" : "No coding harness is available"}
            value={draft}
            disabled={!startable.length || Boolean(starting)}
            onInput={(event): void => setDraft(event.currentTarget.value)}
            onKeyDown={(event): void => {
              if (!isSendKey(event)) return;
              event.preventDefault();
              send();
            }}
          />
          <div class="vw-composer-foot">
            <span class="vw-agent-id">{state.harnesses.find((item) => item.id === harness)?.label ?? "Agent"}</span>
            <button class="vw-send" type="button" aria-label="Start chat" disabled={!draft.trim() || !harness || Boolean(starting)} onClick={send}>{starting ? <span class="vw-spinner" aria-hidden="true" /> : "↑"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function OpeningChat({ row, elapsed, onBack, onClose }: { row: SessionRow; elapsed: number; onBack: () => void; onClose: () => void }): JSX.Element {
  return (
    <div class="vw-chat">
      <div class="vw-app-head">
        <button class="vw-icon" type="button" aria-label="Back to chats" onClick={onBack}>‹</button>
        <HarnessLogo id={row.harness} size={28} />
        <span class="vw-head-copy"><strong>{sessionDisplayName(row)}</strong><small>{harnessDisplayName(row.harness)} · Opening</small></span>
        <button class="vw-icon" type="button" aria-label="Close chat" onClick={onClose}>×</button>
      </div>
      <div class="vw-opening" role="status" aria-busy="true">
        <span class="vw-startup-orbit" aria-hidden="true"><span /></span>
        <strong>{openingMessage(elapsed)}</strong>
        <span>{elapsed < 4_000 ? "Connecting to the conversation…" : "Loading the latest transcript window…"}</span>
      </div>
    </div>
  );
}

function MessengerPanel({ state }: { state: unknown }): JSX.Element {
  const s = readWidgetState(state);
  const [view, setView] = useState<View>(() => rememberedUi.view);
  const [query, setQuery] = useState(rememberedUi.query);
  const [awaiting, setAwaiting] = useState<{ key: string; startedAt: number; row: SessionRow } | null>(null);
  const [openingNow, setOpeningNow] = useState(() => Date.now());
  // The failure is copied into local state on arrival so the row can stop showing it without the
  // host having to retract anything — the host's `attachError` is a fact about the last attach and
  // stays true until the next one.
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const viewRef = useRef(view);
  const hasAttachedRef = useRef(s.attached !== null);
  viewRef.current = view;
  hasAttachedRef.current = s.attached !== null;

  useEffect(() => {
    rememberedUi.view = view;
    rememberedUi.query = query;
  }, [query, view]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (viewRef.current === "new") setView(hasAttachedRef.current ? "chat" : "list");
      else if (viewRef.current === "list" && hasAttachedRef.current) setView("chat");
      else widget.close();
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
      setView("list");
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
      if (row.key) widget.sendIntent(INTENT_QUEUE, { action: "ack", key: row.key });
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
        setAwaiting({ key: "", startedAt: Date.now(), row });
        setView("chat");
      }
      return;
    }
    widget.sendIntent(INTENT_QUEUE, { action: "attach", key: row.key });
    setAwaiting({ key: row.key, startedAt: Date.now(), row });
    setView("chat");
  };

  if (view === "new") {
    return <NewChat state={s} onBack={(): void => setView(s.attached ? "chat" : "list")} onClose={(): void => widget.close()} onStarted={(): void => setView("chat")} />;
  }
  if (view === "chat") {
    if (awaiting !== null && !attachSettled(awaiting.key, s.attached)) {
      return <OpeningChat row={awaiting.row} elapsed={openingNow - awaiting.startedAt} onBack={(): void => { setAwaiting(null); setView("list"); }} onClose={(): void => widget.close()} />;
    }
    return (
      <Chat
        state={s}
        onBack={(): void => {
          setView("list");
        }}
        onNew={(): void => setView("new")}
        onClose={(): void => widget.close()}
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
      onNew={(): void => setView("new")}
      onClose={(): void => widget.close()}
      onOpen={open}
    />
  );
}

// The last tone the host reported — the shell asks for it whenever it redraws the pill's dot.
let lastTone: WidgetState["pill"]["tone"] = "off";
let unreadCount = 0;
let collapsedMode: PillMode = "connecting";
let collapsedHarness = "";
let collapsedRenderKey: string | null = null;
widget.registerPanel({
  id: "agent",
  title: "Chats",
  render: mountPanel(MessengerPanel),
  default: true,
  indicator: () => lastTone,
  badge: () => unreadCount,
});

// 50px control + 4px visual bleed on each side. The outer host adds its own 1px rim, yielding the
// conventional 60px messenger footprint without clipping badges, rings, shadows, or focus paint.
const COLLAPSED_SIZE_PX = 58;
let collapsedHostObserver: MutationObserver | null = null;

/**
 * Lucarne 1.7.x floors every host width at 80px. That is useful for generic text pills but wrong
 * for a floating messenger launcher. The iframe is same-origin by Lucarne's shell contract, so
 * while (and only while) the pill exists, keep its outer host matched to the square content. The
 * style observer reasserts the size after Lucarne's close-time resize relay reapplies its floor.
 */
function fitCollapsedHost(): void {
  const pill = document.querySelector<HTMLButtonElement>(".pill");
  const root = window.frameElement?.getRootNode();
  const host = root && "host" in root ? (root as ShadowRoot).host : null;
  if (!host || !("style" in host)) return;
  const hostElement = host as HTMLElement;
  if (!pill) {
    if (hostElement.style.borderRadius !== "26px") hostElement.style.borderRadius = "26px";
    return;
  }
  const size = `${COLLAPSED_SIZE_PX}px`;
  if (hostElement.style.width !== size) hostElement.style.width = size;
  if (hostElement.style.height !== size) hostElement.style.height = size;
  if (hostElement.style.borderRadius !== "30px") hostElement.style.borderRadius = "30px";
  const identityReady = hasHarnessLogo(collapsedHarness);
  const visibility = identityReady ? "visible" : "hidden";
  const pointerEvents = identityReady ? "auto" : "none";
  if (hostElement.style.visibility !== visibility) hostElement.style.visibility = visibility;
  if (hostElement.style.pointerEvents !== pointerEvents) hostElement.style.pointerEvents = pointerEvents;
  if (!collapsedHostObserver) {
    collapsedHostObserver = new MutationObserver(fitCollapsedHost);
    collapsedHostObserver.observe(hostElement, { attributes: true, attributeFilter: ["style"] });
  }
}

/**
 * Lucarne owns the pill DOM, but this app owns its identity. Decorate each shell redraw with the
 * same canonical harness mark used throughout the messenger and expose its semantic layout mode
 * to CSS. Observing only the wrap's direct children avoids reacting to our own logo render.
 */
function syncCollapsedChrome(): void {
  const pill = document.querySelector<HTMLButtonElement>(".pill");
  if (!pill) return;
  pill.dataset.mode = collapsedMode;
  const identityReady = hasHarnessLogo(collapsedHarness);
  pill.hidden = !identityReady;
  const brand = pill.querySelector<HTMLElement>(".brand");
  if (brand) {
    renderPreact(
      collapsedHarness
        ? <HarnessLogo id={collapsedHarness} size={30} />
        : null,
      brand,
    );
  }
  fitCollapsedHost();
}

const shellWrap = document.querySelector(".wrap");
if (shellWrap) {
  new MutationObserver(syncCollapsedChrome).observe(shellWrap, { childList: true });
}
syncCollapsedChrome();

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
  unreadCount = state.attention.length + (state.needsInput ? 1 : 0);
  collapsedMode = pillModeFor(state);
  collapsedHarness = state.attached?.harness
    ?? state.harness
    ?? state.sessions.find((session) => session.active)?.harness
    ?? "";
  const renderKey = [pill.tone, pill.label, collapsedMode, collapsedHarness, unreadCount].join("\u0000");
  if (renderKey !== collapsedRenderKey) {
    collapsedRenderKey = renderKey;
    widget.setPill({ tone: pill.tone, label: pill.label });
    syncCollapsedChrome();
  }
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
