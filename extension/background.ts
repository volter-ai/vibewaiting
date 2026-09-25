import {
  type ExtensionSettings,
  NATIVE_HOST_NAME,
  type NativeHostEvent,
  VIBEWAITING_EXTENSION_PROTOCOL,
} from "../src/extension-protocol.js";
import { parseRemoteAccessConfiguration } from "../src/extension-protocol.js";
import { parseBrowserContextAttachments } from "../src/browser-context.js";
import { VIBEWAITING_NEUTRAL } from "../src/theme.js";
import {
  parseBrowserOperationCall,
  parseBrowserOperationResult,
  type BrowserOperationCall,
  type BrowserOperationResult,
} from "@volter-ai-dev/supercode-browser-playwright/protocol";
import {
  launcherBadgeFromState,
  type LauncherBadgeTone,
} from "../src/launcher.js";
import {
  parseRemoteDeviceSnapshot,
  type RemoteDeviceSnapshot,
} from "@volter-ai-dev/supercode-remote-access/client";

const SETTINGS_KEY = "vibewaiting:settings";
const ATTACH_LINK_MENU = "vibewaiting:attach-link";
const CONTENT_SCRIPT_ID = "vibewaiting-content";
const SURFACE_SCRIPT_ID = "vibewaiting-surface";
const SITE_ORIGINS = ["http://*/*", "https://*/*"];
const contentPorts = new Set<ExtensionPort>();
const contentPortsByTab = new Map<number, ExtensionPort>();
const contentPageByTab = new Map<number, string>();
const tabByContentPage = new Map<string, number>();
const guestPorts = new Map<
  ExtensionPort,
  { id: string; visible: boolean; tabId: number | null }
>();
const optionsPorts = new Set<ExtensionPort>();
const pendingBrowserRequests = new Map<
  string,
  { guest: ExtensionPort; tabId: number }
>();
const pendingAgentBrowserRequests = new Map<
  string,
  {
    tabId: number;
    operation: BrowserOperationCall["operation"];
    timer: ReturnType<typeof setTimeout>;
    /** The caller keeps the call open while the person decides (Supercode `pending` lines). */
    acceptsPending: boolean;
    /** The agent task the call belongs to: per-origin allowances are kept for it. */
    task: string | null;
  }
>();
/**
 * Operations waiting for the person's decision, by approval id. Each is bound
 * to its operation id, its tab and the exact action the refusal named (`key`);
 * Approve re-runs that one operation with a one-time grant for that key.
 */
interface PendingApproval {
  id: string;
  requestId: string;
  tabId: number;
  call: BrowserOperationCall;
  key: string;
  /** Single-use: the offscreen document honours the grant only with it. */
  nonce: string;
  task: string | null;
  origin: string;
  onceOnly: boolean;
  note?: string;
  summary: string;
  reason: string;
  detail?: string;
  timer: ReturnType<typeof setTimeout>;
}
const pendingApprovals = new Map<string, PendingApproval>();
/** How long the approval card waits for the person; Supercode keeps the agent's call open meanwhile. */
const APPROVAL_WINDOW_MS = 90_000;
/** A tab on the debugger path detaches after this long without a browser operation. */
const DEBUGGER_IDLE_MS = 60_000;
/** Tabs an agent has driven: each new document's surface reconnects to the Playwright host. */
const drivenTabs = new Set<number>();
const pendingHostEvents = new Map<number, unknown[]>();
const pendingRemoteAccessOpen = new Set<number>();
const pendingIntents: Array<{ id: string; payload: unknown }> = [];
const chunks = new Map<string, { total: number; parts: string[] }>();
let nativePort: ExtensionPort | null = null;
let nativeReady = false;
let nativeConnecting: Promise<void> | null = null;
let lastPatch: unknown;
let lastStatus: {
  phase: string;
  message?: string;
  scope?: "companion" | "runtime" | "setup";
} = { phase: "stopped" };
let lastRemoteAccess: {
  devices: RemoteDeviceSnapshot;
  pairing?: unknown;
  passcode: string;
  snapshot: unknown;
} | null = null;

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

