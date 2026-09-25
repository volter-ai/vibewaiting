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
 * by. The background mints a fresh id for every document, from the identity
 * Chrome gives the document's port (its tab, top frame and document), never
 * from anything the page says, and the Playwright host binds the connection
 * to that id. An operation on a tab goes to its current document's id only.
 */
const currentSurface = new Map<number, { id: string; order: number }>();
const surfaceWaiters = new Map<number, Array<(id: string) => void>>();
function surfaceIdFor(tabId: number, documentId: string | undefined): Promise<{ id: string; order: number } | null> {
  return chrome.runtime.sendMessage({ type: "vibewaiting:surface-id", tabId, documentId })
    .then((minted) => {
      const { id, order } = (minted ?? {}) as { id?: unknown; order?: unknown };
      return typeof id === "string" && typeof order === "number" ? { id, order } : null;
    }, () => null);
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
  let surfaceId: string | null = null;
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
    // The document is gone: its id is no one's target any more.
    if (currentSurface.get(tabId)?.id === surfaceId) currentSurface.delete(tabId);
  });
  void Promise.all([ready, surfaceIdFor(tabId, documentId)]).then(([host, minted]) => {
    // Ids arrive asynchronously: a document that has gone, or whose id is
    // older than the tab's current one, never becomes the tab's target.
    const stale = !minted || !connected || (currentSurface.get(tabId)?.order ?? -1) > minted.order;
    if (stale) {
      if (connected) port.disconnect();
      return;
    }
    const id = minted.id;
    surfaceId = id;
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
  if (message?.type === "vibewaiting:tab-closed" && typeof message.tabId === "number") {
    const tabId = message.tabId;
    void ready.then((host) => host.postMessage({ type: "tab-closed", tabId }, "*"));
    return false;
  }
  if (message?.type === "vibewaiting:approval-settled" && typeof message.tabId === "number") {
    // The person answered (or no one will): calls on the tab may run again.
    const tabId = message.tabId;
    void ready.then((host) => host.postMessage({ type: "settled", tabId }, "*"));
    return false;
  }
  if (message?.type !== "vibewaiting:browser-operation" || typeof message.tabId !== "number") return false;
  const tabId = message.tabId;
  const grant = typeof message.grant === "string" ? message.grant : undefined;
  const reply = new MessageChannel();
  reply.port1.onmessage = (event) => {
    respond(event.data);
    reply.port1.close();
  };
  void ready.then(async (host) => {
    // A tab with no connected document has no target: never another page.
    const target = message.via === "debugger" ? debuggerTarget(host, tabId) : await surfaceOf(tabId) ?? `none:${tabId}`;
    // The origins the person allowed for this call's task on this tab (background.ts).
    const allowed = Array.isArray(message.allowed) ? message.allowed.filter((origin) => typeof origin === "string") : [];
    host.postMessage({ type: "operation", target, tabId, via: message.via === "debugger" ? "debugger" : "surface", call: message.call, grant, allowed }, "*", [reply.port2]);
  });
  return true;
});
