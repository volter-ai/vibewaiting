/**
 * Vibewaiting's policy for an agent's actions in the person's own tab, after
 * Claude in Chrome's per-site permissions: every action that can change the
 * page or send it input asks the person, unless they allowed the tab's
 * current origin for this agent task. Reading never asks (snapshots, queries,
 * waits, hovering, moving the mouse). Some actions ask even on an allowed
 * origin, and can only be allowed once: scripts, and fills into a sensitive
 * field (a password, one-time code or card field, or a file input).
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

/** A sensitive field a fill writes into: password (as the field is now), one-time code, card, or file. */
function sensitiveField(target: GuardedTarget): string | null {
  for (const node of target.nodes) {
    if (node.tag !== "input" && node.tag !== "textarea") continue;
    const type = (node.attributes.type ?? "").toLowerCase();
    const autocomplete = (node.attributes.autocomplete ?? "").toLowerCase();
    if (type === "password" || /\bpassword\b/.test(autocomplete)) return "password";
    if (/\bone-time-code\b/.test(autocomplete)) return "one-time code";
    if (/\bcc-[a-z-]+\b/.test(autocomplete)) return "card";
    if (type === "file") return "file";
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

const SCRIPT_NOTE =
  "While it runs (at most 9 seconds) the script has Playwright's full control of this tab: it can read and change the page, click, type, navigate, and read anything the page can. It is cancelled when its time is up, and whatever it installed (routes, exposed functions, init scripts, listeners) is removed before the next action.";

/**
 * The approval this action needs, or null when the agent may act. `inPage`:
 * the page described the target itself (the AlmostCDP path). `allowed`: the
 * origins the person allowed for this task on this tab.
 */
export function approvalFor(
  request: PlaywrightAction,
  pageUrl: string,
  inPage: boolean,
  allowed: readonly string[],
): BrowserApproval | null {
  const byPage = inPage ? " (as described by the page)" : "";
  if (request.action === "script") {
    if (request.source.length > MAX_SCRIPT_LENGTH)
      throw new BrowserActionRefusal(
        "INVALID_INPUT",
        `Scripts longer than ${MAX_SCRIPT_LENGTH.toLocaleString("en-US")} characters are refused: the person could not review them.`,
      );
    const args = JSON.stringify(request.args ?? {}, null, 2);
    return {
      key: JSON.stringify(["script", pageUrl, request.source, args]),
      summary: `Run a script on ${pagePlace(pageUrl)}${byPage}`,
      reason: "Scripts always need the person's approval, once each.",
      detail: `${request.source}\n\n// args\n${args}`,
      note: SCRIPT_NOTE,
      origin: originOf(pageUrl),
      onceOnly: true,
    };
  }
  if (!("target" in request)) {
    const origin = originOf(request.url);
    if (allowed.includes(origin)) return null;
    const place = pagePlace(request.url);
    const direction = (request.value as { direction?: string } | undefined)?.direction;
    return {
      key: JSON.stringify([request.action, request.url, request.value ?? null]),
      summary: request.action === "back" ? `Go back from ${place}${byPage}`
        : request.action === "forward" ? `Go forward from ${place}${byPage}`
          : request.action === "reload" ? `Reload ${place}${byPage}`
            : `Scroll ${direction ?? ""} on ${place}${byPage}`.replace("  ", " "),
      reason: `Changing a page needs the person's approval unless they allowed ${origin} for this task.`,
      origin,
      onceOnly: false,
    };
  }
  const { action, target, value } = request;
  // Reading never asks.
  if (action === "hover") return null;
  const origin = originOf(target.url);
  const place = pagePlace(target.url);
  const identity = target.nodes.map((node) => node.backendNodeId).sort((a, b) => a - b);
  const key = JSON.stringify([action, target.url, identity, target.point ?? null, value ?? null]);
  const sensitive = action === "fill" ? sensitiveField(target) : null;
  if (!sensitive && allowed.includes(origin)) return null;
  const reason = sensitive
    ? `Filling a ${sensitive} field always needs the person's approval, once each.`
    : `Acting on a page needs the person's approval unless they allowed ${origin} for this task.`;
  const ask = (summary: string): BrowserApproval => ({ key, summary, reason, origin, onceOnly: sensitive !== null });
  const named = nameOf(target) ?? "an element";

  if (request.pointer) {
    const point = target.point ?? { x: 0, y: 0 };
    const at = `(${Math.round(point.x)}, ${Math.round(point.y)})`;
    const over = nameOf(target);
    const drag = action === "drag" ? value as { to?: { x: number; y: number }; drop?: GuardedTarget } | undefined : undefined;
    const drop = drag?.drop ? nameOf(drag.drop) : null;
    return ask(`${POINTER_VERBS[action] ?? action} at ${at}` +
      (over ? ` over ${over}` : target.unidentified ? " over an element that could not be identified" : "") +
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
