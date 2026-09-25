/**
 * Vibewaiting's policy for an agent's tool calls in the person's own tab, after
 * Claude in Chrome's per-site permissions: every call that can change the page
 * or send it input asks the person, unless they allowed the tab's current
 * origin for this agent task (the Playwright host applies that allowance).
 * Reading never asks (snapshots, screenshots, finding text, waiting, hovering,
 * console reads). Navigating anywhere but an http or https address is refused. Some calls ask even on an allowed origin, and
 * can only be allowed once: typing into a sensitive field (a password,
 * one-time code or card field, or a field that was one earlier on this
 * document), and anything on a page without a real origin (about:, data:,
 * file:, blob:).
 *
 * Whether to ask never depends on what an element is called. The words on the
 * page only shape the card ("may submit, pay or delete"); the page describes
 * its own elements, and cards say so. Asked by the Playwright host before each
 * call (playwright.ts); the host asks the person (background.ts) and lets the
 * one approved call through.
 */
import type { Page } from "@volter/almostcdp/playwright";
import type { BrowserToolCall } from "../src/browser-tools.js";

/** An action that needs the person's approval, named as the person sees it. */
export interface BrowserApproval {
  /** The exact call and targets: identical only for the same call on the same elements of the same page. */
  key: string;
  /** "Click “Place order” on shop.example — may submit, pay or delete". */
  summary: string;
  /** Why it asks: the agent's refusal message. */
  reason: string;
  /** The origin "Allow on <origin> for this task" allows. */
  origin: string;
  /** Asks even on an allowed origin, and can only be allowed once. */
  onceOnly: boolean;
}

/** A call Vibewaiting refuses outright, whatever the person would say. */
export class BrowserRefusal extends Error {}

/** An element as the page describes it (run in the page by `describe`). */
interface Described {
  tag: string;
  /** Its accessible-ish names: label, aria-label, title, value, alt, placeholder, text. */
  names: string[];
  /** The names of the controls it sits in (a button, a link, a label). */
  controls: string[];
  /** "password", "one-time code", "card" or "file" when it is (or was, on this document) such a field. */
  sensitive: string | null;
  textField: boolean;
  inForm: boolean;
  /** Part of Vibewaiting's own launcher or messenger. */
  own: boolean;
  /** A frame element: input focused there goes to a document the policy cannot see. */
  frame: boolean;
  /** This element's identity on its document, fixed when the policy first sees it. */
  id: string;
}

/** The dialog the page shows, as the host saw it open. */
export interface OpenDialog {
  type: string;
  message: string;
  /** Distinguishes one dialog from the next with the same words. */
  sequence: number;
}

/** Pages without a real origin: an allowance could never name them. */
function opaque(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ["about:", "data:", "file:", "blob:", "javascript:"].includes(parsed.protocol) || parsed.origin === "null";
  } catch {
    return true;
  }
}

/** Words that make a card warn; they never decide whether to ask. */
const CONSEQUENTIAL =
  /\b(accept|allow|approve|authori[sz]e|buy|checkout|confirm|delete|grant|log\s*out|merge|order|pay|place\s+order|post|publish|purchase|remove|send|sign\s*out|submit|transfer)\b/i;

/** Calls that only read: they never ask. */
const READING = new Set([
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_find",
  "browser_hover",
  "browser_wait_for",
  "browser_console_messages",
]);

