/**
 * Vibewaiting's policy for an agent's actions in the person's own tab, after
 * Claude in Chrome's per-site permissions: every action that can change the
 * page or send it input asks the person, unless they allowed the tab's
 * current origin for this agent task (the Playwright host applies that
 * allowance). Reading never asks (snapshots, queries, waits, hovering, moving
 * the mouse). Some actions ask even on an allowed origin, and can only be
 * allowed once: JavaScript run in the page; typing into a sensitive field (a
 * password, one-time code or card field, or a file input, or a field that was
 * one earlier on this document); raw pointer input whose target cannot be
 * identified; and anything on a page without a real origin (about:, data:,
 * file:, blob:).
 *
 * Whether to ask never depends on what an element is called. The words on
 * the page only shape the card ("may submit, pay or delete"); on the in-page
 * (AlmostCDP) path the page itself describes its elements, and cards say so.
 * Asked by the Playwright host before each action (playwright.ts); the host
 * asks the person (background.ts) and lets the one approved action through.
 */
import { BrowserActionRefusal } from "@volter-ai-dev/supercode-browser-playwright/protocol";
import type { GuardedNode, GuardedTarget, PlaywrightAction } from "@volter-ai-dev/supercode-browser-playwright/executor";

/** An action that needs the person's approval, named as the person sees it. */
export interface BrowserApproval {
  /** The exact action and target: identical only for the same action on the same element of the same page. */
  key: string;
  /** "Click “Place order” on shop.example — may submit, pay or delete". */
  summary: string;
  /** Why it asks: the agent's refusal message. */
  reason: string;
  /** What will run, when the summary cannot say it (a script's full source and arguments). */
  detail?: string;
  /** What the action can reach, when that is more than the summary says. */
  note?: string;
  /** The page's origin, which "Allow on <origin> for this task" allows. */
  origin: string;
  /** Asks even on an allowed origin, and can only be allowed once. */
  onceOnly: boolean;
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

/** Longer scripts are refused outright: a person cannot review them in a card. */
export const MAX_SCRIPT_LENGTH = 20_000;

/** Words that make a card warn; they never decide whether to ask. */
const CONSEQUENTIAL =
  /\b(accept|allow|approve|authori[sz]e|buy|checkout|confirm|delete|grant|log\s*out|merge|order|pay|place\s+order|post|publish|purchase|remove|send|sign\s*out|submit|transfer)\b/i;

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "number", "password", "date", "datetime-local", "month", "time", "week"]);

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

/** Every name the browser gives a node: its accessible name and the attributes that label it. */
function namesOf(node: GuardedNode): string[] {
  const { attributes } = node;
  return [node.name, attributes["aria-label"], attributes.title, attributes.value, attributes.alt, node.text]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "");
}

/** The controls an element sits in: its accessibility ancestors, never the document itself. */
function controlsOf(target: GuardedTarget): GuardedNode[] {
  return target.ancestors.filter((node) => !/^(RootWebArea|WebArea)$/.test(node.role));
}

/** What the element is called, from itself or the controls it sits in. */
function nameOf(target: GuardedTarget): string | null {
  const controls = controlsOf(target);
  const name = [...target.nodes, ...controls].flatMap(namesOf)[0];
  if (name) return quoted(name);
  return target.nodes[0]?.tag ? `a <${target.nodes[0].tag}> element` : null;
}

/** The card's warning, from the words on and around the element. */
function warning(target: GuardedTarget): string {
  const words = [...target.nodes, ...controlsOf(target)].flatMap(namesOf);
  return words.some((word) => CONSEQUENTIAL.test(word)) ? " — may submit, pay or delete" : "";
}

/**
 * The nodes of a target that are sensitive fields now: the Playwright host
 * remembers them, so a field stays sensitive on its document after it
 * changes (a "Show password" toggle).
 */
export function sensitiveNodeIds(target: GuardedTarget): number[] {
  return target.nodes.filter((node) => sensitiveKind(node) !== null).map((node) => node.backendNodeId);
}

