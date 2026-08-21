// Vibewaiting is intentionally only the composition seam between Lucarne's embeddable shell and
// Supercode's reusable default UI. Agent semantics, components, transcript presentation, logos,
// continuation controls, and presentation memory live in @volter-ai-dev/supercode-ui. This file
// owns only iframe sizing, Lucarne intents, collapsed launcher chrome, and host focus lifecycle.
import { SupercodeMessenger } from "@volter-ai-dev/supercode-ui/preact/messenger";
import { HarnessLogo, hasHarnessLogo } from "@volter-ai-dev/supercode-ui/preact/logo";
import { normalizeUiState } from "@volter-ai-dev/supercode-ui/core";
import type { SupercodeUiIntent, SupercodeUiState, TranscriptAttachment, TranscriptImage, UiAdapter } from "@volter-ai-dev/supercode-ui";
import { createWidget } from "lucarne/widget/runtime";
import { render as renderPreact } from "preact";
import type { JSX } from "preact";

type PillMode = "connecting" | "idle" | "unread" | "working" | "needs-input" | "error";
type WidgetIntent = SupercodeUiIntent
  | { action: "mounted" }
  | { action: "panelVisible" }
  | { action: "panelHidden" }
  | { action: "resolveImage"; requestId: string; reference: string };

const NS = "vibewaiting";
const INTENT_QUEUE = "agent";
const BRIDGE_ACK_TIMEOUT_MS = 600;
const IMAGE_RESOLUTION_TIMEOUT_MS = 15_000;
const MAX_RESOLVED_IMAGE_URL_CHARS = 22_400_000;
const MAX_RESOLVED_IMAGE_BYTES = 16 * 1024 * 1024;
const widget = createWidget({ ns: NS, version: 1 });
const MAX_PICKED_FILES = 8;
const MAX_FILE_BYTES_READ = 80_000;
const MAX_IMAGE_FILES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_FILE_PATTERN = /\.(?:c|cc|cpp|css|csv|go|h|hpp|html|ini|java|js|json|jsx|md|mjs|py|rb|rs|sh|sql|toml|ts|tsx|txt|xml|ya?ml)$/i;

