/**
 * Vibewaiting's policy for an agent's actions in the person's own tab:
 * filling password and file fields, activating controls likely to submit,
 * purchase, publish, send, transfer or delete, and every `browser.script` (a
 * script is Playwright with the whole page, its own locator calls unguarded)
 * need the person's approval. Asked by the Playwright host before each element
 * action, coordinate action and script, with the target described from the
 * browser side by Supercode's executor; the host asks the person
 * (playwright.ts, background.ts) and lets the one approved action through.
 */
import { BrowserActionRefusal } from "@volter-ai-dev/supercode-browser-playwright/protocol";
import type { GuardedNode, PlaywrightAction } from "@volter-ai-dev/supercode-browser-playwright/executor";

/** An action that needs the person's approval, named as the person sees it. */
export interface BrowserApproval {
  /** The exact action and target: identical only for the same action on the same element of the same page. */
  key: string;
  /** "Fill password field on github.com/login". */
  summary: string;
  /** Why it needs approval: the agent's refusal message. */
  reason: string;
  /** What will run, when the summary cannot say it (a script's full source and arguments). */
  detail?: string;
}

/** Longer scripts are refused outright: a person cannot review them in a card. */
export const MAX_SCRIPT_LENGTH = 20_000;

const CONSEQUENTIAL_BROWSER_ACTION =
  /\b(buy|checkout|confirm|delete|log\s*out|pay|place\s+order|post|publish|purchase|remove|send|sign\s*out|submit|transfer)\b/i;

const VERBS: Record<string, string> = {
  click: "Click",
  check: "Check",
  uncheck: "Uncheck",
  select: "Select an option in",
  press: "Press",
  mousedown: "Press the mouse on",
  mouseup: "Release the mouse on",
  drag: "Drag to",
};

/** "github.com/login": the page as the person reads it in the address bar. */
export function pagePlace(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    return `${parsed.host}${path}`;
  } catch {
    return url;
  }
}

function quoted(name: string): string {
  return `“${name.length > 60 ? `${name.slice(0, 59)}…` : name}”`;
}

/** Every name the browser gives a node: its accessible name and the attributes that label it. */
function namesOf(node: GuardedNode): string[] {
  const { attributes } = node;
  return [node.name, attributes["aria-label"], attributes.title, attributes.value, attributes.alt]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "");
}

/** The approval this action needs, or null when the agent may act. */
export function approvalFor(request: PlaywrightAction, pageUrl: string): BrowserApproval | null {
  if (request.action === "script") {
    if (request.source.length > MAX_SCRIPT_LENGTH)
      throw new BrowserActionRefusal(
        "INVALID_INPUT",
        `Scripts longer than ${MAX_SCRIPT_LENGTH.toLocaleString("en-US")} characters are refused: the person could not review them.`,
      );
    const args = JSON.stringify(request.args ?? {}, null, 2);
    return {
      key: JSON.stringify(["script", pageUrl, request.source, args]),
      summary: `Run script on ${pagePlace(pageUrl)}`,
      reason: "Running a Playwright script in the page requires the person's approval.",
      detail: `${request.source}\n\n// args\n${args}`,
    };
  }
  const { action, target, value } = request;
  const place = pagePlace(target.url);
  const identity = target.nodes.map((node) => node.backendNodeId).sort((a, b) => a - b);
  const key = JSON.stringify([action, target.url, identity, target.point ?? null]);
  const fields = target.nodes.filter((node) =>
    node.tag === "input" && ["password", "file"].includes((node.attributes.type ?? "").toLowerCase()));
  if ((action === "fill" || action === "press") && fields.length) {
    const kind = (fields[0]!.attributes.type ?? "").toLowerCase();
    return {
      key,
      summary: `${action === "fill" ? "Fill" : `Press ${String(value)} in`} ${kind} field on ${place}`,
      reason: `Typing into ${kind} inputs requires the person's approval.`,
    };
  }
  const activating = action === "click" || action === "check" || action === "uncheck" || action === "select" ||
    action === "mousedown" || action === "mouseup" || action === "drag" ||
    (action === "press" && ["Enter", "Space", " "].includes(String(value)));
  if (!activating) return null;
  // The element and the controls it sits in: a click on a label inside a Delete button deletes.
  const named = [...target.nodes, ...target.ancestors].flatMap(namesOf);
  const consequential = named.find((name) => CONSEQUENTIAL_BROWSER_ACTION.test(name));
  if (!consequential) return null;
  const verb = action === "press" ? `Press ${String(value) === " " ? "Space" : String(value)} on` : VERBS[action] ?? action;
  return {
    key,
    summary: `${verb} ${quoted(consequential.replace(/\s+/g, " ").trim())} on ${place}`,
    reason: `${action} on ${JSON.stringify(consequential)} may perform a consequential action and requires the person's approval.`,
  };
}
