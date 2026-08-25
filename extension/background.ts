import {
  type ExtensionSettings,
  NATIVE_HOST_NAME,
  type NativeHostEvent,
  VIBEWAITING_EXTENSION_PROTOCOL,
} from "../src/extension-protocol.js";
import { parseRemoteAccessConfiguration } from "../src/extension-protocol.js";
import {
  parseBrowserContextAttachments,
} from "../src/browser-context.js";
import { VIBEWAITING_NEUTRAL } from "../src/theme.js";
import { launcherBadgeFromState, type LauncherBadgeTone } from "../src/launcher.js";

const SETTINGS_KEY = "vibewaiting:settings";
const ATTACH_LINK_MENU = "vibewaiting:attach-link";
const contentPorts = new Set<ExtensionPort>();
const contentPortsByTab = new Map<number, ExtensionPort>();
const guestPorts = new Map<
  ExtensionPort,
  { id: string; visible: boolean; tabId: number | null }
>();
const optionsPorts = new Set<ExtensionPort>();
const pendingBrowserRequests = new Map<
  string,
  { guest: ExtensionPort; tabId: number }
>();
const pendingHostEvents = new Map<number, unknown[]>();
const pendingIntents: Array<{ id: string; payload: unknown }> = [];
const chunks = new Map<string, { total: number; parts: string[] }>();
let nativePort: ExtensionPort | null = null;
let nativeReady = false;
let nativeConnecting: Promise<void> | null = null;
let lastPatch: unknown;
let lastStatus: { phase: string; message?: string } = { phase: "stopped" };
let lastRemoteAccess: { passcode: string; snapshot: unknown } | null = null;

function installContextMenus(): void {
  const options = {
    id: ATTACH_LINK_MENU,
    title: "Attach link to Vibewaiting",
    contexts: ["link"] as Array<"link">,
  };
  chrome.contextMenus.create(options, () => {
    if (!chrome.runtime.lastError) return;
    chrome.contextMenus.update(ATTACH_LINK_MENU, options, () => {
      void chrome.runtime.lastError;
    });
  });
}

installContextMenus();

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function senderTab(port: ExtensionPort): { tabId: number | null } {
  const tab = port.sender?.tab;
  return {
    tabId: Number.isInteger(tab?.id) ? tab!.id! : null,
  };
}

function launcherFromPatch(patch: unknown): {
  harness: string;
  label: string;
  badge: number;
  badgeTone: LauncherBadgeTone;
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
  const badge = launcherBadgeFromState(state);
  return {
    harness,
    label: pillLabel ? `Open agent chats · ${pillLabel}` : "Open agent chats",
    badge: badge.count,
    badgeTone: badge.tone,
    hidden: !harness,
  };
}

function post(port: ExtensionPort, message: unknown): void {
  try {
    port.postMessage(message);
  } catch {
    contentPorts.delete(port);
    guestPorts.delete(port);
    for (const [tabId, candidate] of contentPortsByTab)
      if (candidate === port) contentPortsByTab.delete(tabId);
  }
}

