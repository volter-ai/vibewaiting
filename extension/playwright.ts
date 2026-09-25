/**
 * The extension's Playwright host, in a sandboxed extension page (Manifest V3
 * allows eval only there, and Playwright serializes its page functions). It
 * serves one AlmostCDP endpoint that each driven tab's main-world surface
 * attaches to, connects unmodified Playwright to it, and answers the agent's
 * `browser.*` operations with Supercode's Playwright executor. A tab whose
 * page forbids eval is instead its own Playwright connection over Chrome's
 * DevTools protocol, relayed from `chrome.debugger` by the background. The
 * offscreen document (offscreen.ts) is its only caller.
 *
 * No agent code runs in this realm: `browser.script` is answered by running
 * its source as JavaScript in the page (the page's own power), and the
 * executor's Playwright-script path is refused by the policy.
 */
import { createSocketEndpoint } from "@volter/almostcdp/socket";
import { MessagePortTransport } from "@volter/almostcdp/message-port";
import { connectPlaywright, messagePortTransport, pageFor, type Browser, type Page } from "@volter/almostcdp/playwright";
import { PlaywrightOperationExecutor, type PlaywrightAction } from "@volter-ai-dev/supercode-browser-playwright/executor";
import {
  BROWSER_OPERATION_NAMES,
  BrowserActionRefusal,
  parseBrowserOperationCall,
  type BrowserOperationName,
  type BrowserOperationResult,
} from "@volter-ai-dev/supercode-browser-playwright/protocol";
import { approvalFor, pageScriptApproval, sensitiveNodeIds, type BrowserApproval } from "./browser-policy.js";

/** Vibewaiting's own overlay in the page, which snapshots leave out. */
const OWN_OVERLAY = '[data-widget-shell-id="vibewaiting"]';
/** JavaScript run in the page must answer within this. */
const PAGE_SCRIPT_TIMEOUT_MS = 9_000;

const endpoint = createSocketEndpoint({ address: "vibewaiting.extension" });
let browser: Promise<Browser> | undefined;
/** Tabs driven over Chrome's debugger, by `debugger:<tabId>`: one browser each, holding that one page. */
const debuggerBrowsers = new Map<string, Promise<Browser>>();
const executors = new WeakMap<Page, PlaywrightOperationExecutor>();
// Operations on one page never interleave.
const queues = new Map<string, Promise<unknown>>();

/**
 * The person's approvals the background has offered, by single-use nonce
 * (relayed by the offscreen document): the approved action's key and its
 * tab. An operation names a nonce; the key never travels with it.
 */
const offers = new Map<string, { key: string; tabId: number }>();

/**
 * The person's one-time approval for the operation now running: it lets
 * exactly one matching action through, only during that operation.
 */
interface Grant { key: string; used: boolean }
interface Running {
  grant: Grant | null;
  approval: BrowserApproval | null;
  /** The origins the person allowed for this call's task on its tab. */
  allowed: readonly string[];
  /** The allowed origin an action of this call ran under, which the background marks as used. */
  allowanceUsed: string | null;
  tabId: number;
  inPage: boolean;
}
const running = new WeakMap<Page, Running>();

/** Nodes seen as sensitive fields on each page: they stay sensitive on their document. */
const sensitive = new WeakMap<Page, Set<number>>();

/**
 * Tabs with an approval the person has not answered, by tab id: the refused
 * action's summary. A call that starts on such a tab without the grant is
 * refused, even one queued before the card appeared; the background clears the
 * mark when the card is answered (`settled`), and the approved re-run clears
 * it as it starts.
 */
const awaiting = new Map<number, string>();

