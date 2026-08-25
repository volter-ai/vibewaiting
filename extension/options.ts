export {};

import {
  browserShortcutLabel,
  type BrowserShortcut,
} from "../src/browser-shortcuts.js";
import qrcode from "qrcode-generator";
import {
  parseRemoteAccessConfiguration,
  type RemoteAccessConfiguration,
  type RemoteAccessProvider,
} from "../src/extension-protocol.js";
import {
  activeRemotePairingUrl,
  parseRemotePairingHandoff,
} from "../src/remote-pairing.js";
import { parseRemoteDeviceSnapshot } from "../src/remote-devices.js";

const SETTINGS_KEY = "vibewaiting:settings";
const form = document.querySelector<HTMLFormElement>("form");
const workspace = document.querySelector<HTMLInputElement>("#workspace");
const harness = document.querySelector<HTMLSelectElement>("#harness");
const policy = document.querySelector<HTMLSelectElement>("#policy");
const statusOutput = document.querySelector<HTMLOutputElement>("output");
const extensionId = document.querySelector<HTMLElement>("#extension-id");
const nativeInstallHint = document.querySelector<HTMLElement>(
  "#native-install-hint",
);
const remoteEnabled = document.querySelector<HTMLInputElement>("#remote-enabled");
const remoteProvider = document.querySelector<HTMLSelectElement>("#remote-provider");
const remoteDetail = document.querySelector<HTMLElement>("#remote-detail");
const remoteHandoff = document.querySelector<HTMLElement>("#remote-handoff");
const remoteQr = document.querySelector<HTMLImageElement>("#remote-qr");
const remotePairingInstruction = document.querySelector<HTMLElement>(
  "#remote-pairing-instruction",
);
const remoteCodeLabel = document.querySelector<HTMLElement>("#remote-code-label");
const remoteCode = document.querySelector<HTMLElement>("#remote-code");
const remoteLink = document.querySelector<HTMLAnchorElement>("#remote-link");
const remoteCopy = document.querySelector<HTMLButtonElement>("#remote-copy");
const remoteStability = document.querySelector<HTMLElement>("#remote-stability");
const remoteDevices = document.querySelector<HTMLElement>("#remote-devices");
const remoteDisconnect =
  document.querySelector<HTMLButtonElement>("#remote-disconnect");
const remoteError = document.querySelector<HTMLElement>("#remote-error");
let activeRemoteConfiguration: RemoteAccessConfiguration = { enabled: false, provider: "auto" };
let pairingRefreshTimer: ReturnType<typeof setTimeout> | undefined;

type Capability = { detail: string; provider: Exclude<RemoteAccessProvider, "auto">; status: "needs-setup" | "ready" | "unavailable" };
type RemoteSnapshot = {
  activeProvider?: Exclude<RemoteAccessProvider, "auto">;
  capabilities: Capability[];
  enabled: boolean;
  error?: string;
  provider: RemoteAccessProvider;
  publicUrl?: string;
  stability?: "stable" | "temporary";
  status: "connected" | "error" | "off" | "reconnecting" | "starting";
};
for (const node of document.querySelectorAll<HTMLElement>("[data-shortcut]")) {
  const shortcut = node.dataset.shortcut as BrowserShortcut | undefined;
  if (shortcut) node.textContent = browserShortcutLabel(shortcut);
}
document
  .querySelector<HTMLButtonElement>("#configure-shortcuts")
  ?.addEventListener("click", () => {
    void chrome.tabs.create({
      url: /Firefox/i.test(navigator.userAgent)
        ? "about:addons"
        : "chrome://extensions/shortcuts",
    });
  });
if (extensionId) extensionId.textContent = chrome.runtime.id;
const port = chrome.runtime.connect({ name: "vibewaiting:options" });

port.onMessage.addListener((raw) => {
  if (
    !statusOutput ||
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw)
  )
    return;
  const message = raw as Record<string, unknown>;
  if (message.type === "remote-access") {
    renderRemoteAccess(
      message.snapshot,
      message.passcode,
      message.pairing,
      message.devices,
    );
    return;
  }
  if (message.type !== "status" || typeof message.phase !== "string") return;
  statusOutput.dataset.phase = message.phase;
  if (nativeInstallHint)
    nativeInstallHint.hidden = message.phase !== "error";
  statusOutput.value =
    message.phase === "ready"
      ? "Connected. Open any regular browser tab."
      : message.phase === "starting"
        ? "Connecting to local coding sessions…"
        : typeof message.message === "string"
          ? message.message
          : message.phase === "setup"
            ? "Choose a workspace to connect."
            : "Not connected.";
});
port.postMessage({ type: "remote-access-pairing-request" });

