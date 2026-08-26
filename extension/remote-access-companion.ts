import qrcode from "qrcode-generator";
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
  capabilities: unknown[];
  enabled: boolean;
  error?: string;
  provider: RemoteAccessProvider;
  publicUrl?: string;
  stability?: "stable" | "temporary";
  status: RemoteAccessStatus;
}

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
    .vw-remote-access { position: relative; font: 14px/1.4 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color-scheme: light dark; }
    .vw-remote-access[data-embedded="true"] { position:fixed; z-index:1000; inset:0; pointer-events:none; }
    .vw-remote-access[data-embedded="true"] .vw-remote-trigger { display:none; }
    .vw-remote-access[data-embedded="true"] .vw-remote-panel { position:fixed; right:16px; bottom:16px; pointer-events:auto; }
    .vw-remote-trigger { position: relative; display:grid; width:48px; height:48px; padding:0; place-items:center; border:1px solid rgba(20,20,28,.15); border-radius:14px; color:#24242a; background:color-mix(in srgb,#fff 90%,transparent); box-shadow:0 5px 18px rgba(16,18,30,.13); cursor:pointer; }
    .vw-remote-trigger:hover { background:#fff; box-shadow:0 7px 22px rgba(16,18,30,.17); }
    .vw-remote-trigger:focus-visible,.vw-remote-close:focus-visible,.vw-remote-button:focus-visible,.vw-remote-link:focus-visible { outline:3px solid rgba(36,36,42,.28); outline-offset:2px; }
    .vw-remote-trigger svg { width:24px; height:24px; fill:none; stroke:currentColor; stroke-width:1.65; stroke-linecap:round; stroke-linejoin:round; }
    .vw-remote-state { position:absolute; right:5px; bottom:5px; width:9px; height:9px; border:2px solid #fff; border-radius:50%; background:#2e9b58; }
    .vw-remote-trigger[data-status="starting"] .vw-remote-state,.vw-remote-trigger[data-status="reconnecting"] .vw-remote-state { background:#b87918; }
    .vw-remote-trigger[data-status="off"] .vw-remote-state,.vw-remote-trigger[data-status="error"] .vw-remote-state { display:none; }
    .vw-remote-panel { position:absolute; z-index:8; right:calc(100% + 12px); bottom:0; width:316px; padding:18px; border:1px solid rgba(20,20,28,.14); border-radius:16px; color:#202026; background:#fff; box-shadow:0 18px 60px rgba(16,18,30,.2),0 3px 12px rgba(16,18,30,.1); }
    .vw-remote-panel[hidden] { display:none; }
    .vw-remote-heading { display:flex; gap:12px; align-items:flex-start; justify-content:space-between; }
    .vw-remote-heading strong { display:block; font-size:16px; line-height:1.25; }
    .vw-remote-heading p,.vw-remote-detail { margin:5px 0 0; color:#6a6a74; font-size:12px; }
    .vw-remote-close { display:grid; flex:0 0 auto; width:30px; height:30px; padding:0; place-items:center; border:0; border-radius:9px; color:#676771; background:transparent; cursor:pointer; }
    .vw-remote-close:hover { background:#f1f1f4; }
    .vw-remote-close svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; }
    .vw-remote-progress { display:flex; gap:10px; min-height:86px; align-items:center; color:#5f5f68; }
    .vw-remote-spinner { width:18px; height:18px; flex:0 0 auto; border:2px solid #d6d6dc; border-top-color:#34343a; border-radius:50%; animation:vw-remote-spin .85s linear infinite; }
    .vw-remote-handoff { display:grid; grid-template-columns:112px minmax(0,1fr); gap:14px; margin-top:16px; align-items:start; }
    .vw-remote-qr { display:block; width:112px; height:112px; border:1px solid #e0e0e4; border-radius:10px; background:white; }
    .vw-remote-scan-label { display:block; margin:1px 0 12px; color:#35353c; font-size:12px; font-weight:650; }
    .vw-remote-code-label { display:block; color:#6a6a74; font-size:11px; }
    .vw-remote-code { display:block; margin:3px 0 8px; color:#202026; font:700 22px/1.15 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.04em; }
    .vw-remote-link { display:block; overflow:hidden; color:#35353c; font-size:11px; text-decoration:underline; text-overflow:ellipsis; white-space:nowrap; }
    .vw-remote-devices { display:flex; min-height:28px; margin-top:14px; align-items:center; justify-content:space-between; gap:10px; color:#5f5f68; font-size:12px; }
    .vw-remote-disconnect { padding:4px 0; border:0; color:#555560; background:transparent; font:600 11px/1.2 ui-sans-serif,-apple-system,sans-serif; text-decoration:underline; cursor:pointer; }
    .vw-remote-actions { display:flex; gap:8px; margin-top:16px; }
    .vw-remote-button { min-height:36px; padding:0 12px; border:1px solid #d7d7dc; border-radius:10px; color:#29292f; background:#f7f7f8; font:600 12px/1 ui-sans-serif,-apple-system,sans-serif; cursor:pointer; }
    .vw-remote-button:hover { background:#ededf0; }
    .vw-remote-button[data-kind="stop"] { margin-left:auto; color:#a53232; background:transparent; }
    .vw-remote-error { margin:14px 0 0; color:#a53232; font-size:12px; }
    @media (prefers-color-scheme:dark) {
      .vw-remote-trigger { border-color:rgba(255,255,255,.16); color:#f4f4f5; background:rgba(27,27,31,.92); }
      .vw-remote-trigger:hover { background:#25252a; }
      .vw-remote-state { border-color:#202025; }
      .vw-remote-panel { border-color:rgba(255,255,255,.14); color:#f1f1f3; background:#202025; }
      .vw-remote-heading p,.vw-remote-detail,.vw-remote-progress,.vw-remote-code-label { color:#aaaab3; }
      .vw-remote-scan-label { color:#e0e0e4; }
      .vw-remote-devices { color:#aaaab3; }.vw-remote-disconnect { color:#c9c9cf; }
      .vw-remote-close { color:#b8b8c0; }.vw-remote-close:hover { background:#303036; }
      .vw-remote-code { color:#f1f1f3; }.vw-remote-link { color:#d0d0d5; }
      .vw-remote-button { border-color:#494950; color:#eeeef0; background:#2c2c31; }.vw-remote-button:hover { background:#36363c; }
    }
    @media (max-width:760px) { .vw-remote-panel { position:fixed; right:16px; bottom:80px; left:16px; width:auto; } }
    @media (prefers-reduced-motion:reduce) { .vw-remote-spinner { animation:none; border-top-color:#d6d6dc; } }
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
    if (!snapshot.enabled || snapshot.status === "off") configure(true);
    else if (snapshot.status === "connected") options.requestPairing();
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

export function createRemoteAccessLauncher(options: {
  open(): void;
}): RemoteAccessLauncher {
  const root = document.createElement("div");
  const style = document.createElement("style");
  style.textContent = `
    .vw-remote-launcher { position:relative; font:14px/1 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    .vw-remote-launcher button { position:relative; display:grid; width:48px; height:48px; padding:0; place-items:center; border:1px solid rgba(20,20,28,.15); border-radius:14px; color:#24242a; background:color-mix(in srgb,#fff 90%,transparent); box-shadow:0 5px 18px rgba(16,18,30,.13); cursor:pointer; }
    .vw-remote-launcher button:hover { background:#fff; box-shadow:0 7px 22px rgba(16,18,30,.17); }
    .vw-remote-launcher button:focus-visible { outline:3px solid rgba(36,36,42,.28); outline-offset:2px; }
    .vw-remote-launcher svg { width:24px; height:24px; fill:none; stroke:currentColor; stroke-width:1.65; stroke-linecap:round; stroke-linejoin:round; }
    .vw-remote-launcher-state { position:absolute; right:5px; bottom:5px; width:9px; height:9px; border:2px solid #fff; border-radius:50%; background:#2e9b58; }
    .vw-remote-launcher button[data-status="starting"] .vw-remote-launcher-state,.vw-remote-launcher button[data-status="reconnecting"] .vw-remote-launcher-state { background:#b87918; }
    .vw-remote-launcher button[data-status="off"] .vw-remote-launcher-state,.vw-remote-launcher button[data-status="error"] .vw-remote-launcher-state { display:none; }
    @media (prefers-color-scheme:dark) { .vw-remote-launcher button { border-color:rgba(255,255,255,.16); color:#f4f4f5; background:rgba(27,27,31,.92); }.vw-remote-launcher button:hover { background:#25252a; }.vw-remote-launcher-state { border-color:#202025; } }
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
