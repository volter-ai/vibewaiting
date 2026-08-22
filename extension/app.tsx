import { connectOverlayApp } from "@volter-ai-dev/widget-shell/frame";
import { mountMessenger } from "../widget/messenger.js";
import type { MessengerTransport } from "../widget/transport.js";
import { TerminalPanel } from "./terminal-panel.js";

const shell = connectOverlayApp();
const port = chrome.runtime.connect({ name: "vibewaiting:guest" });
const patchListeners = new Set<(patch: unknown) => void>();
let sequence = 0;
const clientId = crypto.randomUUID();

port.onMessage.addListener((raw) => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
  const message = raw as Record<string, unknown>;
  if (message.type !== "patch") return;
  for (const listener of patchListeners) listener(message.patch);
});

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
  setLauncher: shell.setLauncher,
  closeShell: shell.close,
  destroy() {
    patchListeners.clear();
    port.disconnect();
    shell.destroy();
  },
};

mountMessenger(transport, { TerminalPanel });
