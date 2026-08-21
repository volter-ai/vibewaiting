import { harnessLogoDataUrl } from "@volter-ai-dev/supercode-ui/preact/logo";
import {
  createExtensionGeometryPersistence,
  createExtensionIframeContent,
  createOverlay,
} from "@volter-ai-dev/widget-shell";
import { VIBEWAITING_ACCENT, VIBEWAITING_RADIUS } from "../src/theme.js";

const overlay = createOverlay({
  id: "vibewaiting",
  content: createExtensionIframeContent(chrome.runtime, "app.html", {
    title: "Vibewaiting agent chats",
  }),
  viewport: { width: 390, height: 667, gutter: 16 },
  launcher: { label: "Open agent chats", hidden: true },
  behavior: {
    persistence: createExtensionGeometryPersistence(chrome.storage.local),
  },
  theme: { accent: VIBEWAITING_ACCENT, radius: VIBEWAITING_RADIUS },
});

overlay.mount();
const port = chrome.runtime.connect({ name: "vibewaiting:content" });
port.onMessage.addListener((raw) => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
  const message = raw as Record<string, unknown>;
  if (message.type !== "launcher") return;
  const harness = typeof message.harness === "string" ? message.harness : "";
  const icon = harnessLogoDataUrl(harness);
  overlay.setLauncher({
    label:
      typeof message.label === "string" ? message.label : "Open agent chats",
    icon,
    hidden: message.hidden === true || icon === null,
  });
  overlay.setBadge(typeof message.badge === "number" ? message.badge : null);
});

window.addEventListener(
  "pagehide",
  () => {
    port.disconnect();
    overlay.destroy();
  },
  { once: true },
);