function forwardHostEvent(tabId: number, event: unknown): void {
  let delivered = false;
  for (const [port, guest] of guestPorts) {
    if (guest.tabId !== tabId) continue;
    post(port, { type: "host-event", event });
    delivered = true;
  }
  if (delivered) return;
  const pending = pendingHostEvents.get(tabId) ?? [];
  pending.push(event);
  if (pending.length > 8) pending.shift();
  pendingHostEvents.set(tabId, pending);
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
        : VIBEWAITING_NEUTRAL;
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

function broadcastRemoteAccess(): void {
  if (!lastRemoteAccess) return;
  for (const port of optionsPorts) post(port, { type: "remote-access", ...lastRemoteAccess });
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

function disconnectNative(): boolean {
  const priorPort = nativePort;
  nativePort = null;
  nativeReady = false;
  lastPatch = undefined;
  pendingIntents.length = 0;
  chunks.clear();
  priorPort?.disconnect();
  return priorPort !== null;
}

// The development runner evaluates inside this service worker over its private CDP target. A web
// page cannot reach this global, and production behavior never calls it.
(globalThis as typeof globalThis & {
  __vibewaitingDisconnectNativeForDevelopment?: () => boolean;
}).__vibewaitingDisconnectNativeForDevelopment = () => {
  const connected = nativePort !== null;
  // Let Runtime.evaluate return before disconnecting the port that keeps this worker alive.
  setTimeout(disconnectNative, 0);
  return connected;
};

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
    return;
  }
  if (message.type === "remote-access" && typeof message.passcode === "string") {
    lastRemoteAccess = { passcode: message.passcode, snapshot: message.snapshot };
    broadcastRemoteAccess();
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

function browserResponse(
  port: ExtensionPort,
  id: string,
  value:
    | { ok: true; attachments: unknown }
    | { ok: false; error: string },
): void {
  post(port, { type: "browser-context-response", id, ...value });
}

function handleContentMessage(port: ExtensionPort, tabId: number, raw: unknown): void {
  const message = record(raw);
  if (!message || typeof message.id !== "string") return;
  if (message.type === "browser-context-response") {
    const pending = pendingBrowserRequests.get(message.id);
    if (!pending || pending.tabId !== tabId) return;
    pendingBrowserRequests.delete(message.id);
    if (message.ok !== true) {
      browserResponse(pending.guest, message.id, {
        ok: false,
        error:
          typeof message.error === "string" && message.error
            ? message.error
            : "Could not capture browser context.",
      });
      return;
    }
    if (message.attachments === null) {
      browserResponse(pending.guest, message.id, {
        ok: true,
        attachments: null,
      });
      return;
    }
    const attachments = parseBrowserContextAttachments(message.attachments);
    browserResponse(
      pending.guest,
      message.id,
      attachments
        ? { ok: true, attachments }
        : { ok: false, error: "The page returned invalid browser context." },
    );
    return;
  }
  if (message.type !== "browser-shortcut-result") return;
  if (
    message.command !== "focus-composer" &&
    message.command !== "attach-browser-context" &&
    message.command !== "previous-conversation" &&
    message.command !== "next-conversation"
  )
    return;
  const attachments =
    message.attachments === undefined
      ? []
      : parseBrowserContextAttachments(message.attachments);
  if (attachments === null) return;
  forwardHostEvent(tabId, {
    type: "shortcut",
    id: message.id,
    command: message.command,
    ...(attachments.length ? { attachments } : {}),
  });
}

function handleBrowserRequest(
  port: ExtensionPort,
  guest: { tabId: number | null },
  message: Record<string, unknown>,
): boolean {
  if (
    message.type !== "browser-context-request" ||
    typeof message.id !== "string" ||
    message.id.length > 200 ||
    message.action !== "candidates"
  )
    return false;
  if (guest.tabId === null) {
    browserResponse(port, message.id, {
      ok: false,
      error: "This Vibewaiting surface is not attached to a browser tab.",
    });
    return true;
  }
  const content = contentPortsByTab.get(guest.tabId);
  if (!content) {
    browserResponse(port, message.id, {
      ok: false,
      error: "The current page is not available for context capture.",
    });
    return true;
  }
  if (pendingBrowserRequests.size >= 32) {
    const oldestId = pendingBrowserRequests.keys().next().value as string;
    const oldest = pendingBrowserRequests.get(oldestId);
    pendingBrowserRequests.delete(oldestId);
    if (oldest)
      browserResponse(oldest.guest, oldestId, {
        ok: false,
        error: "Too many browser captures are already pending.",
      });
  }
  pendingBrowserRequests.set(message.id, { guest: port, tabId: guest.tabId });
  post(content, {
    type: "browser-context-request",
    id: message.id,
    action: "candidates",
  });
  return true;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "vibewaiting:options") {
    optionsPorts.add(port);
    post(port, { type: "status", ...lastStatus });
    if (lastRemoteAccess) post(port, { type: "remote-access", ...lastRemoteAccess });
    port.onMessage.addListener((raw) => {
      const message = record(raw);
      if (message?.type !== "remote-access-configure") return;
      const configuration = parseRemoteAccessConfiguration(message.configuration);
      if (!configuration) return;
      void ensureNative().then(() => {
        nativePort?.postMessage({
          protocol: VIBEWAITING_EXTENSION_PROTOCOL,
          type: "remote-access",
          configuration,
        });
      });
    });
    port.onDisconnect.addListener(() => optionsPorts.delete(port));
    void ensureNative();
    return;
  }
  if (port.name === "vibewaiting:content") {
    const { tabId } = senderTab(port);
    contentPorts.add(port);
    if (tabId !== null) contentPortsByTab.set(tabId, port);
    if (lastPatch !== undefined)
      post(port, { type: "launcher", ...launcherFromPatch(lastPatch) });
    post(port, { type: "status", ...lastStatus });
    if (tabId !== null)
      port.onMessage.addListener((message) =>
        handleContentMessage(port, tabId, message),
      );
    port.onDisconnect.addListener(() => {
      contentPorts.delete(port);
      if (tabId !== null && contentPortsByTab.get(tabId) === port)
        contentPortsByTab.delete(tabId);
      for (const [id, pending] of pendingBrowserRequests) {
        if (pending.tabId !== tabId) continue;
        pendingBrowserRequests.delete(id);
        browserResponse(pending.guest, id, {
          ok: false,
          error: "The page changed before context capture finished.",
        });
      }
    });
    void ensureNative();
    return;
  }
  if (port.name !== "vibewaiting:guest") return;
  const sender = senderTab(port);
  const guest = { id: crypto.randomUUID(), visible: false, ...sender };
  guestPorts.set(port, guest);
  if (lastPatch !== undefined) post(port, { type: "patch", patch: lastPatch });
  post(port, { type: "status", ...lastStatus });
  if (guest.tabId !== null) {
    for (const event of pendingHostEvents.get(guest.tabId) ?? [])
      post(port, { type: "host-event", event });
    pendingHostEvents.delete(guest.tabId);
  }
  port.onMessage.addListener((raw) => {
    const message = record(raw);
    if (message && handleBrowserRequest(port, guest, message)) return;
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
    for (const [id, pending] of pendingBrowserRequests) {
      if (pending.guest === port) pendingBrowserRequests.delete(id);
    }
    if (wasVisible && visibleGuestCount() === 0)
      sendIntent(`${guest.id}:disconnect`, { action: "panelHidden" });
  });
  void ensureNative();
});

chrome.runtime.onMessage.addListener((raw) => {
  const message = record(raw);
  if (message?.type !== "settings-changed") return;
  disconnectNative();
  void ensureNative();
});

chrome.action.onClicked.addListener(
  () => void chrome.runtime.openOptionsPage(),
);
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") void chrome.runtime.openOptionsPage();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== ATTACH_LINK_MENU || !info.linkUrl) return;
  if (!Number.isInteger(tab?.id)) return;
  const content = contentPortsByTab.get(tab!.id!);
  if (!content) return;
  post(content, {
    type: "browser-context-menu",
    id: `context-menu:${Date.now().toString(36)}:${crypto.randomUUID()}`,
    action: "link",
    targetUrl: info.linkUrl,
  });
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (
    command !== "focus-composer" &&
    command !== "attach-browser-context" &&
    command !== "previous-conversation" &&
    command !== "next-conversation"
  )
    return;
  if (!Number.isInteger(tab?.id)) return;
  const content = contentPortsByTab.get(tab!.id!);
  if (!content) return;
  post(content, {
    type: "browser-shortcut",
    id: `shortcut:${Date.now().toString(36)}:${crypto.randomUUID()}`,
    command,
  });
});