/** "shop.example/cart": the page as the person reads it in the address bar. */
export function pagePlace(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    return `${parsed.host}${path}`;
  } catch {
    return url;
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function quoted(name: string): string {
  const clean = name.replace(/\s+/g, " ").trim();
  return `“${clean.length > 60 ? `${clean.slice(0, 59)}…` : clean}”`;
}

function nameOf(element: Described): string {
  const name = [...element.names, ...element.controls][0];
  return name ? quoted(name) : `a <${element.tag}> element`;
}

function warning(elements: readonly Described[]): string {
  return elements.some((element) => [...element.names, ...element.controls].some((word) => CONSEQUENTIAL.test(word)))
    ? " — may submit, pay or delete"
    : "";
}

/**
 * Runs in the page: what the element is, what it is called, and whether it is
 * a sensitive field. A field seen sensitive stays sensitive on its document (a
 * "Show password" toggle does not make it ordinary).
 */
function describeInPage(element: Element): Described {
  const mark = Symbol.for("vibewaiting.sensitive");
  const identity = Symbol.for("vibewaiting.element");
  const marked = element as Element & { [key: symbol]: string | undefined };
  // getRandomValues, not randomUUID: plain http pages are not secure contexts.
  const id = marked[identity] ??= Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const tag = element.localName;
  const input = element as HTMLInputElement;
  const type = (element.getAttribute("type") ?? "").toLowerCase();
  const autocomplete = (element.getAttribute("autocomplete") ?? "").toLowerCase();
  let sensitive: string | null = null;
  if (tag === "input" || tag === "textarea") {
    if (type === "password" || /\bpassword\b/.test(autocomplete)) sensitive = "password";
    else if (/\bone-time-code\b/.test(autocomplete)) sensitive = "one-time code";
    else if (/\bcc-[a-z-]+\b/.test(autocomplete)) sensitive = "card";
    else if (type === "file") sensitive = "file";
  }
  if (sensitive) marked[mark] = sensitive;
  else sensitive = marked[mark] ?? null;
  const text = (value: string | null | undefined): string | null => {
    const clean = (value ?? "").replace(/\s+/g, " ").trim();
    return clean ? clean.slice(0, 120) : null;
  };
  const labels = "labels" in input && input.labels ? Array.from(input.labels, (label) => label.textContent) : [];
  const names = [
    element.getAttribute("aria-label"),
    ...labels,
    element.getAttribute("title"),
    tag === "input" && ["button", "submit", "reset"].includes(type) ? input.value : null,
    element.getAttribute("alt"),
    element.getAttribute("placeholder"),
    tag === "input" || tag === "textarea" || tag === "select" ? null : element.textContent,
  ].map(text).filter((name): name is string => name !== null);
  const controls: string[] = [];
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (["button", "a", "label", "summary"].includes(parent.localName) || parent.getAttribute("role") === "button") {
      const name = text(parent.getAttribute("aria-label")) ?? text(parent.textContent);
      if (name) controls.push(name);
    }
  }
  // Across shadow roots, by shape: the element may come from another realm.
  let own = false;
  for (let node: Element | null = element; node && !own; ) {
    own = node.closest('[data-widget-shell-id="vibewaiting"]') !== null;
    node = (node.getRootNode() as Partial<ShadowRoot>).host ?? null;
  }
  const textTypes = ["", "text", "search", "email", "url", "tel", "number", "password", "date", "datetime-local", "month", "time", "week"];
  return {
    tag,
    names,
    controls,
    sensitive,
    textField: tag === "textarea" || (tag === "input" && textTypes.includes(type)),
    inForm: element.closest("form") !== null,
    own,
    frame: ["iframe", "frame", "object", "embed"].includes(tag),
    id,
  };
}

/** The element a snapshot ref names, described by the page; one element in the page's own frame. */
async function describeTarget(page: Page, target: unknown): Promise<Described & { target: string }> {
  if (typeof target !== "string" || !/^e\d+$/.test(target))
    throw new BrowserRefusal("Vibewaiting acts only on elements named by a ref from the page's own snapshot (e12), not on selectors or elements inside frames.");
  const locator = page.locator(`aria-ref=${target}`);
  if (await locator.count() !== 1)
    throw new BrowserRefusal(`Ref ${target} is not in the current page snapshot. Take a new snapshot.`);
  const described = await locator.evaluate(describeInPage);
  if (described.own) throw new BrowserRefusal("That is Vibewaiting's own launcher or messenger; an agent cannot act on it.");
  return { ...described, target };
}