const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
if (typeof stored === "object" && stored !== null && !Array.isArray(stored)) {
  const settings = stored as Record<string, unknown>;
  if (workspace && typeof settings.workspace === "string")
    workspace.value = settings.workspace;
  if (harness && typeof settings.harness === "string")
    harness.value = settings.harness;
  if (policy && typeof settings.policy === "string")
    policy.value = settings.policy;
  const configuration = parseRemoteAccessConfiguration(settings.remoteAccess);
  if (configuration) {
    activeRemoteConfiguration = configuration;
    if (remoteEnabled) remoteEnabled.checked = configuration.enabled;
    if (remoteProvider) remoteProvider.value = configuration.provider;
  }
}

async function configureRemoteAccess(configuration: RemoteAccessConfiguration): Promise<void> {
  activeRemoteConfiguration = configuration;
  if (remoteEnabled) remoteEnabled.checked = configuration.enabled;
  if (remoteProvider) remoteProvider.value = configuration.provider;
  const current = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
  const settings = typeof current === "object" && current !== null && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {};
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...settings, remoteAccess: configuration } });
  port.postMessage({ type: "remote-access-configure", configuration });
}

remoteEnabled?.addEventListener("change", () => {
  void configureRemoteAccess({ enabled: remoteEnabled.checked, provider: activeRemoteConfiguration.provider });
});
remoteProvider?.addEventListener("change", () => {
  const provider = remoteProvider.value as RemoteAccessProvider;
  void configureRemoteAccess({ enabled: activeRemoteConfiguration.enabled, provider });
});

function renderRemoteAccess(
  rawSnapshot: unknown,
  rawPasscode: unknown,
  rawPairing: unknown,
  rawDevices: unknown,
): void {
  if (!isRemoteSnapshot(rawSnapshot)) return;
  if (pairingRefreshTimer) clearTimeout(pairingRefreshTimer);
  pairingRefreshTimer = undefined;
  activeRemoteConfiguration = { enabled: rawSnapshot.enabled, provider: rawSnapshot.provider };
  if (remoteEnabled) {
    remoteEnabled.checked = rawSnapshot.enabled;
    remoteEnabled.disabled = rawSnapshot.status === "starting" || rawSnapshot.status === "reconnecting";
  }
  if (remoteProvider) {
    remoteProvider.value = rawSnapshot.provider;
    remoteProvider.disabled = rawSnapshot.status === "starting" || rawSnapshot.status === "reconnecting";
    for (const option of remoteProvider.options) {
      if (option.value === "auto") continue;
      const capability = rawSnapshot.capabilities.find((entry) => entry.provider === option.value);
      option.disabled = capability?.status !== "ready";
      option.textContent = `${providerLabel(option.value as RemoteAccessProvider)}${capability?.status === "ready" ? "" : " · setup needed"}`;
    }
  }
  if (remoteDetail) remoteDetail.textContent = remoteDescription(rawSnapshot);
  if (remoteError) remoteError.textContent = rawSnapshot.error ?? "";
  const connected = rawSnapshot.status === "connected" && typeof rawSnapshot.publicUrl === "string";
  if (remoteHandoff) remoteHandoff.hidden = !connected;
  if (!connected || !rawSnapshot.publicUrl) return;
  const pairingUrl = activeRemotePairingUrl(rawPairing, rawSnapshot.publicUrl);
  const handoff = parseRemotePairingHandoff(rawPairing);
  const devices = parseRemoteDeviceSnapshot(rawDevices);
  if (!devices) return;
  if (pairingUrl && handoff) {
    pairingRefreshTimer = setTimeout(
      () => {
        if (remoteQr) {
          const qr = qrcode(0, "M");
          qr.addData(rawSnapshot.publicUrl!);
          qr.make();
          remoteQr.src = qr.createDataURL(6, 2);
          remoteQr.alt = "QR code for opening Vibewaiting remotely";
        }
        if (remotePairingInstruction)
          remotePairingInstruction.textContent = "Scan to open the sign-in page.";
        if (remoteCodeLabel) remoteCodeLabel.textContent = "Then enter:";
        port.postMessage({ type: "remote-access-pairing-request" });
      },
      Math.max(0, handoff.expiresAt - Date.now() - 10_000),
    );
  }
  const passcode = typeof rawPasscode === "string" ? rawPasscode : "";
  if (remotePairingInstruction)
    remotePairingInstruction.textContent = pairingUrl
      ? "Scan to open directly."
      : "Scan to open the sign-in page.";
  if (remoteCodeLabel)
    remoteCodeLabel.textContent = pairingUrl ? "Or enter:" : "Then enter:";
  if (remoteCode) remoteCode.textContent = /^\d{6}$/.test(passcode) ? `${passcode.slice(0, 3)} ${passcode.slice(3)}` : passcode;
  if (remoteLink) {
    remoteLink.href = rawSnapshot.publicUrl;
    remoteLink.textContent = rawSnapshot.publicUrl;
  }
  if (remoteQr) {
    const qr = qrcode(0, "M");
    qr.addData(pairingUrl ?? rawSnapshot.publicUrl);
    qr.make();
    remoteQr.src = qr.createDataURL(6, 2);
    remoteQr.alt = pairingUrl
      ? "QR code for one-scan remote pairing"
      : "QR code for opening Vibewaiting remotely";
  }
  if (remoteStability) remoteStability.textContent = rawSnapshot.stability === "temporary"
    ? "Temporary browser link. It is intentionally not installable."
    : "Stable app link. Open it on your phone to install.";
  if (remoteDevices) remoteDevices.textContent = remoteDeviceSummary(devices);
  if (remoteDisconnect) {
    remoteDisconnect.hidden = devices.authorizedDevices === 0;
    remoteDisconnect.disabled = false;
    remoteDisconnect.textContent = "Disconnect devices";
  }
}