function decide(page: Page, call: Running | undefined, approval: BrowserApproval | null): void {
  if (!approval) return;
  if (call && !approval.onceOnly && call.allowed.includes(approval.origin)) {
    call.allowanceUsed = approval.origin;
    return;
  }
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

async function guard(page: Page, request: PlaywrightAction, inPage: boolean): Promise<void> {
  const call = running.get(page);
  let known = sensitive.get(page);
  if (!known) sensitive.set(page, known = new Set());
  if ("target" in request) for (const id of sensitiveNodeIds(request.target)) known.add(id);
  decide(page, call, approvalFor(request, page.url(), inPage, known));
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
 * The last check before input reaches the tab: the browser's own view of the
 * tab must show no navigation in flight and the origin the action was checked
 * on; on the in-page path the page's reported URL must be the tab's.
 */
async function beforeInput(page: Page, tabId: number, inPage: boolean, checked: string): Promise<void> {
  const tab = await tabState(tabId);
  if (!tab?.url) throw new BrowserActionRefusal("STALE_PAGE", "The tab could not be confirmed, so nothing was sent; ask again.");
  if (tab.pendingUrl)
    throw new BrowserActionRefusal("STALE_PAGE", "The tab is navigating, so nothing was sent; ask again once it has loaded.");
  if (originOf(tab.url) !== originOf(checked))
    throw new BrowserActionRefusal("STALE_PAGE", "The tab is on another site than the one the action was checked on, so nothing was sent; ask again.");
  if (inPage && withoutHash(tab.url) !== withoutHash(page.url()))
    throw new BrowserActionRefusal("STALE_PAGE", "The page reports a different address than the tab shows, so nothing was sent.");
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

/**
 * `browser.script`, answered as JavaScript in the page: the source is the
 * body of an async function of `args`, evaluated by the page itself. It asks
 * every time and can be allowed once only.
 */
async function pageScript(page: Page, call: unknown, state: Running): Promise<BrowserOperationResult> {
  const parsed = parseBrowserOperationCall(call);
  const source = typeof parsed?.input.source === "string" ? parsed.input.source : "";
  const args = (parsed?.input.args as Record<string, unknown> | undefined) ?? {};
  const target = async () => ({
    url: page.url(),
    title: await page.title().catch(() => ""),
    revision: 0,
  });
  try {
    decide(page, state, pageScriptApproval(source, args, page.url(), state.inPage));
    await beforeInput(page, state.tabId, state.inPage, page.url());
    const expression = `(async (args) => {\n${source}\n})(${JSON.stringify(args)})`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const value = await Promise.race([
      page.evaluate(expression),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new BrowserActionRefusal("TIMED_OUT", `The page's JavaScript did not finish in ${PAGE_SCRIPT_TIMEOUT_MS} ms.`)), PAGE_SCRIPT_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    return { ok: true, operation: "browser.script", target: await target(), value: { value } };
  } catch (error) {
    const code = error instanceof BrowserActionRefusal ? error.code : "FAILED";
    return {
      ok: false,
      operation: "browser.script",
      error: { code, message: error instanceof Error ? error.message : String(error) },
      target: await target(),
    };
  }
}

async function execute(
  target: string,
  tabId: number,
  call: unknown,
  grant: string | null,
  allowed: readonly string[],
): Promise<BrowserOperationResult & { approval?: BrowserApproval; allowanceUsed?: string }> {
  // A grant is a nonce the background issued for this tab; its key stays here.
  let key: string | null = null;
  if (grant !== null) {
    const offer = offers.get(grant);
    offers.delete(grant);
    if (!offer || offer.tabId !== tabId)
      return {
        ok: false,
        operation: operationOf(call),
        error: { code: "APPROVAL_REQUIRED", message: "The approval is no longer valid, so nothing ran." },
      };
    key = offer.key;
    awaiting.delete(tabId);
  }
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
  const inPage = !viaDebugger;
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
      syntheticEvents: inPage,
      endpoint: viaDebugger ? `Chrome ${connection.version()} (chrome.debugger)` : connection.version(),
      actionGuard: (request) => guard(page, request, inPage),
      beforeInput: ({ url }) => beforeInput(page, tabId, inPage, url),
      snapshotExclude: OWN_OVERLAY,
    });
    executors.set(page, executor);
  }
  const state: Running = {
    grant: key === null ? null : { key, used: false },
    approval: null,
    allowed,
    allowanceUsed: null,
    tabId,
    inPage,
  };
  running.set(page, state);
  try {
    const result = operationOf(call) === "browser.script" ? await pageScript(page, call, state) : await executor.execute(call);
    // A refusal on an approved re-run is final: the person is not asked twice for one call.
    if (!result.ok && result.error.code === "APPROVAL_REQUIRED" && state.approval && !state.grant) {
      awaiting.set(tabId, state.approval.summary);
      return { ...result, approval: state.approval };
    }
    return state.allowanceUsed ? { ...result, allowanceUsed: state.allowanceUsed } : result;
  } finally {
    if (running.get(page) === state) running.delete(page);
  }
}

window.addEventListener("message", (event) => {
  // Only the offscreen document's own messages: never one dispatched by script.
  if (!event.isTrusted || event.source !== window.parent) return;
  const message = event.data as {
    type?: unknown; target?: unknown; call?: unknown; grant?: unknown; tabId?: unknown; allowed?: unknown;
    nonce?: unknown; key?: unknown; id?: unknown;
  } | null;
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
  const port = event.ports[0];
  if (!port) return;
  if (message?.type === "surface") {
    // The offscreen document names the target this transport belongs to, from
    // Chrome's own sender: the surface is refused unless it is that target.
    if (typeof message.id !== "string") {
      port.close();
      return;
    }
    endpoint.attachSurface(new MessagePortTransport(port), { id: message.id });
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
    const allowed = Array.isArray(message.allowed) ? message.allowed.filter((origin): origin is string => typeof origin === "string") : [];
    const run = (queues.get(target) ?? Promise.resolve()).then(() => execute(target, tabId, message.call, grant, allowed));
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
