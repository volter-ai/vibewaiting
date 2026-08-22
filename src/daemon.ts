// The bridge: one lucarne widget on one browser session ⟷ the coding sessions on this machine.
//
// Three directions, and only three:
//   controller revision → debounced `project(snapshot)` → `host.push(patch)`
//   per-harness discovery slices → merged `projectSessions(descriptors)` → the same push
//   widget intent ("agent" queue) → `send`/`interrupt`/`respond`, `attach` elsewhere, or `release`
//
// Both ends are INJECTABLE (`attachHost`, `client`, `controller`) because the honest test of this
// module is a scripted snapshot sequence, not a browser: the widget half is proven by the fake host
// recording pushes, the agent half by the real `SupercodeController` driven through a fake harness
// client. Nothing here reaches for a global.
//
// TWO controllers, deliberately. The one the daemon starts OWNS a runtime, and the client package
// refuses to point an owning controller at someone else's session (`runtime_owned`) — while
// `setWorkspace` would silently close that runtime to go looking. So a foreign session is followed
// by a SECOND, non-owning controller scoped to that session's own workspace, sharing this process's
// one harness transport (`ownsClient: false`). Attaching therefore never touches the session the
// daemon started, and detaching is just closing the second controller.
import { SessionWindowCache, SupercodeController } from "@volter-ai-dev/supercode-client";
import type {
  FrontendHarness,
  HarnessClientAdapter,
  PromptContextItem,
  PromptImageItem,
  SupercodeClientAction,
  SupercodeClientSnapshot,
} from "@volter-ai-dev/supercode-client";
import type { DiscoveryQuery, HarnessId, HarnessSettingChange, JsonValue, SessionArtifact, SessionDescriptor, SessionFormat, SessionLocator, StructuredLaunch } from "@volter-ai-dev/supercode-harness-sdk";
import type { ContinuationMode } from "@volter-ai-dev/supercode-ui";
import { createLucarneInjector } from "@volter-ai-dev/widget-shell/lucarne";
import { WidgetHost } from "lucarne/widget/host";
import {
  DEFAULT_MAX_ENTRIES,
  projectWithImages,
  toAttachError,
  type AttachError,
  type ProjectionOptions,
  type SessionAttention,
  type SessionAttentionKind,
  type StartupPhase,
  type WidgetState,
} from "./projection.js";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import type { MessengerPersistence } from "./persistence.js";
import { writeSessionArtifact } from "./artifacts.js";
import type { ExportReceipt } from "./projection.js";
import {
  MAX_SESSION_ROWS,
  attachmentFor,
  matchesActive,
  projectSessions,
  sessionKey,
  type ActiveSessionRef,
  type SessionRow,
} from "./sessions.js";
import { VIBEWAITING_RADIUS } from "./theme.js";
import {
  VIBEWAITING_PRESENTATION,
  VIBEWAITING_PRESENTATIONS,
} from "./presentations.js";
import type { TerminalServiceSnapshot } from "./terminal-service.js";

/** Namespaces every page global / element id / sticky-injection id the widget mints (see `lucarne/widget/ns`). */
export const WIDGET_NS = "vibewaiting";
/** The one named intent queue the panel posts to and this daemon drains. */
export const INTENT_QUEUE = "agent";
/** Controller revisions arrive in bursts (one per streamed delta); coalesce them into one push. */
export const DEFAULT_PUSH_DEBOUNCE_MS = 150;
/** Messenger interactions should reach the daemon in the same perceptual beat as the click. */
export const DEFAULT_INTENT_POLL_MS = 100;
/**
 * Legacy state heartbeat. Fresh iframe mounts now announce themselves through the intent queue,
 * so unchanged transcripts never need to cross CDP on a timer. Kept configurable for embedders
 * running an older widget bundle; the default is deliberately event-driven.
 */
export const DEFAULT_REPUSH_INTERVAL_MS = 0;
/** Slow recovery/inventory cadence. Claude Code and Codex update through the native index stream. */
export const DEFAULT_DISCOVER_INTERVAL_MS = 60_000;
/** Re-check a still-untitled new Claude/Codex session without rescanning topic history every tick. */
const TOPIC_RETRY_MS = 30_000;
/** Tool-stream churn is not unread. A no-status peer must be quiet this long before it asks for attention. */
export const DEFAULT_ATTENTION_SETTLE_MS = 15_000;
/** A broken harness attach must become a visible row error, never an eternal local spinner. */
export const DEFAULT_ATTACH_TIMEOUT_MS = 45_000;
/** Harnesses tried, in order, when the caller named none — first one that can actually start wins. */
export const HARNESS_PREFERENCE: readonly string[] = [
  "claude-code",
  "codex",
  "gemini",
  "goose",
  "opencode",
  "pi",
  "grok",
];
/** The widget renders this many entries, so its passive transport should never fetch more. */
const PASSIVE_MIRROR_VIEW = Object.freeze({
  tailMessages: DEFAULT_MAX_ENTRIES,
  maxMessageChars: 16_000,
  includeSubagents: false,
  displayHistory: true,
});
/** Each explicit history request adds one bounded page, never the entire transcript/session store. */
export const TRANSCRIPT_PAGE_SIZE = DEFAULT_MAX_ENTRIES;
/** A historical image is fetched only on click, but each request still has a hard memory bound. */
export const MAX_HISTORICAL_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_HISTORICAL_IMAGE_URL_CHARS = 22_400_000;

/** The slice of `WidgetHost` this daemon uses — the seam a test replaces with a recorder. */
export interface WidgetBridge {
  push(patch: unknown): Promise<void>;
  onIntent(name: string, cb: (intent: { id: string | number; payload: unknown }) => void | Promise<void>): void;
  /**
   * Lucarne's context-aware queue primitive. Newer hosts expose this so a latency-sensitive app
   * can choose its own drain cadence instead of waiting for the conservative shared 1.2s pump.
   */
  drainIntentsWithContext?(name: string): Promise<Array<{
    items: Array<{ id: string | number; payload: unknown }>;
  }>>;
  /** Crash-safe repeating tick (`WidgetHost.every`) — returns a stop function. */
  every(ms: number, fn: () => unknown): () => void;
  remove(): Promise<void>;
}

/** The slice of `SupercodeController` this daemon uses (its external-store contract plus dispatch/close). */
export interface AgentController {
  getSnapshot(): SupercodeClientSnapshot;
  subscribe(listener: () => void): () => void;
  initialize(): Promise<SupercodeClientSnapshot>;
  dispatch(action: SupercodeClientAction): Promise<SupercodeClientSnapshot>;
  exportSession?(sessionKey: string, targetHarness: SessionFormat): Promise<SessionArtifact>;
  close(): Promise<void>;
}

/**
 * The discovery slice of the harness transport, widened where the controller's adapter narrows it.
 *
 * `HarnessClientAdapter.discover` demands a `workspace` because the controller is workspace-scoped;
 * the SDK's own `discover` does not, and calling it with no workspace is exactly the GLOBAL scan
 * this panel exists to show. A real `SupercodeHarnessClient` satisfies both shapes.
 */
export interface SessionDiscoveryClient {
  discover(query: DiscoveryQuery): Promise<{ sessions: SessionDescriptor[] }>;
  subscribeSessionActivity?(
    locators: SessionLocator[],
  ): Promise<{ subscription: string; initial: SessionActivityObservation[] }>;
  unsubscribeSessionActivity?(subscription: string): Promise<{ removed: boolean }>;
  subscribeSessionIndex?(
    query: DiscoveryQuery,
  ): Promise<{ subscription: string; revision: number; initial: SessionDescriptor[] }>;
  unsubscribeSessionIndex?(subscription: string): Promise<{ removed: boolean }>;
}

interface SessionActivityObservation {
  harness: HarnessId;
  session_id: string;
  presence: "persisted" | "running" | "shutting_down";
  turn: "unknown" | "idle" | "working" | "needs_input";
  evidence: {
    source: string;
    native_state: string | null;
    observed_at_ms: number;
    harness_version: string | null;
  };
}

interface SessionActivityEvent {
  subscription: string;
  activities: SessionActivityObservation[];
}

interface SessionActivityEventSource {
  on(event: "sessionActivityEvent", listener: (event: SessionActivityEvent) => void): unknown;
  off(event: "sessionActivityEvent", listener: (event: SessionActivityEvent) => void): unknown;
}

interface SessionIndexEvent {
  subscription: string;
  revision?: number;
  changes?: Array<
    | { kind: "added" | "updated"; descriptor: SessionDescriptor }
    | { kind: "removed"; key: { harness: HarnessId; session_id: string } }
  >;
  error?: { recoverable: true; message: string };
}

interface SessionIndexEventSource {
  on(event: "sessionIndexEvent", listener: (event: SessionIndexEvent) => void): unknown;
  off(event: "sessionIndexEvent", listener: (event: SessionIndexEvent) => void): unknown;
}

/**
 * Native stores are independent inbox sources. Asking for them separately lets the messenger paint
 * the first useful rows without waiting for the slowest store, and lets one broken adapter retain
 * its previous rows without discarding fresh results from every other harness.
 */
const DISCOVERY_HARNESSES: readonly HarnessId[] = [
  "claude-code",
  "codex",
  "gemini",
  "goose",
  "opencode",
  "pi",
  "grok",
  "supercode",
];

/**
 * Skip the owning controller's redundant first workspace scan.
 *
 * The daemon performs one authoritative machine-wide discovery pass immediately after controller inventory.
 * `SupercodeController.initialize()` otherwise queues its own workspace discovery beside harness
 * inventory on the same sequential NDJSON transport. Its timeout then includes time spent waiting
 * behind inventory, even though `autoObserve: false` means startup consumes none of those sessions.
 */
