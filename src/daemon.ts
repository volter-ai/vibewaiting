// The bridge: one lucarne widget on one browser session ⟷ one Supercode controller on one workspace.
//
// Two directions, and only two:
//   controller revision → debounced `project(snapshot)` → `host.push(patch)`
//   widget intent ("agent" queue) → `controller.dispatch({ type: "send", text })`
//
// Both ends are INJECTABLE (`attachHost`, `client`, `controller`) because the honest test of this
// module is a scripted snapshot sequence, not a browser: the widget half is proven by the fake host
// recording pushes, the agent half by the real `SupercodeController` driven through a fake harness
// client. Nothing here reaches for a global.
import { SupercodeController } from "@volter-ai-dev/supercode-client";
import type {
  HarnessClientAdapter,
  SupercodeClientAction,
  SupercodeClientSnapshot,
} from "@volter-ai-dev/supercode-client";
import type { HarnessId } from "@volter-ai-dev/supercode-harness-sdk";
import { WidgetHost } from "lucarne/widget/host";
import { project, type ProjectionOptions, type WidgetState } from "./projection.js";

/** Namespaces every page global / element id / sticky-injection id the widget mints (see `lucarne/widget/ns`). */
export const WIDGET_NS = "vibewaiting";
/** The one named intent queue the panel posts to and this daemon drains. */
export const INTENT_QUEUE = "agent";
/** Controller revisions arrive in bursts (one per streamed delta); coalesce them into one push. */
export const DEFAULT_PUSH_DEBOUNCE_MS = 150;
/** Steady re-push so a shell mounted on a NEWLY NAVIGATED page populates without an agent event. */
export const DEFAULT_REPUSH_INTERVAL_MS = 2000;
/** Harnesses tried, in order, when the caller named none — first one that can actually start wins. */
export const HARNESS_PREFERENCE: readonly string[] = ["claude-code", "codex", "opencode", "pi", "grok"];

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
  projection?: ProjectionOptions | undefined;
  log?: ((message: string) => void) | undefined;
}

export interface Daemon {
  readonly host: WidgetBridge;
  readonly controller: AgentController;
  /** The state of the last push (`null` before the first one) — the daemon's own observable output. */
  lastPushed(): WidgetState | null;
  /** Push the current snapshot NOW, bypassing the debounce. Used after start and by tests. */
  flush(): Promise<void>;
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

/** The one intent shape the panel sends. Anything else is ignored (and logged) rather than guessed at. */
export function parseSendIntent(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const { action, text } = payload as { action?: unknown; text?: unknown };
  if (action !== "send" || typeof text !== "string") return null;
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
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

  const pushNow = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    const state = project(controller.getSnapshot(), options.projection ?? {});
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

  host.onIntent(INTENT_QUEUE, async (intent) => {
    const text = parseSendIntent(intent.payload);
    if (text === null) {
      log(`ignoring unrecognized intent payload: ${JSON.stringify(intent.payload)}`);
      return;
    }
    try {
      await controller.dispatch({ type: "send", text });
    } catch (e) {
      log(`send failed: ${(e as Error)?.message ?? String(e)}`);
    }
    await pushNow();
  });

  await controller.initialize();

  const harness = chooseHarness(controller.getSnapshot(), options.harness);
  if (harness) {
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

  await pushNow();

  return {
    host,
    controller,
    lastPushed: () => lastPushed,
    flush: pushNow,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      stopRepush();
      unsubscribe();
      await inFlight.catch(() => undefined);
      await host.remove().catch((e: unknown) => log(`widget removal failed: ${(e as Error)?.message ?? String(e)}`));
      // `ownsClient: true` (above) makes this close the harness transport too — the caller that
      // injected its own controller owns that controller's resources instead.
      await controller.close().catch((e: unknown) => log(`controller close failed: ${(e as Error)?.message ?? String(e)}`));
    },
  };
}

function requireClient(options: DaemonOptions): HarnessClientAdapter {
  if (!options.client) {
    throw new Error("vibewaiting: startDaemon needs either a `client` (harness transport) or a `controller`");
  }
  return options.client;
}
