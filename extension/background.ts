import {
  type ExtensionSettings,
  NATIVE_HOST_NAME,
  type NativeHostEvent,
  VIBEWAITING_EXTENSION_PROTOCOL,
} from "../src/extension-protocol.js";

const SETTINGS_KEY = "vibewaiting:settings";
const contentPorts = new Set<ExtensionPort>();
const guestPorts = new Map<ExtensionPort, { id: string; visible: boolean }>();
const optionsPorts = new Set<ExtensionPort>();
const pendingIntents: Array<{ id: string; payload: unknown }> = [];
const chunks = new Map<string, { total: number; parts: string[] }>();
let nativePort: ExtensionPort | null = null;
let nativeReady = false;
let nativeConnecting: Promise<void> | null = null;
let lastPatch: unknown;
let lastStatus: { phase: string; message?: string } = { phase: "stopped" };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function launcherFromPatch(patch: unknown): {
  harness: string;
  label: string;
  badge: number;
  hidden: boolean;
} {
  const state = record(patch);
  const attached = record(state?.attached);
  const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
  const active = sessions
    .map(record)
    .find((session) => session?.active === true);
  const harness =
    typeof attached?.harness === "string"
      ? attached.harness
      : typeof state?.harness === "string"
        ? state.harness
        : typeof active?.harness === "string"
          ? active.harness
          : "";
  const pill = record(state?.pill);
  const pillLabel = typeof pill?.label === "string" ? pill.label : "";
  const attentionKeys = new Set(
    (Array.isArray(state?.attention) ? state.attention : [])
      .map(record)
      .map((item) => item?.key)
      .filter((key): key is string => typeof key === "string"),
  );
  if (state?.needsInput === true) {
    const owned = record(state?.owned);
    attentionKeys.add(
      typeof attached?.key === "string"
        ? attached.key
        : typeof owned?.key === "string"
          ? owned.key
          : "@needs-input",
    );
  }
  return {
    harness,
    label: pillLabel ? `Open agent chats · ${pillLabel}` : "Open agent chats",
    badge: attentionKeys.size,
    hidden: !harness,
  };
}

function post(port: ExtensionPort, message: unknown): void {
  try {
    port.postMessage(message);
  } catch {
    contentPorts.delete(port);
    guestPorts.delete(port);
  }
}

function broadcastStatus(): void {
  for (const port of contentPorts)
    post(port, { type: "status", ...lastStatus });
  for (const port of guestPorts.keys())
    post(port, { type: "status", ...lastStatus });
  for (const port of optionsPorts)
    post(port, { type: "status", ...lastStatus });
  const badge =
    lastStatus.phase === "error"
      ? "!"
      : lastStatus.phase === "setup"
        ? "?"
        : lastStatus.phase === "starting"
          ? "…"
          : "";
  const color =
    lastStatus.phase === "error"
      ? "#c44141"
      : lastStatus.phase === "setup"
        ? "#a06b1f"
        : "#5757d9";
  const title =
    lastStatus.phase === "ready"
      ? "Vibewaiting · Connected"
      : lastStatus.phase === "starting"
        ? "Vibewaiting · Connecting"
        : lastStatus.message || "Vibewaiting settings";
  void chrome.action.setBadgeText({ text: badge }).catch(() => undefined);
  void chrome.action.setBadgeBackgroundColor({ color }).catch(() => undefined);
  void chrome.action.setTitle({ title }).catch(() => undefined);
}

function broadcastPatch(patch: unknown): void {
  const launcher = launcherFromPatch(patch);
  for (const port of contentPorts)
    post(port, { type: "launcher", ...launcher });
  for (const port of guestPorts.keys()) post(port, { type: "patch", patch });
}

