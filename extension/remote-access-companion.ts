import qrcode from "qrcode-generator";
import { BRAND_FONT, BRAND_LIGHT, BRAND_SHADOW, brandProperties, type BrandRole } from "../src/brand.js";
import type {
  RemoteAccessConfiguration,
  RemoteAccessProvider,
} from "../src/extension-protocol.js";
import {
  activeRemotePairingUrl,
  parseRemoteDeviceSnapshot,
  parseRemotePairingHandoff,
  type RemoteDeviceSnapshot,
} from "@volter-ai-dev/supercode-remote-access/client";

type RemoteAccessStatus =
  | "connected"
  | "error"
  | "off"
  | "reconnecting"
  | "starting";

interface RemoteAccessSnapshot {
  activeProvider?: Exclude<RemoteAccessProvider, "auto">;
  capabilities: unknown[];
  enabled: boolean;
  error?: string;
  provider: RemoteAccessProvider;
  publicUrl?: string;
  stability?: "stable" | "temporary";
  status: RemoteAccessStatus;
}

interface RemoteAccessCapability {
  detail: string;
  provider: Exclude<RemoteAccessProvider, "auto">;
  status: "needs-setup" | "ready" | "unavailable";
}

const REMOTE_ACCESS_PROVIDERS: readonly RemoteAccessProvider[] = [
  "auto",
  "ngrok",
  "cloudflare",
  "stable",
];

export interface RemoteAccessCompanion {
  readonly node: HTMLElement;
  close(): void;
  destroy(): void;
  open(): void;
  update(
    snapshot: unknown,
    passcode: unknown,
    pairing: unknown,
    devices: unknown,
  ): void;
}

export interface RemoteAccessLauncher {
  readonly node: HTMLElement;
  destroy(): void;
  update(status: unknown): void;
}

const REMOTE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 18.25h9M12 14.75v3.5M5.25 4.75h13.5A2.25 2.25 0 0 1 21 7v5.5a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 12.5V7a2.25 2.25 0 0 1 2.25-2.25Z"/><path d="M15.5 8.15a4.45 4.45 0 0 1 0 3.7M17.75 6.5a6.7 6.7 0 0 1 0 7"/></svg>`;
const CLOSE_ICON = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 5.5 9 9m0-9-9 9"/></svg>`;

function isRemoteAccessSnapshot(value: unknown): value is RemoteAccessSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.enabled === "boolean" &&
    (candidate.activeProvider === undefined ||
      candidate.activeProvider === "cloudflare" ||
      candidate.activeProvider === "ngrok" ||
      candidate.activeProvider === "stable") &&
    (candidate.provider === "auto" ||
      candidate.provider === "cloudflare" ||
      candidate.provider === "ngrok" ||
      candidate.provider === "stable") &&
    (candidate.status === "connected" ||
      candidate.status === "error" ||
      candidate.status === "off" ||
      candidate.status === "reconnecting" ||
      candidate.status === "starting") &&
    Array.isArray(candidate.capabilities)
  );
}

function formatPasscode(value: string): string {
  return /^\d{6}$/.test(value)
    ? `${value.slice(0, 3)} ${value.slice(3)}`
    : value;
}

function providerLabel(provider: RemoteAccessProvider): string {
  if (provider === "ngrok") return "ngrok";
  if (provider === "cloudflare") return "Cloudflare";
  if (provider === "stable") return "Stable relay";
  return "Automatic";
}

function capabilityFor(
  snapshot: RemoteAccessSnapshot,
  provider: RemoteAccessProvider,
): RemoteAccessCapability | null {
  if (provider === "auto") return null;
  for (const value of snapshot.capabilities) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      continue;
    const candidate = value as Record<string, unknown>;
    if (
      candidate.provider === provider &&
      typeof candidate.detail === "string" &&
      (candidate.status === "needs-setup" ||
        candidate.status === "ready" ||
        candidate.status === "unavailable")
    ) {
      return candidate as unknown as RemoteAccessCapability;
    }
  }
  return null;
}

function providerReady(
  snapshot: RemoteAccessSnapshot,
  provider: RemoteAccessProvider,
): boolean {
  if (!snapshot.capabilities.length) return true;
  if (provider === "auto")
    return snapshot.capabilities.some((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
      return (value as Record<string, unknown>).status === "ready";
    });
  return capabilityFor(snapshot, provider)?.status === "ready";
}

