// Vibewaiting is intentionally only the composition seam between Lucarne's embeddable shell and
// Supercode's reusable default UI. Agent semantics, components, transcript presentation, logos,
// continuation controls, and presentation memory live in @volter-ai-dev/supercode-ui. This file
// owns only iframe sizing, Lucarne intents, collapsed launcher chrome, and host focus lifecycle.
import { SupercodeMessenger } from "@volter-ai-dev/supercode-ui/preact/messenger";
import { HarnessLogo, hasHarnessLogo } from "@volter-ai-dev/supercode-ui/preact/logo";
import { normalizeUiState } from "@volter-ai-dev/supercode-ui/core";
import type { SupercodeUiIntent, SupercodeUiState, UiAdapter } from "@volter-ai-dev/supercode-ui";
import { createWidget } from "lucarne/widget/runtime";
import { render as renderPreact } from "preact";
import type { JSX } from "preact";

type PillMode = "connecting" | "idle" | "unread" | "working" | "needs-input" | "error";

const NS = "vibewaiting";
const INTENT_QUEUE = "agent";
const BRIDGE_ACK_TIMEOUT_MS = 600;
const widget = createWidget({ ns: NS, version: 1 });

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
  window.addEventListener("pagehide", () => pageWindow.removeEventListener("resize", onPageResize), { once: true });
} catch {
  // Cross-origin embedders retain fixed safe dimensions.
}

let mountedPanelContainer: HTMLElement | null = null;
let restoreLauncherFocus = false;
let lastPanelState: unknown = {};
let bridgeDisconnected = false;
let bridgeAckTimer: ReturnType<typeof setTimeout> | null = null;
let pendingBridgeIntent: { id: string; attachKey: string | null; mounted: boolean } | null = null;

function clearBridgeWatch(): void {
  if (bridgeAckTimer !== null) clearTimeout(bridgeAckTimer);
  bridgeAckTimer = null;
  pendingBridgeIntent = null;
}

function renderCurrentPanel(): void {
  if (mountedPanelContainer !== null) renderMessengerPanel(mountedPanelContainer, lastPanelState);
}

function watchBridge(id: string, intent: SupercodeUiIntent | { action: "mounted" }): void {
  clearBridgeWatch();
  pendingBridgeIntent = {
    id,
    attachKey: intent.action === "attach" ? intent.key : null,
    mounted: intent.action === "mounted",
  };
  bridgeAckTimer = setTimeout(() => {
    bridgeAckTimer = null;
    bridgeDisconnected = true;
    lastTone = "dead";
    collapsedMode = "error";
    collapsedLabel = "Agent bridge disconnected";
    renderCurrentPanel();
    syncCollapsedChrome();
  }, BRIDGE_ACK_TIMEOUT_MS);
}

function sendBridgeIntent(intent: SupercodeUiIntent | { action: "mounted" }): void {
  const id = widget.sendIntent(INTENT_QUEUE, intent);
  if (intent.action !== "draft" && intent.action !== "ack") watchBridge(id, intent);
}

function closeMessenger(): void {
  if (mountedPanelContainer !== null) renderPreact(null, mountedPanelContainer);
  mountedPanelContainer = null;
  restoreLauncherFocus = true;
  widget.close();
}

const adapter: UiAdapter = {
  onIntent(intent: SupercodeUiIntent): void {
    sendBridgeIntent(intent);
  },
  onClose: closeMessenger,
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
      {bridgeDisconnected ? <section class="vw-bridge-disconnected" role="alert"><strong>Agent bridge disconnected</strong><small>Restart Vibewaiting for this browser session.</small><button type="button" onClick={closeMessenger}>Close</button></section> : null}
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
    sendBridgeIntent({ action: "mounted" });
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
  const root = window.frameElement?.getRootNode();
  const host = root && "host" in root ? (root as ShadowRoot).host : null;
  if (!host || !("style" in host)) return;
  const hostElement = host as HTMLElement;
  if (!pill) {
    if (hostElement.style.borderRadius !== "32px") hostElement.style.borderRadius = "32px";
    return;
  }
  const size = `${COLLAPSED_SIZE_PX}px`;
  if (hostElement.style.width !== size) hostElement.style.width = size;
  if (hostElement.style.height !== size) hostElement.style.height = size;
  if (hostElement.style.borderRadius !== "32px") hostElement.style.borderRadius = "32px";
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
  if (acknowledged || pendingBridgeIntent?.mounted) clearBridgeWatch();
  if (bridgeDisconnected) bridgeDisconnected = false;
  Object.assign(accumulatedState, patch);
  const state = normalizeUiState(accumulatedState);
  lastTone = state.pill.tone;
  unreadCount = state.attention.length + (state.needsInput ? 1 : 0);
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
