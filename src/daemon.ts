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
import {
  HarnessAuthenticationController,
  SessionWindowCache,
  SupercodeSessionCatalog,
  SupercodeController,
} from "@volter-ai-dev/supercode-client";
import { sessionReconnectIdentitySync as sessionKey } from "@volter-ai-dev/supercode-client/node";
import type {
  FrontendHarness,
  HarnessClientAdapter,
  SupercodeSessionCatalogClient,
  SupercodeSessionCatalogSnapshot,
  SupercodeClientAction,
  SupercodeClientSnapshot,
} from "@volter-ai-dev/supercode-client";
import { createNativeInteractiveStart } from "@volter-ai-dev/supercode-harness-sdk";
import type { HarnessId, SessionArtifact, SessionDescriptor, SessionFormat, StructuredLaunch } from "@volter-ai-dev/supercode-harness-sdk";
import type { ContinuationMode } from "@volter-ai-dev/supercode-ui";
import { normalizeUiState, parseSupercodeUiIntent } from "@volter-ai-dev/supercode-ui/core";
import {
  dispatchControllerIntent,
  matchesSessionRef as matchesActive,
  projectAttachedSession as attachmentFor,
  projectSessionInventory as projectSessions,
  projectSubagentInventory,
  projectSubagentTranscript,
  sessionDescriptorRuntimeStatus as sessionRuntimeStatus,
  type ActiveSessionRef,
} from "@volter-ai-dev/supercode-ui/controller";
import { createNativeSessionAttentionTracker } from "@volter-ai-dev/supercode-ui/host";
import { createLucarneInjector } from "@volter-ai-dev/widget-shell/lucarne";
import { WidgetHost } from "lucarne/widget/host";
import {
  DEFAULT_MAX_ENTRIES,
  projectWithImages,
  toAttachError,
  type AttachError,
  type ProjectionOptions,
  type StartupPhase,
  type WidgetState,
} from "./projection.js";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import type { MessengerPersistence } from "./persistence.js";
import { writeSessionArtifact } from "./artifacts.js";
import type { ExportReceipt } from "./projection.js";
import { VIBEWAITING_RADIUS } from "./theme.js";
import {
  VIBEWAITING_PRESENTATION,
  VIBEWAITING_PRESENTATIONS,
} from "./presentations.js";
import type { SupercodeTerminalSnapshot as TerminalServiceSnapshot } from "@volter-ai-dev/supercode-terminal";

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
/** Each explicit inventory page adds the same bounded number of rows. */
export const MAX_SESSION_ROWS = 30;
/** Tool-stream churn is not unread. A no-status peer must be quiet this long before it asks for attention. */
export const DEFAULT_ATTENTION_SETTLE_MS = 15_000;
/** A broken harness attach must become a visible row error, never an eternal local spinner. */
export const DEFAULT_ATTACH_TIMEOUT_MS = 45_000;
/** Harnesses tried, in order, when the caller named none — first one that can actually start wins. */
export const HARNESS_PREFERENCE: readonly string[] = [
  "claude-code",
  "codex",
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

export interface WidgetIntent {
  id: string | number;
  payload: unknown;
  /** Whether this click came from the local extension or a paired remote browser. */
  source?: "local" | "remote";
}

/** The slice of `WidgetHost` this daemon uses — the seam a test replaces with a recorder. */
export interface WidgetBridge {
  push(patch: unknown): Promise<void>;
  onIntent(name: string, cb: (intent: WidgetIntent) => void | Promise<void>): void;
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

export type SessionDiscoveryClient = SupercodeSessionCatalogClient;

/**
 * Native stores are independent inbox sources. Asking for them separately lets the messenger paint
 * the first useful rows without waiting for the slowest store, and lets one broken adapter retain
 * its previous rows without discarding fresh results from every other harness.
 */
const DISCOVERY_HARNESSES: readonly HarnessId[] = [
  "claude-code",
  "codex",
];

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
  refreshNativeSessions(): Promise<void>;
  create(
    harness: "claude-code" | "codex",
    cwd: string,
  ): Promise<TerminalServiceSnapshot>;
  launchSession(
    harness: HarnessId,
    launch: StructuredLaunch,
    conversationKey?: string | null,
    initialInput?: string,
  ): Promise<TerminalServiceSnapshot>;
  bindContext(sessionId: string, conversationKey: string): Promise<TerminalServiceSnapshot>;
  canMoveSession(harness: HarnessId, sessionId: string, cwd: string): boolean;
  prepareMoveSession(
    harness: HarnessId,
    nativeSessionId: string,
    cwd: string,
    proof: { observedAtMs: number; source: string; turn: "idle" } | null,
  ): Promise<{ observedAtMs: number; source: string; turn: "idle" } | null>;
  moveSession(
    harness: HarnessId,
    nativeSessionId: string,
    launch: StructuredLaunch,
    conversationKey: string,
    proof: { observedAtMs: number; source: string; turn: "idle" },
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

function isMoveToTerminalIntent(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  return value.action === "moveToTerminal" && Object.keys(value).length === 1;
}

function isMoveAllToTerminalIntent(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  return value.action === "moveAllToTerminal" && Object.keys(value).length === 1;
}

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
  handler: (intent: WidgetIntent) => void | Promise<void>,
  pollMs = DEFAULT_INTENT_POLL_MS,
  onSettled?: (intent: WidgetIntent) => void | Promise<void>,
): () => void {
  const handle = async (intent: WidgetIntent): Promise<void> => {
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

const SESSION_FORMATS = new Set<string>([
  "claude-code",
  "codex",
  "gemini",
  "goose",
  "opencode",
  "pi",
  "grok",
]);

function parsePanelVisibilityIntent(payload: unknown): boolean | null {
  if (!payload || typeof payload !== "object" || Object.keys(payload).length !== 1) return null;
  const action = (payload as { action?: unknown }).action;
  if (action === "panelVisible") return true;
  if (action === "panelHidden") return false;
  return null;
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
    theme: { radius: VIBEWAITING_RADIUS, surface: "transparent" },
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
      client: requireClient(options),
      workspace: options.workspace,
      ownsClient: true,
      initialInventory: { sessions: [] },
      inventorySubscriptions: false,
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
        return { attention: [], observedCursors: {}, drafts: {}, preferredLaunchModes: {} };
      })
    : { attention: [], observedCursors: {}, drafts: {}, preferredLaunchModes: {} };

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
  let subagentDescriptors: readonly SessionDescriptor[] = [];
  let subagentInspector: WidgetState["subagentInspector"] = null;
  let subagentLoadGeneration = 0;
  let catalogActivities = new Map<string, SupercodeSessionCatalogSnapshot["activities"][number]>();
  let sessionLimit = MAX_SESSION_ROWS;
  let hasMoreSessions = false;
  const initialTranscriptLimit = options.projection?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const transcriptLimits = new Map<string, number>();
  /** A page action can fail before the controller publishes a structured error. Keep it visible. */
  let actionError: string | null = null;
  let exportReceipt: ExportReceipt | null = null;
  let terminalHost = options.terminalService ? await options.terminalService.snapshot() : null;
  let authenticationTerminalSessionId: string | null = null;
  const authentication = options.client?.beginHarnessAuthentication && options.client.verifyHarnessAuthentication
    ? new HarnessAuthenticationController({
        client: options.client,
        cwd: options.workspace,
        timeoutMs: 10 * 60_000,
        host: {
          launch: async (plan) => {
            const terminalService = options.terminalService;
            if (!terminalService) {
              throw new Error("Harness sign-in needs the local terminal companion.");
            }
            terminalHost = await terminalService.snapshot();
            if (!terminalHost.available) {
              throw new Error("Harness sign-in needs the local terminal companion.");
            }
            terminalHost = await terminalService.launchSession(plan.harness, plan.launch);
            const sessionId = terminalHost.attachment?.sessionId;
            if (!sessionId) {
              throw new Error("The terminal host did not expose the native sign-in session.");
            }
            authenticationTerminalSessionId = sessionId;
            let released = false;
            const release = async (): Promise<void> => {
              if (released) return;
              released = true;
              try {
                terminalHost = await terminalService.close(sessionId);
              } finally {
                if (authenticationTerminalSessionId === sessionId) {
                  authenticationTerminalSessionId = null;
                }
              }
            };
            return {
              wait: async () => {
                while (!released && !stopped) {
                  terminalHost = await terminalService.snapshot();
                  const session = terminalHost.sessions.find((item) => item.id === sessionId);
                  if (!session?.activeCommand) return { success: true };
                  await new Promise((resolve) => setTimeout(resolve, 1_000));
                }
                return { success: false, reason: `${plan.harness} sign-in was cancelled.` };
              },
              cancel: release,
              close: release,
            };
          },
        },
      })
    : null;
  const pendingTerminalStarts = new Map<string, {
    cwd: string;
    harness: "claude-code" | "codex";
    knownSessionKeys: Set<string>;
    prompt: string;
    startedAtMs: number;
  }>();
  let terminalBindingInFlight: Promise<void> | null = null;
  let bindPendingTerminalStarts: () => Promise<void> = async () => undefined;
  const terminalMoves = new Map<string, "waiting" | "moving">();
  let terminalMoveInFlight: Promise<void> | null = null;
  let terminalMoveRetryTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleTerminalMoveRetry = (): void => {
    if (terminalMoveRetryTimer || stopped || terminalMoves.size === 0) return;
    terminalMoveRetryTimer = setTimeout(() => {
      terminalMoveRetryTimer = null;
      void processTerminalMove();
    }, 1_000);
    terminalMoveRetryTimer.unref?.();
  };
  let nativeRefreshInFlight: Promise<void> | null = null;
  const refreshNativeSessions = (): Promise<void> => {
    if (!options.terminalService) return Promise.resolve();
    if (!nativeRefreshInFlight) {
      nativeRefreshInFlight = options.terminalService.refreshNativeSessions()
        .catch((error: unknown) => {
          log(`native terminal discovery failed (continuing): ${message(error)}`);
        })
        .finally(() => {
          nativeRefreshInFlight = null;
        });
    }
    return nativeRefreshInFlight;
  };
  const movableNativeDescriptors = (): SessionDescriptor[] => options.terminalService
    ? descriptors.filter((descriptor) =>
        (descriptor.locator.harness === "claude-code" || descriptor.locator.harness === "codex") &&
        options.terminalService!.canMoveSession(
          descriptor.locator.harness,
          descriptor.locator.session_id,
          descriptor.cwd ?? options.workspace,
        )
      )
    : [];
  const materializeArtifact = options.materializeArtifact
    ?? ((artifact: SessionArtifact): Promise<ExportReceipt> => writeSessionArtifact(artifact, join(options.workspace, ".supercode", "exports")));

  let nativeAttentionState = {
    version: 1 as const,
    attention: persisted.attention,
    observedCursors: persisted.observedCursors,
  };
  const drafts = new Map<string, string>(Object.entries(persisted.drafts));
  const preferredLaunchModes = new Map<string, ContinuationMode>(Object.entries(persisted.preferredLaunchModes));
  let persistenceTimer: ReturnType<typeof setTimeout> | null = null;
  let persistenceInFlight: Promise<void> = Promise.resolve();
  const flushPersistence = (): Promise<void> => {
    if (!persistence) return Promise.resolve();
    if (persistenceTimer) clearTimeout(persistenceTimer);
    persistenceTimer = null;
    const state = { attention: nativeAttentionState.attention, observedCursors: nativeAttentionState.observedCursors, drafts: Object.fromEntries(drafts), preferredLaunchModes: Object.fromEntries(preferredLaunchModes) };
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
  const attentionTracker = createNativeSessionAttentionTracker({
    state: nativeAttentionState,
    onChange: (state) => {
      nativeAttentionState = state;
      schedulePersistence();
    },
  });
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
  ): ReturnType<typeof attentionTracker.observe>["attention"] => {
    const observation = attentionTracker.observe({
      sessions,
      descriptors,
      keyForDescriptor: (descriptor) => sessionKey(descriptor.locator),
      controller: snapshot,
      attachedKey: attached?.key ?? null,
      panelVisible,
      now: observedAt,
      settleMs: DEFAULT_ATTENTION_SETTLE_MS,
    });
    if (observation.settleAfterMs !== null) {
      scheduleAttentionSettlement(observation.settleAfterMs);
    }
    return observation.attention;
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
    const ownSnapshot = controller.getSnapshot();
    const ownRef = activeRef(ownSnapshot);
    const writableSessionKeys = new Set(
      (terminalHost?.bindings ?? []).map((binding) => binding.conversationKey),
    );
    if (ownSnapshot.availableActions.send && ownRef?.sessionId) {
      const ownedDescriptor = descriptors.find((descriptor) => matchesActive(descriptor, ownRef));
      if (ownedDescriptor) writableSessionKeys.add(sessionKey(ownedDescriptor.locator));
    }
    for (const [key, slot] of foreignControllers) {
      if (slot.controller.getSnapshot().availableActions.send) writableSessionKeys.add(key);
    }
    const isWritable = (descriptor: SessionDescriptor): boolean =>
      writableSessionKeys.has(sessionKey(descriptor.locator));
    const sessions = projectSessions(descriptors, {
      keyFor: (descriptor) => sessionKey(descriptor.locator),
      now: observedAt,
      home,
      active: ref,
      isWritable,
      maxSessions: sessionLimit,
      preserveOrder: true,
    });
    const inspector = subagentInspector ? {
      ...subagentInspector,
      items: projectSubagentInventory(
        subagentDescriptors.map((descriptor) => {
          const activity = catalogActivities.get(
            `${descriptor.locator.harness}\0${descriptor.locator.session_id}`,
          );
          return activity ? { ...descriptor, activity } : descriptor;
        }),
        {
          keyFor: (descriptor) => sessionKey(descriptor.locator),
          now: observedAt,
          home,
          maxSessions: 100,
        },
      ),
    } : null;
    const ownRows = projectSessions(descriptors, {
      keyFor: (descriptor) => sessionKey(descriptor.locator),
      now: observedAt,
      home,
      active: ownRef,
      isWritable,
      maxSessions: sessionLimit,
      preserveOrder: true,
    });
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
    const activeRuntimeStatus = activeDescriptor
      ? sessionRuntimeStatus(activeDescriptor)
      : null;
    const canResume = projected.canResume && activeDescriptor !== undefined && activeRuntimeStatus === null;
    const canMoveToTerminal = Boolean(
      options.terminalService &&
      activeDescriptor &&
      (activeDescriptor.locator.harness === "claude-code" || activeDescriptor.locator.harness === "codex") &&
      options.terminalService.canMoveSession(
        activeDescriptor.locator.harness,
        activeDescriptor.locator.session_id,
        activeDescriptor.cwd ?? options.workspace,
      )
    );
    const loadedMessages = snapshot.activeSession?.messages.length
      ?? snapshot.conversation.filter((entry) => entry.kind === "message").length;
    const hasEarlier = snapshot.conversation.length > transcriptLimit || (
      activeDescriptor?.message_count !== null &&
      activeDescriptor?.message_count !== undefined &&
      activeDescriptor.message_count > loadedMessages
    );
    const draftKey = activeForeignKey ?? (activeDescriptor ? sessionKey(activeDescriptor.locator) : null);
    const terminalView = terminalHost
      ? {
          ...terminalHost,
          attachment:
            terminalHost.attachment &&
            (terminalHost.attachment.conversationKey === null ||
              terminalHost.attachment.conversationKey === draftKey)
              ? terminalHost.attachment
              : null,
          bindings: draftKey
            ? terminalHost.bindings.filter(
                (binding) => binding.conversationKey === draftKey,
              )
            : [],
          // A conversation toggle never needs the machine-wide tmux catalog.
          // Keep that native inventory behind the bridge instead of exposing
          // unrelated terminal labels and working directories to the iframe.
          sessions: [],
        }
      : null;
    const activeMoveStatus = draftKey ? terminalMoves.get(draftKey) ?? null : null;
    const movableNativeSessionCount = movableNativeDescriptors().length;
    const state: WidgetState & {
      authenticationTerminalSessionId?: string | null;
      canMoveToTerminal?: boolean;
      movableNativeSessionCount?: number;
      terminalHost?: TerminalServiceSnapshot;
      terminalMoveQueuedCount?: number;
      terminalMoveWaitingCount?: number;
      terminalMoveStatus?: "waiting" | "moving" | null;
    } = {
      ...projected,
      pill: startup === "ready" ? projected.pill : { tone: "off", label: startupLabel },
      startup,
      // A requested/selected harness is already a real identity. Keep its real logo visible while
      // the runtime is connecting and after a failed start; hiding the launcher reads as a freeze.
      harness: projected.harness || startupHarness,
      sessions,
      subagentInspector: inspector,
      attached,
      owned: attachmentFor(ownRef, ownRows, ownSnapshot.workspace, home),
      attachError,
      harnessAuthentication: normalizeUiState({
        harnessAuthentication: authentication?.getSnapshot() ?? null,
      }).harnessAuthentication,
      authenticationTerminalSessionId,
      error: actionError ?? projected.error,
      // The shared UI's Retry control means "refresh controller state". Host intents such as
      // resume/send/export already retain their own action, so labelling a refresh as a retry is
      // dishonest; the original button or draft remains the real retry path.
      recoverable: actionError === null && projected.recoverable,
      canResume,
      canMoveToTerminal,
      movableNativeSessionCount,
      terminalMoveQueuedCount: terminalMoves.size,
      terminalMoveWaitingCount: [...terminalMoves.values()].filter((status) => status === "waiting").length,
      terminalMoveStatus: activeMoveStatus,
      canExport: typeof activeController().exportSession === "function" && snapshot.operation === null && Boolean(snapshot.activeSessionKey || snapshot.activeSessionId),
      // Vibewaiting's first complete product lane is intentionally Claude Code + Codex. Supercode
      // retains its full translation/reduction surface; this thin consumer does not advertise
      // unfinished targets or reduction until their messenger journeys are deliberately admitted.
      canReduce: false,
      harnesses: projected.harnesses.filter((item) => item.id === "claude-code" || item.id === "codex").map((item) => {
        const launchModes: ContinuationMode[] = item.startable
          ? [
              "headless",
              ...(options.terminalService && terminalHost?.available && (item.id === "claude-code" || item.id === "codex")
                ? ["terminal" as const]
                : []),
            ]
          : [];
        const preferred = preferredLaunchModes.get(item.id);
        return {
          ...item,
          launchModes,
          preferredLaunchMode: preferred && launchModes.includes(preferred)
            ? preferred
            : launchModes.includes("terminal")
              ? "terminal"
              : launchModes[0] ?? null,
        };
      }),
      continuationModes: canResume
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
      ...(terminalView ? { terminalHost: terminalView } : {}),
    };
    lastPushed = state;
    const inventoryPatch: Partial<WidgetState> & {
      authenticationTerminalSessionId?: string | null;
      canMoveToTerminal?: boolean;
      movableNativeSessionCount?: number;
      terminalMoveQueuedCount?: number;
      terminalMoveWaitingCount?: number;
      terminalMoveStatus?: "waiting" | "moving" | null;
    } = {
      pill: state.pill,
      startup: state.startup,
      sessions: state.sessions,
      subagentInspector: state.subagentInspector,
      attached: state.attached,
      owned: state.owned,
      attachError: state.attachError,
      harnessAuthentication: state.harnessAuthentication,
      authenticationTerminalSessionId: state.authenticationTerminalSessionId ?? null,
      attention: state.attention,
      history: state.history,
      error: state.error,
      recoverable: state.recoverable,
      canResume: state.canResume,
      canMoveToTerminal: state.canMoveToTerminal === true,
      movableNativeSessionCount: state.movableNativeSessionCount ?? 0,
      terminalMoveQueuedCount: state.terminalMoveQueuedCount ?? 0,
      terminalMoveWaitingCount: state.terminalMoveWaitingCount ?? 0,
      terminalMoveStatus: state.terminalMoveStatus ?? null,
      canExport: state.canExport,
      canReduce: state.canReduce,
      continuationModes: state.continuationModes,
      exportBackTarget: state.exportBackTarget,
      exportReceipt: state.exportReceipt,
      reductionReceipt: state.reductionReceipt,
      savedDraft: state.savedDraft,
      ...(terminalView ? { terminalHost: terminalView } : {}),
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
  const unsubscribeAuthentication = authentication?.subscribe(() => {
    void pushNow();
  }) ?? (() => undefined);

  void refreshNativeSessions()
    .then(() => pushNow(false, "inventory"))
    .catch(() => undefined);

  const repushMs = options.repushIntervalMs ?? DEFAULT_REPUSH_INTERVAL_MS;
  const stopRepush = repushMs > 0 ? host.every(repushMs, () => pushNow()) : (): void => undefined;

  // Supercode owns discovery, topic retention, index-gap recovery, lifecycle subscriptions, and
  // pagination. Vibewaiting keeps only the messenger-specific rule that rows do not move under the
  // pointer while the list is open.
  let initialInventorySettled = false;
  let catalog: SupercodeSessionCatalog | null = null;
  const knownDescriptorKeys = new Set<string>();
  const rebuildDescriptors = (
    snapshot: SupercodeSessionCatalogSnapshot | null = catalog?.getSnapshot() ?? null,
    preserveVisibleOrder = panelVisible && initialInventorySettled,
  ): void => {
    if (!snapshot) {
      descriptors = [];
      hasMoreSessions = false;
      return;
    }
    sessionLimit = snapshot.limit;
    hasMoreSessions = snapshot.hasMore;
    catalogActivities = new Map(snapshot.activities.map((activity) => [
      `${activity.harness}\0${activity.session_id}`,
      activity,
    ]));
    const all = [...snapshot.sessions];
    const unseen = all.filter((descriptor) => !knownDescriptorKeys.has(sessionKey(descriptor.locator)));
    for (const descriptor of all) knownDescriptorKeys.add(sessionKey(descriptor.locator));
    if (!preserveVisibleOrder || descriptors.length === 0) {
      descriptors = all;
      return;
    }
    const updatedByKey = new Map(all.map((descriptor) => [sessionKey(descriptor.locator), descriptor]));
    const pinnedKeys = new Set([
      ...(activeForeignKey ? [activeForeignKey] : []),
      ...terminalMoves.keys(),
    ]);
    const stable = descriptors.flatMap((descriptor) => {
      const key = sessionKey(descriptor.locator);
      const updated = updatedByKey.get(key);
      if (!updated) return pinnedKeys.has(key) ? [descriptor] : [];
      updatedByKey.delete(key);
      return [updated];
    });
    const additions = unseen.filter((descriptor) => updatedByKey.has(sessionKey(descriptor.locator)));
    const pinnedCount = stable.filter((descriptor) => pinnedKeys.has(sessionKey(descriptor.locator))).length;
    const selectedAdditions = additions.slice(0, Math.max(0, sessionLimit - pinnedCount));
    const stableBudget = sessionLimit - selectedAdditions.length;
    let unpinnedSlots = Math.max(0, stableBudget - pinnedCount);
    const selectedStable = stable.filter((descriptor) => {
      if (pinnedKeys.has(sessionKey(descriptor.locator))) return true;
      if (unpinnedSlots === 0) return false;
      unpinnedSlots -= 1;
      return true;
    });
    descriptors = [...selectedStable, ...selectedAdditions].slice(0, sessionLimit);
  };
  catalog = discovery
    ? new SupercodeSessionCatalog({
        client: discovery,
        harnesses: DISCOVERY_HARNESSES,
        limit: sessionLimit,
        includeTopicCandidates: true,
      })
    : null;
  const unsubscribeCatalog = catalog?.subscribe((snapshot) => {
    if (stopped) return;
    rebuildDescriptors(snapshot);
    void bindPendingTerminalStarts();
    void pushNow(false, "inventory");
    void processTerminalMove();
  }) ?? (() => undefined);
  const refreshSessions = async (): Promise<void> => {
    if (stopped || !catalog) return;
    await catalog.refresh();
    if (!initialInventorySettled) {
      initialInventorySettled = true;
      rebuildDescriptors(catalog.getSnapshot(), false);
      await pushNow(false, "inventory");
    }
  };

  async function processTerminalMove(): Promise<void> {
    if (terminalMoves.size === 0 || terminalMoveInFlight || !options.terminalService) return;
    let queueChanged = false;
    let queuedKey: string | null = null;
    for (const [key, status] of terminalMoves) {
      if (status !== "waiting") continue;
      const descriptor = descriptors.find((candidate) => sessionKey(candidate.locator) === key);
      if (!descriptor || (
        descriptor.locator.harness !== "claude-code" && descriptor.locator.harness !== "codex"
      ) || !options.terminalService.canMoveSession(
        descriptor.locator.harness,
        descriptor.locator.session_id,
        descriptor.cwd ?? options.workspace,
      )) {
        terminalMoves.delete(key);
        queueChanged = true;
        continue;
      }
      if (descriptor.activity?.presence !== "running" || descriptor.activity.turn === "idle") {
        queuedKey = key;
        break;
      }
    }
    if (!queuedKey) {
      if (queueChanged) await pushNow(true);
      scheduleTerminalMoveRetry();
      return;
    }
    terminalMoveInFlight = (async () => {
      try {
        // Native terminal discovery can take a few seconds. Finish it before taking the
        // authoritative Supercode activity sample so the idle proof cannot expire in transit.
        await options.terminalService!.refreshNativeSessions();
        let current = descriptors.find((candidate) => sessionKey(candidate.locator) === queuedKey);
        if (current?.activity?.presence === "running") {
          await refreshSessions();
          current = descriptors.find((candidate) => sessionKey(candidate.locator) === queuedKey);
        }
        const activity = current?.activity;
        if (!current || (activity?.presence === "running" && activity.turn !== "idle")) {
          terminalMoves.set(queuedKey, "waiting");
          await pushNow(false, "inventory");
          scheduleTerminalMoveRetry();
          return;
        }
        if (current.locator.harness !== "claude-code" && current.locator.harness !== "codex") {
          throw new Error(`${current.locator.harness} native terminal handoff is not supported`);
        }
        const cwd = current.cwd ?? options.workspace;
        if (!options.terminalService!.canMoveSession(current.locator.harness, current.locator.session_id, cwd)) {
          throw new Error("the native terminal owning this session is no longer visible");
        }
        const { launch } = await requireClient(options).resumeInstructions({
          locator: current.locator,
          cwd,
          ...(options.policy ? { policy: options.policy } : {}),
        });
        const knownProof = activity?.presence === "running" && activity.turn === "idle"
          ? {
              observedAtMs: activity.evidence.observed_at_ms,
              source: activity.evidence.source,
              turn: "idle" as const,
            }
          : null;
        const proof = await options.terminalService!.prepareMoveSession(
          current.locator.harness,
          current.locator.session_id,
          cwd,
          knownProof,
        );
        if (!proof) {
          terminalMoves.set(queuedKey, "waiting");
          scheduleTerminalMoveRetry();
          return;
        }
        if (terminalMoves.get(queuedKey) !== "waiting") return;
        terminalMoves.set(queuedKey, "moving");
        await pushNow(true);
        terminalHost = await options.terminalService!.moveSession(
          current.locator.harness,
          current.locator.session_id,
          launch,
          queuedKey,
          proof,
        );
        terminalMoves.delete(queuedKey);
        actionError = null;
        log(`moved ${current.locator.harness} session from its native terminal into owned tmux`);
        await pushNow(true);
      } catch (error) {
        terminalMoves.delete(queuedKey);
        actionError = message(error);
        log(`native terminal move failed: ${actionError}`);
        await pushNow(true);
      }
    })().finally(() => {
      terminalMoveInFlight = null;
      void processTerminalMove();
    });
    await terminalMoveInFlight;
  }

  const discoverMs = options.discoverIntervalMs ?? DEFAULT_DISCOVER_INTERVAL_MS;
  // Begin polling only after bootstrap. Registering it before a slow runtime start let discovery
  // ticks compete with startup on the same harness transport.
  let stopDiscovery = (): void => undefined;
  const startDiscoveryPolling = (): void => {
    if (discoverMs > 0 && catalog) stopDiscovery = host.every(discoverMs, refreshSessions);
  };

  const createController =
    options.createController ??
    ((opts: { workspace: string; descriptor: SessionDescriptor; harnesses: readonly FrontendHarness[]; tailMessages: number }): AgentController =>
      // `ownsClient: false`: this daemon's ONE transport outlives every mirror that borrows it.
      // Seed the locator and already-known harness inventory so initialization does not rediscover
      // an entire workspace merely to mint the controller's local session key.
      new SupercodeController({
        client: requireClient(options),
        workspace: opts.workspace,
        ownsClient: false,
        autoObserve: false,
        initialInventory: {
          harnesses: opts.harnesses,
          sessions: [opts.descriptor],
        },
        // The daemon already owns the one machine-wide index and activity stream. A disposable
        // one-session mirror only needs its bounded transcript follower; opening another native
        // index here queues the requested chat behind an unrelated full inventory scan.
        inventorySubscriptions: false,
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
    const nativeRefresh = refreshNativeSessions();
    // A new attempt supersedes the previous failure, whatever this one goes on to do.
    attachError = null;
    if (activeForeignKey === key) {
      await nativeRefresh;
      await pushNow();
      return;
    }
    const retained = foreignControllers.get(key);
    if (retained) {
      await releaseForeignView();
      activeForeignKey = key;
      log(`returning to locally controlled ${retained.controller.getSnapshot().activeHarness ?? "coding agent"} session`);
      await nativeRefresh;
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
    await nativeRefresh;
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

  bindPendingTerminalStarts = (): Promise<void> => {
    const terminalService = options.terminalService;
    if (stopped || terminalBindingInFlight || !terminalService || pendingTerminalStarts.size === 0)
      return terminalBindingInFlight ?? Promise.resolve();
    terminalBindingInFlight = (async () => {
      for (const [terminalSessionId, pending] of pendingTerminalStarts) {
        if (stopped) return;
        if (now() - pending.startedAtMs > 10 * 60_000) {
          pendingTerminalStarts.delete(terminalSessionId);
          continue;
        }
        const prompt = pending.prompt.trim();
        const matches = descriptors.filter((descriptor) => {
          const key = sessionKey(descriptor.locator);
          if (pending.knownSessionKeys.has(key) || descriptor.locator.harness !== pending.harness)
            return false;
          if (descriptor.cwd !== pending.cwd) return false;
          return [
            ...(descriptor.preview_candidates ?? []),
            ...(descriptor.latest_message_candidates ?? []),
          ].some((candidate) => candidate.role === "user" && candidate.content.trim() === prompt);
        });
        // Multiple exact candidates are uncommon but possible when identical prompts start
        // concurrently. Fail closed instead of associating a terminal with the wrong transcript.
        const [match] = matches;
        if (matches.length !== 1 || !match) continue;
        const conversationKey = sessionKey(match.locator);
        terminalHost = await terminalService.bindContext(
          terminalSessionId,
          conversationKey,
        );
        pendingTerminalStarts.delete(terminalSessionId);
        log(`bound new ${pending.harness} terminal to its persisted conversation`);
        if (!activeForeignKey) await attachSession(conversationKey);
      }
    })().catch((error: unknown) => {
      log(`new terminal binding failed (continuing): ${message(error)}`);
    }).finally(() => {
      terminalBindingInFlight = null;
    });
    return terminalBindingInFlight;
  };

  const stopIntentPump = bindIntentQueue(host, INTENT_QUEUE, async (intent) => {
    const action = intent.payload && typeof intent.payload === "object"
      ? (intent.payload as { action?: unknown }).action
      : null;
    const uiIntent = parseSupercodeUiIntent(intent.payload);
    if (typeof action === "string" && action !== "draft" && action !== "ack") {
      await host.push({ bridgeAck: String(intent.id) }).catch((error: unknown) => {
        log(`bridge acknowledgement failed (continuing): ${message(error)}`);
      });
    }
    if (uiIntent?.action === "mounted") {
      panelVisible = false;
      rebuildDescriptors(catalog?.getSnapshot() ?? null, false);
      await pushNow(true);
      return;
    }
    const panelVisibility = parsePanelVisibilityIntent(intent.payload);
    if (panelVisibility !== null) {
      panelVisible = panelVisibility;
      if (!panelVisible) rebuildDescriptors(catalog?.getSnapshot() ?? null, false);
      if (panelVisible) {
        await pushNow(true);
        void refreshNativeSessions().then(() => pushNow(false, "inventory"));
      }
      return;
    }
    if (uiIntent?.action === "openSubagents") {
      const parent = descriptors.find(
        (descriptor) => sessionKey(descriptor.locator) === uiIntent.key,
      );
      if (!parent) {
        subagentInspector = {
          parentKey: uiIntent.key,
          parentTitle: "Unavailable chat",
          status: "error",
          items: [],
          selectedKey: null,
          transcript: [],
          error: "This conversation is no longer available.",
        };
        await pushNow(false, "inventory");
        return;
      }
      if (subagentInspector?.parentKey === uiIntent.key && subagentInspector.status === "ready") {
        subagentInspector = {
          ...subagentInspector,
          status: "ready",
          selectedKey: null,
          transcript: [],
          error: null,
        };
        await pushNow(false, "inventory");
        return;
      }
      const generation = ++subagentLoadGeneration;
      const [parentRow] = projectSessions([parent], {
        keyFor: (descriptor) => sessionKey(descriptor.locator),
        now: now(),
        home,
        maxSessions: 1,
      });
      subagentDescriptors = [];
      subagentInspector = {
        parentKey: uiIntent.key,
        parentTitle: parentRow?.title ?? parent.title ?? "Untitled chat",
        status: "loading",
        items: [],
        selectedKey: null,
        transcript: [],
        error: null,
      };
      await catalog?.setSupplementalActivityLocators([]);
      await pushNow(false, "inventory");
      try {
        if (!discovery) throw new Error("Session discovery is unavailable.");
        const result = await discovery.discover({
          harnesses: [parent.locator.harness],
          include_child_sessions: true,
          root_session_id: parent.locator.session_id,
          include_topic_candidates: true,
          limit: 101,
        });
        if (stopped || generation !== subagentLoadGeneration) return;
        subagentDescriptors = result.sessions.filter(
          (descriptor) => descriptor.parent_session_id != null,
        ).slice(0, 100);
        subagentInspector = {
          ...subagentInspector,
          status: "ready",
          error: null,
        };
        await catalog?.setSupplementalActivityLocators(
          subagentDescriptors.map((descriptor) => descriptor.locator),
        );
      } catch (error) {
        if (stopped || generation !== subagentLoadGeneration) return;
        subagentInspector = {
          ...subagentInspector,
          status: "error",
          error: message(error),
        };
        await catalog?.setSupplementalActivityLocators([]);
      }
      await pushNow(false, "inventory");
      return;
    }
    if (uiIntent?.action === "openSubagent") {
      const child = subagentInspector?.parentKey === uiIntent.parentKey
        ? subagentDescriptors.find(
            (descriptor) => sessionKey(descriptor.locator) === uiIntent.key,
          )
        : undefined;
      if (!child || !subagentInspector) {
        if (subagentInspector) {
          subagentInspector = { ...subagentInspector, status: "error", error: "This subagent is no longer available." };
          await pushNow(false, "inventory");
        }
        return;
      }
      const generation = ++subagentLoadGeneration;
      subagentInspector = {
        ...subagentInspector,
        status: "loading",
        selectedKey: uiIntent.key,
        transcript: [],
        error: null,
      };
      await pushNow(false, "inventory");
      try {
        const session = await requireClient(options).session(child.locator).load({
          view: PASSIVE_MIRROR_VIEW,
        });
        if (stopped || generation !== subagentLoadGeneration) return;
        subagentInspector = {
          ...subagentInspector,
          status: "ready",
          transcript: projectSubagentTranscript(session, {
            prefix: uiIntent.key,
            maxEntries: options.projection?.maxEntries ?? DEFAULT_MAX_ENTRIES,
            maxEntryChars: options.projection?.maxEntryChars ?? 16_000,
          }),
          error: null,
        };
      } catch (error) {
        if (stopped || generation !== subagentLoadGeneration) return;
        subagentInspector = { ...subagentInspector, status: "error", error: message(error) };
      }
      await pushNow(false, "inventory");
      return;
    }
    if (uiIntent?.action === "closeSubagents") {
      subagentLoadGeneration += 1;
      subagentDescriptors = [];
      subagentInspector = null;
      await catalog?.setSupplementalActivityLocators([]);
      await pushNow(false, "inventory");
      return;
    }
    if (uiIntent?.action === "loadSessions") {
      await catalog?.loadMore(MAX_SESSION_ROWS);
      return;
    }
    if (uiIntent?.action === "loadEarlier") {
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
            bindings: terminalHost?.bindings ?? [],
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
    if (uiIntent?.action === "draft") {
      const snapshot = activeController().getSnapshot();
      const ref = activeRef(snapshot);
      const descriptor = ref?.sessionId ? descriptors.find((candidate) => matchesActive(candidate, ref)) : undefined;
      const key = activeForeignKey ?? (descriptor ? sessionKey(descriptor.locator) : null);
      if (key) {
        if (uiIntent.text === "") drafts.delete(key);
        else drafts.set(key, uiIntent.text);
        schedulePersistence();
      }
      return;
    }
    if (uiIntent?.action === "ack") {
      if (attentionTracker.acknowledge(uiIntent.key)) {
        await pushNow();
      }
      return;
    }
    if (uiIntent?.action === "refresh") {
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
    if (uiIntent?.action === "authenticateHarness") {
      actionError = null;
      try {
        if (!authentication) {
          throw new Error("This Supercode service does not support native harness sign-in.");
        }
        const flow = authentication.authenticate(uiIntent.harness, {
          environment: intent.source === "remote" ? "headless" : "local_browser",
          cwd: options.workspace,
        });
        void flow.then(async (snapshot) => {
          if (snapshot.phase !== "authenticated" || stopped) return;
          log(`verified ${uiIntent.harness} sign-in through its native CLI`);
          await controller.dispatch({ type: "refresh", autoObserve: false, silent: true });
          await refreshSessions();
        }).catch(async (error: unknown) => {
          actionError = message(error);
          log(`harness sign-in failed: ${actionError}`);
          await pushNow(true);
        });
      } catch (error) {
        actionError = message(error);
        log(`harness sign-in failed: ${actionError}`);
      }
      await pushNow(true);
      return;
    }
    if (uiIntent?.action === "configureHarness") {
      actionError = null;
      try {
        await activeController().dispatch({
          type: "configureHarness",
          harness: uiIntent.harness,
          changes: uiIntent.changes,
          expectedRevision: uiIntent.expectedRevision,
        });
        log(`updated ${uiIntent.harness} interoperability settings`);
      } catch (e) {
        actionError = message(e);
        log(`harness settings update failed: ${actionError}`);
      }
      await pushNow();
      return;
    }
    if (uiIntent?.action === "new") {
      const newChat = {
        ...uiIntent,
        mode: uiIntent.mode ?? "headless",
        context: uiIntent.context ?? [],
        images: uiIntent.images ?? [],
      };
      actionError = null;
      attachSeq += 1;
      try {
        if (newChat.mode === "terminal") {
          if (!options.terminalService || !terminalHost?.available) {
            throw new Error("this host does not provide a local terminal");
          }
          if (newChat.context.length || newChat.images.length) {
            throw new Error("terminal starts currently accept text only");
          }
          await releaseForeignView();
          const start = createNativeInteractiveStart({
            harness: newChat.harness as "claude-code" | "codex",
            cwd: options.workspace,
            prompt: newChat.text,
            ...(options.policy ? { policy: options.policy } : {}),
          });
          const knownSessionKeys = new Set(descriptors.map((descriptor) =>
            sessionKey(descriptor.locator)));
          terminalHost = await options.terminalService.launchSession(
            newChat.harness,
            start.launch,
            null,
            start.initialInput,
          );
          const terminalSessionId = terminalHost.attachment?.sessionId;
          if (!terminalSessionId)
            throw new Error("the terminal host did not return an attachment for the new session");
          pendingTerminalStarts.set(terminalSessionId, {
            cwd: options.workspace,
            harness: newChat.harness as "claude-code" | "codex",
            knownSessionKeys,
            prompt: newChat.text,
            startedAtMs: now(),
          });
          log(`started a new ${newChat.harness} session in an owned tmux terminal`);
        } else {
          await releaseForeignView();
          await controller.dispatch({ type: "start", harness: newChat.harness });
          await controller.dispatch({ type: "send", text: newChat.text, ...(newChat.context.length ? { context: newChat.context } : {}), ...(newChat.images.length ? { images: newChat.images } : {}) });
        }
        preferredLaunchModes.set(newChat.harness, newChat.mode);
        schedulePersistence();
      } catch (e) {
        actionError = message(e);
        log(`new chat failed: ${actionError}`);
      }
      await pushNow(newChat.mode === "terminal");
      if (newChat.mode === "terminal") void refreshSessions();
      return;
    }
    if (uiIntent?.action === "send") {
      actionError = null;
      try {
        // The ACTIVE controller: a mirror will refuse (`send` is not among its available actions),
        // and that refusal is the honest answer — the panel never fabricates a send path.
        await dispatchControllerIntent(activeController(), uiIntent);
      } catch (e) {
        actionError = message(e);
        log(`send failed: ${actionError}`);
      }
      await pushNow();
      return;
    }
    if (uiIntent?.action === "interrupt") {
      actionError = null;
      try {
        await dispatchControllerIntent(activeController(), uiIntent);
      } catch (e) {
        actionError = message(e);
        log(`interrupt failed: ${actionError}`);
      }
      await pushNow();
      return;
    }
    if (uiIntent?.action === "release") {
      await releaseForeignView();
      attachError = null;
      actionError = null;
      await pushNow();
      return;
    }
    if (isMoveToTerminalIntent(intent.payload)) {
      actionError = null;
      if (!options.terminalService || !activeForeignKey) {
        actionError = "open a live native-terminal conversation before moving it";
      } else if (terminalMoves.get(activeForeignKey) === "waiting") {
        terminalMoves.delete(activeForeignKey);
      } else if (terminalMoves.get(activeForeignKey) !== "moving") {
        terminalMoves.set(activeForeignKey, "waiting");
      }
      await pushNow(true);
      void processTerminalMove();
      return;
    }
    if (isMoveAllToTerminalIntent(intent.payload)) {
      actionError = null;
      const waiting = [...terminalMoves].filter(([, status]) => status === "waiting");
      if (waiting.length > 0) {
        for (const [key] of waiting) terminalMoves.delete(key);
      } else if (![...terminalMoves.values()].includes("moving")) {
        const candidates = movableNativeDescriptors();
        if (candidates.length === 0) {
          actionError = "no live Claude Code or Codex terminal sessions are available to move";
        } else {
          for (const descriptor of candidates) {
            terminalMoves.set(sessionKey(descriptor.locator), "waiting");
          }
        }
      }
      await pushNow(true);
      void processTerminalMove();
      return;
    }
    if (uiIntent?.action === "resume") {
      const resumeMode = uiIntent.mode ?? "headless";
      actionError = null;
      const foreign = activeForeign();
      const snapshot = foreign?.controller.getSnapshot();
      const key = snapshot?.activeSessionKey ?? null;
      const activeSession = snapshot?.sessions.find((session) => session.key === key);
      const descriptor = activeForeignKey
        ? descriptors.find((candidate) => sessionKey(candidate.locator) === activeForeignKey)
        : undefined;
      const runtimeStatus = descriptor ? sessionRuntimeStatus(descriptor) : null;
      try {
        if (!foreign || !snapshot || snapshot.connection.mode !== "mirror" || key === null) {
          throw new Error("open a persisted read-only conversation before continuing it here");
        }
        // Native resume starts another writer. A process-proven live state is authoritative, so
        // never race it; live-peer messaging remains available where the harness supports that.
        if (
          activeSession?.liveStatus === "running" ||
          activeSession?.liveStatus === "busy" ||
          activeSession?.liveStatus === "idle" ||
          runtimeStatus !== null
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
          if (!descriptor) throw new Error("this persisted session is no longer available");
          if (descriptor.locator.harness !== "claude-code" && descriptor.locator.harness !== "codex") {
            throw new Error(`${descriptor.locator.harness} terminal continuation is not supported yet`);
          }
          const { launch } = await requireClient(options).resumeInstructions({
            locator: descriptor.locator,
            cwd: descriptor.cwd ?? snapshot.workspace,
            ...(options.policy ? { policy: options.policy } : {}),
          });
          terminalHost = await options.terminalService.launchSession(
            descriptor.locator.harness,
            launch,
            activeForeignKey ?? sessionKey(descriptor.locator),
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
    if (uiIntent?.action === "join") {
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
        await dispatchControllerIntent(foreign.controller, uiIntent);
        log(`joined ${snapshot.activeHarness ?? "coding agent"} live session under shared control`);
      } catch (e) {
        actionError = message(e);
        log(`join failed: ${actionError}`);
      }
      await pushNow();
      return;
    }
    if (uiIntent?.action === "detach") {
      actionError = null;
      const snapshot = activeController().getSnapshot();
      try {
        if (!snapshot.availableActions.detach) throw new Error("this conversation is not a shared live attachment");
        await dispatchControllerIntent(activeController(), uiIntent);
        log(`detached from ${snapshot.activeHarness ?? "coding agent"}; continuing as a read-only follower`);
      } catch (e) {
        actionError = message(e);
        log(`detach failed: ${actionError}`);
      }
      await pushNow();
      return;
    }
    if (uiIntent?.action === "terminal") {
      actionError = null;
      const snapshot = activeController().getSnapshot();
      try {
        if (!snapshot.availableActions.openTerminal) throw new Error("this runtime cannot create a terminal handoff");
        await dispatchControllerIntent(activeController(), uiIntent);
        log(`prepared terminal handoff for ${snapshot.activeHarness ?? "coding agent"}`);
      } catch (e) {
        actionError = message(e);
        log(`terminal handoff failed: ${actionError}`);
      }
      await pushNow();
      return;
    }
    if (uiIntent?.action === "export") {
      actionError = null;
      exportReceipt = null;
      const target = uiIntent.targetHarness;
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
    if (uiIntent?.action === "branch") {
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
        const target = uiIntent.targetHarness ?? null;
        if (target !== null && !SESSION_FORMATS.has(target)) {
          throw new Error(`${target} is not a supported session format for continuation`);
        }
        if (target !== null && !snapshot.harnesses.some((harness) => harness.id === target && harness.availableActions.start)) {
          throw new Error(`${target} is not currently available to start a continuation`);
        }
        await dispatchControllerIntent(foreign.controller, uiIntent);
        log(`branched ${snapshot.activeHarness ?? "coding agent"} conversation${target ? ` into ${target}` : ""}`);
      } catch (e) {
        actionError = message(e);
        log(`branch failed: ${actionError}`);
      }
      await pushNow();
      return;
    }
    if (uiIntent?.action === "reduce") {
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
        const target = uiIntent.targetHarness ?? null;
        if (target !== null && !SESSION_FORMATS.has(target)) {
          throw new Error(`${target} is not a supported session format for continuation`);
        }
        if (target !== null && !snapshot.harnesses.some((harness) => harness.id === target && harness.availableActions.start)) {
          throw new Error(`${target} is not currently available to start a continuation`);
        }
        const startedAt = performance.now();
        await dispatchControllerIntent(foreign.controller, uiIntent);
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
    if (uiIntent?.action === "respond") {
      actionError = null;
      try {
        await dispatchControllerIntent(activeController(), uiIntent);
      } catch (e) {
        actionError = message(e);
        log(`respond failed: ${actionError}`);
      }
      await pushNow();
      return;
    }
    if (uiIntent?.action === "attach") {
      actionError = null;
      const task = attachSession(uiIntent.key);
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
      if (terminalMoveRetryTimer) clearTimeout(terminalMoveRetryTimer);
      terminalMoveRetryTimer = null;
      unsubscribeAuthentication();
      await authentication?.close().catch((error: unknown) => {
        log(`native sign-in cleanup failed: ${message(error)}`);
      });
      await flushPersistence();
      stopRepush();
      stopDiscovery();
      unsubscribeCatalog();
      await catalog?.close().catch((error: unknown) => {
        log(`session catalog cleanup failed (continuing): ${message(error)}`);
      });
      stopIntentPump();
      pendingTerminalStarts.clear();
      await terminalBindingInFlight?.catch(() => undefined);
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
