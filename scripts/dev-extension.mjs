#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, readFileSync, watch } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const extensionDirectory = join(root, "dist/extension");
const cliPath = join(root, "dist/cli.js");
const cdpPort = Number(process.env.VIBEWAITING_DEV_CDP_PORT || 49160);
if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65_535)
  throw new Error("VIBEWAITING_DEV_CDP_PORT must be a valid TCP port");
const cdpBase = `http://127.0.0.1:${cdpPort}`;
const defaultProfileDirectory =
  platform() === "darwin"
    ? join(homedir(), "Library/Caches/Vibewaiting/ExtensionDevProfile")
    : join(homedir(), ".cache/vibewaiting/extension-dev-profile");
const profileDirectory = resolve(
  process.env.VIBEWAITING_DEV_PROFILE || defaultProfileDirectory,
);
const startUrl = process.env.VIBEWAITING_DEV_URL || "https://example.com";
const devWorkspace = resolve(process.env.VIBEWAITING_DEV_WORKSPACE || root);
const extensionId = "dbcbmeiocgelabifljkclkacecapalgj";

function command(program, args, options = {}) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(program, args, {
      cwd: root,
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveCommand();
      else
        reject(
          new Error(
            `${program} ${args.join(" ")} exited ${signal || code || "without a status"}`,
          ),
        );
    });
  });
}

async function exists(path) {
  return await new Promise((resolveExists) =>
    access(path, (error) => resolveExists(!error)),
  );
}

async function executableOnPath(name) {
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    if (directory && (await exists(join(directory, name)))) return true;
  }
  return false;
}

async function json(path) {
  const response = await fetch(`${cdpBase}${path}`, {
    signal: AbortSignal.timeout(1_000),
  });
  if (!response.ok) throw new Error(`CDP returned ${response.status}`);
  return await response.json();
}

async function cdpReady() {
  try {
    await json("/json/version");
    return true;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForCdp() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await cdpReady()) return;
    await delay(100);
  }
  throw new Error(`The development browser did not expose CDP on ${cdpBase}`);
}