let siteAccessSync: Promise<void> = Promise.resolve();
function syncSiteAccess(injectExisting = false): Promise<void> {
  siteAccessSync = siteAccessSync
    .catch(() => undefined)
    .then(async () => {
      const allowed = await chrome.permissions.contains({
        origins: SITE_ORIGINS,
      });
      const registered = await chrome.scripting.getRegisteredContentScripts({
        ids: [CONTENT_SCRIPT_ID, SURFACE_SCRIPT_ID],
      });
      const active = registered.map((script) => script.id);
      let registeredNow = false;
      if (allowed && active.length < 2) {
        if (active.length)
          await chrome.scripting.unregisterContentScripts({ ids: active });
        await chrome.scripting.registerContentScripts([
          {
            id: CONTENT_SCRIPT_ID,
            js: ["content.js"],
            matches: SITE_ORIGINS,
            persistAcrossSessions: true,
            runAt: "document_idle",
          },
          {
            // The page's AlmostCDP surface: in the main world, from the
            // document's start, idle until an agent drives the tab.
            id: SURFACE_SCRIPT_ID,
            js: ["surface.js"],
            matches: SITE_ORIGINS,
            persistAcrossSessions: true,
            runAt: "document_start",
            world: "MAIN",
          },
        ]);
        registeredNow = true;
      } else if (!allowed && active.length) {
        for (const port of contentPorts)
          post(port, { type: "site-access-revoked" });
        for (const relay of [...debuggerRelays.values()]) closeRelay(relay, true);
        await chrome.scripting.unregisterContentScripts({ ids: active });
      }
      if (allowed) installContextMenus();
      else chrome.contextMenus.removeAll(() => void chrome.runtime.lastError);

      if (!allowed || (!injectExisting && !registeredNow)) return;
      const tabs = (await chrome.tabs.query({})).filter(
        (tab) =>
          Number.isInteger(tab.id) &&
          typeof tab.url === "string" &&
          /^https?:/.test(tab.url),
      );
      for (let offset = 0; offset < tabs.length; offset += 12) {
        await Promise.all(
          tabs
            .slice(offset, offset + 12)
            .map((tab) =>
              Promise.all([
                chrome.scripting
                  .executeScript({
                    files: ["surface.js"],
                    target: { tabId: tab.id! },
                    world: "MAIN",
                  })
                  .catch(() => undefined),
                chrome.scripting
                  .executeScript({
                    files: ["content.js"],
                    target: { tabId: tab.id! },
                  })
                  .catch(() => undefined),
              ]),
            ),
        );
      }
    });
  return siteAccessSync;
}

function requestSiteAccessSync(injectExisting = false): void {
  void syncSiteAccess(injectExisting).catch((error) => {
    console.error("Vibewaiting could not synchronize website access", error);
  });
}

requestSiteAccessSync();
chrome.permissions.onAdded.addListener(() => requestSiteAccessSync(true));
chrome.permissions.onRemoved.addListener(() => requestSiteAccessSync());

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
  for (const port of optionsPorts)
    post(port, { type: "remote-access", ...lastRemoteAccess });
  for (const port of guestPorts.keys())
    post(port, { type: "remote-access", ...lastRemoteAccess });
  const snapshot = record(lastRemoteAccess.snapshot);
  const status = snapshot?.status;
  if (
    status !== "connected" &&
    status !== "error" &&
    status !== "off" &&
    status !== "reconnecting" &&
    status !== "starting"
  )
    return;
  for (const port of contentPorts)
    post(port, { type: "remote-access-status", status });
}

async function configureRemoteAccess(rawConfiguration: unknown): Promise<void> {
  const configuration = parseRemoteAccessConfiguration(rawConfiguration);
  if (!configuration) return;
  const current = await settings();
  if (current) {
    await chrome.storage.local.set({
      [SETTINGS_KEY]: { ...current, remoteAccess: configuration },
    });
  }
  await ensureNative();
  nativePort?.postMessage({
    protocol: VIBEWAITING_EXTENSION_PROTOCOL,
    type: "remote-access",
    configuration,
  });
}

async function requestRemotePairing(): Promise<void> {
  await ensureNative();
  nativePort?.postMessage({
    protocol: VIBEWAITING_EXTENSION_PROTOCOL,
    type: "remote-access-pairing",
  });
}