export function createRemoteAccessCompanion(options: {
  configure(configuration: RemoteAccessConfiguration): void;
  embedded?: boolean;
  requestPairing(): void;
  revokeDevices(): void;
}): RemoteAccessCompanion {
  const root = document.createElement("div");
  root.className = "vw-remote-access";
  root.dataset.embedded = String(options.embedded === true);
  const id = `vw-remote-access-${crypto.randomUUID()}`;

  const style = document.createElement("style");
  style.textContent = `
    ${brandProperties(".vw-remote-access", REMOTE_ROLES)}
    .vw-remote-access { position: relative; font: 14px/1.4 ${BRAND_FONT.ui}; color-scheme: light dark; }
    .vw-remote-access[data-embedded="true"] { position:fixed; z-index:1000; top:0; left:0; width:0; height:0; pointer-events:none; }
    .vw-remote-access[data-embedded="true"] .vw-remote-trigger { display:none; }
    .vw-remote-access[data-embedded="true"] .vw-remote-panel { position:fixed; right:16px; bottom:16px; pointer-events:auto; }
    .vw-remote-trigger { position: relative; display:grid; width:48px; height:48px; padding:0; place-items:center; border:1px solid var(--vw-border); border-radius:14px; color:var(--vw-fg); background:color-mix(in srgb,var(--vw-surface) 90%,transparent); box-shadow:${BRAND_SHADOW.floating}; cursor:pointer; }
    .vw-remote-trigger:hover { background:var(--vw-surface); }
    .vw-remote-trigger:focus-visible,.vw-remote-close:focus-visible,.vw-remote-button:focus-visible,.vw-remote-link:focus-visible,.vw-remote-provider select:focus-visible { outline:3px solid color-mix(in srgb,var(--vw-fg) 28%,transparent); outline-offset:2px; }
    .vw-remote-trigger svg { width:24px; height:24px; fill:none; stroke:currentColor; stroke-width:1.65; stroke-linecap:round; stroke-linejoin:round; }
    .vw-remote-state { position:absolute; right:5px; bottom:5px; width:9px; height:9px; border:2px solid var(--vw-surface); border-radius:50%; background:var(--vw-live); }
    .vw-remote-trigger[data-status="starting"] .vw-remote-state,.vw-remote-trigger[data-status="reconnecting"] .vw-remote-state { background:var(--vw-attention); }
    .vw-remote-trigger[data-status="off"] .vw-remote-state,.vw-remote-trigger[data-status="error"] .vw-remote-state { display:none; }
    .vw-remote-panel { position:absolute; z-index:8; right:calc(100% + 12px); bottom:0; width:316px; padding:18px; border:1px solid var(--vw-border); border-radius:16px; color:var(--vw-fg); background:var(--vw-surface); box-shadow:${BRAND_SHADOW.floating}; }
    .vw-remote-panel[hidden] { display:none; }
    .vw-remote-heading { display:flex; gap:12px; align-items:flex-start; justify-content:space-between; }
    .vw-remote-heading strong { display:block; font-size:16px; line-height:1.25; }
    .vw-remote-heading p,.vw-remote-detail { margin:5px 0 0; color:var(--vw-muted); font-size:12px; }
    .vw-remote-close { display:grid; flex:0 0 auto; width:30px; height:30px; padding:0; place-items:center; border:0; border-radius:9px; color:var(--vw-muted); background:transparent; cursor:pointer; }
    .vw-remote-close:hover { background:var(--vw-fill-hover); }
    .vw-remote-close svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; }
    .vw-remote-provider { display:grid; grid-template-columns:auto minmax(0,1fr); gap:8px 12px; margin-top:16px; align-items:center; color:var(--vw-muted); font-size:12px; }
    .vw-remote-provider select { min-width:0; height:34px; padding:0 30px 0 10px; border:1px solid var(--vw-border-strong); border-radius:9px; color:var(--vw-fg); background:var(--vw-fill); font:600 12px/1 ${BRAND_FONT.ui}; }
    .vw-remote-provider small { grid-column:1/-1; color:var(--vw-muted); font-size:11px; }
    .vw-remote-progress { display:flex; gap:10px; min-height:86px; align-items:center; color:var(--vw-muted); }
    .vw-remote-spinner { width:18px; height:18px; flex:0 0 auto; border:2px solid var(--vw-border-strong); border-top-color:var(--vw-fg); border-radius:50%; animation:vw-remote-spin .85s linear infinite; }
    .vw-remote-handoff { display:grid; grid-template-columns:112px minmax(0,1fr); gap:14px; margin-top:16px; align-items:start; }
    .vw-remote-qr { display:block; width:112px; height:112px; border:1px solid var(--vw-border); border-radius:10px; background:${BRAND_LIGHT["surface.raised"]}; }
    .vw-remote-scan-label { display:block; margin:1px 0 12px; color:var(--vw-fg); font-size:12px; font-weight:650; }
    .vw-remote-code-label { display:block; color:var(--vw-muted); font-size:11px; }
    .vw-remote-code { display:block; margin:3px 0 8px; color:var(--vw-fg); font:700 22px/1.15 ${BRAND_FONT.data}; letter-spacing:.04em; }
    .vw-remote-link { display:block; overflow:hidden; color:var(--vw-fg); font-size:11px; text-decoration:underline; text-overflow:ellipsis; white-space:nowrap; }
    .vw-remote-devices { display:flex; min-height:28px; margin-top:14px; align-items:center; justify-content:space-between; gap:10px; color:var(--vw-muted); font-size:12px; }
    .vw-remote-disconnect { padding:4px 0; border:0; color:var(--vw-muted); background:transparent; font:600 11px/1.2 ${BRAND_FONT.ui}; text-decoration:underline; cursor:pointer; }
    .vw-remote-actions { display:flex; gap:8px; margin-top:16px; }
    .vw-remote-button { min-height:36px; padding:0 12px; border:1px solid var(--vw-border-strong); border-radius:10px; color:var(--vw-fg); background:var(--vw-fill); font:600 12px/1 ${BRAND_FONT.ui}; cursor:pointer; }
    .vw-remote-button:hover { background:var(--vw-fill-hover); }
    .vw-remote-button[data-kind="stop"] { margin-left:auto; color:var(--vw-danger); background:transparent; }
    .vw-remote-error { margin:14px 0 0; color:var(--vw-danger); font-size:12px; }
    @media (max-width:760px) { .vw-remote-panel { position:fixed; right:16px; bottom:80px; left:16px; width:auto; } }
    @media (prefers-reduced-motion:reduce) { .vw-remote-spinner { animation:none; border-top-color:var(--vw-border-strong); } }
    @keyframes vw-remote-spin { to { transform:rotate(360deg); } }
  `;


  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "vw-remote-trigger";
  trigger.title = "Remote access";
  trigger.setAttribute("aria-label", "Remote access");
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-controls", id);
  trigger.setAttribute("aria-expanded", "false");
  trigger.innerHTML = `${REMOTE_ICON}<span class="vw-remote-state" aria-hidden="true"></span>`;

  const panel = document.createElement("section");
  panel.id = id;
  panel.className = "vw-remote-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Remote access");
  panel.hidden = true;

  const heading = document.createElement("div");
  heading.className = "vw-remote-heading";
  const headingCopy = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = "Remote access";
  const summary = document.createElement("p");
  summary.textContent = "Open Vibewaiting securely from another device.";
  headingCopy.append(title, summary);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "vw-remote-close";
  close.setAttribute("aria-label", "Close remote access");
  close.innerHTML = CLOSE_ICON;
  heading.append(headingCopy, close);

  const body = document.createElement("div");
  body.setAttribute("aria-live", "polite");
  panel.append(heading, body);
  root.append(style, trigger, panel);

  let snapshot: RemoteAccessSnapshot = {
    capabilities: [],
    enabled: false,
    provider: "auto",
    status: "off",
  };
  let passcode = "";
  let pairing: unknown;
  let devices: RemoteDeviceSnapshot | null = null;
  let qrUrl = "";
  let qrDataUrl = "";
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  let pairingTimer: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();

  function clearPairingTimer(): void {
    if (pairingTimer) clearTimeout(pairingTimer);
    pairingTimer = undefined;
  }

  function schedulePairingRefresh(): void {
    clearPairingTimer();
    if (panel.hidden || snapshot.status !== "connected" || !snapshot.publicUrl)
      return;
    const handoff = parseRemotePairingHandoff(pairing);
    const delay = handoff
      ? Math.max(0, handoff.expiresAt - Date.now() - 10_000)
      : 0;
    pairingTimer = setTimeout(() => {
      pairing = undefined;
      render();
      options.requestPairing();
    }, delay);
  }

  function closePanel(): void {
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    clearPairingTimer();
  }

  function openPanel(): void {
    if (!panel.hidden) return;
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    if (snapshot.status === "connected") options.requestPairing();
    close.focus();
  }

  function configure(enabled: boolean): void {
    options.configure({ enabled, provider: snapshot.provider });
    if (enabled) snapshot = { ...snapshot, enabled: true, status: "starting" };
    else {
      const { error: _error, publicUrl: _publicUrl, ...rest } = snapshot;
      snapshot = { ...rest, enabled: false, status: "off" };
    }
    render();
  }

  function render(): void {
    trigger.dataset.status = snapshot.status;
    trigger.setAttribute(
      "aria-description",
      snapshot.status === "connected"
        ? "Remote access is on"
        : snapshot.status === "starting" || snapshot.status === "reconnecting"
          ? "Remote access is connecting"
          : "Remote access is off",
    );
    body.replaceChildren();
    const providerControl = document.createElement("label");
    providerControl.className = "vw-remote-provider";
    const providerTitle = document.createElement("span");
    providerTitle.textContent = "Provider";
    const providerSelect = document.createElement("select");
    providerSelect.setAttribute("aria-label", "Remote access provider");
    providerSelect.disabled =
      snapshot.status === "starting" || snapshot.status === "reconnecting";
    for (const provider of REMOTE_ACCESS_PROVIDERS) {
      const option = document.createElement("option");
      option.value = provider;
      const capability = capabilityFor(snapshot, provider);
      option.textContent = `${providerLabel(provider)}${
        provider !== "auto" && capability?.status !== "ready"
          ? " · setup needed"
          : ""
      }`;
      option.disabled =
        provider !== "auto" && capability?.status !== "ready";
      providerSelect.append(option);
    }
    providerSelect.value = snapshot.provider;
    const providerDetail = document.createElement("small");
    providerDetail.textContent = snapshot.activeProvider && snapshot.status === "connected"
      ? `Connected with ${providerLabel(snapshot.activeProvider)}.`
      : snapshot.provider === "auto"
        ? "Automatic prefers a stable relay, then Cloudflare, then ngrok."
        : capabilityFor(snapshot, snapshot.provider)?.detail ??
          `Use ${providerLabel(snapshot.provider)} for this link.`;
    providerSelect.addEventListener(
      "change",
      () => {
        const provider = providerSelect.value as RemoteAccessProvider;
        const enabled = snapshot.enabled;
        snapshot = {
          ...snapshot,
          provider,
          ...(enabled ? { status: "starting" as const } : {}),
        };
        options.configure({ enabled, provider });
        render();
      },
      { signal: abort.signal },
    );
    providerControl.append(providerTitle, providerSelect, providerDetail);
    body.append(providerControl);
    if (snapshot.status === "starting" || snapshot.status === "reconnecting") {
      const progress = document.createElement("div");
      progress.className = "vw-remote-progress";
      const spinner = document.createElement("span");
      spinner.className = "vw-remote-spinner";
      spinner.setAttribute("aria-hidden", "true");
      const detail = document.createElement("span");
      detail.textContent =
        snapshot.status === "starting"
          ? "Starting a secure link…"
          : "Restoring the secure link…";
      progress.append(spinner, detail);
      body.append(progress);
      return;
    }
    if (snapshot.status === "connected" && snapshot.publicUrl) {
      const currentDevices = devices;
      if (!currentDevices) {
        const progress = document.createElement("div");
        progress.className = "vw-remote-progress";
        progress.textContent = "Checking paired phones…";
        body.append(progress);
        return;
      }
      const pairingUrl = activeRemotePairingUrl(pairing, snapshot.publicUrl);
      const nextQrUrl = pairingUrl ?? snapshot.publicUrl;
      if (nextQrUrl !== qrUrl) {
        const qr = qrcode(0, "M");
        qr.addData(nextQrUrl);
        qr.make();
        qrUrl = nextQrUrl;
        qrDataUrl = qr.createDataURL(5, 2);
      }
      const handoff = document.createElement("div");
      handoff.className = "vw-remote-handoff";
      const qrImage = document.createElement("img");
      qrImage.className = "vw-remote-qr";
      qrImage.alt = pairingUrl
        ? "QR code for one-scan remote pairing"
        : "QR code for opening Vibewaiting remotely";
      qrImage.src = qrDataUrl;
      const details = document.createElement("div");
      const scanLabel = document.createElement("span");
      scanLabel.className = "vw-remote-scan-label";
      scanLabel.textContent = pairingUrl
        ? "Scan to open directly"
        : "Scan to open the sign-in page";
      const codeLabel = document.createElement("span");
      codeLabel.className = "vw-remote-code-label";
      codeLabel.textContent = pairingUrl ? "Or enter" : "Then enter";
      const code = document.createElement("strong");
      code.className = "vw-remote-code";
      code.textContent = formatPasscode(passcode);
      const link = document.createElement("a");
      link.className = "vw-remote-link";
      link.href = snapshot.publicUrl;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = snapshot.publicUrl;
      details.append(scanLabel, codeLabel, code, link);
      handoff.append(qrImage, details);
      const deviceRow = document.createElement("div");
      deviceRow.className = "vw-remote-devices";
      const deviceStatus = document.createElement("span");
      deviceStatus.textContent = remoteDeviceSummary(currentDevices);
      deviceRow.append(deviceStatus);
      if (currentDevices.authorizedDevices > 0) {
        const disconnect = document.createElement("button");
        disconnect.type = "button";
        disconnect.className = "vw-remote-disconnect";
        disconnect.textContent = "Disconnect devices";
        disconnect.addEventListener(
          "click",
          () => {
            disconnect.disabled = true;
            disconnect.textContent = "Disconnecting…";
            options.revokeDevices();
          },
          { signal: abort.signal },
        );
        deviceRow.append(disconnect);
      }
      const remoteDetail = document.createElement("p");
      remoteDetail.className = "vw-remote-detail";
      remoteDetail.textContent =
        snapshot.stability === "temporary"
          ? "Browser access only · this address stops working when remote access stops or reconnects."
          : "Installable · open it once, then choose Install or Add to Home Screen on your phone.";
      const actions = document.createElement("div");
      actions.className = "vw-remote-actions";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "vw-remote-button";
      copy.textContent = "Copy link";
      copy.addEventListener(
        "click",
        () => {
          void navigator.clipboard
            .writeText(snapshot.publicUrl ?? "")
            .then(() => {
              copy.textContent = "Copied";
              if (copiedTimer) clearTimeout(copiedTimer);
              copiedTimer = setTimeout(() => {
                copy.textContent = "Copy link";
              }, 1_500);
            });
        },
        { signal: abort.signal },
      );
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "vw-remote-button";
      stop.dataset.kind = "stop";
      stop.textContent = "Stop access";
      stop.addEventListener("click", () => configure(false), {
        signal: abort.signal,
      });
      actions.append(copy, stop);
      body.append(handoff, deviceRow, remoteDetail, actions);
      return;
    }
    const detail = document.createElement("p");
    detail.className =
      snapshot.status === "error" ? "vw-remote-error" : "vw-remote-detail";
    detail.textContent =
      snapshot.status === "error"
        ? snapshot.error || "The secure link could not be started."
        : "Remote access is off.";
    const actions = document.createElement("div");
    actions.className = "vw-remote-actions";
    const start = document.createElement("button");
    start.type = "button";
    start.className = "vw-remote-button";
    start.disabled = !providerReady(snapshot, snapshot.provider);
    start.textContent =
      snapshot.status === "error" ? "Try again" : "Start remote access";
    start.addEventListener("click", () => configure(true), {
      signal: abort.signal,
    });
    actions.append(start);
    body.append(detail, actions);
  }

  trigger.addEventListener(
    "click",
    () => {
      if (!panel.hidden) {
        closePanel();
        return;
      }
      openPanel();
    },
    { signal: abort.signal },
  );
  close.addEventListener(
    "click",
    () => {
      closePanel();
      trigger.focus();
    },
    { signal: abort.signal },
  );
  root.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || panel.hidden) return;
      event.stopPropagation();
      closePanel();
      trigger.focus();
    },
    { signal: abort.signal },
  );
  render();

  return {
    node: root,
    close: closePanel,
    destroy() {
      if (copiedTimer) clearTimeout(copiedTimer);
      clearPairingTimer();
      abort.abort();
      root.remove();
    },
    open: openPanel,
    update(rawSnapshot, rawPasscode, rawPairing, rawDevices) {
      const nextDevices = parseRemoteDeviceSnapshot(rawDevices);
      if (!isRemoteAccessSnapshot(rawSnapshot) || !nextDevices) return;
      snapshot = rawSnapshot;
      passcode = typeof rawPasscode === "string" ? rawPasscode : "";
      pairing = rawPairing;
      devices = nextDevices;
      render();
      schedulePairingRefresh();
    },
  };
}

