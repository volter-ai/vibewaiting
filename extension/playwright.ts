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
import { BrowserActionRefusal } from "@volter-ai-dev/supercode-browser-playwright/protocol";
import type { PlaywrightAction } from "@volter-ai-dev/supercode-browser-playwright/executor";
import { approvalFor, type BrowserApproval } from "./browser-policy.js";

/** Vibewaiting's own overlay in the page, which snapshots leave out. */
const OWN_OVERLAY = '[data-widget-shell-id="vibewaiting"]';

const endpoint = createSocketEndpoint({ address: "vibewaiting.extension" });
let browser: Promise<Browser> | undefined;
/** Tabs driven over Chrome's debugger, by `debugger:<tabId>`: one browser each, holding that one page. */
const debuggerBrowsers = new Map<string, Promise<Browser>>();
const executors = new WeakMap<Page, PlaywrightOperationExecutor>();
// Operations on one page never interleave.
const queues = new Map<string, Promise<unknown>>();

/**
 * The person's one-time approval for the operation now running: the approved
 * action's key, from the refusal that asked for it. It lets exactly one
 * matching action through, only during the re-run of that operation on that
 * tab (the background binds it to the operation id and tab); nothing is
 * approved standing.
 */
interface Grant { key: string; used: boolean }
interface Running { grant: Grant | null; approval: BrowserApproval | null }
const running = new WeakMap<Page, Running>();

/**
 * Tabs with an approval the person has not answered, by tab id: the refused
 * action's summary. A call that starts on such a tab without the grant is
 * refused, even one queued before the card appeared; the background clears the
 * mark when the card is answered (`settled`), and the approved re-run clears
 * it as it starts.
 */
const awaiting = new Map<number, string>();

async function guard(page: Page, request: PlaywrightAction, inPage: boolean): Promise<void> {
  const approval = approvalFor(request, page.url(), inPage);
  if (!approval) return;
  const call = running.get(page);
  if (call?.grant && !call.grant.used && call.grant.key === approval.key) {
    call.grant.used = true;
    return;
  }
  if (call) call.approval ??= approval;
  throw new BrowserActionRefusal(
    "APPROVAL_REQUIRED",
    call?.grant
      ? `${approval.summary} was not the action the person approved (the page changed), so it did not run.`
      : approval.reason,
  );
}

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

async function execute(
  target: string,
  tabId: number,
  call: unknown,
  grant: string | null,
): Promise<BrowserOperationResult & { approval?: BrowserApproval }> {
  if (grant !== null) awaiting.delete(tabId);
  const deciding = awaiting.get(tabId);
  if (deciding !== undefined)
    return {
      ok: false,
      operation: operationOf(call),
      error: {
        code: "APPROVAL_REQUIRED",
        message: `Waiting for the person's decision on “${deciding}” in Vibewaiting; no other browser operation runs on this tab until they answer (this call was already queued when the card appeared).`,
      },
    };
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
      actionGuard: (request) => guard(page, request, !viaDebugger),
      snapshotExclude: OWN_OVERLAY,
    });
    executors.set(page, executor);
  }
  const state: Running = { grant: grant === null ? null : { key: grant, used: false }, approval: null };
  running.set(page, state);
  try {
    const result = await executor.execute(call);
    // A refusal on an approved re-run is final: the person is not asked twice for one call.
    if (!result.ok && result.error.code === "APPROVAL_REQUIRED" && state.approval && !state.grant) {
      awaiting.set(tabId, state.approval.summary);
      return { ...result, approval: state.approval };
    }
    return result;
  } finally {
    if (running.get(page) === state) running.delete(page);
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const message = event.data as { type?: unknown; target?: unknown; call?: unknown; grant?: unknown; tabId?: unknown } | null;
  if (message?.type === "settled" && typeof message.tabId === "number") {
    awaiting.delete(message.tabId);
    return;
  }
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
  if (message?.type === "operation" && typeof message.target === "string" && typeof message.tabId === "number") {
    const target = message.target;
    const tabId = message.tabId;
    const grant = typeof message.grant === "string" ? message.grant : null;
    const run = (queues.get(target) ?? Promise.resolve()).then(() => execute(target, tabId, message.call, grant));
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