async function revokeRemoteDevices(): Promise<void> {
  await ensureNative();
  nativePort?.postMessage({
    protocol: VIBEWAITING_EXTENSION_PROTOCOL,
    type: "remote-access-revoke",
  });
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
(
  globalThis as typeof globalThis & {
    __vibewaitingDisconnectNativeForDevelopment?: () => boolean;
  }
).__vibewaitingDisconnectNativeForDevelopment = () => {
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
  if (message.type === "browser-operation-request") {
    const call = parseBrowserOperationCall(message.call);
    if (typeof message.id === "string" && call)
      void routeBrowserOperation(message.id, call, message.acceptsPending === true,
        typeof message.task === "string" ? message.task : null);
    return;
  }
  if (message.type === "browser-operation-cancelled") {
    // The agent's call ended (its socket closed or the companion gave up):
    // an approval it was waiting on can no longer run anything.
    for (const approval of [...pendingApprovals.values()])
      if (approval.requestId === message.id) settleApproval(approval.id, "abandoned");
    const pending = pendingAgentBrowserRequests.get(message.id);
    if (pending) {
      clearTimeout(pending.timer);
      pendingAgentBrowserRequests.delete(message.id);
    }
    return;
  }
  if (message.type === "patch") {
    lastPatch = message.patch;
    broadcastPatch(message.patch);
    return;
  }
  if (message.type === "status") {
    nativeReady = message.phase === "ready";
    lastStatus = {
      phase: message.phase,
      ...(message.phase === "error" ? { scope: "runtime" as const } : {}),
      ...(message.message ? { message: message.message } : {}),
    };
    broadcastStatus();
    if (nativeReady) flushIntents();
    return;
  }
  if (
    message.type === "remote-access" &&
    typeof message.passcode === "string"
  ) {
    const devices = parseRemoteDeviceSnapshot(message.devices);
    if (!devices) {
      lastStatus = {
        phase: "error",
        message: "The native host sent invalid remote-device state.",
      };
      broadcastStatus();
      return;
    }
    lastRemoteAccess = {
      devices,
      ...(message.pairing ? { pairing: message.pairing } : {}),
      passcode: message.passcode,
      snapshot: message.snapshot,
    };
    broadcastRemoteAccess();
  }
}

function sendAgentBrowserResponse(id: string, result: BrowserOperationResult): void {
  nativePort?.postMessage({
    protocol: VIBEWAITING_EXTENSION_PROTOCOL,
    type: "browser-operation-response",
    id,
    result,
  });
}

function unavailableBrowserResult(
  operation: BrowserOperationCall["operation"],
  message: string,
): BrowserOperationResult {
  return {
    ok: false,
    operation,
    error: { code: "NOT_AVAILABLE", message },
  };
}

async function routeBrowserOperation(
  id: string,
  call: BrowserOperationCall,
  acceptsPending: boolean,
  task: string | null,
): Promise<void> {
  const offscreen = chrome.offscreen;
  if (!offscreen) {
    sendAgentBrowserResponse(
      id,
      unavailableBrowserResult(
        call.operation,
        "Browser operations need Chrome: in Firefox, Vibewaiting cannot run Playwright for the tab (Firefox has no offscreen documents or debugger API for extensions).",
      ),
    );
    return;
  }
  const requestedPage =
    typeof call.input.page === "string" ? call.input.page : undefined;
  const tabId = requestedPage
    ? (tabByContentPage.get(requestedPage) ?? null)
    : await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      .then(([tab]) => Number.isInteger(tab?.id) ? tab!.id! : null);
  if (tabId === null) {
    sendAgentBrowserResponse(
      id,
      unavailableBrowserResult(
        call.operation,
        requestedPage
          ? "The requested browser page is no longer available."
          : "No active browser tab is available.",
      ),
    );
    return;
  }
  const content = contentPortsByTab.get(tabId);
  if (!content) {
    sendAgentBrowserResponse(
      id,
      unavailableBrowserResult(
        call.operation,
        "The active tab is not an HTTP(S) page with Vibewaiting site access.",
      ),
    );
    return;
  }
  // Nothing else runs on a tab while the person decides about an action on it.
  const deciding = [...pendingApprovals.values()].find((approval) => approval.tabId === tabId);
  if (deciding) {
    sendAgentBrowserResponse(id, {
      ok: false,
      operation: call.operation,
      error: {
        code: "APPROVAL_REQUIRED",
        message: `Waiting for the person's decision on “${deciding.summary}” in Vibewaiting; no other browser operation runs on this tab until they answer.`,
      },
    });
    return;
  }
  await runBrowserOperation(id, tabId, call, null, acceptsPending, task);
}

/**
 * Runs one operation on the tab. `grant` is the key of the action the person
 * approved for this operation; without one, an action needing approval stops
 * the operation and the person is asked in the messenger.
 */
async function runBrowserOperation(
  id: string,
  tabId: number,
  call: BrowserOperationCall,
  grant: string | null,
  acceptsPending: boolean,
  task: string | null,
): Promise<void> {
  const offscreen = chrome.offscreen!;
  const existing = pendingAgentBrowserRequests.get(id);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    if (!pendingAgentBrowserRequests.delete(id)) return;
    sendAgentBrowserResponse(id, {
      ok: false,
      operation: call.operation,
      error: { code: "TIMED_OUT", message: "The active page did not answer in 10 seconds." },
    });
  }, 10_000);
  pendingAgentBrowserRequests.set(id, { tabId, operation: call.operation, timer, acceptsPending, task });
  let raw: unknown;
  debuggerBusy(tabId);
  try {
    await ensurePlaywrightHost(offscreen);
    const via = await driverFor(tabId);
    if (via === "surface") {
      drivenTabs.add(tabId);
      const content = contentPortsByTab.get(tabId);
      if (content) post(content, { type: "surface-connect" });
    }
    raw = await chrome.runtime.sendMessage({
      type: "vibewaiting:browser-operation",
      tabId,
      via,
      call,
      ...(grant === null ? {} : { grant }),
      allowed: allowedOrigins(task, tabId),
    });
  } catch (error) {
    raw = {
      ok: false,
      operation: call.operation,
      error: { code: "NOT_AVAILABLE", message: `The Playwright host is not available: ${error instanceof Error ? error.message : String(error)}` },
    };
  } finally {
    debuggerIdle(tabId);
  }
  allowanceUsed(task, tabId, raw);
  const approval = grant === null ? approvalRequest(raw) : null;
  const pending = pendingAgentBrowserRequests.get(id);
  // The Playwright host holds the tab for a decision once it refuses; it is
  // released unless this refusal becomes a card, and after an approved re-run.
  if (grant !== null || (approval && !(pending?.tabId === tabId && pending.acceptsPending)))
    releaseTab(tabId);
  if (approval && pending?.tabId === tabId && pending.acceptsPending) {
    pendingAgentBrowserRequests.delete(id);
    clearTimeout(pending.timer);
    askPerson(id, tabId, call, approval, task);
    return;
  }
  if (approval && pending?.tabId === tabId) {
    // A caller that cannot keep the call open is refused at once, not asked for.
    raw = {
      ok: false,
      operation: call.operation,
      error: {
        code: "APPROVAL_REQUIRED",
        message: `${approval.reason} This caller cannot wait for the person's approval, so they were not asked.`,
      },
    };
  }
  finishAgentBrowserRequest(id, tabId, raw);
}

/** Surface ids are minted in this order: a later document's id is newer. */
let surfaceMintOrder = 0;

