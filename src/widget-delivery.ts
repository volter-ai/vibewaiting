// Delivery over CDP: Widget Shell's injectOverlay mounts the messenger window into every page behind
// a CDP endpoint (a Volter Browsers session's published cdpUrl). The guest reaches this process through
// two capabilities: it long-polls the patch log and it sends intents. This module is the daemon's
// WidgetBridge; widget/overlay-transport.ts is the other end.
import { injectOverlay, type CdpEndpoint } from "@volter/widget-shell/cdp";
import type { OverlayPlacement, OverlayPresentation, OverlayTheme } from "@volter/widget-shell";
import type { WidgetBridge, WidgetIntent } from "./daemon.js";
import { INTENT_CAPABILITY, PATCHES_CAPABILITY } from "./widget-capabilities.js";

/** How long a patch request waits for the next patch before answering empty (the guest asks again). */
const LONG_POLL_MS = 20_000;
/** Patches kept for guests that fall behind; one further behind is told to resynchronize. */
const PATCH_LOG = 500;

export interface WidgetDeliveryOptions {
  readonly cdp: CdpEndpoint;
  readonly ns: string;
  readonly html: string;
  readonly title?: string;
  readonly launcherLabel: string;
  readonly launcherIcon?: string;
  readonly launcherHidden?: boolean;
  readonly initiallyOpen?: boolean;
  readonly viewport?: { readonly width?: number; readonly height?: number; readonly gutter?: number };
  readonly placement?: OverlayPlacement;
  readonly presentations?: Readonly<Record<string, OverlayPresentation>>;
  readonly initialPresentation?: string;
  readonly theme?: OverlayTheme;
}

/** A patch request: the last sequence number the guest has read (-1 before its first read). */
interface PatchRequest {
  readonly since?: unknown;
}

/** An intent from the guest: its name, the id it minted, its payload and where the click came from. */
interface IntentRequest {
  readonly name?: unknown;
  readonly id?: unknown;
  readonly payload?: unknown;
  readonly source?: unknown;
}

export async function attachWidget(options: WidgetDeliveryOptions): Promise<WidgetBridge> {
  const log: Array<{ seq: number; patch: unknown }> = [];
  let seq = 0;
  let waiters: Array<() => void> = [];
  const listeners = new Map<string, Set<(intent: WidgetIntent) => void | Promise<void>>>();
  const timers = new Set<ReturnType<typeof setInterval>>();

  const patchesSince = (since: number): { seq: number; patches: unknown[]; resync?: true } => {
    // A new guest starts from now; its `mounted` intent brings the whole state.
    if (since < 0) return { seq, patches: [] };
    // One behind the kept log starts from now too, and is told to ask for the whole state again.
    const oldest = log[0]?.seq ?? seq + 1;
    if (since < oldest - 1) return { seq, patches: [], resync: true };
    return { seq, patches: log.filter((entry) => entry.seq > since).map((entry) => entry.patch) };
  };

  const overlay = await injectOverlay(options.cdp, {
    id: `vibewaiting-${options.ns}`,
    content: {
      kind: "iframe",
      srcdoc: options.html,
      title: options.title ?? options.launcherLabel,
      ready: "bridge",
      sandbox: [
        "allow-scripts",
        "allow-same-origin",
        "allow-popups",
        "allow-popups-to-escape-sandbox",
        "allow-top-navigation-by-user-activation",
      ],
    },
    viewport: {
      width: options.viewport?.width ?? 390,
      height: options.viewport?.height ?? 667,
      gutter: options.viewport?.gutter ?? 16,
    },
    placement: options.placement ?? "bottom-end",
    ...(options.presentations ? { presentations: options.presentations } : {}),
    ...(options.initialPresentation ? { initialPresentation: options.initialPresentation } : {}),
    launcher: {
      label: options.launcherLabel,
      ...(options.launcherIcon ? { icon: options.launcherIcon } : {}),
      hidden: options.launcherHidden ?? false,
    },
    initiallyOpen: options.initiallyOpen ?? false,
    lazy: false,
    ...(options.theme ? { theme: options.theme } : {}),
    capabilities: {
      [PATCHES_CAPABILITY]: async (payload) => {
        const raw = Number((payload as PatchRequest | undefined)?.since);
        const since = Number.isInteger(raw) ? raw : -1;
        if (since < 0 || seq > since) return patchesSince(since);
        await new Promise<void>((resolve) => {
          const done = (): void => {
            clearTimeout(timeout);
            resolve();
          };
          const timeout = setTimeout(() => {
            waiters = waiters.filter((waiter) => waiter !== done);
            resolve();
          }, LONG_POLL_MS);
          waiters.push(done);
        });
        return patchesSince(since);
      },
      [INTENT_CAPABILITY]: async (payload) => {
        const request = (payload ?? {}) as IntentRequest;
        if (typeof request.name !== "string") throw new Error("An intent needs a name");
        const intent: WidgetIntent = {
          id: typeof request.id === "string" || typeof request.id === "number" ? request.id : `${Date.now()}`,
          payload: request.payload,
          ...(request.source === "local" || request.source === "remote" ? { source: request.source } : {}),
        };
        await Promise.all([...(listeners.get(request.name) ?? [])].map(async (listener) => await listener(intent)));
        return { accepted: intent.id };
      },
    },
  });

  return {
    async push(patch: unknown): Promise<void> {
      seq += 1;
      log.push({ seq, patch });
      if (log.length > PATCH_LOG) log.splice(0, log.length - PATCH_LOG);
      const woken = waiters;
      waiters = [];
      for (const wake of woken) wake();
    },
    onIntent(name, cb): void {
      const set = listeners.get(name) ?? new Set();
      set.add(cb);
      listeners.set(name, set);
    },
    every(ms, fn): () => void {
      const timer = setInterval(() => {
        try {
          void Promise.resolve(fn()).catch(() => undefined);
        } catch {
          // A tick that throws must not stop the next one.
        }
      }, ms);
      timers.add(timer);
      return () => {
        clearInterval(timer);
        timers.delete(timer);
      };
    },
    async remove(): Promise<void> {
      for (const timer of timers) clearInterval(timer);
      timers.clear();
      const woken = waiters;
      waiters = [];
      for (const wake of woken) wake();
      await overlay.remove();
    },
  };
}
