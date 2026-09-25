/**
 * Vibewaiting's policy for an agent's actions in the person's own tab:
 * password and file fields, and controls likely to submit, purchase, publish,
 * send, transfer or delete, need the person's approval. So does every
 * `browser.script`: a script is Playwright with the whole page, its own locator
 * calls unguarded. Asked by the Playwright host before each locator action and
 * each script; the host asks the person (playwright.ts, background.ts) and
 * lets the one approved action through.
 */
import type { PlaywrightAction } from "@volter-ai-dev/supercode-browser-playwright/executor";

/** An action that needs the person's approval, named as the person sees it. */
export interface BrowserApproval {
  /** The exact action and target: identical only for the same action on the same element of the same page. */
  key: string;
  /** "Fill password field on github.com/login". */
  summary: string;
  /** Why it needs approval: the agent's refusal message. */
  reason: string;
  /** What will run, when the summary cannot say it (a script's source). */
  detail?: string;
}

const CONSEQUENTIAL_BROWSER_ACTION =
  /\b(buy|checkout|confirm|delete|log\s*out|pay|place\s+order|post|publish|purchase|remove|send|sign\s*out|submit|transfer)\b/i;

const VERBS: Record<string, string> = {
  click: "Click",
  check: "Check",
  uncheck: "Uncheck",
  select: "Select an option in",
  press: "Press",
};

/** Self-contained: Playwright serializes it into the page. */
function describe(element: Element): { tag: string; type: string; name: string; path: string } {
  const path: string[] = [];
  for (let node: Element | null = element; node && path.length < 12; node = node.parentElement) {
    const parent: Element | null = node.parentElement;
    path.unshift(`${node.tagName.toLowerCase()}:${parent ? Array.prototype.indexOf.call(parent.children, node) : 0}`);
  }
  return {
    tag: element.tagName.toLowerCase(),
    type: (element.getAttribute("type") ?? "").toLowerCase(),
    name: (
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      element.getAttribute("placeholder") ||
      element.textContent ||
      element.tagName.toLowerCase()
    ).replace(/\s+/g, " ").trim(),
    path: path.join(">"),
  };
}

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

/** The approval this action needs, or null when the agent may act. */
export async function approvalFor(request: PlaywrightAction, pageUrl: string): Promise<BrowserApproval | null> {
  const place = pagePlace(pageUrl);
  if (request.action === "script")
    return {
      key: JSON.stringify(["script", pageUrl, request.source]),
      summary: `Run script on ${place}`,
      reason: "Running a Playwright script in the page requires the person's approval.",
      detail: request.source.length > 1200 ? `${request.source.slice(0, 1199)}…` : request.source,
    };
  const { action, locator, value } = request;
  const element = await locator.evaluate(describe);
  const key = JSON.stringify([action, pageUrl, element.path, element.tag, element.type, element.name]);
  if (action === "fill" && element.tag === "input" && (element.type === "password" || element.type === "file"))
    return {
      key,
      summary: `Fill ${element.type} field on ${place}`,
      reason: `Filling ${element.type} inputs requires the person's approval.`,
    };
  const activating = action === "click" || action === "check" || action === "uncheck" ||
    action === "select" || (action === "press" && ["Enter", "Space", " "].includes(String(value)));
  if (activating && CONSEQUENTIAL_BROWSER_ACTION.test(element.name))
    return {
      key,
      summary: action === "press"
        ? `Press ${String(value) === " " ? "Space" : String(value)} on ${quoted(element.name)} on ${place}`
        : `${VERBS[action] ?? action} ${quoted(element.name)} on ${place}`,
      reason: `${action} on ${JSON.stringify(element.name)} may perform a consequential action and requires the person's approval.`,
    };
  return null;
}
