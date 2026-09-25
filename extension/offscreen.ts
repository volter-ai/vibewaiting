/**
 * The offscreen document that keeps the Playwright host (playwright.html, a
 * sandboxed page without extension APIs) alive across the tabs' navigations,
 * and connects it to them: each driven tab's surface port, relayed by the
 * tab's content script, a tab's debugger relay from the background, and the
 * background's tool calls.
 */

const frame = document.createElement("iframe");
frame.src = "playwright.html";
frame.title = "Playwright host";
const ready = new Promise<Window>((resolve) => {
  window.addEventListener("message", (event) => {
    if (event.source === frame.contentWindow && (event.data as { type?: unknown } | null)?.type === "ready")
      resolve(frame.contentWindow!);
  });
});
document.body.append(frame);

/**
 * Each tab's current surface: the target Playwright finds the tab's document
 * by. The background mints the tab's id once, for the tab Chrome gives the
 * document's port (never from anything the page says); each new document of
 * the tab connects as that target's successor, in the tab's own endpoint, and
 * the latest document to connect is the current one.
 */
const currentSurface = new Map<number, { id: string; order: number }>();
const surfaceWaiters = new Map<number, Array<(id: string) => void>>();
/**
 * Each tab's AlmostCDP target id, minted here once for the tab Chrome names as
 * the port's sender (never from anything the page says), and kept as long as
 * this document and its Playwright host live: each new document of the tab
 * connects as that target's successor, so Playwright sees one page navigate.
 * Connections are numbered in the order they arrive; the latest is the tab's.
 */
const tabTargets = new Map<number, string>();
let surfaceOrder = 0;
function surfaceIdFor(tabId: number): { id: string; order: number } {
  let id = tabTargets.get(tabId);
  if (!id) tabTargets.set(tabId, id = crypto.randomUUID());
  return { id, order: ++surfaceOrder };
}
/** The tab's current surface id, waiting briefly for a document that is still connecting. */
function surfaceOf(tabId: number): Promise<string | null> {
  const current = currentSurface.get(tabId);
  if (current) return Promise.resolve(current.id);
  return new Promise((resolve) => {
    const waiters = surfaceWaiters.get(tabId) ?? [];
    const timer = setTimeout(() => resolve(null), 5_000);
    waiters.push((next) => { clearTimeout(timer); resolve(next); });
    surfaceWaiters.set(tabId, waiters);
  });
}

/** Each document's succession token: fresh per document, the previous one retired. */
const documentTokens = new Map<number, { documentId: string | undefined; token: string }>();
function tokenFor(tabId: number, documentId: string | undefined): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  documentTokens.set(tabId, { documentId, token });
  return token;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "vibewaiting:surface") return;
  const tabId = port.sender?.tab?.id;
  if (typeof tabId !== "number" || port.sender?.frameId !== 0) {
    port.disconnect();
    return;
  }
  const documentId = port.sender?.documentId;
  let surfaceOrder: number | null = null;
  let connected = true;
  const channel = new MessageChannel();
  channel.port1.onmessage = (event) => {
    try { port.postMessage(event.data); } catch { /* The document is gone; its disconnect follows. */ }
  };
  port.onMessage.addListener((message) => channel.port1.postMessage(message));
  port.onDisconnect.addListener(() => {
    channel.port1.postMessage({ type: "close" });
    channel.port1.close();
    if (documentTokens.get(tabId)?.documentId === documentId) documentTokens.delete(tabId);
    connected = false;
    // The document is gone; a successor that already connected stays the tab's target.
    if (surfaceOrder !== null && currentSurface.get(tabId)?.order === surfaceOrder) currentSurface.delete(tabId);
  });
  const minted = surfaceIdFor(tabId);
  void ready.then((host) => {
    // Ids arrive asynchronously: a document that has gone, or whose id is
    // older than the tab's current one, never becomes the tab's target.
    const stale = !connected || (currentSurface.get(tabId)?.order ?? -1) > minted.order;
    if (stale) {
      if (connected) port.disconnect();
      return;
    }
    const id = minted.id;
    surfaceOrder = minted.order;
    host.postMessage({ type: "surface", tabId, id }, "*", [channel.port2]);
    port.postMessage({ type: "hello", id, token: tokenFor(tabId, documentId) });
    currentSurface.set(tabId, { id, order: minted.order });
    for (const waiter of surfaceWaiters.get(tabId) ?? []) waiter(id);
    surfaceWaiters.delete(tabId);
  });
});

/**
 * A tab driven over Chrome's debugger (the background's relay, reached by a
 * runtime port) is its own Playwright connection in the host, for that
 * tab; `debugger:<tabId>` names it here.
 */