remoteDisconnect?.addEventListener("click", () => {
  remoteDisconnect.disabled = true;
  remoteDisconnect.textContent = "Disconnecting…";
  port.postMessage({ type: "remote-access-revoke-request" });
});

remoteCopy?.addEventListener("click", () => {
  const value = remoteLink?.href;
  if (!value) return;
  void navigator.clipboard.writeText(value).then(() => {
    if (!remoteCopy) return;
    remoteCopy.textContent = "Copied";
    window.setTimeout(() => { if (remoteCopy) remoteCopy.textContent = "Copy link"; }, 1_500);
  });
});

function isRemoteSnapshot(value: unknown): value is RemoteSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.enabled === "boolean" &&
    (candidate.provider === "auto" || candidate.provider === "cloudflare" || candidate.provider === "ngrok" || candidate.provider === "stable") &&
    typeof candidate.status === "string" && Array.isArray(candidate.capabilities);
}

function providerLabel(provider: RemoteAccessProvider): string {
  if (provider === "cloudflare") return "Cloudflare";
  if (provider === "ngrok") return "ngrok";
  if (provider === "stable") return "Stable relay";
  return "Automatic";
}

function remoteDeviceSummary(devices: {
  authorizedDevices: number;
  connectedDevices: number;
}): string {
  if (devices.connectedDevices > 0)
    return `${devices.connectedDevices} connected · ${devices.authorizedDevices} paired`;
  if (devices.authorizedDevices > 0)
    return `${devices.authorizedDevices} paired offline`;
  return "No paired phones";
}

function remoteDescription(snapshot: RemoteSnapshot): string {
  if (snapshot.status === "connected" && snapshot.activeProvider) return `Connected with ${providerLabel(snapshot.activeProvider)}.`;
  if (snapshot.status === "starting") return "Opening a secure phone link…";
  if (snapshot.status === "reconnecting") return "Reconnecting the phone link…";
  if (snapshot.status === "error") return "Phone access could not connect.";
  const capability = snapshot.capabilities.find((entry) => entry.provider === snapshot.provider);
  return snapshot.provider === "auto"
    ? "Automatic prefers your stable relay, then Cloudflare, then configured ngrok."
    : capability?.detail ?? "Only this computer can access Vibewaiting.";
}

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!workspace?.value.trim()) return;
  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      workspace: workspace.value.trim(),
      ...(harness?.value ? { harness: harness.value } : {}),
      ...(policy?.value ? { policy: policy.value } : {}),
      remoteAccess: activeRemoteConfiguration,
    },
  });
  await chrome.runtime.sendMessage({ type: "settings-changed" });
  if (statusOutput)
    statusOutput.value =
      "Saved. Vibewaiting is connecting to the local agent bridge.";
});

window.addEventListener(
  "pagehide",
  () => {
    if (pairingRefreshTimer) clearTimeout(pairingRefreshTimer);
    port.disconnect();
  },
  { once: true },
);
