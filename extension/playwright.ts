/**
 * The extension's Playwright host, in a sandboxed extension page (Manifest V3
 * allows eval only there, and Playwright serializes its page functions). Each
 * driven tab is one browser to Playwright: an AlmostCDP endpoint that tab's
 * main-world surfaces attach to (one per document), or, for a page that
 * forbids eval, Chrome's own DevTools protocol relayed from `chrome.debugger`
 * by the background. The agent's tool calls are answered by Playwright's own
 * MCP tool backend over that browser, after the policy (browser-policy.ts) has
 * asked the person where it must. The offscreen document (offscreen.ts) is its
 * only caller.
 *
 * No agent code runs here or in the page: the tools that run code are not
 * served (SERVED_BROWSER_TOOLS).
 */
import { createSocketEndpoint, type SocketEndpoint } from "@volter/almostcdp/socket";
import { MessagePortTransport } from "@volter/almostcdp/message-port";
import {
  connectPlaywright,
  createPlaywrightMcpBackend,
  messagePortTransport,
  pageFor,
  playwrightMcpTools,
  type Browser,
  type Page,
  type PlaywrightMcpBackend,
} from "@volter/almostcdp/playwright";
import { browserToolError, parseBrowserToolCall, servedBrowserTool, type BrowserToolResult } from "../src/browser-tools.js";
import { approvalFor, BrowserRefusal, restoreFocus, type BrowserApproval, type OpenDialog } from "./browser-policy.js";

const tools = playwrightMcpTools().filter((tool) => servedBrowserTool(tool.schema.name));

/** One driven tab: its browser to Playwright, and the tool backend over it. */
interface Driven {
  /** The tab's AlmostCDP endpoint; its documents' surfaces attach to it. None for a debugger tab. */
  endpoint: SocketEndpoint | null;
  browser: Promise<Browser> | null;
  backend: Promise<PlaywrightMcpBackend> | null;
  /** A debugger tab's relay port: closing it detaches Chrome's debugger. */
  relay: MessagePort | null;
}
const surfaceTabs = new Map<number, Driven>();
const debuggerTabs = new Map<number, Driven>();
// Calls on one tab never interleave.
const queues = new Map<number, Promise<unknown>>();

/**
 * The person's approvals the background has offered, by single-use nonce
 * (relayed by the offscreen document): the approved call's key and its tab.
 * A call names a nonce; the key never travels with it.
 */
const offers = new Map<string, { key: string; tabId: number }>();

/**
 * Tabs with an approval the person has not answered, by tab id: the refused
 * call's summary. A call that starts on such a tab without the grant is
 * refused, even one queued before the card appeared; the background clears the
 * mark when the card is answered (`settled`), and the approved re-run clears
 * it as it starts.
 */
const awaiting = new Map<number, string>();

/**
 * Calls the agent stopped waiting for (cancelled, or timed out in the
 * background), by call id: a queued one never starts, and a running one can
 * send no further input: the page's input gate closes (surface.ts), or the
 * debugger detaches.
 */
const cancelled = new Set<string>();
const running = new Map<string, () => void>();

const INPUT_GATE = Symbol.for("vibewaiting.input-gate");
function setGate(page: Page, open: boolean): Promise<void> {
  return page.evaluate(([gate, value]) => {
    (window as unknown as Record<symbol, unknown>)[Symbol.for(gate)] = value;
  }, [INPUT_GATE.description!, open] as const);
}
/** Calls from queueing until they answer. */
const inFlight = new Set<string>();

/** The dialog each page shows, which an approval to answer it names. */
const dialogs = new WeakMap<Page, OpenDialog | null>();
let dialogSequence = 0;
function watchDialogs(page: Page): void {
  if (dialogs.has(page)) return;
  dialogs.set(page, null);
  page.on("dialog", (dialog) => { dialogs.set(page, { type: dialog.type(), message: dialog.message(), sequence: ++dialogSequence }); });
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) dialogs.set(page, null); });
}

/** A call's answer to the background: the tool's result, and what the policy decided. */
interface Answer {
  result: BrowserToolResult;
  /** The approval a refused call asks for, which the background shows as a card. */
  approval?: BrowserApproval;
  /** The allowed origin this call ran under, which the background marks as used. */
  allowanceUsed?: string;
}

/** Without a fragment: a same-document change is not a different page. */
function withoutHash(url: string): string {
  const hash = url.indexOf("#");
  return hash < 0 ? url : url.slice(0, hash);
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** The tab as the browser sees it (through the offscreen document and the background). */
function tabState(tabId: number): Promise<{ url?: string; pendingUrl?: string } | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 2_000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data as { url?: string; pendingUrl?: string } | null);
    };
    window.parent.postMessage({ type: "tab-state", tabId }, "*", [channel.port2]);
  });
}