const debuggerTabs = new Map<number, string>();
function debuggerTarget(host: Window, tabId: number): string {
  let target = debuggerTabs.get(tabId);
  if (target) return target;
  target = `debugger:${tabId}`;
  debuggerTabs.set(tabId, target);
  const relay = chrome.runtime.connect({ name: "vibewaiting:cdp" });
  relay.postMessage({ type: "attach", tabId });
  const channel = new MessageChannel();
  const close = (): void => {
    if (debuggerTabs.get(tabId) !== target) return;
    debuggerTabs.delete(tabId);
    channel.port1.postMessage({ type: "close" });
    channel.port1.close();
  };
  channel.port1.onmessage = (event) => {
    const message = event.data as { type?: unknown } | null;
    if (message?.type === "close") {
      relay.disconnect();
      close();
      return;
    }
    try { relay.postMessage(event.data); } catch { close(); }
  };
  relay.onMessage.addListener((message) => {
    if ((message as { type?: unknown } | null)?.type === "close") close();
    else channel.port1.postMessage(message);
  });
  relay.onDisconnect.addListener(close);
  host.postMessage({ type: "debugger", tabId }, "*", [channel.port2]);
  return target;
}

/** Calls waiting here for their tab's document, and those of them the agent stopped waiting for. */
const routingCalls = new Set<string>();
const cancelledCalls = new Set<string>();

/** Only the background (an extension context without a tab) drives the Playwright host. */
function fromBackground(sender: MessageSender): boolean {
  return sender.id === chrome.runtime.id && !sender.tab && sender.url === chrome.runtime.getURL("background.js");
}

// The Playwright host's one question for the browser: the tab as Chrome sees
// it (its URL, and a navigation in flight), asked just before input.
window.addEventListener("message", (event) => {
  const message = event.data as { type?: unknown; tabId?: unknown } | null;
  const port = event.ports[0];
  if (!event.isTrusted || event.source !== frame.contentWindow || message?.type !== "tab-state" ||
    typeof message.tabId !== "number" || !port) return;
  void chrome.runtime.sendMessage({ type: "vibewaiting:tab-state", tabId: message.tabId })
    .then((state) => port.postMessage(state ?? null), () => port.postMessage(null))
    .finally(() => port.close());
});

chrome.runtime.onMessage.addListener((raw, sender, respond) => {
  const message = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : null;
  if (!fromBackground(sender)) return false;
  // The person's approvals: the nonce and the approved action's key go to the
  // host, which honours a nonce once, for its tab.
  if (message?.type === "vibewaiting:grant-offer" && typeof message.nonce === "string" &&
    typeof message.key === "string" && typeof message.tabId === "number") {
    const offer = { type: "grant-offer", nonce: message.nonce, key: message.key, tabId: message.tabId };
    void ready.then((host) => host.postMessage(offer, "*"));
    return false;
  }
  if (message?.type === "vibewaiting:grant-revoke" && typeof message.nonce === "string") {
    const nonce = message.nonce;
    void ready.then((host) => host.postMessage({ type: "grant-revoke", nonce }, "*"));
    return false;
  }
  if (message?.type === "vibewaiting:operation-cancel" && typeof message.id === "string") {
    const id = message.id;
    // A call still waiting here for its tab's document never reaches the host.
    if (routingCalls.has(id)) cancelledCalls.add(id);
    void ready.then((host) => host.postMessage({ type: "cancel", id }, "*"));
    return false;
  }
  if (message?.type === "vibewaiting:tab-closed" && typeof message.tabId === "number") {
    const tabId = message.tabId;
    tabTargets.delete(tabId);
    void ready.then((host) => host.postMessage({ type: "tab-closed", tabId }, "*"));
    return false;
  }
  if (message?.type === "vibewaiting:approval-settled" && typeof message.tabId === "number") {
    // The person answered (or no one will): calls on the tab may run again.
    const tabId = message.tabId;
    void ready.then((host) => host.postMessage({ type: "settled", tabId }, "*"));
    return false;
  }
  if (message?.type !== "vibewaiting:browser-operation" || typeof message.tabId !== "number" || typeof message.id !== "string") return false;
  const tabId = message.tabId;
  const grant = typeof message.grant === "string" ? message.grant : undefined;
  const reply = new MessageChannel();
  reply.port1.onmessage = (event) => {
    respond(event.data);
    reply.port1.close();
  };
  const id = message.id;
  routingCalls.add(id);
  void ready.then(async (host) => {
    // A tab with no connected document has no target: never another page.
    const target = message.via === "debugger" ? debuggerTarget(host, tabId) : await surfaceOf(tabId) ?? `none:${tabId}`;
    // From here the host has the call, and hears its cancellation itself.
    const stopped = cancelledCalls.has(id);
    routingCalls.delete(id);
    cancelledCalls.delete(id);
    if (stopped) {
      reply.port1.close();
      respond({ result: { content: [{ type: "text", text: "### Error\nThe agent stopped waiting for this call, so it did not run." }], isError: true } });
      return;
    }
    // The origins the person allowed for this call's task on this tab (background.ts).
    const allowed = Array.isArray(message.allowed) ? message.allowed.filter((origin) => typeof origin === "string") : [];
    host.postMessage({ type: "operation", id, target, tabId, via: message.via === "debugger" ? "debugger" : "surface", call: message.call, grant, allowed }, "*", [reply.port2]);
  });
  return true;
});
