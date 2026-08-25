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
import { createRemoteAccessCompanion } from "./remote-access-companion.js";

interface VibewaitingContentGlobal {
  __vibewaitingContentMounted?: boolean;
}

const contentGlobal = globalThis as VibewaitingContentGlobal;
if (!contentGlobal.__vibewaitingContentMounted) {
  contentGlobal.__vibewaitingContentMounted = true;
  mountVibewaitingContent();
}

function mountVibewaitingContent(): void {
let port: ReturnType<typeof chrome.runtime.connect> | undefined;
const remoteAccess = createRemoteAccessCompanion({
  configure(configuration) {
    port?.postMessage({ type: "remote-access-configure", configuration });
  },
  requestPairing() {
    port?.postMessage({ type: "remote-access-pairing-request" });
  },
  revokeDevices() {
    port?.postMessage({ type: "remote-access-revoke-request" });
  },
});

const overlay = createOverlay({
  id: "vibewaiting",
  content: createExtensionIframeContent(chrome.runtime, "app.html", {
    title: "Vibewaiting agent chats",
  }),
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

overlay.mount();
const unsubscribe = overlay.subscribe((state) => {
  if (state.phase === "closed") remoteAccess.close();
});
const contentPort = chrome.runtime.connect({ name: "vibewaiting:content" });
port = contentPort;
let destroyed = false;
const destroy = (): void => {
  if (destroyed) return;
  destroyed = true;
  contentGlobal.__vibewaitingContentMounted = false;
  unsubscribe();
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
  if (message.type === "remote-access") {
    remoteAccess.update(
      message.snapshot,
      message.passcode,
      message.pairing,
      message.devices,
    );
    return;
  }
  if (message.type === "launcher") {
    const harness = typeof message.harness === "string" ? message.harness : "";
    const icon = harnessLogoDataUrl(harness);
    overlay.setLauncher({
      label:
        `${typeof message.label === "string" ? message.label : "Open agent chats"} · ${browserShortcutLabel("focus")}`,
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
    message.command !== "focus-composer" &&
      message.command !== "attach-browser-context" &&
      message.command !== "previous-conversation" &&
      message.command !== "next-conversation"
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

window.addEventListener(
  "pagehide",
  destroy,
  { once: true },
);
}