function withSeededOwnerDiscovery(client: HarnessClientAdapter): HarnessClientAdapter {
  let seedDiscovery = true;
  return new Proxy(client, {
    get(target, property): unknown {
      if (property === "discover") {
        return async (query: Parameters<HarnessClientAdapter["discover"]>[0]): Promise<{ sessions: SessionDescriptor[] }> => {
          if (seedDiscovery) {
            seedDiscovery = false;
            return { sessions: [] };
          }
          return await target.discover(query);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as HarnessClientAdapter;
}

/**
 * Give a one-session mirror controller the inventory facts the daemon already established.
 *
 * `SupercodeController.initialize()` normally probes harnesses and discovers the entire target
 * workspace before `observe` can resolve its opaque session key. The inbox row already carries the
 * authoritative locator, and the owning controller already carries the harness inventory, so doing
 * both scans again makes opening proportional to unrelated transcript files. This adapter seeds
 * only the controller's first inventory pass; every other transport method and any later refresh
 * still reaches the real client unchanged.
 */
export function withSeededMirrorInventory(
  client: HarnessClientAdapter,
  descriptor: SessionDescriptor,
  harnesses: readonly FrontendHarness[],
): HarnessClientAdapter {
  let seedDiscovery = true;
  let seedHarnesses = harnesses.some((harness) => harness.id === descriptor.locator.harness);
  return new Proxy(client, {
    get(target, property): unknown {
      if (property === "discover") {
        return async (query: Parameters<HarnessClientAdapter["discover"]>[0]): Promise<{ sessions: SessionDescriptor[] }> => {
          if (seedDiscovery) {
            seedDiscovery = false;
            return { sessions: [descriptor] };
          }
          return await target.discover(query);
        };
      }
      if (property === "listHarnesses") {
        return async (query: Parameters<HarnessClientAdapter["listHarnesses"]>[0]) => {
          if (seedHarnesses) {
            seedHarnesses = false;
            return { harnesses: [...harnesses] };
          }
          return await target.listHarnesses(query);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as HarnessClientAdapter;
}

export interface DaemonOptions {
  /** The lucarne session whose pages get the widget. */
  sessionId: string;
  /** How to reach the lucarne daemon for the one mount call. */
  engine?: { baseUrl?: string | undefined; token?: string | undefined };
  /** The built srcdoc bundle (`dist/widget.html`). */
  html: string;
  /** The project directory the coding agent runs in. */
  workspace: string;
  /** Preferred harness id. Unset → the first startable one in `HARNESS_PREFERENCE`. */
  harness?: HarnessId | undefined;
  /**
   * The controller's execution policy, fixed at construction. The CALLER decides it (it is a host
   * decision, never a browser-dispatchable one — see the client package's security posture); unset
   * means the controller's own default.
   */
  policy?: "default" | "yolo" | undefined;
  /** Inject the harness transport (a real `SupercodeHarnessClient`, or a fake in tests). */
  client?: HarnessClientAdapter | undefined;
  /**
   * Optional background inventory transport. Keeping it separate prevents a slow global scan from
   * queuing user-initiated loads, resumes, and sends behind the same sequential NDJSON process.
   * The caller owns its lifecycle.
   */
  discoveryClient?: SessionDiscoveryClient | undefined;
  /** Inject a whole controller, bypassing construction (tests, or a host that already owns one). */
  controller?: AgentController | undefined;
  /** Replace the widget mount (tests). Default: `WidgetHost.attach`. */
  attachHost?: (opts: { sessionId: string; ns: string; html: string; engine?: DaemonOptions["engine"] }) => Promise<WidgetBridge>;
  pushDebounceMs?: number | undefined;
  /** Intent queue cadence. Default 100ms; `0` uses Lucarne's stock shared drain pump. */
  intentPollMs?: number | undefined;
  /** Legacy compatibility heartbeat. Default `0`; the widget's `mounted` intent requests state. */
  repushIntervalMs?: number | undefined;
  /**
   * How often to re-run GLOBAL session discovery (no workspace → every harness, every project).
   * `0` disables the Sessions panel's refresh entirely (tests). Default `DEFAULT_DISCOVER_INTERVAL_MS`.
   */
  discoverIntervalMs?: number | undefined;
  /** Maximum total time to initialize and observe a foreign session. Default 45 seconds. */
  attachTimeoutMs?: number | undefined;
  /** Home directory folded to `~` in the session list. Default: the process's own. */
  home?: string | undefined;
  /** Clock for relative ages. Default `Date.now` — injected so a test can pin "3m ago". */
  now?: (() => number) | undefined;
  /**
   * How a FOREIGN session gets its (non-owning) controller. Default: a second `SupercodeController`
   * on this daemon's client with `ownsClient: false`, so closing it leaves the transport alone.
   */
  createController?: ((opts: {
    workspace: string;
    descriptor: SessionDescriptor;
    harnesses: readonly FrontendHarness[];
    tailMessages: number;
  }) => AgentController) | undefined;
  projection?: ProjectionOptions | undefined;
  log?: ((message: string) => void) | undefined;
  /** Durable messenger chrome. The CLI supplies a private local file store; tests may inject memory. */
  persistence?: MessengerPersistence | false | undefined;
  /** Materialize a verified export. Default: a private bundle under `<workspace>/.supercode/exports`. */
  materializeArtifact?: ((artifact: SessionArtifact) => Promise<ExportReceipt>) | undefined;
  /** Optional native tmux companion; absent in browser-only and Lucarne-only hosts. */
  terminalService?: TerminalService | undefined;
}

export interface TerminalService {
  snapshot(): Promise<TerminalServiceSnapshot>;
  create(
    harness: "claude-code" | "codex",
    cwd: string,
  ): Promise<TerminalServiceSnapshot>;
  continueSession(
    harness: HarnessId,
    launch: StructuredLaunch,
  ): Promise<TerminalServiceSnapshot>;
  attach(
    sessionId: string,
    mode: "observe" | "control",
  ): Promise<TerminalServiceSnapshot>;
  close(sessionId: string): Promise<TerminalServiceSnapshot>;
  openLocal(sessionId: string): Promise<TerminalServiceSnapshot>;
  dismiss(): Promise<TerminalServiceSnapshot>;
}

type TerminalIntent =
  | { action: "terminalRefresh" }
  | { action: "terminalCreate"; harness: "claude-code" | "codex" }
  | {
      action: "terminalAttach";
      sessionId: string;
      mode: "observe" | "control";
    }
  | { action: "terminalClose"; sessionId: string }
  | { action: "terminalOpenLocal"; sessionId: string }
  | { action: "terminalDismiss" };

function parseTerminalHostIntent(payload: unknown): TerminalIntent | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const value = payload as Record<string, unknown>;
  if (value.action === "terminalRefresh" && Object.keys(value).length === 1)
    return { action: "terminalRefresh" };
  if (value.action === "terminalDismiss" && Object.keys(value).length === 1)
    return { action: "terminalDismiss" };
  if (
    value.action === "terminalCreate" &&
    (value.harness === "claude-code" || value.harness === "codex") &&
    Object.keys(value).length === 2
  ) {
    return { action: "terminalCreate", harness: value.harness };
  }
  if (
    value.action === "terminalClose" &&
    typeof value.sessionId === "string" &&
    Object.keys(value).length === 2
  ) {
    return { action: "terminalClose", sessionId: value.sessionId };
  }
  if (
    value.action === "terminalOpenLocal" &&
    typeof value.sessionId === "string" &&
    Object.keys(value).length === 2
  ) {
    return { action: "terminalOpenLocal", sessionId: value.sessionId };
  }
  if (
    value.action === "terminalAttach" &&
    typeof value.sessionId === "string" &&
    (value.mode === "observe" || value.mode === "control") &&
    Object.keys(value).length === 3
  ) {
    return { action: "terminalAttach", mode: value.mode, sessionId: value.sessionId };
  }
  return null;
}

/**
 * Bind one intent queue at messenger latency when the host exposes its safe context-aware drain.
 * The queue is still read-and-cleared by Lucarne; this layer only chooses a faster cadence and
 * preserves the stock host's dedupe-before-handle contract. Older/test hosts fall back unchanged.
 */
export function bindIntentQueue(
  host: WidgetBridge,
  name: string,
  handler: (intent: { id: string | number; payload: unknown }) => void | Promise<void>,
  pollMs = DEFAULT_INTENT_POLL_MS,
  onSettled?: (intent: { id: string | number; payload: unknown }) => void | Promise<void>,
): () => void {
  const handle = async (intent: { id: string | number; payload: unknown }): Promise<void> => {
    try {
      await handler(intent);
    } finally {
      await onSettled?.(intent);
    }
  };
  if (pollMs <= 0 || host.drainIntentsWithContext === undefined) {
    host.onIntent(name, handle);
    return (): void => undefined;
  }

  const seen = new Set<string | number>();
  const seenOrder: Array<string | number> = [];
  let draining = false;
  return host.every(pollMs, async () => {
    if (draining) return;
    draining = true;
    try {
      const pages = await host.drainIntentsWithContext!(name);
      for (const page of pages) {
        for (const intent of page.items) {
          if (seen.has(intent.id)) continue;
          seen.add(intent.id);
          seenOrder.push(intent.id);
          // Bound the page-lifetime dedupe cache without making a recent intent replayable.
          if (seenOrder.length > 2_000) {
            const oldest = seenOrder.shift();
            if (oldest !== undefined) seen.delete(oldest);
          }
          await handle(intent);
        }
      }
    } finally {
      draining = false;
    }
  });
}

export interface Daemon {
  readonly host: WidgetBridge;
  /** The controller this daemon STARTED. It keeps its runtime for the daemon's whole life. */
  readonly controller: AgentController;
  /** Whichever controller the Agent panel is currently showing — the daemon-owned one or a foreign conversation. */
  activeController(): AgentController;
  /** The state of the last push (`null` before the first one) — the daemon's own observable output. */
  lastPushed(): WidgetState | null;
  /** Push the current snapshot NOW, bypassing the debounce. Used after start and by tests. */
  flush(): Promise<void>;
  /** Re-run the machine-wide, per-harness discovery pass and push completed slices. */
  refreshSessions(): Promise<void>;
  /** Point the Agent panel at a discovered session (the `attach` intent's implementation). */
  attach(key: string): Promise<void>;
  /** Unsubscribe, remove the widget from every page, and close the controller (and its client if we own it). */
  stop(): Promise<void>;
}

/**
 * Pick the harness to start: the caller's choice when it can genuinely start, else the first
 * preferred one that can, else any that can, else `null`. Reads the controller's OWN per-harness
 * `availableActions` (installed + authenticated + `start_session`) rather than re-deriving
 * readiness — the snapshot's top-level `availableActions.start` only says *some* harness could.
 */
export function chooseHarness(snapshot: SupercodeClientSnapshot, preferred?: HarnessId): HarnessId | null {
  const startable = snapshot.harnesses.filter((h) => h.availableActions.start);
  if (preferred) {
    const named = startable.find((h) => h.id === preferred);
    return named ? named.id : null;
  }
  for (const id of HARNESS_PREFERENCE) {
    const match = startable.find((h) => h.id === id);
    if (match) return match.id;
  }
  return startable[0]?.id ?? null;
}

export interface SendIntent {
  text: string;
  context: PromptContextItem[];
  images: PromptImageItem[];
}

function parsePromptContext(value: unknown): PromptContextItem[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) return null;
  const parsed: PromptContextItem[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") return null;
    if (Object.keys(candidate).some((key) => !["id", "kind", "label", "detail"].includes(key))) return null;
    const { id, kind, label, detail } = candidate as Record<string, unknown>;
    if (typeof label !== "string" || label.trim() === "" || label.length > 200) return null;
    if (typeof detail !== "string" || detail === "" || detail.length > 20_000) return null;
    if (id !== undefined && (typeof id !== "string" || id === "" || id.length > 2_000)) return null;
    if (kind !== undefined && (typeof kind !== "string" || kind === "" || kind.length > 100)) return null;
    parsed.push({
      ...(typeof id === "string" ? { id } : {}),
      ...(typeof kind === "string" ? { kind } : {}),
      label: label.trim(),
      detail,
    });
  }
  return parsed;
}

function parsePromptImages(value: unknown): PromptImageItem[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) return null;
  const parsed: PromptImageItem[] = [];
  let totalBytes = 0;
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") return null;
    if (Object.keys(candidate).some((key) => !["id", "label", "url"].includes(key))) return null;
    const { id, label, url } = candidate as Record<string, unknown>;
    if (typeof label !== "string" || label.trim() === "" || label.length > 200) return null;
    if (typeof url !== "string" || !(url.startsWith("data:image/") || url.startsWith("https://") || url.startsWith("http://"))) return null;
    if (url.length > 12 * 1024 * 1024) return null;
    totalBytes += url.length;
    if (totalBytes > 32 * 1024 * 1024) return null;
    if (id !== undefined && (typeof id !== "string" || id === "" || id.length > 2_000)) return null;
    parsed.push({ ...(typeof id === "string" ? { id } : {}), label: label.trim(), url });
  }
  return parsed;
}

/** The composer's intent shape. Anything else is ignored (and logged) rather than guessed at. */
export function parseSendIntent(payload: unknown): SendIntent | null {
  if (!payload || typeof payload !== "object") return null;
  if (Object.keys(payload).some((key) => !["action", "text", "context", "images"].includes(key))) return null;
  const { action, text, context: contextValue, images: imageValue } = payload as { action?: unknown; text?: unknown; context?: unknown; images?: unknown };
  if (action !== "send" || typeof text !== "string") return null;
  const trimmed = text.trim();
  const context = parsePromptContext(contextValue);
  const images = parsePromptImages(imageValue);
  return (trimmed === "" && !images?.length) || context === null || images === null ? null : { text: trimmed, context, images };
}

/** The Stop button's entire payload. No target is accepted from the page. */
export function parseInterruptIntent(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  return (payload as { action?: unknown }).action === "interrupt";
}

/** Return from a foreign mirror to the runtime this daemon started. No browser-supplied target. */
export function parseReleaseIntent(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  return (payload as { action?: unknown }).action === "release";
}

/** Continue the mirror currently selected by the daemon. The page never supplies a session key. */
export function parseResumeIntent(payload: unknown): ContinuationMode | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as { action?: unknown; mode?: unknown };
  if (value.action !== "resume") return null;
  if (Object.keys(value).length === 1) return "headless";
  if (
    Object.keys(value).length === 2 &&
    (value.mode === "headless" || value.mode === "terminal")
  ) return value.mode;
  return null;
}

/** Join the selected mirror's controller-proven live endpoint; the page cannot supply an endpoint. */
export function parseJoinIntent(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  return (payload as { action?: unknown }).action === "join" && Object.keys(payload).length === 1;
}

/** Leave shared control and return to following the same session. */
export function parseDetachIntent(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  return (payload as { action?: unknown }).action === "detach" && Object.keys(payload).length === 1;
}

export function parseTerminalIntent(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  return (payload as { action?: unknown }).action === "terminal" && Object.keys(payload).length === 1;
}

export interface ExportIntent { targetHarness: HarnessId }

export function parseExportIntent(payload: unknown): ExportIntent | null {
  if (!payload || typeof payload !== "object" || Object.keys(payload).some((key) => key !== "action" && key !== "targetHarness")) return null;
  const { action, targetHarness } = payload as { action?: unknown; targetHarness?: unknown };
  if (action !== "export" || typeof targetHarness !== "string" || targetHarness.trim() === "") return null;
  return { targetHarness: targetHarness.trim() as HarnessId };
}

export interface BranchIntent {
  targetHarness: HarnessId | null;
}

export interface ReduceIntent {
  targetHarness: HarnessId | null;
}

export interface ConfigureHarnessIntent {
  harness: HarnessId;
  changes: HarnessSettingChange[];
  expectedRevision: string;
}

const SESSION_FORMATS = new Set<string>([
  "claude-code",
  "codex",
  "gemini",
  "goose",
  "opencode",
  "pi",
  "grok",
]);

/**
 * Continue the selected transcript as a separate branch. A harness choice is user input, but the
 * daemon still validates it against its own live inventory before dispatch; no session locator or
 * runtime endpoint is accepted from the page.
 */
export function parseBranchIntent(payload: unknown): BranchIntent | null {
  if (!payload || typeof payload !== "object") return null;
  if (Object.keys(payload).some((key) => key !== "action" && key !== "targetHarness")) return null;
  const { action, targetHarness } = payload as { action?: unknown; targetHarness?: unknown };
  if (action !== "branch") return null;
  if (targetHarness === undefined) return { targetHarness: null };
  if (typeof targetHarness !== "string" || targetHarness.trim() === "") return null;
  return { targetHarness: targetHarness.trim() as HarnessId };
}

/** Start a verified reversible continuation. The page may choose only a
 * declared target harness; source identity and recovery paths stay inside the
 * trusted controller/service boundary. */
export function parseReduceIntent(payload: unknown): ReduceIntent | null {
  if (!payload || typeof payload !== "object") return null;
  if (Object.keys(payload).some((key) => key !== "action" && key !== "targetHarness")) return null;
  const { action, targetHarness } = payload as { action?: unknown; targetHarness?: unknown };
  if (action !== "reduce") return null;
  if (targetHarness === undefined) return { targetHarness: null };
  if (typeof targetHarness !== "string" || targetHarness.trim() === "") return null;
  return { targetHarness: targetHarness.trim() as HarnessId };
}

/**
 * Parse only the bounded, revisioned setting choice projected by Supercode's UI. The trusted
 * controller still checks this against the active harness and its freshly inspected controls.
 */
export function parseConfigureHarnessIntent(payload: unknown): ConfigureHarnessIntent | null {
  if (!payload || typeof payload !== "object") return null;
  if (Object.keys(payload).some((key) => !["action", "harness", "changes", "expectedRevision"].includes(key))) return null;
  const { action, harness, changes, expectedRevision } = payload as Record<string, unknown>;
  if (action !== "configureHarness" || typeof harness !== "string" || harness.length < 1 || harness.length > 100) return null;
  if (typeof expectedRevision !== "string" || expectedRevision.length < 1 || expectedRevision.length > 500) return null;
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 20) return null;
  const parsed: HarnessSettingChange[] = [];
  for (const change of changes) {
    if (!change || typeof change !== "object" || Object.keys(change).some((key) => key !== "key" && key !== "value")) return null;
    const { key, value } = change as Record<string, unknown>;
    if (typeof key !== "string" || key.length < 1 || key.length > 200) return null;
    if (value !== null && (typeof value !== "string" || value.length > 500)) return null;
    parsed.push({ key, value: value as string | null });
  }
  return { harness: harness as HarnessId, changes: parsed, expectedRevision };
}

/** A newly mounted iframe asks for one forced snapshot; no page-chosen target or state is trusted. */
export function parseMountedIntent(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  return (payload as { action?: unknown }).action === "mounted" && Object.keys(payload).length === 1;
}

function parsePanelVisibilityIntent(payload: unknown): boolean | null {
  if (!payload || typeof payload !== "object" || Object.keys(payload).length !== 1) return null;
  const action = (payload as { action?: unknown }).action;
  if (action === "panelVisible") return true;
  if (action === "panelHidden") return false;
  return null;
}

export function parseLoadSessionsIntent(payload: unknown): boolean {
  return Boolean(payload && typeof payload === "object" && (payload as { action?: unknown }).action === "loadSessions" && Object.keys(payload).length === 1);
}

export function parseLoadEarlierIntent(payload: unknown): boolean {
  return Boolean(payload && typeof payload === "object" && (payload as { action?: unknown }).action === "loadEarlier" && Object.keys(payload).length === 1);
}

export interface ResolveImageIntent {
  requestId: string;
  reference: string;
}

/** A page may echo only a projection-minted opaque reference; the current host registry resolves it. */
export function parseResolveImageIntent(payload: unknown): ResolveImageIntent | null {
  if (!payload || typeof payload !== "object") return null;
  if (Object.keys(payload).some((key) => key !== "action" && key !== "requestId" && key !== "reference")) return null;
  const { action, requestId, reference } = payload as { action?: unknown; requestId?: unknown; reference?: unknown };
  if (action !== "resolveImage" || typeof requestId !== "string" || typeof reference !== "string") return null;
  if (requestId.length < 1 || requestId.length > 200 || reference.length < 1 || reference.length > 4_000) return null;
  return { requestId, reference };
}

export interface DraftIntent { text: string }

/** Drafts are scoped to the daemon-selected conversation; the page supplies neither key nor path. */
export function parseDraftIntent(payload: unknown): DraftIntent | null {
  if (!payload || typeof payload !== "object" || Object.keys(payload).some((key) => key !== "action" && key !== "text")) return null;
  const { action, text } = payload as { action?: unknown; text?: unknown };
  if (action !== "draft" || typeof text !== "string" || text.length > 50_000) return null;
  return { text };
}

export interface NewChatIntent {
  harness: HarnessId;
  text: string;
  context: PromptContextItem[];
  images: PromptImageItem[];
}

/** A new chat is lazy: the runtime is replaced only when the first message is actually sent. */
export function parseNewChatIntent(payload: unknown): NewChatIntent | null {
  if (!payload || typeof payload !== "object") return null;
  if (Object.keys(payload).some((key) => !["action", "harness", "text", "context", "images"].includes(key))) return null;
  const { action, harness, text, context: contextValue, images: imageValue } = payload as { action?: unknown; harness?: unknown; text?: unknown; context?: unknown; images?: unknown };
  if (action !== "new" || typeof harness !== "string" || typeof text !== "string") return null;
  const trimmedHarness = harness.trim();
  const trimmedText = text.trim();
  const context = parsePromptContext(contextValue);
  const images = parsePromptImages(imageValue);
  if (trimmedHarness === "" || (trimmedText === "" && !images?.length) || context === null || images === null) return null;
  return { harness: trimmedHarness as HarnessId, text: trimmedText, context, images };
}

/** Reading a chat is explicit acknowledgement; inventory counts are never treated as unread. */
export function parseAcknowledgeIntent(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const { action, key } = payload as { action?: unknown; key?: unknown };
  if (action !== "ack" || typeof key !== "string") return null;
  return key.trim() || null;
}

export function parseRefreshIntent(payload: unknown): boolean {
  return Boolean(payload && typeof payload === "object" && (payload as { action?: unknown }).action === "refresh");
}

export interface RespondIntent {
  requestId: JsonValue;
  optionId: string | null;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

/** A structured native request response. The page can select only a controller-minted request id. */
export function parseRespondIntent(payload: unknown): RespondIntent | null {
  if (!payload || typeof payload !== "object") return null;
  const { action, requestId, optionId } = payload as {
    action?: unknown;
    requestId?: unknown;
    optionId?: unknown;
  };
  if (action !== "respond" || !isJsonValue(requestId)) return null;
  if (optionId !== null && typeof optionId !== "string") return null;
  return { requestId, optionId };
}

/** The Sessions panel's intent shape: a row key minted by `sessionKey`, echoed back on click. */
export function parseAttachIntent(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const { action, key } = payload as { action?: unknown; key?: unknown };
  if (action !== "attach" || typeof key !== "string") return null;
  const trimmed = key.trim();
  return trimmed === "" ? null : trimmed;
}

/** The active session in the only terms a descriptor also carries — `null` when nothing is selected. */
export function activeRef(snapshot: SupercodeClientSnapshot): ActiveSessionRef | null {
  if (!snapshot.activeHarness) return null;
  return { harness: snapshot.activeHarness, sessionId: snapshot.activeSessionId };
}

async function defaultAttachHost(opts: {
  sessionId: string;
  ns: string;
  html: string;
  engine?: DaemonOptions["engine"];
}): Promise<WidgetBridge> {
  const injector = createLucarneInjector({
    launcherLabel: "Open agent chats",
    launcherHidden: true,
    presentations: VIBEWAITING_PRESENTATIONS,
    initialPresentation: VIBEWAITING_PRESENTATION.messenger,
    theme: { radius: VIBEWAITING_RADIUS },
  });
  return await WidgetHost.attach(opts.sessionId, {
    ns: opts.ns,
    html: opts.html,
    injector,
    ...(opts.engine ? { engine: { ...(opts.engine.baseUrl ? { baseUrl: opts.engine.baseUrl } : {}), ...(opts.engine.token ? { token: opts.engine.token } : {}) } } : {}),
  });
}

/**
 * Mount the widget, bring the controller up, and wire the two together. Resolves once the widget is
 * mounted, the controller is initialized, a session has been started (when one can be), and the
 * first state has been pushed — so a caller that awaits this can honestly print "the panel is live".
 */
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const log = options.log ?? ((): void => undefined);
  const daemonStartedAt = performance.now();
  const debounceMs = options.pushDebounceMs ?? DEFAULT_PUSH_DEBOUNCE_MS;
  const attach = options.attachHost ?? defaultAttachHost;
  // Foreign mirrors are intentionally disposable, but their bounded display
  // windows are not. Sharing this headless cache makes returning to a chat an
  // immediate paint while its native transcript refresh continues.
  const mirrorCache = new SessionWindowCache({ maxEntries: 12 });

  const controller: AgentController =
    options.controller ??
    new SupercodeController({
      client: withSeededOwnerDiscovery(requireClient(options)),
      workspace: options.workspace,
      ownsClient: true,
      // Startup immediately creates its own runtime; observing the newest
      // persisted session first only performs a redundant full transcript load.
      autoObserve: false,
      mirrorView: PASSIVE_MIRROR_VIEW,
      allowHarnessConfiguration: true,
      ...(options.policy ? { policy: options.policy } : {}),
    });

  const hostAttachStartedAt = performance.now();
  const host = await attach({
    sessionId: options.sessionId,
    ns: WIDGET_NS,
    html: options.html,
    ...(options.engine ? { engine: options.engine } : {}),
  });
  log(`widget host attached in ${Math.round(performance.now() - hostAttachStartedAt)}ms`);

  const persistence = options.persistence === false ? null : options.persistence ?? null;
  const persisted = persistence
    ? await persistence.load().catch((error: unknown) => {
        log(`messenger state load failed (continuing): ${message(error)}`);
        return { attention: [], drafts: {} };
      })
    : { attention: [], drafts: {} };

  let stopped = false;
  let lastPushed: WidgetState | null = null;
  let imageProjection: ReturnType<typeof projectWithImages> | null = null;
  let lastQueuedFingerprint: string | null = null;
  let lastInventoryFingerprint: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  let startup: StartupPhase = "connecting";
  let startupHarness = options.harness ?? "";

  const home = options.home ?? homedir();
  const now = options.now ?? Date.now;
  // The machine-wide discovery door, called without a workspace and isolated from control RPCs.
  const discovery: SessionDiscoveryClient | undefined = options.discoveryClient ?? options.client;
  /** The last global scan, held whole — the row keys the panel echoes back resolve through it. */
  let descriptors: readonly SessionDescriptor[] = [];
  const activityBySession = new Map<string, SessionActivityObservation>();
  let activitySubscription: string | null = null;
  let activityLocatorFingerprint = "";
  let activitySubscriptionGeneration = 0;
  let indexSubscription: string | null = null;
  let indexRevision = 0;
  let indexLimitFingerprint = "";
  let indexSubscriptionGeneration = 0;
  let indexRecoveryInFlight: Promise<void> | null = null;
  let sessionLimit = MAX_SESSION_ROWS;
  let hasMoreSessions = false;
  const initialTranscriptLimit = options.projection?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const transcriptLimits = new Map<string, number>();
  /** A page action can fail before the controller publishes a structured error. Keep it visible. */
  let actionError: string | null = null;
  let exportReceipt: ExportReceipt | null = null;
  let terminalHost = options.terminalService ? await options.terminalService.snapshot() : null;
  const materializeArtifact = options.materializeArtifact
    ?? ((artifact: SessionArtifact): Promise<ExportReceipt> => writeSessionArtifact(artifact, join(options.workspace, ".supercode", "exports")));

  // Messenger attention belongs to the daemon so it remains consistent across every injected page.
  // The first inventory establishes a baseline; only later transcript changes become unread.
  const observedUpdates = new Map<
    string,
    Pick<SessionRow, "messages" | "preview" | "runtimeStatus"> & {
      announcedMessages: number | null;
      announcedPreview: string;
    }
  >();
  const attention = new Map<string, SessionAttention>(persisted.attention.map((item) => [item.key, item]));
  const drafts = new Map<string, string>(Object.entries(persisted.drafts));
  let persistenceTimer: ReturnType<typeof setTimeout> | null = null;
  let persistenceInFlight: Promise<void> = Promise.resolve();
  const flushPersistence = (): Promise<void> => {
    if (!persistence) return Promise.resolve();
    if (persistenceTimer) clearTimeout(persistenceTimer);
    persistenceTimer = null;
    const state = { attention: [...attention.values()], drafts: Object.fromEntries(drafts) };
    persistenceInFlight = persistenceInFlight
      .catch(() => undefined)
      .then(() => persistence.save(state))
      .catch((error: unknown) => log(`messenger state save failed (continuing): ${message(error)}`));
    return persistenceInFlight;
  };
  const schedulePersistence = (): void => {
    if (!persistence || persistenceTimer) return;
    persistenceTimer = setTimeout(() => { void flushPersistence(); }, 300);
    persistenceTimer.unref?.();
  };
  const markAttention = (key: string, kind: SessionAttentionKind, preview?: string): void => {
    const prior = attention.get(key);
    const boundedPreview = preview?.slice(0, 240);
    const sameEvent = boundedPreview
      ? prior?.preview === boundedPreview
      : prior?.kind === kind && prior.preview === undefined;
    const unreadCount = sameEvent ? (prior?.unreadCount ?? 1) : Math.min((prior?.unreadCount ?? 0) + 1, 999);
    const next: SessionAttention = { key, kind, unreadCount, ...(boundedPreview ? { preview: boundedPreview } : {}) };
    if (JSON.stringify(attention.get(key)) === JSON.stringify(next)) return;
    attention.set(key, next);
    schedulePersistence();
  };
  let priorRuntimeActive = false;
  let priorRuntimeKey: string | null = null;
  let panelVisible = false;
  let attentionTimer: ReturnType<typeof setTimeout> | null = null;
  let attentionDueAt = Number.POSITIVE_INFINITY;
  const scheduleAttentionSettlement = (delayMs: number): void => {
    const dueAt = Date.now() + Math.max(0, delayMs);
    if (attentionTimer && dueAt >= attentionDueAt) return;
    if (attentionTimer) clearTimeout(attentionTimer);
    attentionDueAt = dueAt;
    attentionTimer = setTimeout(() => {
      attentionTimer = null;
      attentionDueAt = Number.POSITIVE_INFINITY;
      void pushNow(false, "inventory");
    }, Math.max(0, delayMs));
    attentionTimer.unref?.();
  };

  /**
   * Why the last attach did not happen. A logged-only failure is invisible to the person who tapped
   * the row — the panel would sit on "opening…" forever — so every path that gives up on an attach
   * sets this and pushes, and every new attempt clears it.
   */
  let attachError: AttachError | null = null;

  /**
   * Foreign conversations start as cheap mirrors. Once one is resumed it owns a real runtime and
   * must survive navigation to another chat, just like a background conversation in a messenger.
   * Passive mirrors are still closed when left so their transcript followers cannot accumulate.
   */
  interface ForeignControllerSlot {
    controller: AgentController;
    unsubscribe: () => void;
    sourceHarness: HarnessId;
  }
  const foreignControllers = new Map<string, ForeignControllerSlot>();
  let activeForeignKey: string | null = null;
  const activeForeign = (): ForeignControllerSlot | null =>
    activeForeignKey === null ? null : foreignControllers.get(activeForeignKey) ?? null;
  const activeController = (): AgentController => activeForeign()?.controller ?? controller;

  const observeAttention = (
    snapshot: SupercodeClientSnapshot,
    sessions: ReturnType<typeof projectSessions>,
    attached: ReturnType<typeof attachmentFor>,
    observedAt: number,
  ): SessionAttention[] => {
    for (const row of sessions) {
      const prior = observedUpdates.get(row.key);
      let announcedMessages = prior?.announcedMessages ?? row.messages;
      let announcedPreview = prior?.announcedPreview ?? row.preview;
      if (prior === undefined) {
        observedUpdates.set(row.key, {
          messages: row.messages,
          preview: row.preview,
          runtimeStatus: row.runtimeStatus,
          announcedMessages,
          announcedPreview,
        });
        continue;
      }
      if (panelVisible && row.key === attached?.key) {
        announcedMessages = row.messages;
        announcedPreview = row.preview;
        observedUpdates.set(row.key, {
          messages: row.messages,
          preview: row.preview,
          runtimeStatus: row.runtimeStatus,
          announcedMessages,
          announcedPreview,
        });
        continue;
      }
      // A live peer can refresh its descriptor timestamp on every heartbeat. That is recency, not
      // unread conversation. Harnesses with process state announce completion explicitly. For
      // others, hold message growth until the transcript has gone quiet: tool-stream churn should
      // never make the launcher's badge climb every five seconds.
      if (prior.runtimeStatus === "busy" && row.runtimeStatus === "idle") {
        markAttention(row.key, "finished", row.preview);
        announcedMessages = row.messages;
        announcedPreview = row.preview;
      } else if (row.runtimeStatus !== "busy") {
        if (row.messages !== null && prior.messages !== null && row.messages < prior.messages) {
          // A rewritten/compacted session establishes a new baseline; it is not negative unread.
          announcedMessages = row.messages;
          announcedPreview = row.preview;
        } else {
          const hasUnannouncedUpdate =
            (row.messages !== null && announcedMessages !== null && row.messages > announcedMessages) ||
            (row.preview !== "" && row.preview !== announcedPreview);
          if (hasUnannouncedUpdate && row.updatedAt !== null) {
            const age = observedAt - row.updatedAt;
            if (age >= DEFAULT_ATTENTION_SETTLE_MS) {
              markAttention(row.key, "unseen", row.preview);
              announcedMessages = row.messages;
              announcedPreview = row.preview;
            } else {
              scheduleAttentionSettlement(DEFAULT_ATTENTION_SETTLE_MS - age);
            }
          }
        }
      }
      observedUpdates.set(row.key, {
        messages: row.messages,
        preview: row.preview,
        runtimeStatus: row.runtimeStatus,
        announcedMessages,
        announcedPreview,
      });
    }

    const runtimeActive =
      snapshot.turn.state !== "idle" || snapshot.requests.some((request) => request.status === "pending");
    const runtimeKey = attached?.key || priorRuntimeKey;
    if (priorRuntimeActive && !runtimeActive && priorRuntimeKey && !(panelVisible && attached?.key === priorRuntimeKey)) {
      const lastAssistant = [...snapshot.conversation].reverse().find(
        (entry) => entry.kind === "message" && entry.role === "assistant" && entry.text.trim() !== "",
      );
      const preview = lastAssistant?.kind === "message"
        ? lastAssistant.text.replace(/\s+/g, " ").trim()
        : undefined;
      markAttention(priorRuntimeKey, snapshot.error ? "failed" : "finished", preview);
    }
    priorRuntimeActive = runtimeActive;
    priorRuntimeKey = runtimeActive ? runtimeKey : null;

    const visible = new Set(sessions.map((row) => row.key));
    return [...attention.values()].filter((item) => visible.has(item.key));
  };

  const pushNow = (force = false, scope: "full" | "inventory" = "full"): Promise<void> => {
    if (stopped) return Promise.resolve();
    const snapshot = activeController().getSnapshot();
    const ref = activeRef(snapshot);
    // A branch starts before its new native session necessarily appears in global discovery. Once
    // it does, move the retained controller from its source-row key to the branch's real row key so
    // reopening that row returns to the same live runtime instead of spawning a duplicate mirror.
    if (activeForeignKey !== null && snapshot.connection.mode === "control" && ref?.sessionId) {
      const current = foreignControllers.get(activeForeignKey);
      const persisted = descriptors.find((descriptor) => matchesActive(descriptor, ref));
      const persistedKey = persisted ? sessionKey(persisted.locator) : null;
      if (current && persistedKey && persistedKey !== activeForeignKey) {
        const priorLimit = transcriptLimits.get(activeForeignKey);
        foreignControllers.delete(activeForeignKey);
        foreignControllers.set(persistedKey, current);
        if (priorLimit !== undefined) {
          transcriptLimits.delete(activeForeignKey);
          transcriptLimits.set(persistedKey, priorLimit);
        }
        activeForeignKey = persistedKey;
      }
    }
    const transcriptWindowKey = activeForeignKey ?? "@owned";
    const transcriptLimit = transcriptLimits.get(transcriptWindowKey) ?? initialTranscriptLimit;
    const observedAt = now();
    const sessions = projectSessions(descriptors, { now: observedAt, home, active: ref, max: sessionLimit, preserveOrder: true });
    const ownSnapshot = controller.getSnapshot();
    const ownRef = activeRef(ownSnapshot);
    const ownRows = projectSessions(descriptors, { now: observedAt, home, active: ownRef, max: sessionLimit, preserveOrder: true });
    imageProjection = projectWithImages(snapshot, { ...options.projection, maxEntries: transcriptLimit });
    const projected = imageProjection.state;
    const startupLabel = startup === "connecting"
      ? "Connecting to coding agents…"
      : startup === "starting"
        ? `Starting ${startupHarness || "coding agent"}…`
        : "Loading recent sessions…";
    const attached = attachmentFor(ref, sessions, snapshot.workspace, home);
    const activeDescriptor = activeForeignKey
      ? descriptors.find((descriptor) => sessionKey(descriptor.locator) === activeForeignKey)
      : ref?.sessionId
        ? descriptors.find((descriptor) => matchesActive(descriptor, ref))
        : undefined;
    const loadedMessages = snapshot.activeSession?.messages.length
      ?? snapshot.conversation.filter((entry) => entry.kind === "message").length;
    const hasEarlier = snapshot.conversation.length > transcriptLimit || (
      activeDescriptor?.message_count !== null &&
      activeDescriptor?.message_count !== undefined &&
      activeDescriptor.message_count > loadedMessages
    );
    const draftKey = activeForeignKey ?? (activeDescriptor ? sessionKey(activeDescriptor.locator) : null);
    const state: WidgetState & { terminalHost?: TerminalServiceSnapshot } = {
      ...projected,
      pill: startup === "ready" ? projected.pill : { tone: "off", label: startupLabel },
      startup,
      // A requested/selected harness is already a real identity. Keep its real logo visible while
      // the runtime is connecting and after a failed start; hiding the launcher reads as a freeze.
      harness: projected.harness || startupHarness,
      sessions,
      attached,
      owned: attachmentFor(ownRef, ownRows, ownSnapshot.workspace, home),
      attachError,
      error: actionError ?? projected.error,
      // The shared UI's Retry control means "refresh controller state". Host intents such as
      // resume/send/export already retain their own action, so labelling a refresh as a retry is
      // dishonest; the original button or draft remains the real retry path.
      recoverable: actionError === null && projected.recoverable,
      canExport: typeof activeController().exportSession === "function" && snapshot.operation === null && Boolean(snapshot.activeSessionKey || snapshot.activeSessionId),
      canReduce: projected.canReduce,
      continuationModes: projected.canResume
        ? [
            "headless",
            ...(
              options.terminalService &&
              activeDescriptor &&
              (activeDescriptor.locator.harness === "claude-code" || activeDescriptor.locator.harness === "codex")
                ? ["terminal" as const]
                : []
            ),
          ]
        : [],
      exportBackTarget: snapshot.connection.strategy === "branch" || snapshot.connection.strategy === "reduce"
        ? activeForeign()?.sourceHarness ?? null
        : null,
      exportReceipt,
      history: { sessionLimit, hasMoreSessions, transcriptLimit, hasEarlier },
      savedDraft: draftKey ? drafts.get(draftKey) ?? "" : "",
      attention: observeAttention(snapshot, sessions, attached, observedAt),
      ...(terminalHost ? { terminalHost } : {}),
    };
    lastPushed = state;
    const inventoryPatch: Partial<WidgetState> = {
      pill: state.pill,
      startup: state.startup,
      sessions: state.sessions,
      attached: state.attached,
      owned: state.owned,
      attachError: state.attachError,
      attention: state.attention,
      history: state.history,
      error: state.error,
      recoverable: state.recoverable,
      canExport: state.canExport,
      canReduce: state.canReduce,
      continuationModes: state.continuationModes,
      exportBackTarget: state.exportBackTarget,
      exportReceipt: state.exportReceipt,
      reductionReceipt: state.reductionReceipt,
      savedDraft: state.savedDraft,
      ...(terminalHost ? { terminalHost } : {}),
    };
    const stateFingerprint = JSON.stringify(state);
    const inventoryFingerprint = JSON.stringify(inventoryPatch);
    if (!force && (scope === "full" ? stateFingerprint === lastQueuedFingerprint : inventoryFingerprint === lastInventoryFingerprint)) {
      return inFlight;
    }
    lastQueuedFingerprint = stateFingerprint;
    lastInventoryFingerprint = inventoryFingerprint;
    const delivery: WidgetState | Partial<WidgetState> = scope === "full" ? state : inventoryPatch;
    // Serialize pushes: two overlapping CDP evaluations could otherwise deliver out of order and
    // leave the panel showing an older transcript than the one already drawn.
    inFlight = inFlight
      .catch(() => undefined)
      .then(() => host.push(delivery))
      .catch((e: unknown) => {
        // A failed delivery must remain retryable even if the projected state itself is unchanged.
        if (lastQueuedFingerprint === stateFingerprint) lastQueuedFingerprint = null;
        if (lastInventoryFingerprint === inventoryFingerprint) lastInventoryFingerprint = null;
        log(`push failed (continuing): ${(e as Error)?.message ?? String(e)}`);
      });
    return inFlight;
  };

  const schedulePush = (): void => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void pushNow();
    }, debounceMs);
    timer.unref?.();
  };

  const unsubscribe = controller.subscribe(schedulePush);

  const repushMs = options.repushIntervalMs ?? DEFAULT_REPUSH_INTERVAL_MS;
  const stopRepush = repushMs > 0 ? host.every(repushMs, () => pushNow()) : (): void => undefined;

  /** Re-scan each native store, publishing completed inbox slices as they arrive. */
  let refreshInFlight: Promise<void> | null = null;
  const sessionsByHarness = new Map<HarnessId, SessionDescriptor[]>();
  const topicCandidatesBySession = new Map<string, SessionDescriptor["preview_candidates"]>();
  const topicAttemptedAtBySession = new Map<string, number>();
  const retainTopic = (descriptor: SessionDescriptor): SessionDescriptor => {
    const activity = (descriptor as SessionDescriptor & { activity?: SessionActivityObservation | null }).activity;
    if (activity) activityBySession.set(`${activity.harness}\0${activity.session_id}`, activity);
    const key = sessionKey(descriptor.locator);
    if (descriptor.preview_candidates?.length) {
      topicCandidatesBySession.set(key, descriptor.preview_candidates);
      return descriptor;
    }
    const retained = topicCandidatesBySession.get(key);
    return retained?.length ? { ...descriptor, preview_candidates: retained } : descriptor;
  };
  const rebuildDescriptors = (preserveVisibleOrder = panelVisible): void => {
    const all = [...sessionsByHarness.values()].flat().map((descriptor) => {
      const activity = activityBySession.get(
        `${descriptor.locator.harness}\0${descriptor.locator.session_id}`,
      );
      return activity ? { ...descriptor, activity } : descriptor;
    });
    all.sort((left, right) =>
      (right.updated_at_ms ?? Number.MIN_SAFE_INTEGER) - (left.updated_at_ms ?? Number.MIN_SAFE_INTEGER)
      || left.locator.harness.localeCompare(right.locator.harness)
      || left.locator.session_id.localeCompare(right.locator.session_id));
    hasMoreSessions = all.length > sessionLimit
      || [...sessionsByHarness.values()].some((sessions) => sessions.length > sessionLimit);
    if (!preserveVisibleOrder || descriptors.length === 0) {
      descriptors = all.slice(0, sessionLimit);
      return;
    }
    const updatedByKey = new Map(all.map((descriptor) => [sessionKey(descriptor.locator), descriptor]));
    const stable = descriptors.flatMap((descriptor) => {
      const key = sessionKey(descriptor.locator);
      const updated = updatedByKey.get(key);
      if (!updated) return [];
      updatedByKey.delete(key);
      return [updated];
    });
    // New conversations append while the panel is open instead of reordering the row under the
    // pointer. At a full page they replace only the oldest visible rows; appending after all 30 and
    // then truncating used to make every newly-created conversation invisible until panel close.
    const additions = [...updatedByKey.values()];
    descriptors = [
      ...stable.slice(0, Math.max(0, sessionLimit - additions.length)),
      ...additions,
    ].slice(0, sessionLimit);
  };
  const activityCandidate = discovery as (SessionDiscoveryClient & Partial<SessionActivityEventSource>) | undefined;
  const activityTransport = activityCandidate?.subscribeSessionActivity
    && activityCandidate.unsubscribeSessionActivity
    && activityCandidate.on
    && activityCandidate.off
    ? {
        subscribe: activityCandidate.subscribeSessionActivity.bind(activityCandidate),
        unsubscribe: activityCandidate.unsubscribeSessionActivity.bind(activityCandidate),
        on: activityCandidate.on.bind(activityCandidate),
        off: activityCandidate.off.bind(activityCandidate),
      }
    : null;
  const indexCandidate = discovery as (SessionDiscoveryClient & Partial<SessionIndexEventSource>) | undefined;
  const indexTransport = indexCandidate?.subscribeSessionIndex
    && indexCandidate.unsubscribeSessionIndex
    && indexCandidate.on
    && indexCandidate.off
    ? {
        subscribe: indexCandidate.subscribeSessionIndex.bind(indexCandidate),
        unsubscribe: indexCandidate.unsubscribeSessionIndex.bind(indexCandidate),
        on: indexCandidate.on.bind(indexCandidate),
        off: indexCandidate.off.bind(indexCandidate),
      }
    : null;
  const applyActivities = (activities: readonly SessionActivityObservation[]): boolean => {
    let changed = false;
    for (const activity of activities) {
      const key = `${activity.harness}\0${activity.session_id}`;
      const previous = activityBySession.get(key);
      const before = previous
        ? `${previous.presence}:${previous.turn}:${previous.evidence.source}:${previous.evidence.native_state ?? ""}:${previous.evidence.harness_version ?? ""}`
        : "";
      const after = `${activity.presence}:${activity.turn}:${activity.evidence.source}:${activity.evidence.native_state ?? ""}:${activity.evidence.harness_version ?? ""}`;
      activityBySession.set(key, activity);
      if (before !== after) changed = true;
    }
    if (changed) rebuildDescriptors();
    return changed;
  };
  const onSessionActivity = (event: SessionActivityEvent): void => {
    if (stopped || event.subscription !== activitySubscription) return;
    if (applyActivities(event.activities)) void pushNow(false, "inventory");
  };
  activityTransport?.on("sessionActivityEvent", onSessionActivity);

  const syncActivitySubscription = async (): Promise<void> => {
    if (!activityTransport || stopped) return;
    const locators = descriptors.map((descriptor) => descriptor.locator);
    const fingerprint = locators.map(sessionKey).sort().join("\n");
    if (fingerprint === activityLocatorFingerprint) return;
    activityLocatorFingerprint = fingerprint;
    const generation = ++activitySubscriptionGeneration;
    if (locators.length === 0) return;
    try {
      const opened = await activityTransport.subscribe(locators);
      if (stopped || generation !== activitySubscriptionGeneration) {
        await activityTransport.unsubscribe(opened.subscription).catch(() => undefined);
        return;
      }
      const previous = activitySubscription;
      activitySubscription = opened.subscription;
      if (applyActivities(opened.initial)) await pushNow(false, "inventory");
      if (previous) await activityTransport.unsubscribe(previous).catch((error: unknown) => {
        log(`old activity subscription cleanup failed (continuing): ${message(error)}`);
      });
    } catch (error) {
      if (!stopped && generation === activitySubscriptionGeneration) {
        activityLocatorFingerprint = "";
        log(`session activity subscription failed (continuing): ${message(error)}`);
      }
    }
  };
  const syncIndexSubscription = async (): Promise<void> => {
    if (!indexTransport || stopped) return;
    const fingerprint = String(sessionLimit);
    if (fingerprint === indexLimitFingerprint) return;
    indexLimitFingerprint = fingerprint;
    const generation = ++indexSubscriptionGeneration;
    try {
      const opened = await indexTransport.subscribe({
        harnesses: ["claude-code", "codex"],
        limit: sessionLimit + 1,
        include_topic_candidates: true,
      });
      if (stopped || generation !== indexSubscriptionGeneration) {
        await indexTransport.unsubscribe(opened.subscription).catch(() => undefined);
        return;
      }
      const previous = indexSubscription;
      indexSubscription = opened.subscription;
      indexRevision = opened.revision;
      for (const harness of ["claude-code", "codex"] as const) {
        sessionsByHarness.set(
          harness,
          opened.initial.filter((descriptor) => descriptor.locator.harness === harness).map(retainTopic),
        );
      }
      rebuildDescriptors();
      await syncActivitySubscription();
      await pushNow(false, "inventory");
      if (previous) await indexTransport.unsubscribe(previous).catch((error: unknown) => {
        log(`old session index cleanup failed (continuing): ${message(error)}`);
      });
    } catch (error) {
      if (!stopped && generation === indexSubscriptionGeneration) {
        indexLimitFingerprint = "";
        log(`session index subscription failed; retaining slow recovery scan: ${message(error)}`);
      }
    }
  };
  const refreshSessions = (harnesses: readonly HarnessId[] = DISCOVERY_HARNESSES): Promise<void> => {
    if (stopped || !discovery) return Promise.resolve();
    // A slow native store must not let the recovery inventory tick pile up identical RPCs. Apart
    // from wasting work, those queued calls used to extend one timeout into minutes of repeated
    // "loading" failures.
    if (refreshInFlight) return refreshInFlight;
    const reportTimings = sessionsByHarness.size === 0;
    refreshInFlight = Promise.all(harnesses.map(async (harness) => {
      const startedAt = performance.now();
      try {
        const result = await discovery.discover({ harnesses: [harness], limit: sessionLimit + 1 });
        if (stopped) return;
        const sessions = result.sessions.map(retainTopic);
        sessionsByHarness.set(harness, sessions);
        rebuildDescriptors();
        if (reportTimings) {
          log(`discovered ${sessions.length} ${harness} sessions in ${Math.round(performance.now() - startedAt)}ms`);
        }
        await pushNow(false, "inventory");
      } catch (e) {
        if (!stopped) {
          log(`session discovery failed for ${harness} after ${Math.round(performance.now() - startedAt)}ms (continuing): ${message(e)}`);
        }
      }
    })).then(async () => {
      if (stopped) return;
      await syncActivitySubscription();
      await syncIndexSubscription();
      // The index snapshot and every targeted replacement already carry
      // topic candidates. Retrying a second full Claude/Codex scan would
      // quietly reintroduce the hot path this subscription removes.
      if (indexSubscription) return;
      const now = performance.now();
      const pendingTopicKeys = descriptors
        .filter((descriptor) => descriptor.locator.harness === "claude-code" || descriptor.locator.harness === "codex")
        .map((descriptor) => sessionKey(descriptor.locator))
        .filter((key) => !topicCandidatesBySession.has(key)
          && now - (topicAttemptedAtBySession.get(key) ?? Number.NEGATIVE_INFINITY) >= TOPIC_RETRY_MS);
      if (pendingTopicKeys.length === 0) return;
      for (const key of pendingTopicKeys) topicAttemptedAtBySession.set(key, now);
      const startedAt = performance.now();
      try {
        const result = await discovery.discover({
          harnesses: ["claude-code", "codex"],
          limit: sessionLimit,
          include_topic_candidates: true,
        });
        if (stopped) return;
        for (const descriptor of result.sessions) retainTopic(descriptor);
        for (const harness of ["claude-code", "codex"] as const) {
          const sessions = sessionsByHarness.get(harness);
          if (sessions) sessionsByHarness.set(harness, sessions.map(retainTopic));
        }
        rebuildDescriptors();
        log(`discovered ${result.sessions.length} Claude Code/Codex topics in ${Math.round(performance.now() - startedAt)}ms`);
        await pushNow(false, "inventory");
      } catch (e) {
        if (!stopped) {
          log(`topic discovery failed after ${Math.round(performance.now() - startedAt)}ms (continuing): ${message(e)}`);
        }
      }
    }).finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  };

  const recoverSessionIndex = (): Promise<void> => {
    if (indexRecoveryInFlight) return indexRecoveryInFlight;
    indexLimitFingerprint = "";
    indexRecoveryInFlight = syncIndexSubscription()
      .finally(() => {
        indexRecoveryInFlight = null;
      });
    return indexRecoveryInFlight;
  };
  const onSessionIndex = (event: SessionIndexEvent): void => {
    if (stopped || event.subscription !== indexSubscription) return;
    if (event.error) {
      log(`session index reported a recoverable error: ${event.error.message}`);
      return;
    }
    if (!Number.isSafeInteger(event.revision) || event.revision !== indexRevision + 1) {
      log(`session index revision gap (${indexRevision} -> ${String(event.revision)}); resnapshotting`);
      void recoverSessionIndex();
      return;
    }
    indexRevision = event.revision;
    for (const change of event.changes ?? []) {
      if (change.kind === "removed") {
        if (change.key.harness !== "claude-code" && change.key.harness !== "codex") continue;
        const key = `${change.key.harness}\0${change.key.session_id}`;
        const sessions = sessionsByHarness.get(change.key.harness);
        const removed = sessions?.find((descriptor) =>
          descriptor.locator.session_id === change.key.session_id);
        if (sessions) {
          sessionsByHarness.set(
            change.key.harness,
            sessions.filter((descriptor) =>
              descriptor.locator.session_id !== change.key.session_id),
          );
        }
        activityBySession.delete(key);
        if (removed) {
          const descriptorKey = sessionKey(removed.locator);
          topicCandidatesBySession.delete(descriptorKey);
          topicAttemptedAtBySession.delete(descriptorKey);
        }
        continue;
      }
      const descriptor = retainTopic(change.descriptor);
      const harness = descriptor.locator.harness;
      if (harness !== "claude-code" && harness !== "codex") continue;
      const sessions = [...(sessionsByHarness.get(harness) ?? [])];
      const existing = sessions.findIndex((candidate) =>
        candidate.locator.session_id === descriptor.locator.session_id);
      if (existing >= 0) sessions[existing] = descriptor;
      else sessions.push(descriptor);
      sessions.sort((left, right) =>
        (right.updated_at_ms ?? Number.MIN_SAFE_INTEGER) - (left.updated_at_ms ?? Number.MIN_SAFE_INTEGER)
        || left.locator.session_id.localeCompare(right.locator.session_id));
      sessionsByHarness.set(harness, sessions.slice(0, sessionLimit + 1));
    }
    rebuildDescriptors();
    void syncActivitySubscription();
    void pushNow(false, "inventory");
  };
  indexTransport?.on("sessionIndexEvent", onSessionIndex);

  const discoverMs = options.discoverIntervalMs ?? DEFAULT_DISCOVER_INTERVAL_MS;
  // Begin polling only after bootstrap. Registering it before a slow runtime start let discovery
  // ticks compete with startup on the same harness transport.
  let stopDiscovery = (): void => undefined;
  const startDiscoveryPolling = (): void => {
    if (discoverMs > 0 && discovery) stopDiscovery = host.every(discoverMs, () => {
      const harnesses = indexSubscription
        ? DISCOVERY_HARNESSES.filter((harness) => harness !== "claude-code" && harness !== "codex")
        : DISCOVERY_HARNESSES;
      if (harnesses.length > 0) return refreshSessions(harnesses);
    });
  };

  const createController =
    options.createController ??
    ((opts: { workspace: string; descriptor: SessionDescriptor; harnesses: readonly FrontendHarness[]; tailMessages: number }): AgentController =>
      // `ownsClient: false`: this daemon's ONE transport outlives every mirror that borrows it.
      // Seed the locator and already-known harness inventory so initialization does not rediscover
      // an entire workspace merely to mint the controller's local session key.
      new SupercodeController({
        client: withSeededMirrorInventory(requireClient(options), opts.descriptor, opts.harnesses),
        workspace: opts.workspace,
        ownsClient: false,
        autoObserve: false,
        mirrorView: { ...PASSIVE_MIRROR_VIEW, tailMessages: opts.tailMessages },
        mirrorCache,
        allowHarnessConfiguration: true,
      }));

  /**
   * Leave the selected foreign conversation. A passive mirror is disposable; a resumed/branched
   * controller is retained so switching chats never kills work the user explicitly continued.
   */
  const releaseForeignView = async (): Promise<void> => {
    const key = activeForeignKey;
    const previous = activeForeign();
    activeForeignKey = null;
    if (!previous || key === null) return;
    if (previous.controller.getSnapshot().connection.mode === "control") return;
    foreignControllers.delete(key);
    previous.unsubscribe();
    await previous.controller.close().catch((e: unknown) => log(`detach failed: ${message(e)}`));
  };

  // Attaches run independently and are generation-checked. A slow native transcript must never
  // hold a newer selection behind it; whichever attempt is newest owns the panel, and every loser
  // closes its candidate rather than leaving a follower behind.
  let attachSeq = 0;
  const attachTasks = new Set<Promise<void>>();
  const attachTimeoutMs = options.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS;

  /**
   * Record why an attach did not happen, and PUSH it — the panel's stuck "opening…" row is settled
   * by this state arriving, never by a timeout it invents. A superseded attempt (the user tapped
   * another row while this one was failing) records nothing: the newer attach owns the panel now.
   */
  const failAttach = async (key: string, seq: number, reason: string, logLine = `attach failed: ${reason}`): Promise<void> => {
    log(logLine);
    if (stopped || seq !== attachSeq) return;
    attachError = toAttachError(key, reason);
    await pushNow();
  };

  const runAttach = async (key: string, seq: number): Promise<void> => {
    if (stopped || seq !== attachSeq) return;
    // A new attempt supersedes the previous failure, whatever this one goes on to do.
    attachError = null;
    if (activeForeignKey === key) {
      await pushNow();
      return;
    }
    const retained = foreignControllers.get(key);
    if (retained) {
      await releaseForeignView();
      activeForeignKey = key;
      log(`returning to locally controlled ${retained.controller.getSnapshot().activeHarness ?? "coding agent"} session`);
      await pushNow();
      return;
    }
    const descriptor = descriptors.find((d) => sessionKey(d.locator) === key);
    if (!descriptor) {
      await failAttach(
        key,
        seq,
        "that session is no longer in the list",
        `attach: no discovered session with key ${key}`,
      );
      return;
    }
    await releaseForeignView();
    if (matchesActive(descriptor, activeRef(controller.getSnapshot()))) {
      log(`following this daemon's own ${descriptor.locator.harness} session again`);
      await pushNow();
      return;
    }
    const workspace = descriptor.cwd ?? options.workspace;
    const attachStartedAt = performance.now();
    let initializedAt = attachStartedAt;
    let candidate: AgentController;
    try {
      candidate = createController({
        workspace,
        descriptor,
        harnesses: controller.getSnapshot().harnesses,
        tailMessages: transcriptLimits.get(key) ?? initialTranscriptLimit,
      });
    } catch (e) {
      await failAttach(key, seq, message(e), `attach unavailable: ${message(e)}`);
      return;
    }
    const unpublishCandidate = (): void => {
      const published = foreignControllers.get(key);
      if (published?.controller !== candidate) return;
      foreignControllers.delete(key);
      if (activeForeignKey === key) activeForeignKey = null;
      published.unsubscribe();
    };
    try {
      const timeoutSeconds = Math.max(1, Math.ceil(attachTimeoutMs / 1000));
      await withTimeout(
        (async () => {
          await candidate.initialize();
          initializedAt = performance.now();
          // The controller mints its own workspace-scoped keys; ours is a hash of the locator, so
          // the two are matched on the pair every representation carries.
          const target = candidate
            .getSnapshot()
            .sessions.find(
              (s) => s.harness === descriptor.locator.harness && s.sessionId === descriptor.locator.session_id,
            );
          if (!target) throw new Error(`that session is not visible in ${workspace}`);
          if (stopped || seq !== attachSeq) return;
          // Publish the controller before observe resolves. A shared cached
          // window commits synchronously at the start of observe, and this
          // subscription is what lets that state reach the widget while the
          // native refresh remains in flight.
          let publishedTranscript = false;
          const publishCandidateRevision = (): void => {
            if (!publishedTranscript && candidate.getSnapshot().activeSession) {
              publishedTranscript = true;
              log(
                `first ${descriptor.locator.harness} transcript state ready in ` +
                `${Math.round(performance.now() - attachStartedAt)}ms`,
              );
              void pushNow();
              return;
            }
            schedulePush();
          };
          const candidateSlot: ForeignControllerSlot = {
            controller: candidate,
            unsubscribe: candidate.subscribe(publishCandidateRevision),
            sourceHarness: descriptor.locator.harness,
          };
          activeForeignKey = key;
          foreignControllers.set(key, candidateSlot);
          await candidate.dispatch({ type: "observe", sessionKey: target.key });
        })(),
        attachTimeoutMs,
        `could not open this session within ${timeoutSeconds} ${timeoutSeconds === 1 ? "second" : "seconds"}`,
      );
    } catch (e) {
      unpublishCandidate();
      await candidate.close().catch(() => undefined);
      await failAttach(key, seq, message(e));
      return;
    }
    if (stopped || seq !== attachSeq) {
      unpublishCandidate();
      await candidate.close().catch(() => undefined);
      return;
    }
    const attachedAt = performance.now();
    log(
      `following ${descriptor.locator.harness} in ${workspace} (read-only mirror; ` +
      `${Math.round(attachedAt - attachStartedAt)}ms total = ${Math.round(initializedAt - attachStartedAt)}ms seeded init + ` +
      `${Math.round(attachedAt - initializedAt)}ms transcript)`,
    );
    await pushNow();
  };

  const attachSession = (key: string): Promise<void> => {
    const seq = (attachSeq += 1);
    const task = runAttach(key, seq);
    attachTasks.add(task);
    void task.then(
      () => attachTasks.delete(task),
      () => attachTasks.delete(task),
    );
    return task;
  };

  const stopIntentPump = bindIntentQueue(host, INTENT_QUEUE, async (intent) => {
    const action = intent.payload && typeof intent.payload === "object"
      ? (intent.payload as { action?: unknown }).action
      : null;
    if (typeof action === "string" && action !== "draft" && action !== "ack") {
      await host.push({ bridgeAck: String(intent.id) }).catch((error: unknown) => {
        log(`bridge acknowledgement failed (continuing): ${message(error)}`);
      });
    }
    if (parseMountedIntent(intent.payload)) {
      panelVisible = false;
      rebuildDescriptors(false);
      await pushNow(true);
      return;
    }
    const panelVisibility = parsePanelVisibilityIntent(intent.payload);
    if (panelVisibility !== null) {
      panelVisible = panelVisibility;
      if (!panelVisible) rebuildDescriptors(false);
      if (panelVisible) await pushNow(true);
      return;
    }
    if (parseLoadSessionsIntent(intent.payload)) {
      sessionLimit += MAX_SESSION_ROWS;
      await refreshSessions();
      return;
    }
    if (parseLoadEarlierIntent(intent.payload)) {
      actionError = null;
      const key = activeForeignKey ?? "@owned";
      const nextLimit = (transcriptLimits.get(key) ?? initialTranscriptLimit) + TRANSCRIPT_PAGE_SIZE;
      transcriptLimits.set(key, nextLimit);
      const slot = activeForeign();
      const snapshot = slot?.controller.getSnapshot();
      if (slot && snapshot?.connection.mode === "mirror" && activeForeignKey !== null) {
        const foreignKey = activeForeignKey;
        const descriptor = descriptors.find((candidate) => sessionKey(candidate.locator) === foreignKey);
        let replacement: AgentController | null = null;
        const seq = (attachSeq += 1);
        try {
          if (!descriptor) throw new Error("this conversation is no longer available to load earlier messages");
          replacement = createController({
            workspace: descriptor.cwd ?? options.workspace,
            descriptor,
            harnesses: controller.getSnapshot().harnesses,
            tailMessages: nextLimit,
          });
          await withTimeout(
            (async () => {
              await replacement!.initialize();
              const target = replacement!.getSnapshot().sessions.find(
                (session) => session.harness === descriptor.locator.harness && session.sessionId === descriptor.locator.session_id,
              );
              if (!target) throw new Error("that session is no longer visible in its workspace");
              await replacement!.dispatch({ type: "observe", sessionKey: target.key });
            })(),
            attachTimeoutMs,
            "loading earlier messages timed out",
          );
          if (stopped || seq !== attachSeq) {
            await replacement.close().catch(() => undefined);
            return;
          }
          const previous = foreignControllers.get(foreignKey);
          foreignControllers.set(foreignKey, {
            controller: replacement,
            unsubscribe: replacement.subscribe(schedulePush),
            sourceHarness: previous?.sourceHarness ?? descriptor.locator.harness,
          });
          activeForeignKey = foreignKey;
          previous?.unsubscribe();
          await previous?.controller.close().catch((e: unknown) => log(`older-window replacement close failed: ${message(e)}`));
          log(`expanded ${descriptor.locator.harness} transcript window to ${nextLimit} entries`);
        } catch (e) {
          await replacement?.close().catch(() => undefined);
          transcriptLimits.set(key, nextLimit - TRANSCRIPT_PAGE_SIZE);
          actionError = message(e);
          log(`load earlier failed: ${actionError}`);
        }
      }
      await pushNow();
      return;
    }
    const terminalIntent = parseTerminalHostIntent(intent.payload);
    if (terminalIntent !== null) {
      if (!options.terminalService) {
        actionError = "This host does not provide local terminal sessions.";
      } else {
        try {
          if (terminalIntent.action === "terminalRefresh")
            terminalHost = await options.terminalService.snapshot();
          else if (terminalIntent.action === "terminalCreate")
            terminalHost = await options.terminalService.create(
              terminalIntent.harness,
              options.workspace,
            );
          else if (terminalIntent.action === "terminalAttach")
            terminalHost = await options.terminalService.attach(
              terminalIntent.sessionId,
              terminalIntent.mode,
            );
          else if (terminalIntent.action === "terminalClose")
            terminalHost = await options.terminalService.close(
              terminalIntent.sessionId,
            );
          else if (terminalIntent.action === "terminalOpenLocal")
            terminalHost = await options.terminalService.openLocal(
              terminalIntent.sessionId,
            );
          else terminalHost = await options.terminalService.dismiss();
        } catch (error) {
          terminalHost = {
            attachment: null,
            available: false,
            canOpenLocal: terminalHost?.canOpenLocal ?? false,
            error: message(error),
            sessions: terminalHost?.sessions ?? [],
          };
        }
      }
      await pushNow(true);
      return;
    }
    const imageRequest = parseResolveImageIntent(intent.payload);
    if (imageRequest !== null) {
      const resolved = imageProjection?.resolveImage(imageRequest.reference) ?? null;
      let response: Record<string, unknown>;
      if (!resolved) {
        response = { requestId: imageRequest.requestId, status: "failed", message: "This image is no longer in the visible transcript window." };
      } else if (!resolved.url.startsWith("data:image/") || resolved.url.length > MAX_HISTORICAL_IMAGE_URL_CHARS || (resolved.byteSize !== undefined && resolved.byteSize > MAX_HISTORICAL_IMAGE_BYTES)) {
        response = { requestId: imageRequest.requestId, status: "failed", message: "This image is too large to preview safely." };
      } else {
        response = {
          requestId: imageRequest.requestId,
          status: "resolved",
          dataUrl: resolved.url,
          ...(resolved.mediaType ? { mediaType: resolved.mediaType } : {}),
          ...(resolved.byteSize !== undefined ? { byteSize: resolved.byteSize } : {}),
        };
      }
      await host.push({ imageResolution: response }).catch((error: unknown) => {
        log(`historical image delivery failed (continuing): ${message(error)}`);
      });
      return;
    }
    const draft = parseDraftIntent(intent.payload);
    if (draft !== null) {
      const snapshot = activeController().getSnapshot();
      const ref = activeRef(snapshot);
      const descriptor = ref?.sessionId ? descriptors.find((candidate) => matchesActive(candidate, ref)) : undefined;
      const key = activeForeignKey ?? (descriptor ? sessionKey(descriptor.locator) : null);
      if (key) {
        if (draft.text === "") drafts.delete(key);
        else drafts.set(key, draft.text);
        schedulePersistence();
      }
      return;
    }
    const acknowledged = parseAcknowledgeIntent(intent.payload);
    if (acknowledged !== null) {
      if (attention.delete(acknowledged)) {
        schedulePersistence();
        await pushNow();
      }
      return;
    }
    if (parseRefreshIntent(intent.payload)) {
      actionError = null;
      try {
        await activeController().dispatch({ type: "refresh", autoObserve: false });
        await refreshSessions();
      } catch (e) {
        actionError = message(e);
        log(`refresh failed: ${actionError}`);
      }
      await pushNow();
      return;
    }
    const harnessConfiguration = parseConfigureHarnessIntent(intent.payload);
    if (harnessConfiguration !== null) {
      actionError = null;
      try {
        await activeController().dispatch({
          type: "configureHarness",
          harness: harnessConfiguration.harness,
          changes: harnessConfiguration.changes,
          expectedRevision: harnessConfiguration.expectedRevision,
        });
        log(`updated ${harnessConfiguration.harness} interoperability settings`);
      } catch (e) {
        actionError = message(e);
        log(`harness settings update failed: ${actionError}`);
      }
      await pushNow();
      return;
    }
    const newChat = parseNewChatIntent(intent.payload);
    if (newChat !== null) {
      actionError = null;
      attachSeq += 1;
      try {
        await releaseForeignView();
        await controller.dispatch({ type: "start", harness: newChat.harness });
        await controller.dispatch({ type: "send", text: newChat.text, ...(newChat.context.length ? { context: newChat.context } : {}), ...(newChat.images.length ? { images: newChat.images } : {}) });
      } catch (e) {
        actionError = message(e);
        log(`new chat failed: ${actionError}`);
      }
      await pushNow();
      return;
    }
    const send = parseSendIntent(intent.payload);
    if (send !== null) {
      actionError = null;
      try {
        // The ACTIVE controller: a mirror will refuse (`send` is not among its available actions),
        // and that refusal is the honest answer — the panel never fabricates a send path.
        await activeController().dispatch({ type: "send", text: send.text, ...(send.context.length ? { context: send.context } : {}), ...(send.images.length ? { images: send.images } : {}) });
      } catch (e) {
        actionError = message(e);
        log(`send failed: ${actionError}`);
      }
      await pushNow();
      return;
    }
    if (parseInterruptIntent(intent.payload)) {
      actionError = null;
      try {
        await activeController().dispatch({ type: "interrupt" });
      } catch (e) {
        actionError = message(e);
        log(`interrupt failed: ${actionError}`);
      }
      await pushNow();
      return;
    }
    if (parseReleaseIntent(intent.payload)) {
      await releaseForeignView();
      attachError = null;
      actionError = null;
      await pushNow();
      return;
    }
    const resumeMode = parseResumeIntent(intent.payload);
    if (resumeMode !== null) {
      actionError = null;
      const foreign = activeForeign();
      const snapshot = foreign?.controller.getSnapshot();
      const key = snapshot?.activeSessionKey ?? null;
      const activeSession = snapshot?.sessions.find((session) => session.key === key);
      try {
        if (!foreign || !snapshot || snapshot.connection.mode !== "mirror" || key === null) {
          throw new Error("open a persisted read-only conversation before continuing it here");
        }
        // Native resume starts another writer. A process-proven live state is authoritative, so
        // never race it; live-peer messaging remains available where the harness supports that.
        if (
          activeSession?.liveStatus === "running" ||
          activeSession?.liveStatus === "busy" ||
          activeSession?.liveStatus === "idle"
        ) {
          throw new Error("this session is active in another agent window; message it live or start a separate continuation");
        }
        if (!snapshot.availableActions.resume) {
          throw new Error(`${snapshot.activeHarness ?? "this harness"} cannot resume this persisted session`);
        }
        const resumeStartedAt = performance.now();
        if (resumeMode === "terminal") {
          if (!options.terminalService) {
            throw new Error("this host does not provide a local terminal");
          }
          const descriptor = activeForeignKey
            ? descriptors.find((candidate) => sessionKey(candidate.locator) === activeForeignKey)
            : undefined;
          if (!descriptor) throw new Error("this persisted session is no longer available");
          if (descriptor.locator.harness !== "claude-code" && descriptor.locator.harness !== "codex") {
            throw new Error(`${descriptor.locator.harness} terminal continuation is not supported yet`);
          }
          const { launch } = await requireClient(options).resumeInstructions({
            locator: descriptor.locator,
            cwd: descriptor.cwd ?? snapshot.workspace,
            ...(options.policy ? { policy: options.policy } : {}),
          });
          terminalHost = await options.terminalService.continueSession(
            descriptor.locator.harness,
            launch,
          );
          log(
            `resumed ${snapshot.activeHarness ?? "coding agent"} session in an owned tmux terminal in ` +
            `${Math.round(performance.now() - resumeStartedAt)}ms`,
          );
        } else {
          await foreign.controller.dispatch({ type: "resume", sessionKey: key });
          log(
            `resumed ${snapshot.activeHarness ?? "coding agent"} session headlessly under local control in ` +
            `${Math.round(performance.now() - resumeStartedAt)}ms`,
          );
        }
      } catch (e) {
        actionError = message(e);
        log(`resume failed: ${actionError}`);
      }
      await pushNow();
      return;
    }
    if (parseJoinIntent(intent.payload)) {
      actionError = null;
      const foreign = activeForeign();
      const snapshot = foreign?.controller.getSnapshot();
      const key = snapshot?.activeSessionKey ?? null;
      try {
        if (!foreign || !snapshot || snapshot.connection.mode !== "mirror" || key === null) {
          throw new Error("open a live shared conversation before joining it");
        }
        if (!snapshot.availableActions.attach) {
          throw new Error(`${snapshot.activeHarness ?? "this harness"} does not expose a joinable live endpoint`);
        }
        await foreign.controller.dispatch({ type: "attach", sessionKey: key });
        log(`joined ${snapshot.activeHarness ?? "coding agent"} live session under shared control`);
      } catch (e) {
        actionError = message(e);
        log(`join failed: ${actionError}`);
      }
      await pushNow();
      return;
    }
    if (parseDetachIntent(intent.payload)) {
      actionError = null;
      const snapshot = activeController().getSnapshot();
      try {
        if (!snapshot.availableActions.detach) throw new Error("this conversation is not a shared live attachment");
        await activeController().dispatch({ type: "detach" });
        log(`detached from ${snapshot.activeHarness ?? "coding agent"}; continuing as a read-only follower`);
      } catch (e) {
        actionError = message(e);
        log(`detach failed: ${actionError}`);
      }
      await pushNow();
      return;
    }
    if (parseTerminalIntent(intent.payload)) {
      actionError = null;
      const snapshot = activeController().getSnapshot();
      try {
        if (!snapshot.availableActions.openTerminal) throw new Error("this runtime cannot create a terminal handoff");
        await activeController().dispatch({ type: "openTerminal" });
        log(`prepared terminal handoff for ${snapshot.activeHarness ?? "coding agent"}`);
      } catch (e) {
        actionError = message(e);
        log(`terminal handoff failed: ${actionError}`);
      }
      await pushNow();
      return;
    }
    const exportIntent = parseExportIntent(intent.payload);
    if (exportIntent !== null) {
      actionError = null;
      exportReceipt = null;
      const target = exportIntent.targetHarness;
      const selected = activeController();
      try {
        if (!SESSION_FORMATS.has(target)) throw new Error(`${target} is not a supported native export format`);
        if (typeof selected.exportSession !== "function") throw new Error("this controller does not expose native session export");
        let snapshot = selected.getSnapshot();
        let key = snapshot.activeSessionKey;
        if (!key && snapshot.activeSessionId) {
          await selected.dispatch({ type: "refresh", autoObserve: false });
          snapshot = selected.getSnapshot();
          key = snapshot.sessions.find(
            (session) => session.harness === snapshot.activeHarness && session.sessionId === snapshot.activeSessionId,
          )?.key ?? null;
        }
        if (!key) throw new Error("this continuation has not persisted a native session to export yet");
        const artifact = await selected.exportSession(key, target as SessionFormat);
        if (artifact.fidelity === "semantic" || artifact.residue.length > 0) {
          throw new Error(`refusing a lossy ${target} export (${artifact.residue.length} unresolved fidelity notes)`);
        }
        exportReceipt = await materializeArtifact(artifact);
        log(`exported ${snapshot.activeHarness ?? "coding agent"} session to ${target} at ${exportReceipt.path}`);
      } catch (e) {
        actionError = message(e);
        log(`export failed: ${actionError}`);
      }
      await pushNow();
      return;
    }
    const branch = parseBranchIntent(intent.payload);
    if (branch !== null) {
      actionError = null;
      const foreign = activeForeign();
      const snapshot = foreign?.controller.getSnapshot();
      const key = snapshot?.activeSessionKey ?? null;
      try {
        if (!foreign || !snapshot || snapshot.connection.mode !== "mirror" || key === null) {
          throw new Error("open a read-only conversation before starting a separate continuation");
        }
        if (!snapshot.availableActions.branch) {
          throw new Error(`${snapshot.activeHarness ?? "this harness"} cannot branch this conversation`);
        }
        const target = branch.targetHarness;
        if (target !== null && !SESSION_FORMATS.has(target)) {
          throw new Error(`${target} is not a supported session format for continuation`);
        }
        if (target !== null && !snapshot.harnesses.some((harness) => harness.id === target && harness.availableActions.start)) {
          throw new Error(`${target} is not currently available to start a continuation`);
        }
        await foreign.controller.dispatch({
          type: "branch",
          sessionKey: key,
          ...(target === null ? {} : { targetHarness: target as SessionFormat }),
        });
        log(`branched ${snapshot.activeHarness ?? "coding agent"} conversation${target ? ` into ${target}` : ""}`);
      } catch (e) {
        actionError = message(e);
        log(`branch failed: ${actionError}`);
      }
      await pushNow();
      return;
    }
    const reduction = parseReduceIntent(intent.payload);
    if (reduction !== null) {
      actionError = null;
      const foreign = activeForeign();
      const snapshot = foreign?.controller.getSnapshot();
      const key = snapshot?.activeSessionKey ?? null;
      try {
        if (!foreign || !snapshot || snapshot.connection.mode !== "mirror" || key === null) {
          throw new Error("open a persisted read-only conversation before reducing it");
        }
        if (!snapshot.availableActions.reduce) {
          throw new Error("this Supercode service cannot create a verified reversible continuation");
        }
        const target = reduction.targetHarness;
        if (target !== null && !SESSION_FORMATS.has(target)) {
          throw new Error(`${target} is not a supported session format for continuation`);
        }
        if (target !== null && !snapshot.harnesses.some((harness) => harness.id === target && harness.availableActions.start)) {
          throw new Error(`${target} is not currently available to start a continuation`);
        }
        const startedAt = performance.now();
        await foreign.controller.dispatch({
          type: "reduce",
          sessionKey: key,
          ...(target === null ? {} : { targetHarness: target as SessionFormat }),
        });
        const receipt = foreign.controller.getSnapshot().reductionReceipt;
        if (!receipt?.verified || !receipt.reversible) {
          throw new Error("Supercode started no verified reversible reduction");
        }
        log(
          `reduced ${snapshot.activeHarness ?? "coding agent"} conversation${target ? ` into ${target}` : ""} ` +
          `${receipt.sourceTokens}→${receipt.reducedTokens} tokens (${receipt.ratio.toFixed(1)}x) in ` +
          `${Math.round(performance.now() - startedAt)}ms`,
        );
      } catch (e) {
        actionError = message(e);
        log(`reduction failed: ${actionError}`);
      }
      await pushNow();
      return;
    }
    const response = parseRespondIntent(intent.payload);
    if (response !== null) {
      actionError = null;
      try {
        await activeController().dispatch({ type: "respond", ...response });
      } catch (e) {
        actionError = message(e);
        log(`respond failed: ${actionError}`);
      }
      await pushNow();
      return;
    }
    const key = parseAttachIntent(intent.payload);
    if (key !== null) {
      actionError = null;
      const task = attachSession(key);
      // The context-aware Lucarne drain can receive a newer click while this native load is still
      // running. Keep its pump free; the attach task itself owns failure projection and cleanup.
      if (host.drainIntentsWithContext !== undefined) void task.catch(() => undefined);
      else await task;
      return;
    }
    if (action === "send" || action === "new" || action === "configureHarness") {
      actionError = `Invalid ${action} intent payload.`;
      log(`${action} rejected: ${actionError}`);
      await pushNow();
      return;
    }
    log(`ignoring unrecognized intent payload: ${JSON.stringify(intent.payload)}`);
  }, options.intentPollMs ?? DEFAULT_INTENT_POLL_MS, async (intent) => {
    const action = intent.payload && typeof intent.payload === "object"
      ? (intent.payload as { action?: unknown }).action
      : null;
    if (typeof action !== "string" || action === "draft" || action === "ack" || action === "mounted" || action === "panelVisible" || action === "panelHidden") return;
    await host.push({ bridgeDone: String(intent.id) }).catch((error: unknown) => {
      log(`bridge completion failed (continuing): ${message(error)}`);
    });
  });

  // Push before the first potentially slow RPC. Without this, the iframe mounts but receives no
  // state until initialization, harness startup, and discovery have all finished — indistinguishable
  // from a frozen panel on a cold machine.
  await pushNow();
  // The CLI supplies a dedicated discovery transport, so its per-harness store scans can overlap
  // controller inventory without queueing behind it. Embedders that reuse one transport retain the
  // serialized path: its NDJSON service processes requests one at a time.
  const discoveryStartedAt = performance.now();
  const bootstrapDiscovery = options.discoveryClient ? refreshSessions() : null;
  const inventoryStartedAt = performance.now();
  await controller.initialize();
  log(`controller inventory ready in ${Math.round(performance.now() - inventoryStartedAt)}ms`);

  const harness = chooseHarness(controller.getSnapshot(), options.harness);
  startupHarness = harness ?? options.harness ?? "";

  const finishDiscovery = async (): Promise<void> => {
    await (bootstrapDiscovery ?? refreshSessions());
    log(`discovered ${descriptors.length} recent sessions in ${Math.round(performance.now() - discoveryStartedAt)}ms`);
  };
  if (bootstrapDiscovery) {
    // A messenger can be usable before its historical inbox finishes filling. The dedicated lane
    // publishes rows as soon as they arrive while the control lane starts independently.
    void finishDiscovery();
  } else {
    startup = "discovering";
    await pushNow();
    await finishDiscovery();
  }

  if (harness) {
    startup = "starting";
    await pushNow();
    try {
      const harnessStartedAt = performance.now();
      await controller.dispatch({ type: "start", harness });
      log(`started ${harness} in ${options.workspace} in ${Math.round(performance.now() - harnessStartedAt)}ms`);
    } catch (e) {
      log(`could not start ${harness}: ${(e as Error)?.message ?? String(e)}`);
    }
  } else if (options.harness) {
    log(`harness '${options.harness}' cannot start here — the panel will mirror instead`);
  } else {
    log("no startable harness found — the panel will mirror instead");
  }

  startup = "ready";
  await pushNow();
  startDiscoveryPolling();
  log(`widget ready in ${Math.round(performance.now() - daemonStartedAt)}ms total`);

  return {
    host,
    controller,
    activeController,
    lastPushed: () => lastPushed,
    flush: pushNow,
    refreshSessions,
    attach: attachSession,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (attentionTimer) clearTimeout(attentionTimer);
      attentionTimer = null;
      await flushPersistence();
      stopRepush();
      stopDiscovery();
      activitySubscriptionGeneration += 1;
      indexSubscriptionGeneration += 1;
      activityTransport?.off("sessionActivityEvent", onSessionActivity);
      indexTransport?.off("sessionIndexEvent", onSessionIndex);
      if (activityTransport && activitySubscription) {
        await activityTransport.unsubscribe(activitySubscription).catch((error: unknown) => {
          log(`activity subscription cleanup failed (continuing): ${message(error)}`);
        });
        activitySubscription = null;
      }
      if (indexTransport && indexSubscription) {
        await indexTransport.unsubscribe(indexSubscription).catch((error: unknown) => {
          log(`session index cleanup failed (continuing): ${message(error)}`);
        });
        indexSubscription = null;
      }
      stopIntentPump();
      unsubscribe();
      await Promise.all([...attachTasks].map((task) => task.catch(() => undefined)));
      activeForeignKey = null;
      const foreign = [...foreignControllers.values()];
      foreignControllers.clear();
      for (const slot of foreign) slot.unsubscribe();
      await Promise.all(
        foreign.map((slot) => slot.controller.close().catch((e: unknown) => log(`detach failed: ${message(e)}`))),
      );
      await inFlight.catch(() => undefined);
      await host.remove().catch((e: unknown) => log(`widget removal failed: ${(e as Error)?.message ?? String(e)}`));
      // `ownsClient: true` (above) makes this close the harness transport too — the caller that
      // injected its own controller owns that controller's resources instead.
      await controller.close().catch((e: unknown) => log(`controller close failed: ${(e as Error)?.message ?? String(e)}`));
    },
  };
}

/** One place that turns a thrown unknown into a line a human can read. */
function message(e: unknown): string {
  return (e as Error)?.message ?? String(e);
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(reason)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requireClient(options: DaemonOptions): HarnessClientAdapter {
  if (!options.client) {
    throw new Error("vibewaiting: startDaemon needs either a `client` (harness transport) or a `controller`");
  }
  return options.client;
}