/**
 * Origins the person allowed, per agent task and tab ("Allow on <origin> for
 * this task"), with when each last let an action through. An allowance covers
 * exactly that origin on that tab for that task; it ends when the task does
 * (a task id is never reused), when the tab closes, and after
 * ALLOWANCE_IDLE_MS without use. Allowances live only in this worker's memory.
 */
const ALLOWANCE_IDLE_MS = 15 * 60_000;
const allowances = new Map<string, Map<string, number>>();
function allowanceKey(task: string, tabId: number): string {
  return `${tabId}\n${task}`;
}
function allowedOrigins(task: string | null, tabId: number): string[] {
  if (task === null) return [];
  const origins = allowances.get(allowanceKey(task, tabId));
  if (!origins) return [];
  const now = Date.now();
  for (const [origin, used] of origins) if (now - used > ALLOWANCE_IDLE_MS) origins.delete(origin);
  return [...origins.keys()];
}
function allowanceUsed(task: string | null, tabId: number, raw: unknown): void {
  const origin = record(raw)?.allowanceUsed;
  const origins = task === null ? undefined : allowances.get(allowanceKey(task, tabId));
  if (typeof origin === "string" && origins?.has(origin)) origins.set(origin, Date.now());
}

function releaseTab(tabId: number): void {
  void chrome.runtime.sendMessage({ type: "vibewaiting:approval-settled", tabId }).catch(() => undefined);
}

/** The approval a refused operation asks for (playwright.ts attaches it to an `APPROVAL_REQUIRED` result). */
interface ApprovalRequest {
  key: string;
  summary: string;
  reason: string;
  detail?: string;
  note?: string;
  origin: string;
  onceOnly: boolean;
}

function approvalRequest(raw: unknown): ApprovalRequest | null {
  const result = record(raw);
  const error = record(result?.error);
  const approval = record(result?.approval);
  if (result?.ok !== false || error?.code !== "APPROVAL_REQUIRED" || !approval) return null;
  const { key, summary, reason, detail, note, origin, onceOnly } = approval;
  if (typeof key !== "string" || typeof summary !== "string" || typeof reason !== "string" || typeof origin !== "string") return null;
  return {
    key, summary, reason, origin, onceOnly: onceOnly !== false,
    ...(typeof detail === "string" ? { detail } : {}),
    ...(typeof note === "string" ? { note } : {}),
  };
}

function approvalCard(approval: PendingApproval): unknown {
  return {
    type: "browser-approval",
    approval: {
      id: approval.id,
      summary: approval.summary,
      reason: approval.reason,
      ...(approval.detail ? { detail: approval.detail } : {}),
      ...(approval.note ? { note: approval.note } : {}),
      // "Allow on <origin> for this task" exists only for an action an
      // allowance can cover, from a caller that names its task.
      ...(!approval.onceOnly && approval.task !== null ? { allowOrigin: approval.origin } : {}),
    },
  };
}

/** Shows the approval card in the tab's messenger and keeps the agent's call open for the decision. */
function askPerson(
  requestId: string,
  tabId: number,
  call: BrowserOperationCall,
  approval: ApprovalRequest,
  task: string | null,
): void {
  const id = crypto.randomUUID();
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const pending: PendingApproval = {
    id,
    requestId,
    tabId,
    call,
    nonce,
    task,
    ...approval,
    timer: setTimeout(() => settleApproval(id, "expired"), APPROVAL_WINDOW_MS),
  };
  pendingApprovals.set(id, pending);
  void chrome.runtime.sendMessage({ type: "vibewaiting:grant-offer", nonce, key: approval.key, tabId }).catch(() => undefined);
  // The tab stays on its driver while the person decides.
  debuggerBusy(tabId);
  nativePort?.postMessage({
    protocol: VIBEWAITING_EXTENSION_PROTOCOL,
    type: "browser-operation-pending",
    id: requestId,
    message: `Waiting for the person to approve in Vibewaiting: ${approval.summary}`,
  });
  const content = contentPortsByTab.get(tabId);
  if (content) post(content, { type: "browser-approval-open" });
  for (const [port, guest] of guestPorts)
    if (guest.tabId === tabId) post(port, approvalCard(pending));
}

/** The person's answer (or its absence): Approve re-runs the one operation; anything else refuses it. */
function settleApproval(
  id: string,
  decision: "approve" | "allow-origin" | "deny" | "expired" | "closed" | "abandoned",
): void {
  const approval = pendingApprovals.get(id);
  if (!approval) return;
  pendingApprovals.delete(id);
  clearTimeout(approval.timer);
  debuggerIdle(approval.tabId);
  if (![...pendingApprovals.values()].some((other) => other.tabId === approval.tabId)) {
    const content = contentPortsByTab.get(approval.tabId);
    if (content) post(content, { type: "browser-approval-watch", active: false });
  }
  for (const [port, guest] of guestPorts)
    if (guest.tabId === approval.tabId)
      post(port, { type: "browser-approval-settled", id, decision });
  if (decision === "allow-origin" && approval.task !== null && !approval.onceOnly) {
    const key = allowanceKey(approval.task, approval.tabId);
    const origins = allowances.get(key) ?? new Map<string, number>();
    origins.set(approval.origin, Date.now());
    allowances.set(key, origins);
  }
  if (decision === "approve" || decision === "allow-origin") {
    void runBrowserOperation(approval.requestId, approval.tabId, approval.call, approval.nonce, true, approval.task);
    return;
  }
  void chrome.runtime.sendMessage({ type: "vibewaiting:grant-revoke", nonce: approval.nonce }).catch(() => undefined);
  releaseTab(approval.tabId);
  // The agent stopped waiting: there is no one to answer.
  if (decision === "abandoned") return;
  sendAgentBrowserResponse(approval.requestId, {
    ok: false,
    operation: approval.call.operation,
    error: {
      code: "APPROVAL_REQUIRED",
      message:
        decision === "deny"
          ? `The person denied this in Vibewaiting: ${approval.summary}. Nothing ran.`
          : decision === "expired"
            ? `The person did not answer in ${APPROVAL_WINDOW_MS / 1000} seconds: ${approval.summary}. Nothing ran.`
            : `The tab closed before the person answered: ${approval.summary}. Nothing ran.`,
    },
  });
}

