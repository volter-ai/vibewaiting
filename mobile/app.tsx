import { mountMessenger } from "../widget/messenger.js";
import { TerminalViewer } from "@volter-ai-dev/supercode-terminal/ui";
import type { JSX } from "preact";
import { useRef } from "preact/hooks";
import type { MessengerTransport } from "../widget/transport.js";
import type { TerminalPanelProps } from "../widget/messenger.js";

function MobileTerminalPanel({ state, send }: TerminalPanelProps): JSX.Element {
  if (!state.attachment) throw new Error("Terminal mode requires an attachment.");
  const attachment = state.attachment;
  const surface = useRef<HTMLElement>(null);
  const terminalInput = (): HTMLTextAreaElement | null =>
    surface.current?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea") ?? null;
  const focusTerminal = (): void => terminalInput()?.focus({ preventScroll: true });
  const pressTerminalKey = (
    key: string,
    code: string,
    modifiers: Pick<KeyboardEventInit, "ctrlKey"> = {},
  ): void => {
    const input = terminalInput();
    if (!input) return;
    for (const type of ["keydown", "keyup"])
      input.dispatchEvent(
        new KeyboardEvent(type, {
          ...modifiers,
          key,
          code,
          bubbles: true,
          cancelable: true,
        }),
      );
  };
  return (
    <section ref={surface} class="vw-terminal-surface" aria-label="Terminal view">
      <TerminalViewer
        active
        attachment={attachment}
        onRetry={() => send({ action: "terminalAttach", mode: attachment.mode, sessionId: attachment.sessionId })}
      />
      {attachment.mode === "control" ? (
        <nav
          class="vw-mobile-terminal-keys"
          aria-label="Terminal keys"
          onPointerDown={(event) => event.preventDefault()}
        >
          <button type="button" aria-label="Show keyboard" onClick={focusTerminal}>Keyboard</button>
          <button type="button" onClick={() => pressTerminalKey("Escape", "Escape")}>Esc</button>
          <button type="button" onClick={() => pressTerminalKey("Tab", "Tab")}>Tab</button>
          <button type="button" aria-label="Arrow left" onClick={() => pressTerminalKey("ArrowLeft", "ArrowLeft")}>←</button>
          <button type="button" aria-label="Arrow up" onClick={() => pressTerminalKey("ArrowUp", "ArrowUp")}>↑</button>
          <button type="button" aria-label="Arrow down" onClick={() => pressTerminalKey("ArrowDown", "ArrowDown")}>↓</button>
          <button type="button" aria-label="Arrow right" onClick={() => pressTerminalKey("ArrowRight", "ArrowRight")}>→</button>
          <button type="button" aria-label="Control C" onClick={() => pressTerminalKey("c", "KeyC", { ctrlKey: true })}>^C</button>
        </nav>
      ) : null}
    </section>
  );
}

const patchListeners = new Set<(patch: unknown) => void>();
const visibilityListeners = new Set<(visible: boolean) => void>();
const pending: string[] = [];
let socket: WebSocket | null = null;
let sequence = 0;
let retry = 0;
let retryTimer: number | undefined;
let destroyed = false;
let connectedOnce = false;
const clientId = crypto.randomUUID();
const connectionStatus = document.querySelector<HTMLElement>("#connection-status");

function setConnectionStatus(state: "connected" | "offline" | "reconnecting"): void {
  if (!connectionStatus) return;
  connectionStatus.dataset.state = state;
  connectionStatus.hidden = state === "connected" || (!connectedOnce && state === "reconnecting");
  connectionStatus.textContent = state === "offline" ? "Waiting for network" : "Reconnecting…";
}

function clearRetry(): void {
  if (retryTimer === undefined) return;
  window.clearTimeout(retryTimer);
  retryTimer = undefined;
}

function scheduleReconnect(): void {
  clearRetry();
  if (destroyed || document.visibilityState !== "visible") return;
  if (!navigator.onLine) {
    setConnectionStatus("offline");
    return;
  }
  setConnectionStatus("reconnecting");
  const delay = Math.min(10_000, 400 * 2 ** retry++);
  retryTimer = window.setTimeout(() => {
    retryTimer = undefined;
    connect();
  }, delay);
}

function connect(): void {
  if (
    destroyed ||
    document.visibilityState !== "visible" ||
    socket?.readyState === WebSocket.OPEN ||
    socket?.readyState === WebSocket.CONNECTING
  ) return;
  clearRetry();
  if (!navigator.onLine) {
    setConnectionStatus("offline");
    return;
  }
  if (connectedOnce) setConnectionStatus("reconnecting");
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const next = new WebSocket(`${protocol}//${location.host}/ws`);
  socket = next;
  next.addEventListener("open", () => {
    if (socket !== next) return;
    retry = 0;
    connectedOnce = true;
    setConnectionStatus("connected");
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
    scheduleReconnect();
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
    destroyed = true;
    clearRetry();
    socket?.close();
    socket = null;
    patchListeners.clear();
    visibilityListeners.clear();
  },
};

document.addEventListener("visibilitychange", () => {
  const visible = document.visibilityState === "visible";
  for (const listener of visibilityListeners) listener(visible);
  if (visible && socket?.readyState !== WebSocket.OPEN) connect();
  else if (!visible) clearRetry();
});

window.addEventListener("online", () => {
  if (socket?.readyState === WebSocket.OPEN) setConnectionStatus("connected");
  else connect();
});
window.addEventListener("offline", () => setConnectionStatus("offline"));
window.addEventListener("pageshow", () => connect());

function syncViewport(): void {
  const viewport = window.visualViewport;
  document.documentElement.style.setProperty(
    "--vw-mobile-height",
    `${Math.round(viewport?.height ?? window.innerHeight)}px`,
  );
  document.documentElement.style.setProperty(
    "--vw-mobile-offset",
    `${Math.round(viewport?.offsetTop ?? 0)}px`,
  );
}

syncViewport();
window.addEventListener("resize", syncViewport);
window.visualViewport?.addEventListener("resize", syncViewport);
window.visualViewport?.addEventListener("scroll", syncViewport);

if ("serviceWorker" in navigator && window.isSecureContext)
  void navigator.serviceWorker.register("/service-worker.js", { scope: "/" }).catch(() => undefined);

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