// The companion and its launcher are injected into third-party pages, so their
// colours are the brand's roles resolved at build, switched by the OS scheme.
const REMOTE_ROLES: Record<string, BrandRole> = {
  "--vw-surface": "surface.raised",
  "--vw-fill": "surface.subtle",
  "--vw-fill-hover": "surface.inset",
  "--vw-fg": "text.primary",
  "--vw-muted": "text.muted",
  "--vw-border": "border.default",
  "--vw-border-strong": "border.strong",
  "--vw-live": "status.live.base",
  "--vw-attention": "status.attention.base",
  "--vw-danger": "status.danger.text",
};

export function createRemoteAccessLauncher(options: {
  open(): void;
}): RemoteAccessLauncher {
  const root = document.createElement("div");
  const style = document.createElement("style");
  style.textContent = `
    ${brandProperties(".vw-remote-launcher", REMOTE_ROLES)}
    .vw-remote-launcher { position:relative; font:14px/1 ${BRAND_FONT.ui}; }
    .vw-remote-launcher button { position:relative; display:grid; width:48px; height:48px; padding:0; place-items:center; border:1px solid var(--vw-border); border-radius:14px; color:var(--vw-fg); background:color-mix(in srgb,var(--vw-surface) 90%,transparent); box-shadow:${BRAND_SHADOW.floating}; cursor:pointer; }
    .vw-remote-launcher button:hover { background:var(--vw-surface); }
    .vw-remote-launcher button:focus-visible { outline:3px solid color-mix(in srgb,var(--vw-fg) 28%,transparent); outline-offset:2px; }
    .vw-remote-launcher svg { width:24px; height:24px; fill:none; stroke:currentColor; stroke-width:1.65; stroke-linecap:round; stroke-linejoin:round; }
    .vw-remote-launcher-state { position:absolute; right:5px; bottom:5px; width:9px; height:9px; border:2px solid var(--vw-surface); border-radius:50%; background:var(--vw-live); }
    .vw-remote-launcher button[data-status="starting"] .vw-remote-launcher-state,.vw-remote-launcher button[data-status="reconnecting"] .vw-remote-launcher-state { background:var(--vw-attention); }
    .vw-remote-launcher button[data-status="off"] .vw-remote-launcher-state,.vw-remote-launcher button[data-status="error"] .vw-remote-launcher-state { display:none; }
  `;

  root.className = "vw-remote-launcher";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.title = "Remote access";
  trigger.dataset.status = "off";
  trigger.setAttribute("aria-label", "Remote access");
  trigger.innerHTML = `${REMOTE_ICON}<span class="vw-remote-launcher-state" aria-hidden="true"></span>`;
  const abort = new AbortController();
  trigger.addEventListener("click", options.open, { signal: abort.signal });
  root.append(style, trigger);
  return {
    node: root,
    destroy() {
      abort.abort();
      root.remove();
    },
    update(value) {
      if (
        value !== "connected" &&
        value !== "error" &&
        value !== "off" &&
        value !== "reconnecting" &&
        value !== "starting"
      )
        return;
      trigger.dataset.status = value;
      trigger.setAttribute(
        "aria-description",
        value === "connected"
          ? "Remote access is on"
          : value === "starting" || value === "reconnecting"
            ? "Remote access is connecting"
            : "Remote access is off",
      );
    },
  };
}

function remoteDeviceSummary(devices: RemoteDeviceSnapshot | null): string {
  if (!devices) return "Checking paired phones…";
  const { authorizedDevices, connectedDevices } = devices;
  if (connectedDevices > 0 && authorizedDevices > connectedDevices)
    return `${connectedDevices} connected · ${authorizedDevices} paired`;
  if (connectedDevices > 0)
    return `${connectedDevices} ${connectedDevices === 1 ? "phone" : "phones"} connected`;
  if (authorizedDevices > 0)
    return `${authorizedDevices} paired ${authorizedDevices === 1 ? "phone" : "phones"} offline`;
  return "No paired phones";
}