let playwrightHost: Promise<void> | null = null;
/** The offscreen document hosting Playwright (offscreen.html → playwright.html). */
async function ensurePlaywrightHost(offscreen: NonNullable<typeof chrome.offscreen>): Promise<void> {
  if (await offscreen.hasDocument()) return;
  playwrightHost ??= offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["IFRAME_SCRIPTING"],
    justification: "Runs Playwright in a sandboxed frame to answer an agent's browser operations on the tab the person shares.",
  }).finally(() => { playwrightHost = null; });
  await playwrightHost;
}

/**
 * How Playwright reaches a tab. A page whose Content-Security-Policy forbids
 * eval cannot answer Playwright's evaluations through the main-world AlmostCDP
 * surface, so such a tab is driven over Chrome's own DevTools protocol through
 * `chrome.debugger` (Chrome shows its "started debugging this browser" bar on
 * it) until the debugger detaches: the person cancels the bar, the tab closes,
 * or website access is revoked.
 */
async function driverFor(tabId: number): Promise<"surface" | "debugger"> {
  if (debuggerRelays.has(tabId)) return "debugger";
  const [probe] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      try {
        new Function("return 0");
        return true;
      } catch {
        return false;
      }
    },
  }).catch(() => [] as Array<{ result?: boolean }>);
  return probe?.result === false ? "debugger" : "surface";
}

/**
 * One tab driven over `chrome.debugger`, presented to Playwright as a browser
 * holding that one page (the shape of Playwright's own extension relay): the
 * browser-level commands Playwright's connect sends are answered here, the
 * tab's own and its child sessions' commands go to the tab's debugger.
 */
interface DebuggerRelay {
  tabId: number;
  port: ExtensionPort;
  sessionId: string;
  targetInfo: Record<string, unknown> | null;
  attach: Promise<void> | null;
  children: Set<string>;
  /**
   * Further sessions Playwright opened on the tab itself (`newCDPSession`,
   * which Supercode's guard uses): commands go to the tab's debugger; events
   * reach only the first session.
   */
  aliases: Set<string>;
  /** Browser-level sessions Playwright opened (`Target.attachToBrowserTarget`). */
  browserSessions: Set<string>;
}
const debuggerRelays = new Map<number, DebuggerRelay>();

function relaySend(relay: DebuggerRelay, message: unknown): void {
  try {
    relay.port.postMessage({ type: "data", data: JSON.stringify(message) });
  } catch { /* The Playwright host went away; its disconnect closes the relay. */ }
}

function attachRelay(relay: DebuggerRelay): Promise<void> {
  relay.attach ??= (async () => {
    await chrome.debugger.attach({ tabId: relay.tabId }, "1.3");
    const info = await chrome.debugger.sendCommand({ tabId: relay.tabId }, "Target.getTargetInfo") as
      { targetInfo?: Record<string, unknown> } | undefined;
    relay.targetInfo = info?.targetInfo ?? null;
    relaySend(relay, {
      method: "Target.attachedToTarget",
      params: { sessionId: relay.sessionId, targetInfo: { ...relay.targetInfo, attached: true }, waitingForDebugger: false },
    });
  })();
  return relay.attach;
}

async function relayCommand(relay: DebuggerRelay, method: string, params: unknown, sessionId: string | undefined): Promise<unknown> {
  const tab = { tabId: relay.tabId };
  // A browser-level session Playwright opened is the relay's own browser level.
  if (sessionId !== undefined && relay.browserSessions.has(sessionId)) sessionId = undefined;
  if (sessionId === undefined) {
    if (method === "Browser.getVersion") {
      const version = /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? "0";
      return { protocolVersion: "1.3", product: `Chrome/${version}`, revision: "", userAgent: navigator.userAgent, jsVersion: "" };
    }
    if (method === "Browser.setDownloadBehavior") return {};
    if (method === "Target.setAutoAttach") {
      await attachRelay(relay);
      return {};
    }
    if (method === "Target.getTargetInfo") return { targetInfo: relay.targetInfo };
    if (method === "Target.attachToBrowserTarget") {
      const browserSession = `${relay.sessionId}-browser-${crypto.randomUUID()}`;
      relay.browserSessions.add(browserSession);
      return { sessionId: browserSession };
    }
    if (method === "Target.attachToTarget") {
      await attachRelay(relay);
      if ((params as { targetId?: unknown } | undefined)?.targetId !== relay.targetInfo?.targetId)
        throw new Error("Vibewaiting drives only the tab the person shares.");
      const alias = `${relay.sessionId}-${crypto.randomUUID()}`;
      relay.aliases.add(alias);
      return { sessionId: alias };
    }
    if (method === "Target.detachFromTarget") {
      const detached = String((params as { sessionId?: unknown } | undefined)?.sessionId);
      relay.aliases.delete(detached);
      relay.browserSessions.delete(detached);
      return {};
    }
    if (method === "Target.createTarget" || method === "Target.closeTarget" || method === "Target.createBrowserContext")
      throw new Error("Vibewaiting drives only the tab the person shares.");
    await attachRelay(relay);
    return await chrome.debugger.sendCommand(tab, method, params);
  }
  if (sessionId === relay.sessionId || relay.aliases.has(sessionId)) return await chrome.debugger.sendCommand(tab, method, params);
  if (relay.children.has(sessionId)) return await chrome.debugger.sendCommand({ ...tab, sessionId }, method, params);
  throw new Error(`No session ${sessionId} in this tab.`);
}

