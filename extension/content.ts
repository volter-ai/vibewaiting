import { harnessLogoDataUrl } from "@volter-ai-dev/supercode-ui/preact/logo";
import {
  createExtensionGeometryPersistence,
  createExtensionIframeContent,
  createOverlay,
} from "@volter-ai-dev/widget-shell";
import {
  VIBEWAITING_PRESENTATION,
  VIBEWAITING_PRESENTATIONS,
} from "../src/presentations.js";
import { VIBEWAITING_RADIUS } from "../src/theme.js";
import {
  captureBrowserContext,
  captureLinkAttachment,
  captureShortcutAttachments,
} from "./browser-context.js";
import { browserShortcutLabel } from "../src/browser-shortcuts.js";
import { createRemoteAccessLauncher } from "./remote-access-companion.js";

/** Tells the page's main-world surface (surface.ts) which port reaches the Playwright host. */
const SURFACE_MESSAGE = "vibewaiting:almostcdp-surface";

interface VibewaitingContentGlobal {
  __vibewaitingContentMounted?: boolean;
}

const contentGlobal = globalThis as VibewaitingContentGlobal;
if (!contentGlobal.__vibewaitingContentMounted) {
  contentGlobal.__vibewaitingContentMounted = true;
  mountVibewaitingContent();
}

