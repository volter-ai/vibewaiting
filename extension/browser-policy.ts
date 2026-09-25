/**
 * Vibewaiting's policy for an agent's actions in the person's own tab:
 * password and file fields, and controls likely to submit, purchase, publish,
 * send, transfer or delete, need the person's approval, so the operation is
 * refused with `APPROVAL_REQUIRED`. So does every `browser.script`: a script
 * is Playwright with the whole page, its own locator calls unguarded. Asked
 * by the Playwright host before each locator action and each script.
 */
import { BrowserActionRefusal } from "@volter-ai-dev/supercode-browser-playwright/protocol";
import type { PlaywrightAction } from "@volter-ai-dev/supercode-browser-playwright/executor";

const CONSEQUENTIAL_BROWSER_ACTION =
  /\b(buy|checkout|confirm|delete|log\s*out|pay|place\s+order|post|publish|purchase|remove|send|sign\s*out|submit|transfer)\b/i;

/** Self-contained: Playwright serializes it into the page. */
function describe(element: Element): { tag: string; type: string; name: string } {
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
  };
}

export async function guardBrowserAction(request: PlaywrightAction): Promise<void> {
  if (request.action === "script")
    throw new BrowserActionRefusal(
      "APPROVAL_REQUIRED",
      "Running a Playwright script in the page requires explicit browser approval.",
    );
  const { action, locator, value } = request;
  const element = await locator.evaluate(describe);
  if (action === "fill" && element.tag === "input" && (element.type === "password" || element.type === "file"))
    throw new BrowserActionRefusal(
      "APPROVAL_REQUIRED",
      "Filling password and file inputs requires explicit browser approval.",
    );
  const activating = action === "click" || action === "check" || action === "uncheck" ||
    action === "select" || (action === "press" && ["Enter", "Space", " "].includes(String(value)));
  if (activating && CONSEQUENTIAL_BROWSER_ACTION.test(element.name))
    throw new BrowserActionRefusal(
      "APPROVAL_REQUIRED",
      `${action} on ${JSON.stringify(element.name)} may perform a consequential action.`,
    );
}