/**
 * Chrome shows its debugging bar while the debugger is attached, so a tab on
 * the debugger path is attached only while an agent is driving it: it detaches
 * DEBUGGER_IDLE_MS after its last operation, and the next operation attaches
 * again.
 */
const debuggerIdleTimers = new Map<number, ReturnType<typeof setTimeout>>();
const operationsInFlight = new Map<number, number>();
function debuggerBusy(tabId: number): void {
  operationsInFlight.set(tabId, (operationsInFlight.get(tabId) ?? 0) + 1);
  clearTimeout(debuggerIdleTimers.get(tabId));
  debuggerIdleTimers.delete(tabId);
}
function debuggerIdle(tabId: number): void {
  const remaining = (operationsInFlight.get(tabId) ?? 1) - 1;
  if (remaining > 0) {
    operationsInFlight.set(tabId, remaining);
    return;
  }
  operationsInFlight.delete(tabId);
  if (!debuggerRelays.has(tabId)) return;
  clearTimeout(debuggerIdleTimers.get(tabId));
  debuggerIdleTimers.set(tabId, setTimeout(() => {
    debuggerIdleTimers.delete(tabId);
    const relay = debuggerRelays.get(tabId);
    if (relay && !operationsInFlight.has(tabId)) closeRelay(relay, true);
  }, DEBUGGER_IDLE_MS));
}

function closeRelay(relay: DebuggerRelay, detach: boolean): void {
  if (debuggerRelays.get(relay.tabId) !== relay) return;
  debuggerRelays.delete(relay.tabId);
  clearTimeout(debuggerIdleTimers.get(relay.tabId));
  debuggerIdleTimers.delete(relay.tabId);
  if (detach && relay.attach) void chrome.debugger.detach({ tabId: relay.tabId }).catch(() => undefined);
  try {
    relay.port.postMessage({ type: "close", code: 1000, reason: "The tab's debugger detached" });
    relay.port.disconnect();
  } catch { /* Already gone. */ }
}

chrome.debugger?.onEvent.addListener((source, method, params) => {
  const relay = source.tabId === undefined ? undefined : debuggerRelays.get(source.tabId);
  if (!relay) return;
  const child = (params as { sessionId?: unknown } | undefined)?.sessionId;
  if (typeof child === "string" && method === "Target.attachedToTarget") relay.children.add(child);
  if (typeof child === "string" && method === "Target.detachedFromTarget") relay.children.delete(child);
  relaySend(relay, { sessionId: source.sessionId ?? relay.sessionId, method, params });
  // The tab's own events also reach every further session opened on it
  // (Supercode's guard watches navigations through one).
  if (source.sessionId === undefined)
    for (const alias of relay.aliases) relaySend(relay, { sessionId: alias, method, params });
});
chrome.debugger?.onDetach.addListener((source) => {
  const relay = source.tabId === undefined ? undefined : debuggerRelays.get(source.tabId);
  if (!relay) return;
  relaySend(relay, { method: "Target.detachedFromTarget", params: { sessionId: relay.sessionId, targetId: relay.targetInfo?.targetId } });
  closeRelay(relay, false);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  const relay = debuggerRelays.get(tabId);
  if (relay) closeRelay(relay, false);
});

/** The Playwright host's CDP connection to one tab's debugger (offscreen.ts). */
function acceptDebuggerPort(port: ExtensionPort): void {
  if (port.sender?.tab || port.sender?.id !== chrome.runtime.id) {
    port.disconnect();
    return;
  }
  let relay: DebuggerRelay | null = null;
  port.onMessage.addListener((raw) => {
    const message = record(raw);
    if (!message) return;
    if (!relay) {
      const tabId = message.tabId;
      if (message.type !== "attach" || typeof tabId !== "number" || debuggerRelays.has(tabId)) {
        port.disconnect();
        return;
      }
      relay = { tabId, port, sessionId: `vibewaiting-tab-${tabId}`, targetInfo: null, attach: null, children: new Set(), aliases: new Set(), browserSessions: new Set() };
      debuggerRelays.set(tabId, relay);
      return;
    }
    if (message.type === "close") {
      closeRelay(relay, true);
      return;
    }
    if (message.type !== "data" || typeof message.data !== "string") return;
    const current = relay;
    const command = JSON.parse(message.data) as { id: number; method: string; params?: unknown; sessionId?: string };
    void relayCommand(current, command.method, command.params, command.sessionId).then(
      (result) => relaySend(current, { id: command.id, ...(command.sessionId ? { sessionId: command.sessionId } : {}), result: result ?? {} }),
      (error: unknown) => relaySend(current, {
        id: command.id,
        ...(command.sessionId ? { sessionId: command.sessionId } : {}),
        error: { message: error instanceof Error ? error.message : String(error) },
      }),
    );
  });
  port.onDisconnect.addListener(() => { if (relay) closeRelay(relay, true); });
}

