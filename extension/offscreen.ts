/**
 * The offscreen document that keeps the Playwright host (playwright.html, a
 * sandboxed page without extension APIs) alive across the tabs' navigations,
 * and connects it to them: each driven tab's surface port, relayed by the
 * tab's content script, and the background's operation requests.
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

chrome.runtime.onMessage.addListener((raw, _sender, respond) => {
  const message = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : null;
  if (message?.type !== "vibewaiting:browser-operation" || typeof message.tabId !== "number") return false;
  const target = surfaceOf(message.tabId).id;
  const reply = new MessageChannel();
  reply.port1.onmessage = (event) => {
    respond(event.data as BrowserOperationResult);
    reply.port1.close();
  };
  void ready.then((host) => host.postMessage({ type: "operation", target, call: message.call }, "*", [reply.port2]));
  return true;
});
