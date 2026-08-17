// The bridge: one lucarne widget on one browser session ⟷ the coding sessions on this machine.
//
// Three directions, and only three:
//   controller revision → debounced `project(snapshot)` → `host.push(patch)`
//   global discovery tick → `projectSessions(descriptors)` → the same push
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
import { SupercodeController } from "@volter-ai-dev/supercode-client";
import type {
  HarnessClientAdapter,
  SupercodeClientAction,
  SupercodeClientSnapshot,
} from "@volter-ai-dev/supercode-client";
import type { DiscoveryQuery, HarnessId, JsonValue, SessionDescriptor } from "@volter-ai-dev/supercode-harness-sdk";
import { WidgetHost } from "lucarne/widget/host";
import {
  DEFAULT_MAX_ENTRIES,
  project,
  toAttachError,
  type AttachError,
  type ProjectionOptions,
  type StartupPhase,
  type WidgetState,
} from "./projection.js";
import { homedir } from "node:os";
import {
  MAX_SESSION_ROWS,
  attachmentFor,
  matchesActive,
  projectSessions,
  sessionKey,
  type ActiveSessionRef,
} from "./sessions.js";

/** Namespaces every page global / element id / sticky-injection id the widget mints (see `lucarne/widget/ns`). */
export const WIDGET_NS = "vibewaiting";
/** The one named intent queue the panel posts to and this daemon drains. */
export const INTENT_QUEUE = "agent";
/** Controller revisions arrive in bursts (one per streamed delta); coalesce them into one push. */
export const DEFAULT_PUSH_DEBOUNCE_MS = 150;
/** Steady re-push so a shell mounted on a NEWLY NAVIGATED page populates without an agent event. */
export const DEFAULT_REPUSH_INTERVAL_MS = 2000;
/** How often the machine is re-scanned for coding sessions. Cheap: one RPC, capped result. */
export const DEFAULT_DISCOVER_INTERVAL_MS = 5000;
/** A broken harness attach must become a visible row error, never an eternal local spinner. */
export const DEFAULT_ATTACH_TIMEOUT_MS = 45_000;
/** Harnesses tried, in order, when the caller named none — first one that can actually start wins. */
export const HARNESS_PREFERENCE: readonly string[] = ["claude-code", "codex", "opencode", "pi", "grok"];
/** The widget renders this many entries, so its passive transport should never fetch more. */
const PASSIVE_MIRROR_VIEW = Object.freeze({
  tailMessages: DEFAULT_MAX_ENTRIES,
  maxMessageChars: 16_000,
  includeSubagents: false,
  displayHistory: true,
});

/** The slice of `WidgetHost` this daemon uses — the seam a test replaces with a recorder. */
export interface WidgetBridge {
  push(patch: unknown): Promise<void>;
  onIntent(name: string, cb: (intent: { id: string | number; payload: unknown }) => void | Promise<void>): void;
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
  /** Inject a whole controller, bypassing construction (tests, or a host that already owns one). */
  controller?: AgentController | undefined;
  /** Replace the widget mount (tests). Default: `WidgetHost.attach`. */
  attachHost?: (opts: { sessionId: string; ns: string; html: string; engine?: DaemonOptions["engine"] }) => Promise<WidgetBridge>;
  pushDebounceMs?: number | undefined;
  /**
   * Re-push heartbeat. A shell mounted AFTER the last revision-driven push (the user navigated to a
   * new page while the agent was idle) starts EMPTY and would stay empty until the next agent event
   * — the injector never tells the host about fresh mounts, so a steady re-push is the platform
   * idiom (see the widget README's `host.every` usage). State is small (projection-capped), so the
   * default is cheap. `0` disables (tests).
   */
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
  createController?: ((opts: { workspace: string }) => AgentController) | undefined;
  projection?: ProjectionOptions | undefined;
  log?: ((message: string) => void) | undefined;
}

