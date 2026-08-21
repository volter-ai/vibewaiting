export {};

const SETTINGS_KEY = "vibewaiting:settings";
const form = document.querySelector<HTMLFormElement>("form");
const workspace = document.querySelector<HTMLInputElement>("#workspace");
const harness = document.querySelector<HTMLSelectElement>("#harness");
const policy = document.querySelector<HTMLSelectElement>("#policy");
const statusOutput = document.querySelector<HTMLOutputElement>("output");
const extensionId = document.querySelector<HTMLElement>("#extension-id");
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
  if (message.type !== "status" || typeof message.phase !== "string") return;
  statusOutput.dataset.phase = message.phase;
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

const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
if (typeof stored === "object" && stored !== null && !Array.isArray(stored)) {
  const settings = stored as Record<string, unknown>;
  if (workspace && typeof settings.workspace === "string")
    workspace.value = settings.workspace;
  if (harness && typeof settings.harness === "string")
    harness.value = settings.harness;
  if (policy && typeof settings.policy === "string")
    policy.value = settings.policy;
}

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!workspace?.value.trim()) return;
  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      workspace: workspace.value.trim(),
      ...(harness?.value ? { harness: harness.value } : {}),
      ...(policy?.value ? { policy: policy.value } : {}),
    },
  });
  await chrome.runtime.sendMessage({ type: "settings-changed" });
  if (statusOutput)
    statusOutput.value =
      "Saved. Vibewaiting is connecting to the local agent bridge.";
});

window.addEventListener("pagehide", () => port.disconnect(), { once: true });
