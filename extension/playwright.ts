/**
 * The extension's Playwright host, in a sandboxed extension page (Manifest V3
 * allows eval only there, and Playwright compiles scripts and serializes its
 * page functions). It serves one AlmostCDP endpoint that each driven tab's
 * main-world surface attaches to, connects unmodified Playwright to it, and
 * answers the agent's `browser.*` operations with Supercode's Playwright
 * executor. A tab whose page forbids eval is instead its own Playwright
 * connection over Chrome's DevTools protocol, relayed from `chrome.debugger`
 * by the background. The offscreen document (offscreen.ts) is its only caller.
 */
import { createSocketEndpoint } from "@volter/almostcdp/socket";
import { MessagePortTransport } from "@volter/almostcdp/message-port";
import { connectPlaywright, messagePortTransport, pageFor, type Browser, type Page } from "@volter/almostcdp/playwright";
import { PlaywrightOperationExecutor } from "@volter-ai-dev/supercode-browser-playwright/executor";
import {
  BROWSER_OPERATION_NAMES,
  type BrowserOperationName,
  type BrowserOperationResult,
} from "@volter-ai-dev/supercode-browser-playwright/protocol";
import { guardBrowserAction } from "./browser-policy.js";

/** Vibewaiting's own overlay in the page, which snapshots leave out. */
const OWN_OVERLAY = '[data-widget-shell-id="vibewaiting"]';

const endpoint = createSocketEndpoint({ address: "vibewaiting.extension" });
let browser: Promise<Browser> | undefined;
/** Tabs driven over Chrome's debugger, by `debugger:<tabId>`: one browser each, holding that one page. */
const debuggerBrowsers = new Map<string, Promise<Browser>>();
const executors = new WeakMap<Page, PlaywrightOperationExecutor>();
// Operations on one page never interleave.
const queues = new Map<string, Promise<unknown>>();

function connected(): Promise<Browser> {
  browser ??= connectPlaywright(endpoint).then((connection) => {
    connection.on("disconnected", () => { browser = undefined; });
    return connection;
  }, (error: unknown) => {
    browser = undefined;
    throw error;
  });
  return browser;
}

function operationOf(call: unknown): BrowserOperationName {
  const name = typeof call === "object" && call !== null ? (call as { operation?: unknown }).operation : undefined;
  return (BROWSER_OPERATION_NAMES as readonly unknown[]).includes(name) ? name as BrowserOperationName : "browser.status";
}

async function execute(target: string, call: unknown): Promise<BrowserOperationResult> {
  let page: Page;
  let connection: Browser;
  const viaDebugger = debuggerBrowsers.get(target);
  try {
    connection = await (viaDebugger ?? connected());
    page = await pageFor(connection, viaDebugger ? undefined : target);
  } catch (error) {
    return {
      ok: false,
      operation: operationOf(call),
      error: { code: "NOT_AVAILABLE", message: `The page is not reachable: ${error instanceof Error ? error.message : String(error)}` },
    };
  }
  let executor = executors.get(page);
  if (!executor) {
    executor = new PlaywrightOperationExecutor(page, {
      syntheticEvents: !viaDebugger,
      endpoint: viaDebugger ? `Chrome ${connection.version()} (chrome.debugger)` : connection.version(),
      actionGuard: guardBrowserAction,
      snapshotExclude: OWN_OVERLAY,
    });
    executors.set(page, executor);
  }
  return await executor.execute(call);
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const message = event.data as { type?: unknown; target?: unknown; call?: unknown } | null;
  const port = event.ports[0];
  if (!port) return;
  if (message?.type === "surface") {
    endpoint.attachSurface(new MessagePortTransport(port));
    return;
  }
  if (message?.type === "debugger" && typeof message.target === "string") {
    const target = message.target;
    const connection = connectPlaywright(messagePortTransport(port)).then((opened) => {
      opened.on("disconnected", () => { if (debuggerBrowsers.get(target) === connection) debuggerBrowsers.delete(target); });
      return opened;
    });
    debuggerBrowsers.set(target, connection);
    connection.catch(() => { if (debuggerBrowsers.get(target) === connection) debuggerBrowsers.delete(target); });
    return;
  }
  if (message?.type === "operation" && typeof message.target === "string") {
    const target = message.target;
    const run = (queues.get(target) ?? Promise.resolve()).then(() => execute(target, message.call));
    const settled = run.catch(() => undefined);
    queues.set(target, settled);
    void settled.then(() => { if (queues.get(target) === settled) queues.delete(target); });
    void run.then((result) => port.postMessage(result), (error: unknown) => port.postMessage({
      ok: false,
      operation: operationOf(message.call),
      error: { code: "FAILED", message: error instanceof Error ? error.message : String(error) },
    } satisfies BrowserOperationResult));
  }
});
window.parent.postMessage({ type: "ready" }, "*");
