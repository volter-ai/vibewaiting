import { connectOverlayApp } from "@volter-ai-dev/widget-shell/frame";
import { TerminalPanel } from "@volter-ai-dev/supercode-terminal/ui";
import type { JSX } from "preact";
import { mountMessenger } from "../widget/messenger.js";
import type { TerminalPanelProps } from "../widget/messenger.js";
import type { MessengerTransport } from "../widget/transport.js";

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

mountMessenger(transport, { TerminalPanel: LocalTerminalPanel });
