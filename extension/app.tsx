import { connectOverlayApp } from "@volter-ai-dev/widget-shell/frame";
import { TerminalPanel } from "@volter-ai-dev/supercode-terminal/ui";
import type { JSX } from "preact";
import {
  parseBrowserContextAttachments,
  type BrowserContextAction,
  type BrowserContextAttachment,
} from "../src/browser-context.js";
import { mountMessenger } from "../widget/messenger.js";
import type { TerminalPanelProps } from "../widget/messenger.js";
import type {
  MessengerHostEvent,
  MessengerTransport,
} from "../widget/transport.js";

function LocalTerminalPanel({
  state,
  send,
  onClose,
}: TerminalPanelProps): JSX.Element {
  return (
    <TerminalPanel
      state={state}
      createActions={[
        { id: "claude-code", label: "New Claude Code" },
        { id: "codex", label: "New Codex" },
      ]}
      onClose={onClose}
      onRefresh={() => send({ action: "terminalRefresh" })}
      onCreate={(harness) => {
        if (harness !== "claude-code" && harness !== "codex") return;
        return send({ action: "terminalCreate", harness });
      }}
      onAttach={(sessionId, mode) =>
        send({ action: "terminalAttach", sessionId, mode })
      }
      onStop={(sessionId) => send({ action: "terminalClose", sessionId })}
      onOpen={(sessionId) =>
        send({ action: "terminalOpenLocal", sessionId })
      }
      onDismiss={() => send({ action: "terminalDismiss" })}
    />
  );
}

const shell = connectOverlayApp();
const port = chrome.runtime.connect({ name: "vibewaiting:guest" });
const patchListeners = new Set<(patch: unknown) => void>();
const hostEventListeners = new Set<(event: MessengerHostEvent) => void>();
const pendingHostEvents: MessengerHostEvent[] = [];
const browserRequests = new Map<
  string,
  {
    resolve(value: BrowserContextAttachment[] | null): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
let sequence = 0;
const clientId = crypto.randomUUID();

port.onMessage.addListener((raw) => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
  const message = raw as Record<string, unknown>;
  if (message.type === "patch") {
    for (const listener of patchListeners) listener(message.patch);
    return;
  }
  if (
    message.type === "browser-context-response" &&
    typeof message.id === "string"
  ) {
    const pending = browserRequests.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    browserRequests.delete(message.id);
    if (message.ok !== true) {
      pending.reject(
        new Error(
          typeof message.error === "string" && message.error
            ? message.error
            : "Could not capture browser context.",
        ),
      );
      return;
    }
    if (message.attachments === null) {
      pending.resolve(null);
      return;
    }
    const attachments = parseBrowserContextAttachments(message.attachments);
    if (!attachments) {
      pending.reject(new Error("The extension returned invalid browser context."));
      return;
    }
    pending.resolve(attachments);
    return;
  }
  if (message.type !== "host-event" || !isHostEvent(message.event)) return;
  if (!hostEventListeners.size) {
    pendingHostEvents.push(message.event);
    if (pendingHostEvents.length > 8) pendingHostEvents.shift();
    return;
  }
  for (const listener of hostEventListeners) listener(message.event);
});

function isHostEvent(value: unknown): value is MessengerHostEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type !== "shortcut" ||
    typeof candidate.id !== "string" ||
    candidate.command !== "focus-composer" &&
      candidate.command !== "attach-browser-context" &&
      candidate.command !== "previous-conversation" &&
      candidate.command !== "next-conversation"
  )
    return false;
  if (candidate.attachment === undefined) return true;
  return parseBrowserContextAttachments([candidate.attachment]) !== null;
}

const transport: MessengerTransport = {
  sendIntent(_name, payload) {
    const id = `${clientId}:${++sequence}`;
    port.postMessage({ type: "intent", id, payload });
    return id;
  },
  onPatch(listener) {
    patchListeners.add(listener);
    return () => patchListeners.delete(listener);
  },
  onVisibility: shell.onVisibility,
  requestBrowserContext(action: BrowserContextAction) {
    const id = `${clientId}:browser:${++sequence}`;
    return new Promise<BrowserContextAttachment[] | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        browserRequests.delete(id);
        reject(new Error("Browser context capture timed out."));
      }, 120_000);
      browserRequests.set(id, { resolve, reject, timer });
      port.postMessage({ type: "browser-context-request", id, action });
    });
  },
  onHostEvent(listener) {
    hostEventListeners.add(listener);
    for (const event of pendingHostEvents.splice(0)) listener(event);
    return () => hostEventListeners.delete(listener);
  },
  setLauncher: shell.setLauncher,
  closeShell: shell.close,
  destroy() {
    patchListeners.clear();
    hostEventListeners.clear();
    for (const [id, pending] of browserRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The page closed before context capture finished."));
      browserRequests.delete(id);
    }
    port.disconnect();
    shell.destroy();
  },
};

mountMessenger(transport, {
  TerminalPanel: LocalTerminalPanel,
  requestPresentation: async (name) => {
    await shell.requestPresentation(name);
  },
  reportContentSize: async (size) => {
    await shell.reportContentSize(size);
  },
});