/** The element keys go to, described by the page; keys for a frame or Vibewaiting's own overlay are refused. */
async function describeFocused(page: Page): Promise<Described | null> {
  const focused = await page.evaluateHandle(() => {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active && active !== document.body ? active : null;
  });
  const element = focused.asElement();
  const described = element ? await element.evaluate(describeInPage) : null;
  await focused.dispose();
  if (described?.frame) throw new BrowserRefusal("Focus is inside a frame, whose element Vibewaiting cannot see, so keys are not sent there.");
  if (described?.own) throw new BrowserRefusal("Focus is on Vibewaiting's own launcher or messenger; an agent cannot type there.");
  return described;
}

/**
 * After the person pressed Allow in the messenger, focus is on the messenger:
 * an approved key press goes back to the element it was approved for, found
 * by its identity on this document. Focus the page moved elsewhere stays.
 */
export async function restoreFocus(page: Page, approvedKey: string): Promise<void> {
  const [tool, , , , identity] = JSON.parse(approvedKey) as [string, string, string, unknown, { id?: unknown } | null];
  if (tool !== "browser_press_key" || typeof identity?.id !== "string") return;
  await page.evaluate((id) => {
    const identityKey = Symbol.for("vibewaiting.element");
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    let overlay = false;
    for (let node: Element | null = active; node && !overlay; ) {
      overlay = node.closest('[data-widget-shell-id="vibewaiting"]') !== null;
      node = (node.getRootNode() as Partial<ShadowRoot>).host ?? null;
    }
    if (!overlay) return;
    const visit = (root: Document | ShadowRoot): HTMLElement | null => {
      for (const element of Array.from(root.querySelectorAll("*"))) {
        if ((element as Element & { [key: symbol]: unknown })[identityKey] === id) return element as HTMLElement;
        const inner = element.shadowRoot ? visit(element.shadowRoot) : null;
        if (inner) return inner;
      }
      return null;
    };
    visit(document)?.focus();
  }, identity.id);
}

/** The document the page shows now: an approval holds only for the document it was asked on. */
function documentOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    const holder = document as Document & { [key: symbol]: string | undefined };
    return holder[Symbol.for("vibewaiting.document")] ??= Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  });
}

/**
 * The approval this call asks for, or null when it never asks (reading).
 * Describes the elements it would act on by asking the page.
 */