function finishAgentBrowserRequest(id: string, tabId: number, raw: unknown): void {
  const pending = pendingAgentBrowserRequests.get(id);
  if (!pending || pending.tabId !== tabId) return;
  pendingAgentBrowserRequests.delete(id);
  clearTimeout(pending.timer);
  const result = parseBrowserOperationResult(raw);
  if (!result) {
    sendAgentBrowserResponse(id, {
      ok: false,
      operation: pending.operation,
      error: { code: "FAILED", message: "The page returned an invalid browser result." },
    });
    return;
  }
  if (result.operation !== pending.operation) {
    sendAgentBrowserResponse(id, {
      ok: false,
      operation: pending.operation,
      error: { code: "FAILED", message: "The page returned a result for the wrong browser operation." },
    });
    return;
  }
  sendAgentBrowserResponse(id, {
    ...result,
    ...(result.target
      ? {
          target: {
            ...result.target,
            ...(contentPageByTab.get(tabId)
              ? { page: contentPageByTab.get(tabId)! }
              : {}),
          },
        }
      : {}),
  });
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
    lastStatus = {
      phase: "starting",
      scope: configured ? "runtime" : "setup",
      message: configured
        ? "Connecting to local coding sessions…"
        : "Checking the local companion…",
    };
    broadcastStatus();
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
          scope: "companion",
          message:
            detail ||
            `Run vibewaiting native install --extension-id ${chrome.runtime.id}`,
        };
        broadcastStatus();
      });
      if (configured) {
        port.postMessage({
          protocol: VIBEWAITING_EXTENSION_PROTOCOL,
          type: "start",
          settings: configured,
        });
      } else {
        // Presence is inferred from the native channel instead of a new protocol command so a
        // freshly updated extension can still onboard against the previous companion. This probe
        // is deliberately short-lived; the real host starts only after the workspace is saved.
        globalThis.setTimeout(() => {
          if (nativePort !== port) return;
          nativePort = null;
          port.disconnect();
          lastStatus = {
            phase: "setup",
            scope: "setup",
            message: "Local companion ready. Choose a folder for new chats.",
          };
          broadcastStatus();
        }, 150);
      }
    } catch (error) {
      nativePort = null;
      lastStatus = {
        phase: "error",
        scope: "companion",
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
  value: { ok: true; attachments: unknown } | { ok: false; error: string },
): void {
  post(port, { type: "browser-context-response", id, ...value });
}

function handleContentMessage(
  port: ExtensionPort,
  tabId: number,
  raw: unknown,
): void {
  const message = record(raw);
  if (!message) return;
  if (message.type === "approval-frame-moved") {
    for (const [guestPort, guest] of guestPorts)
      if (guest.tabId === tabId) post(guestPort, { type: "browser-approval-moved" });
    return;
  }
  if (message.type === "remote-access-open") {
    let delivered = false;
    for (const [guestPort, guest] of guestPorts)
      if (guest.tabId === tabId) {
        post(guestPort, { type: "remote-access-open" });
        delivered = true;
      }
    if (!delivered) pendingRemoteAccessOpen.add(tabId);
    return;
  }
  if (typeof message.id !== "string") return;
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
  if (port.name === "vibewaiting:cdp") {
    acceptDebuggerPort(port);
    return;
  }
  if (port.name === "vibewaiting:options") {
    optionsPorts.add(port);
    post(port, { type: "status", ...lastStatus });
    if (lastRemoteAccess)
      post(port, { type: "remote-access", ...lastRemoteAccess });
    port.onMessage.addListener((raw) => {
      const message = record(raw);
      if (message?.type === "retry-native") {
        disconnectNative();
        void ensureNative();
        return;
      }
      if (message?.type === "remote-access-configure") {
        void configureRemoteAccess(message.configuration);
        return;
      }
      if (message?.type === "remote-access-pairing-request")
        void requestRemotePairing();
      if (message?.type === "remote-access-revoke-request")
        void revokeRemoteDevices();
    });
    port.onDisconnect.addListener(() => optionsPorts.delete(port));
    void ensureNative();
    return;
  }
  if (port.name === "vibewaiting:content") {
    const sender = port.sender as (typeof port.sender & { documentLifecycle?: string }) | undefined;
    // Only the tab's own active top document speaks for the tab: never a
    // prerendered, cached or frame document.
    const { tabId } = sender?.frameId === 0 && (sender.documentLifecycle ?? "active") === "active"
      ? senderTab(port) : { tabId: null };
    contentPorts.add(port);
    if (tabId !== null) {
      const priorPage = contentPageByTab.get(tabId);
      if (priorPage) tabByContentPage.delete(priorPage);
      const page = `vibewaiting:${crypto.randomUUID()}`;
      contentPortsByTab.set(tabId, port);
      contentPageByTab.set(tabId, page);
      tabByContentPage.set(page, tabId);
    }
    if (lastPatch !== undefined)
      post(port, { type: "launcher", ...launcherFromPatch(lastPatch) });
    post(port, { type: "status", ...lastStatus });
    if (lastRemoteAccess) {
      const status = record(lastRemoteAccess.snapshot)?.status;
      if (typeof status === "string")
        post(port, { type: "remote-access-status", status });
    }
    if (tabId !== null)
      port.onMessage.addListener((raw) =>
        handleContentMessage(port, tabId, raw),
      );
    if (tabId !== null && drivenTabs.has(tabId))
      post(port, { type: "surface-connect" });
    port.onDisconnect.addListener(() => {
      contentPorts.delete(port);
      if (tabId !== null) {
        pendingRemoteAccessOpen.delete(tabId);
        if (contentPortsByTab.get(tabId) === port) {
          contentPortsByTab.delete(tabId);
          const page = contentPageByTab.get(tabId);
          contentPageByTab.delete(tabId);
          if (page) tabByContentPage.delete(page);
        }
      }
      for (const [id, pending] of pendingBrowserRequests) {
        if (pending.tabId !== tabId) continue;
        pendingBrowserRequests.delete(id);
        browserResponse(pending.guest, id, {
          ok: false,
          error: "The page changed before context capture finished.",
        });
      }
      // An operation in flight keeps its page across a navigation (the
      // surface's succession); the Playwright host answers or times out.
    });
    void ensureNative();
    return;
  }
  if (port.name !== "vibewaiting:guest") return;
  const sender = senderTab(port);
  if (
    sender.tabId === null ||
    contentPortsByTab.get(sender.tabId) === undefined
  ) {
    port.disconnect();
    return;
  }
  const guest = { id: crypto.randomUUID(), visible: false, ...sender };
  guestPorts.set(port, guest);
  if (lastPatch !== undefined) post(port, { type: "patch", patch: lastPatch });
  post(port, { type: "status", ...lastStatus });
  if (lastRemoteAccess)
    post(port, { type: "remote-access", ...lastRemoteAccess });
  if (guest.tabId !== null) {
    if (pendingRemoteAccessOpen.delete(guest.tabId))
      post(port, { type: "remote-access-open" });
    for (const event of pendingHostEvents.get(guest.tabId) ?? [])
      post(port, { type: "host-event", event });
    pendingHostEvents.delete(guest.tabId);
    for (const approval of pendingApprovals.values())
      if (approval.tabId === guest.tabId) post(port, approvalCard(approval));
  }
  port.onMessage.addListener((raw) => {
    const message = record(raw);
    if (message && handleBrowserRequest(port, guest, message)) return;
    if (
      message?.type === "browser-approval-decision" &&
      typeof message.id === "string" &&
      (message.decision === "approve" || message.decision === "allow-origin" || message.decision === "deny")
    ) {
      // Only the messenger in the approval's own tab can answer it.
      if (pendingApprovals.get(message.id)?.tabId === guest.tabId)
        settleApproval(message.id, message.decision);
      return;
    }
    if (message?.type === "remote-access-configure") {
      void configureRemoteAccess(message.configuration);
      return;
    }
    if (message?.type === "remote-access-pairing-request") {
      void requestRemotePairing();
      return;
    }
    if (message?.type === "remote-access-revoke-request") {
      void revokeRemoteDevices();
      return;
    }
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

chrome.runtime.onMessage.addListener((raw, sender, respond) => {
  const message = record(raw);
  if (message?.type === "vibewaiting:surface-id" && typeof message.tabId === "number") {
    // A fresh target id for each document's in-page connection, minted here
    // for the tab and document Chrome named (relayed by the offscreen document).
    if (sender.tab || sender.url !== chrome.runtime.getURL("offscreen.html")) return;
    respond({ id: crypto.randomUUID(), order: ++surfaceMintOrder });
    return;
  }
  if (message?.type === "vibewaiting:tab-state" && typeof message.tabId === "number") {
    // The Playwright host's last check before input, relayed by the offscreen
    // document: the tab as Chrome sees it.
    if (sender.tab || sender.url !== chrome.runtime.getURL("offscreen.html")) return;
    void chrome.tabs.get(message.tabId).then(
      (tab) => respond({ url: tab.url, ...(tab.pendingUrl ? { pendingUrl: tab.pendingUrl } : {}) }),
      () => respond(null),
    );
    return true;
  }
  if (message?.type === "settings-changed") {
    disconnectNative();
    void ensureNative();
    return;
  }
  if (message?.type === "site-access-changed")
    return syncSiteAccess(message.enabled === true).then(
      () => ({ ok: true }),
      (error) => ({
        ok: false,
        error:
          error instanceof Error ? error.message : "website access sync failed",
      }),
    );
});

chrome.tabs.onRemoved.addListener((tabId) => {
  drivenTabs.delete(tabId);
  for (const key of [...allowances.keys()]) if (key.startsWith(`${tabId}\n`)) allowances.delete(key);
  for (const approval of [...pendingApprovals.values()])
    if (approval.tabId === tabId) settleApproval(approval.id, "closed");
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