/**
 * The last check before a call that acts reaches the tab: the browser's own
 * view of the tab must show no navigation in flight and the origin the call was
 * checked on; on the in-page path the page's reported URL must be the tab's.
 */
async function stale(page: Page, tabId: number, inPage: boolean, checked: string): Promise<string | null> {
  const tab = await tabState(tabId);
  if (!tab?.url) return "The tab could not be confirmed, so nothing was sent; ask again.";
  if (tab.pendingUrl) return "The tab is navigating, so nothing was sent; ask again once it has loaded.";
  if (originOf(tab.url) !== originOf(checked))
    return "The tab is on another site than the one the call was checked on, so nothing was sent; ask again.";
  if (inPage && withoutHash(tab.url) !== withoutHash(page.url()))
    return "The page reports a different address than the tab shows, so nothing was sent.";
  return null;
}

function browserOf(driven: Driven, connect: () => Promise<Browser>): Promise<Browser> {
  driven.browser ??= connect().then((browser) => {
    browser.on("disconnected", () => {
      void driven.backend?.then((backend) => backend.dispose()).catch(() => undefined);
      driven.browser = null;
      driven.backend = null;
    });
    return browser;
  }, (error: unknown) => {
    driven.browser = null;
    throw error;
  });
  return driven.browser;
}

function backendOf(driven: Driven, browser: Browser): Promise<PlaywrightMcpBackend> {
  const context = browser.contexts()[0];
  if (!context) return Promise.reject(new Error("The tab's browser has no page."));
  driven.backend ??= createPlaywrightMcpBackend(context, tools).catch((error: unknown) => {
    driven.backend = null;
    throw error;
  });
  return driven.backend;
}

async function execute(
  id: string,
  target: string,
  tabId: number,
  via: "surface" | "debugger",
  rawCall: unknown,
  grant: string | null,
  allowed: readonly string[],
): Promise<Answer> {
  if (cancelled.delete(id)) return { result: browserToolError("The agent stopped waiting for this call, so it did not run.") };
  const call = parseBrowserToolCall(rawCall);
  if (!call) return { result: browserToolError("Vibewaiting does not serve that tool.") };
  // A grant is a nonce the background issued for this tab; its key stays here.
  let key: string | null = null;
  if (grant !== null) {
    const offer = offers.get(grant);
    offers.delete(grant);
    if (!offer || offer.tabId !== tabId) return { result: browserToolError("The approval is no longer valid, so nothing ran.") };
    key = offer.key;
    awaiting.delete(tabId);
  }
  const deciding = awaiting.get(tabId);
  if (deciding !== undefined)
    return {
      result: browserToolError(`Waiting for the person's decision on “${deciding}” in Vibewaiting; no other browser call runs on this tab until they answer (this call was already queued when the card appeared).`),
    };
  const driven = via === "debugger" ? debuggerTabs.get(tabId) : surfaceTabs.get(tabId);
  if (!driven) return { result: browserToolError("The page is not reachable: the tab has no connected document.") };
  let page: Page;
  let backend: PlaywrightMcpBackend;
  try {
    const browser = await browserOf(driven, () => connectPlaywright(driven.endpoint!));
    page = await pageFor(browser, via === "debugger" ? undefined : target);
    watchDialogs(page);
    backend = await backendOf(driven, browser);
  } catch (error) {
    return { result: browserToolError(`The page is not reachable: ${error instanceof Error ? error.message : String(error)}`) };
  }
  let approval: BrowserApproval | null;
  try {
    if (key !== null) await restoreFocus(page, key);
    approval = await approvalFor(call, page, dialogs.get(page) ?? null);
  } catch (error) {
    if (error instanceof BrowserRefusal) return { result: browserToolError(error.message) };
    return { result: browserToolError(`The page could not describe what this call acts on, so nothing ran: ${error instanceof Error ? error.message : String(error)}`) };
  }
  let allowanceUsed: string | undefined;
  if (approval) {
    // An approved re-run runs only the exact action the card named, whichever
    // button the person pressed (Allow on <origin> also installed an allowance).
    if (key !== null) {
      if (key !== approval.key)
        return { result: browserToolError(`${approval.summary} was not the action the person approved (the page changed), so it did not run.`) };
    } else if (!approval.onceOnly && allowed.includes(approval.origin)) allowanceUsed = approval.origin;
    else {
      awaiting.set(tabId, approval.summary);
      return { result: browserToolError(approval.reason), approval };
    }
    const why = await stale(page, tabId, via === "surface", page.url());
    if (why) return { result: browserToolError(why) };
  }
  if (cancelled.delete(id)) return { result: browserToolError("The agent stopped waiting for this call, so it did not run.") };
  const controller = new AbortController();
  running.set(id, () => {
    controller.abort();
    if (via === "surface") void setGate(page, false).catch(() => undefined);
    else driven.relay?.postMessage({ type: "close", code: 1000, reason: "The agent stopped waiting" });
  });
  const dialogBefore = dialogs.get(page) ?? null;
  let result: BrowserToolResult;
  try {
    if (via === "surface") await setGate(page, true);
    result = await backend.callTool(call.tool, call.arguments, controller.signal);
  } finally {
    running.delete(id);
    if (via === "surface") await setGate(page, false).catch(() => undefined);
  }
  // Only the dialog this call answered is gone; one it opened stays.
  if (call.tool === "browser_handle_dialog" && !result.isError && dialogs.get(page) === dialogBefore) dialogs.set(page, null);
  return allowanceUsed ? { result, allowanceUsed } : { result };
}