async function browserChoice() {
  const requested = process.env.VIBEWAITING_DEV_BROWSER;
  if (platform() === "darwin") {
    const choices = [
      {
        id: "brave",
        app: "Brave Browser",
        binary: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      },
      {
        id: "chromium",
        app: "Chromium",
        binary: "/Applications/Chromium.app/Contents/MacOS/Chromium",
      },
      {
        id: "chromium",
        app: "Google Chrome for Testing",
        binary:
          "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      },
    ];
    for (const choice of choices) {
      if (
        (!requested || requested === choice.id) &&
        (await exists(choice.binary))
      )
        return choice;
    }
    throw new Error(
      requested
        ? `No supported ${requested} development browser is installed`
        : "Install Brave, Chromium, or Chrome for Testing for automatic extension development",
    );
  }
  if (platform() === "linux") {
    const choices = [
      { id: "brave", binary: "brave-browser" },
      { id: "chromium", binary: "chromium" },
      { id: "chromium", binary: "chromium-browser" },
    ];
    for (const choice of choices) {
      if (
        (!requested || requested === choice.id) &&
        (await executableOnPath(choice.binary))
      )
        return choice;
    }
    throw new Error(
      requested
        ? `No supported ${requested} development browser is installed`
        : "Install Brave or Chromium for automatic extension development",
    );
  }
  throw new Error(
    "Automatic extension development currently supports macOS and Linux",
  );
}

async function launchBrowser(choice) {
  if (await cdpReady()) {
    process.stdout.write(`development browser: reusing ${cdpBase}\n`);
    return;
  }
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDirectory}`,
    "--no-first-run",
    "--disable-default-apps",
    `--disable-extensions-except=${extensionDirectory}`,
    `--load-extension=${extensionDirectory}`,
    startUrl,
  ];
  if (platform() === "darwin") {
    const child = spawn("open", ["-na", choice.app, "--args", ...args], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } else {
    const child = spawn(choice.binary, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }
  await waitForCdp();
  process.stdout.write(
    `development browser: ${choice.id} · ${profileDirectory}\n`,
  );
}

async function enableDeveloperMode() {
  const response = await fetch(
    `${cdpBase}/json/new?${encodeURIComponent("chrome://extensions/")}`,
    { method: "PUT", signal: AbortSignal.timeout(1_000) },
  );
  if (!response.ok)
    throw new Error(
      `Could not open the browser extensions page (${response.status})`,
    );
  const page = await response.json();
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const tree = await cdpCommand(
        page.webSocketDebuggerUrl,
        "Accessibility.getFullAXTree",
      );
      const developerMode = tree?.nodes?.find(
        (node) => node.role?.value === "switch",
      );
      if (developerMode) {
        const checked = developerMode.properties?.find(
          (property) => property.name === "checked",
        )?.value?.value;
        if (checked === true || checked === "true") return;
        const box = await cdpCommand(
          page.webSocketDebuggerUrl,
          "DOM.getBoxModel",
          { backendNodeId: developerMode.backendDOMNodeId },
        );
        const bounds = box?.model?.border;
        if (Array.isArray(bounds) && bounds.length === 8) {
          const x = (bounds[0] + bounds[2] + bounds[4] + bounds[6]) / 4;
          const y = (bounds[1] + bounds[3] + bounds[5] + bounds[7]) / 4;
          await cdpCommand(
            page.webSocketDebuggerUrl,
            "Input.dispatchMouseEvent",
            {
              type: "mousePressed",
              x,
              y,
              button: "left",
              clickCount: 1,
            },
          );
          await cdpCommand(
            page.webSocketDebuggerUrl,
            "Input.dispatchMouseEvent",
            { type: "mouseReleased", x, y, button: "left", clickCount: 1 },
          );
        }
      }
      await delay(100);
    }
    throw new Error("Could not enable extension Developer mode automatically");
  } finally {
    await cdpCommand(page.webSocketDebuggerUrl, "Page.close", {}, true).catch(
      () => undefined,
    );
  }
}

function cdpCommand(webSocketUrl, method, params = {}, closeIsSuccess = false) {
  return new Promise((resolveCommand, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const requestId = 1;
    let sent = false;
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error(`CDP ${method} timed out`));
    }, 1_000);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        socket.close();
      } catch {
        // The target may close itself while reloading the extension.
      }
      if (error) reject(error);
      else resolveCommand(value);
    }
    socket.addEventListener("open", () => {
      sent = true;
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== requestId) return;
      if (message.error)
        finish(new Error(message.error.message || `CDP ${method} failed`));
      else finish(undefined, message.result);
    });
    socket.addEventListener("close", () => {
      if (sent && closeIsSuccess) finish();
      else if (!settled)
        finish(new Error(`CDP target closed during ${method}`));
    });
    socket.addEventListener("error", () => {
      if (!settled)
        finish(new Error(`Could not connect to CDP target for ${method}`));
    });
  });
}

function extensionTarget(targets) {
  const origin = `chrome-extension://${extensionId}/`;
  return (
    targets.find((target) => target.url === `${origin}background.js`) ||
    targets.find((target) => target.url.startsWith(origin))
  );
}

async function waitForExtensionTarget() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const target = extensionTarget(await json("/json/list"));
    if (target?.webSocketDebuggerUrl) return target;
    await delay(100);
  }
  throw new Error(
    `Vibewaiting extension ${extensionId} is not loaded in the development browser`,
  );
}

async function ensureDevSettings() {
  const extension = await waitForExtensionTarget();
  const key = "vibewaiting:settings";
  const expression = `(async()=>{const key=${JSON.stringify(key)};const stored=(await chrome.storage.local.get(key))[key];if(stored&&typeof stored.workspace==="string"&&stored.workspace)return{seeded:false,workspace:stored.workspace};const settings={workspace:${JSON.stringify(devWorkspace)}};await chrome.storage.local.set({[key]:settings});return{seeded:true,workspace:settings.workspace}})()`;
  const result = await cdpCommand(
    extension.webSocketDebuggerUrl,
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
  );
  const settings = result?.result?.value;
  if (settings?.seeded)
    process.stdout.write(`development workspace: ${settings.workspace}\n`);
}