export async function approvalFor(call: BrowserToolCall, page: Page, dialog: OpenDialog | null): Promise<BrowserApproval | null> {
  const args = call.arguments;
  if (READING.has(call.tool)) {
    // A reading call still names only the page's own elements, never the overlay's.
    if (args.target !== undefined) await describeTarget(page, args.target);
    return null;
  }
  const url = page.url();
  const place = `${pagePlace(url)} (as described by the page)`;
  let origin = originOf(url);
  const elements: Described[] = [];
  let summary: string;
  let identity: unknown = null;
  let onceWhy: string | null = opaque(url) ? "This page has no real origin, so each action on it needs the person's approval, once each." : null;
  switch (call.tool) {
    case "browser_click": {
      const modifiers = Array.isArray(args.modifiers) ? args.modifiers.map(String) : [];
      if (args.button === "middle" || modifiers.some((modifier) => modifier !== "Alt"))
        throw new BrowserRefusal("A middle click or a click holding Shift, Control or Meta can open another tab or window; Vibewaiting drives only this tab.");
      const element = await describeTarget(page, args.target);
      elements.push(element);
      const verb = args.doubleClick === true ? "Double-click" : args.button === "right" ? "Right-click" : "Click";
      const holding = modifiers.length ? ` holding ${modifiers.join("+")}` : "";
      summary = `${verb} ${nameOf(element)}${holding} on ${place}${warning(elements)}`;
      identity = element;
      break;
    }
    case "browser_drag": {
      const from = await describeTarget(page, args.startTarget);
      const to = await describeTarget(page, args.endTarget);
      elements.push(from, to);
      summary = `Drag ${nameOf(from)} onto ${nameOf(to)} on ${place}${warning(elements)}`;
      identity = [from, to];
      break;
    }
    case "browser_select_option": {
      const element = await describeTarget(page, args.target);
      elements.push(element);
      const values = Array.isArray(args.values) ? args.values.map((value) => quoted(String(value))).join(", ") : "";
      summary = `Choose ${values} in ${nameOf(element)} on ${place}${warning(elements)}`;
      identity = element;
      break;
    }
    case "browser_type": {
      const element = await describeTarget(page, args.target);
      elements.push(element);
      const submits = args.submit === true ? element.textField && element.inForm ? ", then press Enter — may submit its form" : ", then press Enter" : "";
      summary = element.sensitive
        ? `Type into ${element.sensitive} field ${nameOf(element)} on ${place}${submits}`
        : `Type ${quoted(String(args.text ?? ""))} into ${nameOf(element)} on ${place}${submits || warning(elements)}`;
      identity = element;
      break;
    }
    case "browser_fill_form": {
      const fields = Array.isArray(args.fields) ? args.fields as Array<Record<string, unknown>> : [];
      for (const field of fields) elements.push(await describeTarget(page, field.target));
      summary = `Fill ${elements.map((element) => element.sensitive ? `${element.sensitive} field ${nameOf(element)}` : nameOf(element)).join(", ")} on ${place}`;
      identity = elements;
      break;
    }
    case "browser_press_key": {
      const focused = await describeFocused(page);
      if (focused) elements.push(focused);
      const key = String(args.key ?? "");
      const where = focused ? `in ${focused.sensitive ? `${focused.sensitive} field ` : ""}${nameOf(focused)}` : "on the page";
      const submits = key === "Enter" && focused?.textField && focused.inForm ? " — may submit its form" : "";
      summary = `Press ${key} ${where} on ${place}${submits || warning(elements)}`;
      identity = focused;
      break;
    }
    case "browser_navigate": {
      const destination = String(args.url ?? "");
      // A javascript: or data: address would run the agent's code as the page.
      if (!/^https?:$/.test((() => { try { return new URL(destination).protocol; } catch { return ""; } })()))
        throw new BrowserRefusal("Vibewaiting navigates only to http and https addresses.");
      summary = `Go to ${pagePlace(destination)} from ${pagePlace(url)}`;
      // Allowing covers the site the tab goes to.
      origin = originOf(destination);
      break;
    }
    case "browser_navigate_back":
      summary = `Go back from ${place}`;
      break;
    case "browser_handle_dialog":
      if (!dialog) throw new BrowserRefusal("The page shows no dialog.");
      summary = `${args.accept === true ? "Accept" : "Dismiss"} the page's ${dialog.type} ${quoted(dialog.message)} on ${place}${args.accept === true ? " — may confirm what it asks" : ""}`;
      identity = dialog;
      break;
    default:
      throw new BrowserRefusal(`Vibewaiting does not serve ${call.tool}.`);
  }
  const sensitive = elements.find((element) => element.sensitive)?.sensitive ?? null;
  const typing = ["browser_type", "browser_fill_form", "browser_press_key"].includes(call.tool);
  if (typing && sensitive) onceWhy = `Typing into a ${sensitive} field always needs the person's approval, once each.`;
  return {
    // A page showing a dialog cannot answer script, and the dialog is the identity.
    key: JSON.stringify([call.tool, url, call.tool === "browser_handle_dialog" ? null : await documentOf(page), args, identity]),
    summary,
    reason: onceWhy ?? `Acting on a page needs the person's approval unless they allowed ${origin} for this task.`,
    origin,
    onceOnly: onceWhy !== null,
  };
}