function mountVibewaitingContent(): void {
  const contentPort = chrome.runtime.connect({ name: "vibewaiting:content" });
  // The agent's browser operations reach this page through the extension's
  // Playwright host (offscreen.ts) and the main-world AlmostCDP surface; this
  // script only relays the surface's port, once the background asks for it.
  let surfacePort: ExtensionPort | null = null;
  const connectSurface = (): void => {
    if (surfacePort) return;
    const host = chrome.runtime.connect({ name: "vibewaiting:surface" });
    surfacePort = host;
    const channel = new MessageChannel();
    host.onMessage.addListener((raw) => {
      const message = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : null;
      if (message?.type === "hello" && typeof message.id === "string" && typeof message.token === "string") {
        window.postMessage({ type: SURFACE_MESSAGE, id: message.id, token: message.token }, "*", [channel.port2]);
        return;
      }
      if (message?.type === "data" || message?.type === "close") channel.port1.postMessage(message);
    });
    channel.port1.onmessage = (event) => {
      try { host.postMessage(event.data); } catch { /* The host went away; its disconnect follows. */ }
    };
    host.onDisconnect.addListener(() => {
      channel.port1.postMessage({ type: "close" });
      channel.port1.close();
      if (surfacePort === host) surfacePort = null;
    });
  };
  const remoteAccess = createRemoteAccessLauncher({
    open() {
      overlay.open();
      contentPort.postMessage({ type: "remote-access-open" });
    },
  });

  const overlay = createOverlay({
    id: "vibewaiting",
    content: {
      ...createExtensionIframeContent(chrome.runtime, "app.html", {
        title: "Vibewaiting agent chats",
      }),
      // The frame loads from the per-session dynamic URL, but its document's
      // origin is the extension's own: the overlay's handshake must address
      // that origin, or the messenger never becomes ready (fixed in
      // widget-shell 0.5.2, which Vibewaiting does not use yet).
      allowedOrigin: `chrome-extension://${chrome.runtime.id}`,
    },
    presentations: VIBEWAITING_PRESENTATIONS,
    initialPresentation: VIBEWAITING_PRESENTATION.messenger,
    launcher: {
      label: "Open agent chats",
      hidden: true,
      companion: () => remoteAccess.node,
    },
    behavior: {
      persistence: createExtensionGeometryPersistence(chrome.storage.local),
    },
    theme: { radius: VIBEWAITING_RADIUS, surface: "transparent" },
  });

  let destroyed = false;
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    contentGlobal.__vibewaitingContentMounted = false;
    surfacePort?.disconnect();
    remoteAccess.destroy();
    contentPort.disconnect();
    overlay.destroy();
  };
  contentPort.onMessage.addListener((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
    const message = raw as Record<string, unknown>;
    if (message.type === "site-access-revoked") {
      destroy();
      return;
    }
    if (message.type === "browser-approval-open") {
      // An agent's action waits for the person: the messenger shows the approval card.
      overlay.open();
      return;
    }
    if (message.type === "surface-connect") {
      connectSurface();
      return;
    }
    if (message.type === "remote-access-status") {
      remoteAccess.update(message.status);
      return;
    }
    if (message.type === "launcher") {
      const harness =
        typeof message.harness === "string" ? message.harness : "";
      const icon = harnessLogoDataUrl(harness);
      overlay.setLauncher({
        label: `${typeof message.label === "string" ? message.label : "Open agent chats"} · ${browserShortcutLabel("focus")}`,
        icon,
        hidden: message.hidden === true || icon === null,
      });
      overlay.setBadge(
        typeof message.badge === "number" ? message.badge : null,
        message.badgeTone === "neutral" ? "neutral" : "attention",
      );
      return;
    }
    if (
      message.type === "browser-context-request" &&
      typeof message.id === "string" &&
      message.action === "candidates"
    ) {
      try {
        contentPort.postMessage({
          type: "browser-context-response",
          id: message.id,
          ok: true,
          attachments: captureBrowserContext(),
        });
      } catch (error) {
        contentPort.postMessage({
          type: "browser-context-response",
          id: message.id,
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "Could not capture browser context.",
        });
      }
      return;
    }
    if (
      message.type === "browser-context-menu" &&
      message.action === "link" &&
      typeof message.id === "string" &&
      typeof message.targetUrl === "string"
    ) {
      try {
        overlay.open();
        const attachment = captureLinkAttachment(message.targetUrl);
        requestAnimationFrame(() =>
          contentPort.postMessage({
            type: "browser-shortcut-result",
            id: message.id,
            command: "attach-browser-context",
            attachments: [attachment],
          }),
        );
      } catch {
        overlay.open();
      }
      return;
    }
    if (
      message.type !== "browser-shortcut" ||
      typeof message.id !== "string" ||
      (message.command !== "focus-composer" &&
        message.command !== "attach-browser-context" &&
        message.command !== "previous-conversation" &&
        message.command !== "next-conversation")
    )
      return;
    const id = message.id;
    const command = message.command;
    const finish = (attachments?: unknown): void => {
      overlay.open();
      requestAnimationFrame(() =>
        contentPort.postMessage({
          type: "browser-shortcut-result",
          id,
          command,
          ...(attachments ? { attachments } : {}),
        }),
      );
    };
    if (command !== "attach-browser-context") {
      finish();
      return;
    }
    try {
      finish(captureShortcutAttachments());
    } catch {
      finish();
    }
  });

  overlay.mount();
  keepShellChromeOffTheFrame();
  window.addEventListener("pagehide", destroy, { once: true });
}

/**
 * Widget Shell 0.4.1 draws its drag and resize handles over the messenger
 * frame's edges. Chrome then reports everything in the frame as occluded to
 * IntersectionObserver v2, and the approval card, which enables Approve only
 * once the browser confirms the card is visible, could never be approved.
 * The shell's window is lifted above its handles, whose grab areas stay
 * outside it (fixed in widget-shell 0.5.2).
 */
function keepShellChromeOffTheFrame(): void {
  const root = document.querySelector('[data-widget-shell-id="vibewaiting"]')?.shadowRoot;
  if (!root) return;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    .ws-window { z-index: 5; }
    .ws-drag-handle { top: -14px; }
    .ws-resize-handle[data-corner^="n"] { top: -12px; }
    .ws-resize-handle[data-corner^="s"] { bottom: -12px; }
    .ws-resize-handle[data-corner$="w"] { left: -12px; }
    .ws-resize-handle[data-corner$="e"] { right: -12px; }
  `);
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
}
