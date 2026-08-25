import { mountMessenger } from "../widget/messenger.js";
import { TerminalViewer } from "@volter-ai-dev/supercode-terminal/ui";
import type { JSX } from "preact";
import type { MessengerTransport } from "../widget/transport.js";
import type { TerminalPanelProps } from "../widget/messenger.js";

function MobileTerminalPanel({ state, send }: TerminalPanelProps): JSX.Element {
  if (!state.attachment) throw new Error("Terminal mode requires an attachment.");
  const attachment = state.attachment;
  return (
    <section class="vw-terminal-surface" aria-label="Terminal view">
      <TerminalViewer
        active
        attachment={attachment}
        onRetry={() => send({ action: "terminalAttach", mode: attachment.mode, sessionId: attachment.sessionId })}
      />
    </section>
  );
}

const patchListeners = new Set<(patch: unknown) => void>();
const visibilityListeners = new Set<(visible: boolean) => void>();
const pending: string[] = [];
let socket: WebSocket | null = null;
let sequence = 0;
let retry = 0;
const clientId = crypto.randomUUID();

function connect(): void {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const next = new WebSocket(`${protocol}//${location.host}/ws`);
  socket = next;
  next.addEventListener("open", () => {
    retry = 0;
    for (const message of pending.splice(0)) next.send(message);
  });
  next.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (message.type === "patch") {
        const patch = withSameOriginTerminal(message.patch);
        for (const listener of patchListeners) listener(patch);
      }
    } catch {
      // A malformed server frame cannot mutate the messenger.
    }
  });
  next.addEventListener("close", (event) => {
    if (socket !== next) return;
    socket = null;
    if (event.code === 4001) {
      location.replace("/");
      return;
    }
    const delay = Math.min(10_000, 400 * 2 ** retry++);
    window.setTimeout(connect, delay);
  });
}

function send(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (socket?.readyState === WebSocket.OPEN) socket.send(serialized);
  else {
    pending.push(serialized);
    if (pending.length > 100) pending.shift();
  }
}

const transport: MessengerTransport = {
  sendIntent(_name, payload) {
    const id = `${clientId}:${++sequence}`;
    send({ id, payload });
    return id;
  },
  onPatch(listener) {
    patchListeners.add(listener);
    return () => patchListeners.delete(listener);
  },
  onVisibility(listener) {
    visibilityListeners.add(listener);
    listener(document.visibilityState === "visible");
    return () => visibilityListeners.delete(listener);
  },
  setLauncher() {},
  closeShell() {},
  destroy() {
    socket?.close();
    socket = null;
    patchListeners.clear();
    visibilityListeners.clear();
  },
};

document.addEventListener("visibilitychange", () => {
  const visible = document.visibilityState === "visible";
  for (const listener of visibilityListeners) listener(visible);
});

connect();
mountMessenger(transport, {
  TerminalPanel: MobileTerminalPanel,
  closable: false,
  requestPresentation: async () => undefined,
});

function withSameOriginTerminal(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const root = value as Record<string, unknown>;
  const host = root.terminalHost;
  if (typeof host !== "object" || host === null || Array.isArray(host)) return value;
  const attachment = (host as Record<string, unknown>).attachment;
  if (typeof attachment !== "object" || attachment === null || Array.isArray(attachment)) return value;
  return {
    ...root,
    terminalHost: {
      ...host,
      attachment: { ...attachment, baseUrl: location.origin },
    },
  };
}