function readImage(file: File): Promise<TranscriptAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({
      id: `browser-image:${file.name}:${file.size}:${file.lastModified}`,
      label: file.name || "Attached image",
      url: String(reader.result),
    });
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name || "image"}.`));
    reader.readAsDataURL(file);
  });
}

function pickAttachments(): Promise<TranscriptAttachment[] | null> {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = "image/png,image/jpeg,image/gif,image/webp,text/*,.json,.md,.mjs,.toml,.tsx,.ts,.yaml,.yml";
  input.hidden = true;
  document.body.append(input);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: TranscriptAttachment[] | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      input.remove();
      if (error) reject(error);
      else resolve(value);
    };
    input.addEventListener("cancel", () => finish(null), { once: true });
    input.addEventListener("change", () => {
      const files = [...(input.files ?? [])];
      if (!files.length) return finish(null);
      if (files.length > MAX_PICKED_FILES) return finish(null, new Error(`Attach at most ${MAX_PICKED_FILES} files at a time.`));
      const images = files.filter((file) => file.type.startsWith("image/"));
      if (images.length > MAX_IMAGE_FILES) return finish(null, new Error(`Attach at most ${MAX_IMAGE_FILES} images at a time.`));
      const unsupported = files.find((file) => !(IMAGE_TYPES.has(file.type) || file.type.startsWith("text/") || TEXT_FILE_PATTERN.test(file.name)));
      if (unsupported) return finish(null, new Error(`${unsupported.name} is not a supported text or image file.`));
      const oversized = images.find((file) => file.size > MAX_IMAGE_BYTES);
      if (oversized) return finish(null, new Error(`${oversized.name} is larger than 5 MB.`));
      void Promise.all(files.map(async (file): Promise<TranscriptAttachment> => {
        if (IMAGE_TYPES.has(file.type)) return readImage(file);
        const source = await file.slice(0, MAX_FILE_BYTES_READ).text();
        const truncated = file.size > MAX_FILE_BYTES_READ || source.length > 20_000;
        const suffix = truncated ? "\n\n[…file truncated to the messenger context limit]" : "";
        return {
          id: `browser-file:${file.name}:${file.size}:${file.lastModified}`,
          kind: "file",
          label: file.name,
          detail: `${source.slice(0, Math.max(0, 20_000 - suffix.length)) || "[Empty file]"}${suffix}`,
        };
      })).then((items) => finish(items), (error: unknown) => finish(null, error instanceof Error ? error : new Error("Could not read the selected files.")));
    }, { once: true });
    input.click();
  });
}

function syncPanelViewport(requestResize = true): void {
  let pageWidth = 436;
  let pageHeight = 496;
  try {
    pageWidth = window.parent.innerWidth;
    pageHeight = window.parent.innerHeight;
  } catch {
    // Cross-origin hosts retain the safe desktop defaults.
  }
  const width = Math.max(240, Math.min(420, pageWidth - 32));
  const height = Math.max(280, Math.min(480, pageHeight - 32));
  document.documentElement.style.setProperty("--vw-panel-width", `${width}px`);
  document.documentElement.style.setProperty("--vw-panel-height", `${height}px`);
  document.documentElement.style.setProperty("--scui-width", `${width}px`);
  document.documentElement.style.setProperty("--scui-height", `${height}px`);
  if (requestResize) widget.requestResize();
}

syncPanelViewport(false);
try {
  const pageWindow = window.parent;
  const onPageResize = (): void => syncPanelViewport();
  pageWindow.addEventListener("resize", onPageResize);
  window.addEventListener("pagehide", () => {
    pageWindow.removeEventListener("resize", onPageResize);
    if (mountedPanelContainer !== null) sendBridgeIntent({ action: "panelHidden" });
    for (const [requestId, pending] of imageResolutions) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The page closed before this image loaded."));
      imageResolutions.delete(requestId);
    }
  }, { once: true });
} catch {
  // Cross-origin embedders retain fixed safe dimensions.
}

let mountedPanelContainer: HTMLElement | null = null;
let restoreLauncherFocus = false;
let lastPanelState: unknown = {};
let bridgeDisconnected = false;
let bridgeReconnecting = false;
let bridgeAckTimer: ReturnType<typeof setTimeout> | null = null;
let pendingBridgeIntent: { id: string; attachKey: string | null; acceptsSnapshot: boolean } | null = null;
const bridgeCompletions = new Map<string, () => void>();
let imageRequestSequence = 0;
const imageResolutions = new Map<string, {
  resolve: (blob: Blob) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

function resolveBridgeCompletion(id: string): void {
  const resolve = bridgeCompletions.get(id);
  if (!resolve) return;
  bridgeCompletions.delete(id);
  resolve();
}

function clearBridgeWatch(): void {
  if (bridgeAckTimer !== null) clearTimeout(bridgeAckTimer);
  bridgeAckTimer = null;
  pendingBridgeIntent = null;
}

function renderCurrentPanel(): void {
  if (mountedPanelContainer !== null) renderMessengerPanel(mountedPanelContainer, lastPanelState);
}

function watchBridge(id: string, intent: WidgetIntent): void {
  clearBridgeWatch();
  pendingBridgeIntent = {
    id,
    attachKey: intent.action === "attach" ? intent.key : null,
    acceptsSnapshot: intent.action === "mounted" || intent.action === "panelVisible",
  };
  bridgeAckTimer = setTimeout(() => {
    bridgeAckTimer = null;
    resolveBridgeCompletion(id);
    bridgeReconnecting = false;
    bridgeDisconnected = true;
    lastTone = "dead";
    collapsedMode = "error";
    collapsedLabel = "Agent bridge disconnected";
    renderCurrentPanel();
    syncCollapsedChrome();
  }, BRIDGE_ACK_TIMEOUT_MS);
}

function sendBridgeIntent(intent: WidgetIntent): void | Promise<void> {
  const id = widget.sendIntent(INTENT_QUEUE, intent);
  if (intent.action !== "draft" && intent.action !== "ack") watchBridge(id, intent);
  if (intent.action === "draft" || intent.action === "ack" || intent.action === "mounted" || intent.action === "panelVisible" || intent.action === "panelHidden") return;
  return new Promise<void>((resolve) => bridgeCompletions.set(id, resolve));
}

function imageBlobFromDataUrl(dataUrl: string): Blob {
  if (!dataUrl.startsWith("data:image/") || dataUrl.length > MAX_RESOLVED_IMAGE_URL_CHARS) {
    throw new Error("The host returned an invalid or oversized image.");
  }
  const comma = dataUrl.indexOf(",");
  if (comma < 0 || comma > 200) throw new Error("The host returned an invalid image.");
  const declaration = dataUrl.slice(5, comma);
  const mediaType = declaration.split(";", 1)[0]?.toLowerCase() ?? "";
  if (!mediaType.startsWith("image/")) throw new Error("The host returned an invalid image.");
  const encoded = dataUrl.slice(comma + 1);
  let blob: Blob;
  if (declaration.toLowerCase().endsWith(";base64")) {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    blob = new Blob([bytes], { type: mediaType });
  } else {
    blob = new Blob([decodeURIComponent(encoded)], { type: mediaType });
  }
  if (blob.size > MAX_RESOLVED_IMAGE_BYTES) throw new Error("This image is too large to preview safely.");
  return blob;
}

function resolveHistoricalImage(image: TranscriptImage): Promise<Blob> {
  if (!image.reference) return Promise.reject(new Error("This image has no host retrieval reference."));
  const reference = image.reference;
  imageRequestSequence += 1;
  const requestId = `image-${Date.now().toString(36)}-${imageRequestSequence.toString(36)}`;
  return new Promise<Blob>((resolve, reject) => {
    const timer = setTimeout(() => {
      imageResolutions.delete(requestId);
      reject(new Error("Loading this image timed out. Try again."));
    }, IMAGE_RESOLUTION_TIMEOUT_MS);
    imageResolutions.set(requestId, { resolve, reject, timer });
    Promise.resolve(sendBridgeIntent({ action: "resolveImage", requestId, reference })).catch((error: unknown) => {
      clearTimeout(timer);
      imageResolutions.delete(requestId);
      reject(error instanceof Error ? error : new Error("Could not request this image."));
    });
  });
}

function reconnectBridge(): void {
  if (bridgeReconnecting) return;
  bridgeReconnecting = true;
  collapsedMode = "connecting";
  collapsedLabel = "Reconnecting agent bridge";
  renderCurrentPanel();
  syncCollapsedChrome();
  sendBridgeIntent({ action: "mounted" });
}

function closeMessenger(): void {
  sendBridgeIntent({ action: "panelHidden" });
  if (mountedPanelContainer !== null) renderPreact(null, mountedPanelContainer);
  mountedPanelContainer = null;
  restoreLauncherFocus = true;
  widget.close();
}

const adapter: UiAdapter = {
  onIntent(intent: SupercodeUiIntent): void | Promise<void> {
    return sendBridgeIntent(intent);
  },
  onClose: closeMessenger,
  pickContext: pickAttachments,
  resolveImage: resolveHistoricalImage,
  copyText(value: string): Promise<void> | void {
    return navigator.clipboard?.writeText(value);
  },
};

function MessengerDialog({ state }: { state: unknown }): JSX.Element {
  const normalized = normalizeUiState(state);
  const message = "Vibewaiting is no longer connected to its local agent bridge.";
  const displayState = bridgeDisconnected ? {
    ...normalized,
    pill: { tone: "dead" as const, label: "Agent bridge disconnected" },
    operation: null,
    error: message,
    recoverable: false,
    attachError: pendingBridgeIntent?.attachKey
      ? { key: pendingBridgeIntent.attachKey, message }
      : normalized.attachError,
  } : normalized;
  return (
    <div
      class="vw-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Agent chats"
      tabIndex={-1}
      onKeyDown={(event): void => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        closeMessenger();
      }}
    >
      <SupercodeMessenger state={displayState} adapter={adapter} components={{ TaskPlan: () => null }} />
      {bridgeDisconnected ? <section class="vw-bridge-disconnected" role="alert"><strong>{bridgeReconnecting ? "Reconnecting…" : "Agent bridge disconnected"}</strong><small>{bridgeReconnecting ? "Checking the local agent bridge." : "The local controller stopped responding."}</small><span><button type="button" disabled={bridgeReconnecting} onClick={reconnectBridge}>{bridgeReconnecting ? "Reconnecting…" : "Reconnect"}</button><button type="button" class="vw-secondary" onClick={closeMessenger}>Close</button></span></section> : null}
    </div>
  );
}

function renderMessengerPanel(element: HTMLElement, state: unknown): void {
  lastPanelState = state;
  if (mountedPanelContainer !== null && mountedPanelContainer !== element) renderPreact(null, mountedPanelContainer);
  const firstMount = mountedPanelContainer !== element;
  mountedPanelContainer = element;
  renderPreact(<MessengerDialog state={state} />, element);
  if (firstMount) {
    sendBridgeIntent({ action: "panelVisible" });
    queueMicrotask(() => {
      const focusTarget = element.querySelector<HTMLElement>("textarea:not(:disabled), input:not(:disabled), button:not(:disabled), [tabindex='0']");
      focusTarget?.focus({ preventScroll: true });
    });
  }
}

let lastTone: SupercodeUiState["pill"]["tone"] = "off";
let unreadCount = 0;
let collapsedMode: PillMode = "connecting";
let collapsedHarness = "";
let collapsedLabel = "Open agent chats";
let collapsedRenderKey: string | null = null;

widget.registerPanel({
  id: "agent",
  title: "Chats",
  render: renderMessengerPanel,
  default: true,
  indicator: () => lastTone,
  badge: () => unreadCount,
});

// A conventional 56px messenger launcher plus 4px of safe area on every side. The safe area is
// part of the iframe host so badges, focus rings, activity dots, and hover scale never get clipped.
const COLLAPSED_SIZE_PX = 64;
let collapsedHostObserver: MutationObserver | null = null;

function fitCollapsedHost(): void {
  const pill = document.querySelector<HTMLButtonElement>(".pill");
  const panel = document.querySelector<HTMLElement>(".panel");
  const root = window.frameElement?.getRootNode();
  const host = root && "host" in root ? (root as ShadowRoot).host : null;
  if (!host || !("style" in host)) return;
  const hostElement = host as HTMLElement;
  if (!pill) {
    const radius = panel ? "12px" : "32px";
    if (hostElement.style.borderRadius !== radius) hostElement.style.borderRadius = radius;
    const scrim = root && "querySelector" in root ? (root as ShadowRoot).querySelector<HTMLElement>("div") : null;
    if (scrim && scrim.style.borderRadius !== radius) scrim.style.borderRadius = radius;
    return;
  }
  const size = `${COLLAPSED_SIZE_PX}px`;
  if (hostElement.style.width !== size) hostElement.style.width = size;
  if (hostElement.style.height !== size) hostElement.style.height = size;
  if (hostElement.style.borderRadius !== "32px") hostElement.style.borderRadius = "32px";
  const scrim = root && "querySelector" in root ? (root as ShadowRoot).querySelector<HTMLElement>("div") : null;
  if (scrim && scrim.style.borderRadius !== "32px") scrim.style.borderRadius = "32px";
  const identityReady = hasHarnessLogo(collapsedHarness);
  const visibility = identityReady ? "visible" : "hidden";
  const pointerEvents = identityReady ? "auto" : "none";
  if (hostElement.style.visibility !== visibility) hostElement.style.visibility = visibility;
  if (hostElement.style.pointerEvents !== pointerEvents) hostElement.style.pointerEvents = pointerEvents;
  if (!collapsedHostObserver) {
    collapsedHostObserver = new MutationObserver(fitCollapsedHost);
    collapsedHostObserver.observe(hostElement, { attributes: true, attributeFilter: ["style"] });
  }
}

function syncCollapsedChrome(): void {
  const pill = document.querySelector<HTMLButtonElement>(".pill");
  if (!pill) return;
  pill.dataset.mode = collapsedMode;
  const identityReady = hasHarnessLogo(collapsedHarness);
  pill.hidden = !identityReady;
  pill.setAttribute("aria-label", collapsedLabel);
  pill.title = collapsedLabel;
  const brand = pill.querySelector<HTMLElement>(".brand");
  if (brand) renderPreact(identityReady ? <HarnessLogo id={collapsedHarness} size={34} /> : null, brand);
  fitCollapsedHost();
  if (restoreLauncherFocus && !pill.hidden) {
    restoreLauncherFocus = false;
    pill.focus({ preventScroll: true });
  }
}

const shellWrap = document.querySelector(".wrap");
if (shellWrap) new MutationObserver(syncCollapsedChrome).observe(shellWrap, { childList: true });
syncCollapsedChrome();

const accumulatedState: Record<string, unknown> = {};

function pillMode(state: SupercodeUiState): PillMode {
  if (state.startup !== "ready") return "connecting";
  if (state.error) return "error";
  if (state.needsInput) return "needs-input";
  if (state.busy) return "working";
  if (state.attention.length) return "unread";
  return "idle";
}

widget.onPatch((patch) => {
  if (!isRecord(patch)) return;
  const acknowledged = typeof patch.bridgeAck === "string" && patch.bridgeAck === pendingBridgeIntent?.id;
  const includesSnapshot = Object.keys(patch).some((key) => key !== "bridgeAck" && key !== "bridgeDone");
  if (typeof patch.bridgeDone === "string") resolveBridgeCompletion(patch.bridgeDone);
  if (acknowledged || (pendingBridgeIntent?.acceptsSnapshot && includesSnapshot)) clearBridgeWatch();
  if (bridgeReconnecting) bridgeReconnecting = false;
  if (bridgeDisconnected) bridgeDisconnected = false;
  const resolution = isRecord(patch.imageResolution) ? patch.imageResolution : null;
  if (resolution && typeof resolution.requestId === "string") {
    const pending = imageResolutions.get(resolution.requestId);
    if (pending) {
      clearTimeout(pending.timer);
      imageResolutions.delete(resolution.requestId);
      if (resolution.status === "resolved" && typeof resolution.dataUrl === "string") {
        try {
          pending.resolve(imageBlobFromDataUrl(resolution.dataUrl));
        } catch (error) {
          pending.reject(error instanceof Error ? error : new Error("Could not decode this image."));
        }
      } else {
        pending.reject(new Error(typeof resolution.message === "string" && resolution.message ? resolution.message : "Could not load this image."));
      }
    }
  }
  for (const [key, value] of Object.entries(patch)) {
    if (key !== "imageResolution") accumulatedState[key] = value;
  }
  const state = normalizeUiState(accumulatedState);
  lastTone = state.pill.tone;
  const unreadKeys = new Set(state.attention.map((item) => item.key));
  if (state.needsInput) unreadKeys.add(state.attached?.key || state.owned?.key || "@needs-input");
  unreadCount = unreadKeys.size;
  collapsedMode = pillMode(state);
  collapsedLabel = state.pill.label ? `Open agent chats · ${state.pill.label}` : "Open agent chats";
  collapsedHarness = state.attached?.harness
    || state.harness
    || state.sessions.find((session) => session.active)?.harness
    || "";
  const renderKey = [state.pill.tone, state.pill.label, collapsedMode, collapsedHarness, unreadCount].join("\u0000");
  if (renderKey === collapsedRenderKey) return;
  collapsedRenderKey = renderKey;
  widget.setPill({ tone: state.pill.tone, label: state.pill.label });
  syncCollapsedChrome();
});

// A sticky injection gets a fresh iframe on every navigation. Register the patch listener first,
// then ask the trusted daemon for exactly one current snapshot so a fast reply cannot be lost.
sendBridgeIntent({ action: "mounted" });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