function sensitiveKind(node: GuardedNode): string | null {
  if (node.tag !== "input" && node.tag !== "textarea") return null;
  const type = (node.attributes.type ?? "").toLowerCase();
  const autocomplete = (node.attributes.autocomplete ?? "").toLowerCase();
  if (type === "password" || /\bpassword\b/.test(autocomplete)) return "password";
  if (/\bone-time-code\b/.test(autocomplete)) return "one-time code";
  if (/\bcc-[a-z-]+\b/.test(autocomplete)) return "card";
  if (type === "file") return "file";
  return null;
}

/** A sensitive field typing goes into: as it is now, or as it was earlier on this document. */
function sensitiveField(target: GuardedTarget, known: ReadonlySet<number>): string | null {
  for (const node of target.nodes) {
    const kind = sensitiveKind(node);
    if (kind) return kind;
    if (known.has(node.backendNodeId)) return "password";
  }
  return null;
}


/**
 * The key Playwright sends for a key string: modifiers stripped, aliases
 * mapped ("Control+NumpadEnter" sends Enter with Control held).
 */
export function keyOf(raw: string): { key: string; modifiers: string[] } {
  const parts = raw.endsWith("++") ? [...raw.slice(0, -2).split("+"), "+"] : raw.split("+");
  const base = parts.pop() ?? raw;
  const aliases: Record<string, string> = { NumpadEnter: "Enter", " ": "Space", Spacebar: "Space", Return: "Enter" };
  return { key: aliases[base] ?? base, modifiers: parts.filter(Boolean) };
}

/** A text field, where Enter in a form submits it. */
function textField(target: GuardedTarget): boolean {
  return target.nodes.some((node) =>
    node.tag === "input" && TEXT_INPUT_TYPES.has((node.attributes.type ?? "").toLowerCase()));
}

function inForm(target: GuardedTarget): boolean {
  return target.nodes.some((node) => node.inForm === true);
}

const POINTER_VERBS: Record<string, string> = {
  click: "Click the mouse",
  mousedown: "Press the mouse",
  mouseup: "Release the mouse",
  wheel: "Scroll the mouse wheel",
  drag: "Drag the mouse",
};

const PAGE_SCRIPT_NOTE =
  "It runs as the page itself, in the page's own JavaScript, and can do anything the page can: read and change the page, read what the page stores, and send requests as the page. It cannot reach Vibewaiting or other tabs.";

/** An action on a page without a real origin, or with a target that cannot be identified, is allowed once each. */
function onceOnlyWhy(url: string, target?: GuardedTarget): string | null {
  if (opaque(url)) return "This page has no real origin, so each action on it needs the person's approval, once each.";
  if (target?.unidentified !== undefined)
    return "What is under the pointer cannot be identified, so the person approves each such action, once each.";
  return null;
}

/**
 * The approval this action asks for, or null when it never asks (reading).
 * `inPage`: the page described the target itself (the AlmostCDP path).
 * `known`: nodes that were sensitive fields earlier on this document.
 */