function decodeChunkedEvent(message: NativeHostEvent): NativeHostEvent | null {
  if (message.type !== "chunk") return message;
  if (
    !Number.isInteger(message.index) ||
    !Number.isInteger(message.total) ||
    message.total < 1 ||
    message.total > 100 ||
    message.index < 0 ||
    message.index >= message.total ||
    typeof message.data !== "string" ||
    message.data.length > 600_000
  )
    return null;
  let entry = chunks.get(message.id);
  if (!entry) {
    if (chunks.size >= 4) chunks.delete(chunks.keys().next().value as string);
    entry = {
      total: message.total,
      parts: Array.from({ length: message.total }, () => ""),
    };
    chunks.set(message.id, entry);
  }
  if (entry.total !== message.total) {
    chunks.delete(message.id);
    return null;
  }
  entry.parts[message.index] = message.data;
  if (entry.parts.some((part) => !part)) return null;
  chunks.delete(message.id);
  const binary = atob(entry.parts.join(""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as NativeHostEvent;
}

function sendIntent(id: string, payload: unknown): void {
  if (!nativePort || !nativeReady) {
    pendingIntents.push({ id, payload });
    if (pendingIntents.length > 100) pendingIntents.shift();
    return;
  }
  nativePort.postMessage({
    protocol: VIBEWAITING_EXTENSION_PROTOCOL,
    type: "intent",
    id,
    payload,
  });
}

function flushIntents(): void {
  if (!nativePort || !nativeReady) return;
  for (const intent of pendingIntents.splice(0))
    sendIntent(intent.id, intent.payload);
}

function handleNativeMessage(raw: unknown): void {
  const candidate = record(raw) as NativeHostEvent | null;
  if (!candidate || candidate.protocol !== VIBEWAITING_EXTENSION_PROTOCOL)
    return;
  const message = decodeChunkedEvent(candidate);
  if (!message) return;
  if (message.type === "patch") {
    lastPatch = message.patch;
    broadcastPatch(message.patch);
    return;
  }
  if (message.type === "status") {
    nativeReady = message.phase === "ready";
    lastStatus = {
      phase: message.phase,
      ...(message.message ? { message: message.message } : {}),
    };
    broadcastStatus();
    if (nativeReady) flushIntents();
  }
}

async function settings(): Promise<ExtensionSettings | null> {
  const value = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
  const candidate = record(value);
  return candidate &&
    typeof candidate.workspace === "string" &&
    candidate.workspace.trim()
    ? (candidate as unknown as ExtensionSettings)
    : null;
}

async function ensureNative(): Promise<void> {
  if (nativePort || nativeConnecting)
    return await (nativeConnecting ?? Promise.resolve());
  nativeConnecting = (async () => {
    const configured = await settings();
    if (!configured) {
      lastStatus = {
        phase: "setup",
        message: "Choose a workspace in Vibewaiting extension settings.",
      };
      broadcastStatus();
      return;
    }
    try {
      const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
      nativePort = port;
      nativeReady = false;
      port.onMessage.addListener(handleNativeMessage);
      port.onDisconnect.addListener(() => {
        if (nativePort !== port) return;
        const detail = chrome.runtime.lastError?.message;
        nativePort = null;
        nativeReady = false;
        lastStatus = {
          phase: "error",
          message:
            detail ||
            `Run vibewaiting native install --extension-id ${chrome.runtime.id}`,
        };
        broadcastStatus();
      });
      port.postMessage({
        protocol: VIBEWAITING_EXTENSION_PROTOCOL,
        type: "start",
        settings: configured,
      });
    } catch (error) {
      nativePort = null;
      lastStatus = {
        phase: "error",
        message:
          error instanceof Error ? error.message : "Native host unavailable",
      };
      broadcastStatus();
    }
  })().finally(() => {
    nativeConnecting = null;
  });
  await nativeConnecting;
}

function visibleGuestCount(): number {
  let count = 0;
  for (const guest of guestPorts.values()) if (guest.visible) count += 1;
  return count;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "vibewaiting:options") {
    optionsPorts.add(port);
    post(port, { type: "status", ...lastStatus });
    port.onDisconnect.addListener(() => optionsPorts.delete(port));
    void ensureNative();
    return;
  }
  if (port.name === "vibewaiting:content") {
    contentPorts.add(port);
    if (lastPatch !== undefined)
      post(port, { type: "launcher", ...launcherFromPatch(lastPatch) });
    post(port, { type: "status", ...lastStatus });
    port.onDisconnect.addListener(() => contentPorts.delete(port));
    void ensureNative();
    return;
  }
  if (port.name !== "vibewaiting:guest") return;
  const guest = { id: crypto.randomUUID(), visible: false };
  guestPorts.set(port, guest);
  if (lastPatch !== undefined) post(port, { type: "patch", patch: lastPatch });
  post(port, { type: "status", ...lastStatus });
  port.onMessage.addListener((raw) => {
    const message = record(raw);
    if (message?.type !== "intent" || typeof message.id !== "string") return;
    const payload = record(message.payload);
    const action = payload?.action;
    if (action === "panelVisible" || action === "panelHidden") {
      const before = visibleGuestCount();
      guest.visible = action === "panelVisible";
      const after = visibleGuestCount();
      if ((before === 0 && after === 1) || (before === 1 && after === 0))
        sendIntent(message.id, message.payload);
      return;
    }
    sendIntent(message.id, message.payload);
  });
  port.onDisconnect.addListener(() => {
    const wasVisible = guest.visible;
    guestPorts.delete(port);
    if (wasVisible && visibleGuestCount() === 0)
      sendIntent(`${guest.id}:disconnect`, { action: "panelHidden" });
  });
  void ensureNative();
});

chrome.runtime.onMessage.addListener((raw) => {
  const message = record(raw);
  if (message?.type !== "settings-changed") return;
  const priorPort = nativePort;
  nativePort = null;
  priorPort?.disconnect();
  nativeReady = false;
  lastPatch = undefined;
  pendingIntents.length = 0;
  void ensureNative();
});

chrome.action.onClicked.addListener(
  () => void chrome.runtime.openOptionsPage(),
);
chrome.runtime.onInstalled.addListener(
  () => void chrome.runtime.openOptionsPage(),
);
