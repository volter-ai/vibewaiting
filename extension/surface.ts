/**
 * The page's AlmostCDP surface, in the page's main world: Playwright's
 * evaluations must run where the page's own objects are, and Manifest V3
 * forbids eval in the isolated world. Evaluation therefore follows the page's
 * Content-Security-Policy; a page that forbids eval is driven through Chrome's
 * debugger instead (background.ts), and its surface never connects. The
 * surface idles until the isolated content script hands it a port to the
 * extension's Playwright host; it then keeps this tab's target across
 * documents (succession) with the id and token that host chose.
 */
import { connectDomSurface, preloadSuccession } from "@volter/almostcdp/dom";
import { MessagePortTransport } from "@volter/almostcdp/message-port";
import { createDomAccessibility } from "@volter/almostcdp/accessibility";

const SURFACE_MESSAGE = "vibewaiting:almostcdp-surface";

interface SurfaceGlobal {
  __vibewaitingSurface?: boolean;
}

const surfaceGlobal = globalThis as SurfaceGlobal;
if (!surfaceGlobal.__vibewaitingSurface) {
  surfaceGlobal.__vibewaitingSurface = true;
  // Scripts a same-origin predecessor handed over run before the page's own.
  preloadSuccession();
  const accept = (event: MessageEvent): void => {
    const message = event.data as { type?: unknown; id?: unknown; token?: unknown } | null;
    const port = event.ports[0];
    if (event.source !== window || message?.type !== SURFACE_MESSAGE || !port ||
      typeof message.id !== "string" || typeof message.token !== "string") return;
    window.removeEventListener("message", accept);
    // A page whose Content-Security-Policy forbids eval cannot answer
    // Playwright here; the extension drives it through Chrome's debugger.
    try {
      new Function("return 0");
    } catch {
      port.postMessage({ type: "close", code: 1000, reason: "The page forbids eval" });
      port.close();
      return;
    }
    // The document's end closes the extension's side of the port; a document
    // restored from the back/forward cache is not connected again (its page
    // patches are already installed), and the agent is told to reload it.
    connectDomSurface({
      transport: new MessagePortTransport(port),
      id: message.id,
      succession: { token: message.token },
      title: document.title,
      url: location.href,
      // Supercode's guard reads each target's role and name over CDP.
      accessibility: createDomAccessibility(),
      // The person's own tab: navigator.webdriver stays as the browser has it.
      automation: false,
    });
  };
  window.addEventListener("message", accept);
}