export function approvalFor(
  request: PlaywrightAction,
  pageUrl: string,
  inPage: boolean,
  known: ReadonlySet<number>,
): BrowserApproval | null {
  const byPage = inPage ? " (as described by the page)" : "";
  if (request.action === "script")
    // Playwright code never runs in Vibewaiting's extension (browser.script
    // is answered as JavaScript in the page, playwright.ts); this refuses the
    // executor's own script path should anything reach it.
    throw new BrowserActionRefusal("UNSUPPORTED",
      "Vibewaiting does not run Playwright scripts; browser.script runs its source as JavaScript in the page.");
  if (!("target" in request)) {
    const origin = originOf(request.url);
    const place = pagePlace(request.url);
    const direction = (request.value as { direction?: string } | undefined)?.direction;
    const once = onceOnlyWhy(request.url);
    return {
      key: JSON.stringify([request.action, request.url, request.value ?? null]),
      summary: request.action === "back" ? `Go back from ${place}${byPage}`
        : request.action === "forward" ? `Go forward from ${place}${byPage}`
          : request.action === "reload" ? `Reload ${place}${byPage}`
            : `Scroll ${direction ?? ""} on ${place}${byPage}`.replace("  ", " "),
      reason: once ?? `Changing a page needs the person's approval unless they allowed ${origin} for this task.`,
      origin,
      onceOnly: once !== null,
    };
  }
  const { action, target, value } = request;
  // Reading never asks.
  if (action === "hover") return null;
  const origin = originOf(target.url);
  const place = pagePlace(target.url);
  const identity = target.nodes.map((node) => node.backendNodeId).sort((a, b) => a - b);
  const key = JSON.stringify([action, target.url, identity, target.point ?? null, value ?? null]);
  const typing = action === "fill" || action === "press";
  const sensitive = typing ? sensitiveField(target, known) : null;
  const once = onceOnlyWhy(target.url, request.pointer ? target : undefined);
  const reason = sensitive
    ? `Typing into a ${sensitive} field always needs the person's approval, once each.`
    : once ?? `Acting on a page needs the person's approval unless they allowed ${origin} for this task.`;
  const ask = (summary: string): BrowserApproval => ({ key, summary, reason, origin, onceOnly: sensitive !== null || once !== null });
  const named = nameOf(target) ?? "an element";

  if (request.pointer) {
    const point = target.point ?? { x: 0, y: 0 };
    const at = `(${Math.round(point.x)}, ${Math.round(point.y)})`;
    const over = nameOf(target);
    const drag = action === "drag" ? value as { to?: { x: number; y: number }; drop?: GuardedTarget } | undefined : undefined;
    const drop = drag?.drop ? nameOf(drag.drop) : null;
    return ask(`${POINTER_VERBS[action] ?? action} at ${at}` +
      (over ? ` over ${over}` : target.unidentified ? " over an element that could not be identified (it may be inside a frame)" : "") +
      (drag?.to ? ` to (${Math.round(drag.to.x)}, ${Math.round(drag.to.y)})${drop ? ` over ${drop}` : ""}` : "") +
      ` on ${place}${byPage}${warning(target)}`);
  }
  if (action === "fill") {
    if (sensitive) return ask(`Fill ${sensitive} field ${named} on ${place}${byPage}`);
    return ask(`Type into ${named} on ${place}${byPage}`);
  }
  if (action === "press") {
    const { key: pressed, modifiers } = keyOf(String(value));
    const shown = [...modifiers, pressed].join("+");
    if (sensitive) return ask(`Press ${shown} in ${sensitive} field ${named} on ${place}${byPage}`);
    const submits = pressed === "Enter" && textField(target) && inForm(target) ? " — may submit its form" : "";
    return ask(`Press ${shown} in ${named} on ${place}${byPage}${submits || warning(target)}`);
  }
  if (action === "select") {
    const options = (value as { options?: Array<{ label: string; value: string }> } | undefined)?.options ?? [];
    const chosen = options.length
      ? options.map((option) => `${quoted(option.label)} (value ${JSON.stringify(option.value)})`).join(", ")
      : `the option ${JSON.stringify((value as { values?: unknown } | undefined)?.values ?? value)}`;
    return ask(`Choose ${chosen} in ${named} on ${place}${byPage}${warning(target)}`);
  }
  const verbs: Record<string, string> = { click: "Click", check: "Check", uncheck: "Uncheck", focus: "Focus" };
  return ask(`${verbs[action] ?? action} ${named} on ${place}${byPage}${warning(target)}`);
}

/**
 * The approval JavaScript run in the page asks for: always, once each. The
 * source runs as the page, never in the extension.
 */
export function pageScriptApproval(source: string, args: unknown, pageUrl: string, inPage: boolean): BrowserApproval {
  if (source.length > MAX_SCRIPT_LENGTH)
    throw new BrowserActionRefusal(
      "INVALID_INPUT",
      `Scripts longer than ${MAX_SCRIPT_LENGTH.toLocaleString("en-US")} characters are refused: the person could not review them.`,
    );
  const shownArgs = JSON.stringify(args ?? {}, null, 2);
  return {
    key: JSON.stringify(["page-script", pageUrl, source, shownArgs]),
    summary: `Run JavaScript in the page on ${pagePlace(pageUrl)}${inPage ? " (as described by the page)" : ""}`,
    reason: "JavaScript in the page always needs the person's approval, once each.",
    detail: `${source}\n\n// args\n${shownArgs}`,
    note: PAGE_SCRIPT_NOTE,
    origin: originOf(pageUrl),
    onceOnly: true,
  };
}
