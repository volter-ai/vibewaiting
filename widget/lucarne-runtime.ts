// The page runtime vibewaiting delivers through Lucarne: its WidgetHost injects it (as a string
// createLucarneInjector builds) and it mounts Widget Shell's overlay around the widget.
import { createOverlay, type OverlayController, type OverlayPresentation, type OverlayTheme } from "@volter/widget-shell";

interface Bootstrap {
  readonly ns: string;
  readonly html: string;
  readonly revision: string;
  readonly hostId: string;
  readonly iframeGlobal: string;
  readonly guardGlobal: string;
  readonly disposeGlobal: string;
  readonly chromeKey: string;
  readonly intentQueuePrefix: string;
  readonly overlay: {
    readonly id: string;
    readonly title: string;
    readonly launcherLabel: string;
    readonly launcherIcon?: string;
    readonly launcherHidden: boolean;
    readonly initiallyOpen: boolean;
    readonly width: number;
    readonly height: number;
    readonly gutter: number;
    readonly placement: "bottom-start" | "bottom-end" | "top-start" | "top-end";
    readonly presentation?: OverlayPresentation;
    readonly presentations?: Readonly<Record<string, OverlayPresentation>>;
    readonly initialPresentation?: string;
    readonly theme?: OverlayTheme;
  };
}

declare global {
  interface Window {
    __widgetShellLucarneBootstrap__?: Bootstrap;
  }
}

const bootstrap = window.__widgetShellLucarneBootstrap__;
delete window.__widgetShellLucarneBootstrap__;

if (bootstrap) {
  try {
    if (window.top === window.self) mount(bootstrap);
  } catch {
    // Cross-origin access means this is a child frame. Lucarne widgets mount only in the top frame.
  }
}

function mount(config: Bootstrap): void {
  const page = window as unknown as Window & Record<string, unknown>;
  const current = document.getElementById(config.hostId);
  if (current?.dataset.widgetShellRevision === config.revision) {
    const frame = current.shadowRoot?.querySelector("iframe");
    if (frame) page[config.iframeGlobal] = frame;
    return;
  }

  const previousDispose = page[config.disposeGlobal];
  if (typeof previousDispose === "function") {
    try {
      previousDispose();
    } catch {
      // A stale shell must not prevent its replacement.
    }
  }

  let controller: OverlayController | undefined;
  let messageListener: ((event: MessageEvent) => void) | undefined;
  let unsubscribeState: (() => void) | undefined;
  let guard: MutationObserver | undefined;
  let disposed = false;

  function pageTheme(): "light" | "dark" {
    try {
      return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch {
      return "light";
    }
  }

  const pageOrigin = window.location.origin;
  const targetOrigin = pageOrigin === "null" ? "*" : pageOrigin;

  function disposeOverlay(): void {
    unsubscribeState?.();
    unsubscribeState = undefined;
    if (messageListener) window.removeEventListener("message", messageListener);
    messageListener = undefined;
    controller?.destroy();
    controller = undefined;
    page[config.iframeGlobal] = null;
  }

  function mountOverlay(): void {
    if (disposed || !document.body) return;
    disposeOverlay();
    controller = createOverlay({
      id: config.overlay.id,
      content: {
        kind: "iframe",
        srcdoc: config.html,
        title: config.overlay.title,
        allowedOrigin: pageOrigin,
        ready: "load",
        sandbox: [
          "allow-scripts",
          "allow-same-origin",
          "allow-popups",
          "allow-popups-to-escape-sandbox",
          "allow-top-navigation-by-user-activation",
        ],
      },
      viewport: {
        width: config.overlay.width,
        height: config.overlay.height,
        gutter: config.overlay.gutter,
      },
      placement: config.overlay.placement,
      ...(config.overlay.presentation ? { presentation: config.overlay.presentation } : {}),
      ...(config.overlay.presentations ? { presentations: config.overlay.presentations } : {}),
      ...(config.overlay.initialPresentation
        ? { initialPresentation: config.overlay.initialPresentation }
        : {}),
      launcher: {
        label: config.overlay.launcherLabel,
        ...(config.overlay.launcherIcon ? { icon: config.overlay.launcherIcon } : {}),
        hidden: config.overlay.launcherHidden,
      },
      initiallyOpen: config.overlay.initiallyOpen,
      lazy: false,
      ...(config.overlay.theme ? { theme: config.overlay.theme } : {}),
    });
    controller.mount();

    const host = document.querySelector<HTMLElement>(
      `[data-widget-shell-id="${CSS.escape(config.overlay.id)}"]`,
    );
    if (!host || !controller.frame) {
      controller.destroy();
      controller = undefined;
      return;
    }
    host.id = config.hostId;
    host.dataset.widgetShellRevision = config.revision;
    page[config.iframeGlobal] = controller.frame;

    const sendVisibility = (): void => {
      const state = controller?.state;
      const visible = state?.phase === "opening" || state?.phase === "open";
      controller?.frame?.contentWindow?.postMessage(
        { [config.chromeKey]: { action: "visibility", visible } },
        targetOrigin,
      );
    };

    messageListener = (event: MessageEvent): void => {
      const frame = controller?.frame;
      if (!frame || event.source !== frame.contentWindow || event.origin !== pageOrigin) return;
      const envelope = event.data as Record<string, unknown> | null;
      const message = envelope?.[config.chromeKey] as Record<string, unknown> | undefined;
      if (!message || typeof message !== "object") return;

      if (message.action === "ready") {
        frame.contentWindow?.postMessage({ theme: pageTheme() }, targetOrigin);
        sendVisibility();
        return;
      }
      if (message.action === "resize") {
        frame.contentWindow?.postMessage(
          {
            [config.chromeKey]: {
              action: "sizeAck",
              w: message.w,
              h: message.h,
            },
          },
          targetOrigin,
        );
        return;
      }
      if (message.action === "launcher") {
        const badge = message.badge;
        if (badge === null || typeof badge === "string" || typeof badge === "number") {
          controller?.setBadge(badge);
        }
        const label = message.label;
        const icon = message.icon;
        const hidden = message.hidden;
        controller?.setLauncher({
          ...(typeof label === "string" && label ? { label } : {}),
          ...(icon === null || typeof icon === "string" ? { icon } : {}),
          ...(typeof hidden === "boolean" ? { hidden } : {}),
        });
        return;
      }
      if (message.action === "close") {
        controller?.close();
        return;
      }
      if (message.action !== "intent" || typeof message.name !== "string" || !message.name) return;
      const queueName = `${config.intentQueuePrefix}${message.name}`;
      const queue = Array.isArray(page[queueName]) ? (page[queueName] as unknown[]) : [];
      queue.push({ id: message.id, payload: message.payload });
      page[queueName] = queue;
    };
    window.addEventListener("message", messageListener);
    unsubscribeState = controller.subscribe(sendVisibility);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    guard?.disconnect();
    guard = undefined;
    disposeOverlay();
    page[config.guardGlobal] = null;
    page[config.disposeGlobal] = null;
  }

  page[config.disposeGlobal] = dispose;
  mountOverlay();
  guard = new MutationObserver(() => {
    if (disposed) return;
    const host = document.getElementById(config.hostId);
    if (!host?.isConnected) mountOverlay();
    else if (controller?.frame) page[config.iframeGlobal] = controller.frame;
  });
  guard.observe(document.documentElement, { childList: true, subtree: true });
  page[config.guardGlobal] = guard;
}