window.addEventListener("message", (event) => {
  // Only the offscreen document's own messages: never one dispatched by script.
  if (!event.isTrusted || event.source !== window.parent) return;
  const message = event.data as {
    type?: unknown; target?: unknown; call?: unknown; grant?: unknown; tabId?: unknown; allowed?: unknown;
    nonce?: unknown; key?: unknown; id?: unknown; via?: unknown;
  } | null;
  if (message?.type === "cancel" && typeof message.id === "string") {
    const active = running.get(message.id);
    if (active) active();
    else if (inFlight.has(message.id)) cancelled.add(message.id);
    return;
  }
  if (message?.type === "settled" && typeof message.tabId === "number") {
    awaiting.delete(message.tabId);
    return;
  }
  if (message?.type === "grant-offer" && typeof message.nonce === "string" && typeof message.key === "string" &&
    typeof message.tabId === "number") {
    offers.set(message.nonce, { key: message.key, tabId: message.tabId });
    return;
  }
  if (message?.type === "grant-revoke" && typeof message.nonce === "string") {
    offers.delete(message.nonce);
    return;
  }
  if (message?.type === "tab-closed" && typeof message.tabId === "number") {
    for (const tabs of [surfaceTabs, debuggerTabs]) {
      const driven = tabs.get(message.tabId);
      tabs.delete(message.tabId);
      void driven?.backend?.then((backend) => backend.dispose()).catch(() => undefined);
      void driven?.browser?.then((browser) => browser.close()).catch(() => undefined);
      void driven?.endpoint?.close();
    }
    awaiting.delete(message.tabId);
    return;
  }
  const port = event.ports[0];
  if (!port || typeof message?.tabId !== "number") return;
  const tabId = message.tabId;
  if (message.type === "surface") {
    // The offscreen document names the target this transport belongs to, from
    // Chrome's own sender: the surface is refused unless it is that target.
    if (typeof message.id !== "string") {
      port.close();
      return;
    }
    let driven = surfaceTabs.get(tabId);
    if (!driven) {
      driven = { endpoint: createSocketEndpoint({ address: "vibewaiting.extension", requireExpect: true }), browser: null, backend: null, relay: null };
      surfaceTabs.set(tabId, driven);
    }
    driven.endpoint!.attachSurface(new MessagePortTransport(port), { id: message.id });
    return;
  }
  if (message.type === "debugger") {
    const driven: Driven = { endpoint: null, browser: null, backend: null, relay: port };
    debuggerTabs.set(tabId, driven);
    void browserOf(driven, () => connectPlaywright(messagePortTransport(port))).then((browser) => {
      browser.on("disconnected", () => { if (debuggerTabs.get(tabId) === driven) debuggerTabs.delete(tabId); });
    }, () => { if (debuggerTabs.get(tabId) === driven) debuggerTabs.delete(tabId); });
    return;
  }
  if (message.type === "operation" && typeof message.target === "string" && typeof message.id === "string") {
    const id = message.id;
    const target = message.target;
    const via = message.via === "debugger" ? "debugger" : "surface";
    const grant = typeof message.grant === "string" ? message.grant : null;
    const allowed = Array.isArray(message.allowed) ? message.allowed.filter((origin): origin is string => typeof origin === "string") : [];
    inFlight.add(id);
    const run = (queues.get(tabId) ?? Promise.resolve()).then(() => execute(id, target, tabId, via, message.call, grant, allowed))
      .finally(() => { inFlight.delete(id); cancelled.delete(id); });
    const settled = run.catch(() => undefined);
    queues.set(tabId, settled);
    void settled.then(() => { if (queues.get(tabId) === settled) queues.delete(tabId); });
    void run.then((answer) => port.postMessage(answer), (error: unknown) => port.postMessage({
      result: browserToolError(error instanceof Error ? error.message : String(error)),
    } satisfies Answer));
  }
});
window.parent.postMessage({ type: "ready" }, "*");
