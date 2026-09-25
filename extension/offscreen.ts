/**
 * The offscreen document that keeps the Playwright host (playwright.html, a
 * sandboxed page without extension APIs) alive across the tabs' navigations,
 * and connects it to them: each driven tab's surface port, relayed by the
 * tab's content script, a tab's debugger relay from the background, and the
 * background's operation requests.
 */
import type { BrowserOperationResult } from "@volter-ai-dev/supercode-browser-playwright/protocol";

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

/** Each tab's surface identity: the target id Playwright finds it by, and its succession token. */
const surfaces = new Map<number, { id: string; token: string }>();
function surfaceOf(tabId: number): { id: string; token: string } {
  let surface = surfaces.get(tabId);
  if (!surface) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    surface = { id: crypto.randomUUID(), token: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("") };
    surfaces.set(tabId, surface);
  }
  return surface;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "vibewaiting:surface") return;
  const tabId = port.sender?.tab?.id;
  if (typeof tabId !== "number" || port.sender?.frameId !== 0) {
    port.disconnect();
    return;
  }
  const channel = new MessageChannel();
  channel.port1.onmessage = (event) => {
    try { port.postMessage(event.data); } catch { /* The document is gone; its disconnect follows. */ }
  };
  port.onMessage.addListener((message) => channel.port1.postMessage(message));
  port.onDisconnect.addListener(() => {
    channel.port1.postMessage({ type: "close" });
    channel.port1.close();
  });
  void ready.then((host) => {
    host.postMessage({ type: "surface" }, "*", [channel.port2]);
    port.postMessage({ type: "hello", ...surfaceOf(tabId) });
  });
});

/**
 * A tab driven over Chrome's debugger (the background's relay, reached by a
 * runtime port) is its own Playwright connection in the host, named by
 * `debugger:<tabId>`.
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
  host.postMessage({ type: "debugger", target }, "*", [channel.port2]);
  return target;
}

/**
 * The person's approvals the background has offered, by single-use nonce:
 * the approved action's key and its tab. A grant is honoured once, only with
 * its nonce, only for its tab.
 */
const grantOffers = new Map<string, { key: string; tabId: number }>();

/** Only the background (an extension context without a tab) drives the Playwright host. */
function fromBackground(sender: MessageSender): boolean {
  return sender.id === chrome.runtime.id && !sender.tab && sender.url === chrome.runtime.getURL("background.js");
}

chrome.runtime.onMessage.addListener((raw, sender, respond) => {
  const message = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : null;
  if (!fromBackground(sender)) return false;
  if (message?.type === "vibewaiting:grant-offer" && typeof message.nonce === "string" &&
    typeof message.key === "string" && typeof message.tabId === "number") {
    grantOffers.set(message.nonce, { key: message.key, tabId: message.tabId });
    return false;
  }
  if (message?.type === "vibewaiting:grant-revoke" && typeof message.nonce === "string") {
    grantOffers.delete(message.nonce);
    return false;
  }
  if (message?.type !== "vibewaiting:browser-operation" || typeof message.tabId !== "number") return false;
  const tabId = message.tabId;
  let grant: string | undefined;
  if (message.grant !== undefined) {
    const offer = typeof message.grant === "string" ? grantOffers.get(message.grant) : undefined;
    if (typeof message.grant === "string") grantOffers.delete(message.grant);
    if (!offer || offer.tabId !== tabId) {
      respond({
        ok: false,
        operation: typeof (message.call as { operation?: unknown } | null)?.operation === "string"
          ? (message.call as { operation: string }).operation : "browser.status",
        error: { code: "APPROVAL_REQUIRED", message: "The approval is no longer valid, so nothing ran." },
      });
      return false;
    }
    grant = offer.key;
  }
  const reply = new MessageChannel();
  reply.port1.onmessage = (event) => {
    respond(event.data as BrowserOperationResult);
    reply.port1.close();
  };
  void ready.then((host) => {
    const target = message.via === "debugger" ? debuggerTarget(host, tabId) : surfaceOf(tabId).id;
    host.postMessage({ type: "operation", target, call: message.call, grant }, "*", [reply.port2]);
  });
  return true;
});