async function reloadExtensionAndTabs() {
  const extension = await waitForExtensionTarget();
  await cdpCommand(
    extension.webSocketDebuggerUrl,
    "Runtime.evaluate",
    { expression: "chrome.runtime.reload()", returnByValue: true },
    true,
  );
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await json("/json/list");
    if (extensionTarget(current)) break;
    await delay(100);
  }
  const current = await json("/json/list");
  const pages = current.filter(
    (target) => target.type === "page" && /^https?:\/\//.test(target.url),
  );
  const results = await Promise.allSettled(
    pages.map((target) =>
      cdpCommand(target.webSocketDebuggerUrl, "Page.reload", {
        ignoreCache: true,
      }),
    ),
  );
  const refreshed = results.filter(
    (result) => result.status === "fulfilled",
  ).length;
  process.stdout.write(
    `extension reloaded · ${refreshed}/${pages.length} web tabs refreshed\n`,
  );
}

const choice = await browserChoice();
await command(process.execPath, [
  cliPath,
  "native",
  "install",
  "--browser",
  choice.id,
  "--extension-id",
  extensionId,
]);
await launchBrowser(choice);
await enableDeveloperMode();
await ensureDevSettings();
await reloadExtensionAndTabs();

let buildRunning = false;
let buildPending = false;
let localSyncPending = false;
let debounce;

async function rebuild() {
  if (buildRunning) {
    buildPending = true;
    return;
  }
  buildRunning = true;
  const started = performance.now();
  try {
    if (localSyncPending) {
      localSyncPending = false;
      await command(process.execPath, [join(root, "scripts/sync-local-supercode.mjs")], {
        env: { ...process.env, VIBEWAITING_SUPERCODE_ONLY: "1" },
      });
    }
    await command("npm", ["run", "build"]);
    await launchBrowser(choice);
    await ensureDevSettings();
    await reloadExtensionAndTabs();
    process.stdout.write(
      `development update ready in ${Math.round(performance.now() - started)}ms\n`,
    );
  } catch (error) {
    process.stderr.write(`development update failed: ${error.message}\n`);
  } finally {
    buildRunning = false;
    if (buildPending) {
      buildPending = false;
      void rebuild();
    }
  }
}

function scheduleRebuild() {
  clearTimeout(debounce);
  debounce = setTimeout(() => void rebuild(), 100);
}

function scheduleLocalStackRebuild() {
  localSyncPending = true;
  scheduleRebuild();
}

const watchers = [];
for (const path of ["extension", "src", "widget"]) {
  watchers.push(watch(join(root, path), { recursive: true }, scheduleRebuild));
}
for (const path of [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.extension.json",
]) {
  watchers.push(watch(join(root, path), scheduleRebuild));
}
const localSourceMarker = join(
  root,
  ".vibewaiting/local-supercode-source",
);
if (await exists(localSourceMarker)) {
  const localSource = readFileSync(localSourceMarker, "utf8").trim();
  const sourceDirectories = [
    "crates",
    "sdk/ui/src",
  ];
  const sourceFiles = [
    "Cargo.lock",
    "crates/cli/Cargo.toml",
    "crates/harness/Cargo.toml",
    "sdk/typescript/client.mjs",
    "sdk/typescript/index.d.ts",
    "sdk/typescript/package.json",
    "sdk/client/client.mjs",
    "sdk/client/index.d.ts",
    "sdk/client/package.json",
    "sdk/terminal/client.d.ts",
    "sdk/terminal/client.mjs",
    "sdk/terminal/index.d.ts",
    "sdk/terminal/index.mjs",
    "sdk/terminal/package.json",
    "sdk/terminal/src/ui.jsx",
    "sdk/terminal/styles.css",
    "sdk/terminal/ui.d.ts",
    "sdk/terminal/ui.mjs",
    "sdk/ui/core.mjs",
    "sdk/ui/controller.mjs",
    "sdk/ui/index.d.ts",
    "sdk/ui/package.json",
    "sdk/ui/styles.css",
  ];
  for (const path of sourceDirectories) {
    const absolute = join(localSource, path);
    if (await exists(absolute)) watchers.push(watch(absolute, { recursive: true }, scheduleLocalStackRebuild));
  }
  for (const path of sourceFiles) {
    const absolute = join(localSource, path);
    if (await exists(absolute)) watchers.push(watch(absolute, scheduleLocalStackRebuild));
  }
  process.stdout.write(`local Supercode source: ${localSource}\n`);
}

process.stdout.write(
  `watching extension, messenger, host, and remembered local Supercode sources\n` +
    `open ${startUrl}; future successful builds reload automatically\n`,
);

function shutdown() {
  clearTimeout(debounce);
  for (const watcher of watchers) watcher.close();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