export interface Daemon {
  readonly host: WidgetBridge;
  /** The controller this daemon STARTED. It keeps its runtime for the daemon's whole life. */
  readonly controller: AgentController;
  /** Whichever controller the Agent panel is currently showing — the owned one, or a foreign mirror. */
  activeController(): AgentController;
  /** The state of the last push (`null` before the first one) — the daemon's own observable output. */
  lastPushed(): WidgetState | null;
  /** Push the current snapshot NOW, bypassing the debounce. Used after start and by tests. */
  flush(): Promise<void>;
  /** Re-run global discovery and push. The discovery tick calls exactly this. */
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

/** The composer's intent shape. Anything else is ignored (and logged) rather than guessed at. */
export function parseSendIntent(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const { action, text } = payload as { action?: unknown; text?: unknown };
  if (action !== "send" || typeof text !== "string") return null;
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
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
  return await WidgetHost.attach(opts.sessionId, {
    ns: opts.ns,
    html: opts.html,
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
  const debounceMs = options.pushDebounceMs ?? DEFAULT_PUSH_DEBOUNCE_MS;
  const attach = options.attachHost ?? defaultAttachHost;

  const controller: AgentController =
    options.controller ??
    new SupercodeController({
      client: requireClient(options),
      workspace: options.workspace,
      ownsClient: true,
      // Startup immediately creates its own runtime; observing the newest
      // persisted session first only performs a redundant full transcript load.
      autoObserve: false,
      mirrorView: PASSIVE_MIRROR_VIEW,
      ...(options.policy ? { policy: options.policy } : {}),
    });

  const host = await attach({
    sessionId: options.sessionId,
    ns: WIDGET_NS,
    html: options.html,
    ...(options.engine ? { engine: options.engine } : {}),
  });

  let stopped = false;
  let lastPushed: WidgetState | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  let startup: StartupPhase = "connecting";
  let startupHarness = options.harness ?? "";

  const home = options.home ?? homedir();
  const now = options.now ?? Date.now;
  // The GLOBAL discovery door: the same transport, called with no workspace.
  const discovery: SessionDiscoveryClient | undefined = options.client;
  /** The last global scan, held whole — the row keys the panel echoes back resolve through it. */
  let descriptors: readonly SessionDescriptor[] = [];

  /**
   * Why the last attach did not happen. A logged-only failure is invisible to the person who tapped
   * the row — the panel would sit on "opening…" forever — so every path that gives up on an attach
   * sets this and pushes, and every new attempt clears it.
   */
  let attachError: AttachError | null = null;

  /** The non-owning controller following a foreign session, when the panel is on one. */
  let mirror: AgentController | null = null;
  let unsubscribeMirror: (() => void) | null = null;
  const activeController = (): AgentController => mirror ?? controller;

  const pushNow = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    const snapshot = activeController().getSnapshot();
    const ref = activeRef(snapshot);
    const sessions = projectSessions(descriptors, { now: now(), home, active: ref, max: MAX_SESSION_ROWS });
    const ownSnapshot = controller.getSnapshot();
    const ownRef = activeRef(ownSnapshot);
    const ownRows = projectSessions(descriptors, { now: now(), home, active: ownRef, max: MAX_SESSION_ROWS });
    const projected = project(snapshot, options.projection ?? {});
    const startupLabel = startup === "connecting"
      ? "Connecting to coding agents…"
      : startup === "starting"
        ? `Starting ${startupHarness || "coding agent"}…`
        : "Loading recent sessions…";
    const state: WidgetState = {
      ...projected,
      pill: startup === "ready" ? projected.pill : { tone: "off", label: startupLabel },
      startup,
      sessions,
      attached: attachmentFor(ref, sessions, snapshot.workspace, home),
      owned: attachmentFor(ownRef, ownRows, ownSnapshot.workspace, home),
      attachError,
    };
    lastPushed = state;
    // Serialize pushes: two overlapping CDP evaluations could otherwise deliver out of order and
    // leave the panel showing an older transcript than the one already drawn.
    inFlight = inFlight
      .catch(() => undefined)
      .then(() => host.push(state))
      .catch((e: unknown) => log(`push failed (continuing): ${(e as Error)?.message ?? String(e)}`));
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

  /** Re-scan the whole machine for coding sessions. Failure is logged and the old list is kept. */
  const refreshSessions = async (): Promise<void> => {
    if (stopped || !discovery) return;
    try {
      const result = await discovery.discover({ limit: MAX_SESSION_ROWS });
      descriptors = result.sessions;
    } catch (e) {
      log(`session discovery failed (continuing): ${message(e)}`);
      return;
    }
    await pushNow();
  };

  const discoverMs = options.discoverIntervalMs ?? DEFAULT_DISCOVER_INTERVAL_MS;
  const stopDiscovery =
    discoverMs > 0 && discovery ? host.every(discoverMs, () => refreshSessions()) : (): void => undefined;

  const createController =
    options.createController ??
    ((opts: { workspace: string }): AgentController =>
      // `ownsClient: false`: this daemon's ONE transport outlives every mirror that borrows it.
      // The requested descriptor is observed explicitly below, so automatic
      // observation here would load the workspace's newest session twice.
      new SupercodeController({
        client: requireClient(options),
        workspace: opts.workspace,
        ownsClient: false,
        autoObserve: false,
        mirrorView: PASSIVE_MIRROR_VIEW,
      }));

  /** Close the current mirror (which aborts its follower) and fall back to the owned controller. */
  const releaseMirror = async (): Promise<void> => {
    const previous = mirror;
    const unsub = unsubscribeMirror;
    mirror = null;
    unsubscribeMirror = null;
    unsub?.();
    if (previous) await previous.close().catch((e: unknown) => log(`detach failed: ${message(e)}`));
  };

  // Attaches are SERIALIZED and generation-checked: a double click must not leave two followers
  // running against two sessions, and the loser must be closed rather than merely forgotten.
  let attachSeq = 0;
  let attachChain: Promise<void> = Promise.resolve();
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
    await releaseMirror();
    if (matchesActive(descriptor, activeRef(controller.getSnapshot()))) {
      log(`following this daemon's own ${descriptor.locator.harness} session again`);
      await pushNow();
      return;
    }
    const workspace = descriptor.cwd ?? options.workspace;
    let candidate: AgentController;
    try {
      candidate = createController({ workspace });
    } catch (e) {
      await failAttach(key, seq, message(e), `attach unavailable: ${message(e)}`);
      return;
    }
    try {
      const timeoutSeconds = Math.max(1, Math.ceil(attachTimeoutMs / 1000));
      await withTimeout(
        (async () => {
          await candidate.initialize();
          // The controller mints its own workspace-scoped keys; ours is a hash of the locator, so
          // the two are matched on the pair every representation carries.
          const target = candidate
            .getSnapshot()
            .sessions.find(
              (s) => s.harness === descriptor.locator.harness && s.sessionId === descriptor.locator.session_id,
            );
          if (!target) throw new Error(`that session is not visible in ${workspace}`);
          await candidate.dispatch({ type: "observe", sessionKey: target.key });
        })(),
        attachTimeoutMs,
        `could not open this session within ${timeoutSeconds} ${timeoutSeconds === 1 ? "second" : "seconds"}`,
      );
    } catch (e) {
      await candidate.close().catch(() => undefined);
      await failAttach(key, seq, message(e));
      return;
    }
    if (stopped || seq !== attachSeq) {
      await candidate.close().catch(() => undefined);
      return;
    }
    mirror = candidate;
    unsubscribeMirror = candidate.subscribe(schedulePush);
    log(`following ${descriptor.locator.harness} in ${workspace} (read-only mirror)`);
    await pushNow();
  };

  const attachSession = (key: string): Promise<void> => {
    const seq = (attachSeq += 1);
    attachChain = attachChain.catch(() => undefined).then(() => runAttach(key, seq));
    return attachChain;
  };

  host.onIntent(INTENT_QUEUE, async (intent) => {
    const text = parseSendIntent(intent.payload);
    if (text !== null) {
      try {
        // The ACTIVE controller: a mirror will refuse (`send` is not among its available actions),
        // and that refusal is the honest answer — the panel never fabricates a send path.
        await activeController().dispatch({ type: "send", text });
      } catch (e) {
        log(`send failed: ${message(e)}`);
      }
      await pushNow();
      return;
    }
    if (parseInterruptIntent(intent.payload)) {
      try {
        await activeController().dispatch({ type: "interrupt" });
      } catch (e) {
        log(`interrupt failed: ${message(e)}`);
      }
      await pushNow();
      return;
    }
    if (parseReleaseIntent(intent.payload)) {
      await releaseMirror();
      attachError = null;
      await pushNow();
      return;
    }
    const response = parseRespondIntent(intent.payload);
    if (response !== null) {
      try {
        await activeController().dispatch({ type: "respond", ...response });
      } catch (e) {
        log(`respond failed: ${message(e)}`);
      }
      await pushNow();
      return;
    }
    const key = parseAttachIntent(intent.payload);
    if (key !== null) {
      await attachSession(key);
      return;
    }
    log(`ignoring unrecognized intent payload: ${JSON.stringify(intent.payload)}`);
  });

  // Push before the first potentially slow RPC. Without this, the iframe mounts but receives no
  // state until initialization, harness startup, and discovery have all finished — indistinguishable
  // from a frozen panel on a cold machine.
  await pushNow();
  await controller.initialize();

  const harness = chooseHarness(controller.getSnapshot(), options.harness);
  startupHarness = harness ?? options.harness ?? "";
  if (harness) {
    startup = "starting";
    await pushNow();
    try {
      await controller.dispatch({ type: "start", harness });
      log(`started ${harness} in ${options.workspace}`);
    } catch (e) {
      log(`could not start ${harness}: ${(e as Error)?.message ?? String(e)}`);
    }
  } else if (options.harness) {
    log(`harness '${options.harness}' cannot start here — the panel will mirror instead`);
  } else {
    log("no startable harness found — the panel will mirror instead");
  }

  startup = "discovering";
  await pushNow();
  await refreshSessions();
  startup = "ready";
  await pushNow();

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
      stopRepush();
      stopDiscovery();
      unsubscribe();
      await attachChain.catch(() => undefined);
      await releaseMirror();
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
