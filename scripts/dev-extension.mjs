#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { access, readFileSync, readdirSync, statSync, watch } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  matchingDevelopmentBrowserPort,
  parseDevelopmentBrowserProcesses,
} from "../dist/dev-browser-selection.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const extensionDirectory = join(root, "dist/extension");
const cliPath = join(root, "dist/cli.js");
const requestedCdpPort = Number(process.env.VIBEWAITING_DEV_CDP_PORT || 49160);
let cdpPort = requestedCdpPort;
if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65_535)
  throw new Error("VIBEWAITING_DEV_CDP_PORT must be a valid TCP port");
let cdpBase = `http://127.0.0.1:${cdpPort}`;
const defaultProfileDirectory =
  platform() === "darwin"
    ? join(homedir(), "Library/Caches/Vibewaiting/ExtensionDevProfile")
    : join(homedir(), ".cache/vibewaiting/extension-dev-profile");
let profileDirectory = resolve(
  process.env.VIBEWAITING_DEV_PROFILE || defaultProfileDirectory,
);
const startUrl = process.env.VIBEWAITING_DEV_URL || "https://example.com";
const devWorkspace = resolve(process.env.VIBEWAITING_DEV_WORKSPACE || root);
const extensionId = "dbcbmeiocgelabifljkclkacecapalgj";

function useCdpPort(port) {
  cdpPort = port;
  cdpBase = `http://127.0.0.1:${port}`;
}

function developmentBrowserProcesses() {
  const result = spawnSync("ps", ["-axo", "command="], { encoding: "utf8" });
  if (result.status !== 0 || typeof result.stdout !== "string") return [];
  return parseDevelopmentBrowserProcesses(result.stdout);
}

async function cdpReadyAt(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function selectDevelopmentBrowser() {
  if (process.env.VIBEWAITING_DEV_CDP_PORT) return;
  const processes = developmentBrowserProcesses();
  const matchingPort = matchingDevelopmentBrowserPort(processes, extensionDirectory);
  if (matchingPort) {
    if (matchingPort !== cdpPort) {
      useCdpPort(matchingPort);
      process.stdout.write(`development browser: matched current checkout on ${cdpBase}\n`);
    }
    return;
  }
  if (!(await cdpReadyAt(cdpPort))) return;
  for (let candidate = 49_160; candidate < 49_200; candidate += 1) {
    if (await cdpReadyAt(candidate)) continue;
    useCdpPort(candidate);
    const suffix = basename(root).replace(/[^a-z0-9_-]+/gi, "-");
    profileDirectory = `${defaultProfileDirectory}-${suffix}`;
    process.stdout.write(
      `development browser: CDP ${requestedCdpPort} belongs to another checkout; using ${cdpBase}\n`,
    );
    return;
  }
  throw new Error("No free Vibewaiting development CDP port is available from 49160 through 49199");
}

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

function terminalRuntimeReady() {
  return (
    spawnSync(
      process.execPath,
      ["-e", 'require("@homebridge/node-pty-prebuilt-multiarch")'],
      { cwd: root, stdio: "ignore" },
    ).status === 0
  );
}

async function ensureTerminalRuntime() {
  if (terminalRuntimeReady()) return;
  process.stdout.write("repairing local terminal runtime\n");
  await command("npm", [
    "rebuild",
    "@homebridge/node-pty-prebuilt-multiarch",
  ]);
  if (!terminalRuntimeReady())
    throw new Error("The local terminal runtime could not be loaded after rebuild");
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

async function launchBrowser(choice, urls = [startUrl]) {
  if (await cdpReady()) {
    process.stdout.write(`development browser: reusing ${cdpBase}\n`);
    return false;
  }
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDirectory}`,
    "--no-first-run",
    "--disable-default-apps",
    `--disable-extensions-except=${extensionDirectory}`,
    `--load-extension=${extensionDirectory}`,
    ...urls,
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
  return true;
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
  return targets.find((target) => target.url === `${origin}background.js`);
}

function extensionPageTarget(targets) {
  const origin = `chrome-extension://${extensionId}/`;
  return targets.find((target) => target.type === "page" && target.url.startsWith(origin));
}

async function waitForExtensionTarget() {
  let extensionWakeRequested = false;
  let pageWakeRequested = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const targets = await json("/json/list");
    const target = extensionTarget(targets);
    if (target?.webSocketDebuggerUrl) return target;
    const extensionPage = extensionPageTarget(targets);
    if (!extensionWakeRequested && extensionPage?.webSocketDebuggerUrl) {
      extensionWakeRequested = true;
      await cdpCommand(
        extensionPage.webSocketDebuggerUrl,
        "Runtime.evaluate",
        {
          expression: 'chrome.runtime.sendMessage({type:"development-wake"}).catch(()=>undefined)',
          awaitPromise: true,
          returnByValue: true,
        },
      ).catch(() => undefined);
    } else if (!pageWakeRequested) {
      pageWakeRequested = true;
      const page = targets.find(
        (candidate) =>
          candidate.type === "page" &&
          /^https?:\/\//.test(candidate.url) &&
          candidate.webSocketDebuggerUrl,
      );
      if (page?.webSocketDebuggerUrl)
        await cdpCommand(page.webSocketDebuggerUrl, "Page.reload", {
          ignoreCache: true,
        }).catch(() => undefined);
    }
    await delay(100);
  }
  throw new Error(
    `Vibewaiting extension ${extensionId} is not loaded in the development browser`,
  );
}

async function ensureDevSettings() {
  const key = "vibewaiting:settings";
  const expression = `(async()=>{const key=${JSON.stringify(key)};const stored=(await chrome.storage.local.get(key))[key];if(stored&&typeof stored.workspace==="string"&&stored.workspace)return{seeded:false,workspace:stored.workspace};const settings={workspace:${JSON.stringify(devWorkspace)}};await chrome.storage.local.set({[key]:settings});return{seeded:true,workspace:settings.workspace}})()`;
  let result;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const extension = await waitForExtensionTarget();
      result = await cdpCommand(
        extension.webSocketDebuggerUrl,
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
      );
      break;
    } catch (error) {
      if (attempt === 9) throw error;
      await delay(100);
    }
  }
  const settings = result?.result?.value;
  if (settings?.seeded)
    process.stdout.write(`development workspace: ${settings.workspace}\n`);
}

async function disconnectNativeHost({ required = true } = {}) {
  const extension = await waitForExtensionTarget();
  const expression = `typeof globalThis.__vibewaitingDisconnectNativeForDevelopment==="function"?{type:"development-native-disconnected",disconnected:globalThis.__vibewaitingDisconnectNativeForDevelopment()}:null`;
  let result;
  try {
    result = await cdpCommand(
      extension.webSocketDebuggerUrl,
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
    );
  } catch (error) {
    if (required) throw error;
    return false;
  }
  const response = result?.result?.value;
  if (response?.type !== "development-native-disconnected") {
    if (required)
      throw new Error("The loaded extension does not support clean native-host reloads");
    return false;
  }
  if (response.disconnected)
    process.stdout.write("native host disconnected for development reload\n");
  return true;
}

async function reloadExtensionAndTabs() {
  const current = await json("/json/list");
  const urls = [...new Set(current
    .filter((target) => target.type === "page" && /^https?:\/\//.test(target.url))
    .map((target) => target.url))];
  await disconnectNativeHost({ required: false });
  const version = await json("/json/version");
  if (!version.webSocketDebuggerUrl) throw new Error("Development browser has no browser CDP target");
  await cdpCommand(version.webSocketDebuggerUrl, "Browser.close", {}, true);
  for (let attempt = 0; attempt < 30 && await cdpReady(); attempt += 1) await delay(100);
  if (await cdpReady()) throw new Error(`Development browser on ${cdpBase} did not stop for extension update`);
  await launchBrowser(choice, urls.length ? urls : [startUrl]);
  await ensureDevSettings();
  await waitForExpectedBuild();
  process.stdout.write(
    `extension build ${readFileSync(join(extensionDirectory, "build-id.txt"), "utf8").trim()} attested · ${urls.length || 1} web ${urls.length === 1 ? "tab" : "tabs"} restored\n`,
  );
}

async function loadedBuildId() {
  const extension = await waitForExtensionTarget();
  const result = await cdpCommand(
    extension.webSocketDebuggerUrl,
    "Runtime.evaluate",
    {
      expression: `fetch(chrome.runtime.getURL("build-id.txt"),{cache:"no-store"}).then(response=>response.ok?response.text():null).catch(()=>null)`,
      awaitPromise: true,
      returnByValue: true,
    },
  );
  return typeof result?.result?.value === "string"
    ? result.result.value.trim()
    : null;
}

async function waitForExpectedBuild() {
  const expected = readFileSync(join(extensionDirectory, "build-id.txt"), "utf8").trim();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      if ((await loadedBuildId()) === expected) return;
    } catch {
      // The service worker target is expected to disappear briefly during chrome.runtime.reload().
    }
    await delay(100);
  }
  const loaded = await loadedBuildId().catch(() => null);
  throw new Error(
    `extension reload was stale on CDP ${cdpPort}: expected build ${expected}, loaded ${loaded ?? "no build id"}`,
  );
}

const choice = await browserChoice();
await ensureTerminalRuntime();
await command(process.execPath, [
  cliPath,
  "native",
  "install",
  "--browser",
  choice.id,
  "--extension-id",
  extensionId,
]);
await selectDevelopmentBrowser();
const launched = await launchBrowser(choice);
await ensureDevSettings();
if (launched) {
  await waitForExpectedBuild();
  process.stdout.write(`extension build ${readFileSync(join(extensionDirectory, "build-id.txt"), "utf8").trim()} attested at launch\n`);
} else {
  await reloadExtensionAndTabs();
}

let buildRunning = false;
let buildPending = false;
let localSyncPending = false;
let debounce;

function buildInputFingerprint() {
  const inputs = ["extension", "mobile", "src", "widget", "package.json", "tsconfig.json", "tsconfig.extension.json"];
  const records = [];
  const visit = (path) => {
    const details = statSync(path);
    if (details.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
      return;
    }
    records.push(`${path.slice(root.length)}:${details.size}:${details.mtimeMs}`);
  };
  for (const input of inputs) visit(join(root, input));
  return records.join("\n");
}

async function rebuild() {
  if (buildRunning) {
    buildPending = true;
    return;
  }
  buildRunning = true;
  const startingInputs = buildInputFingerprint();
  const started = performance.now();
  try {
    if (localSyncPending) {
      localSyncPending = false;
      await command(process.execPath, [join(root, "scripts/sync-local-supercode.mjs")], {
        env: { ...process.env, VIBEWAITING_SUPERCODE_ONLY: "1" },
      });
    }
    await command("npm", ["run", "build"]);
    const launched = await launchBrowser(choice);
    if (launched) {
      await ensureDevSettings();
      await waitForExpectedBuild();
      process.stdout.write(`extension build ${readFileSync(join(extensionDirectory, "build-id.txt"), "utf8").trim()} attested at launch\n`);
    } else {
      await reloadExtensionAndTabs();
    }
    process.stdout.write(
      `development update ready in ${Math.round(performance.now() - started)}ms\n`,
    );
  } catch (error) {
    process.stderr.write(`development update failed: ${error.message}\n`);
  } finally {
    buildRunning = false;
    const inputsChangedDuringBuild = buildPending && buildInputFingerprint() !== startingInputs;
    buildPending = false;
    if (localSyncPending || inputsChangedDuringBuild) void rebuild();
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
for (const path of ["extension", "mobile", "src", "widget"]) {
  watchers.push(watch(join(root, path), { recursive: true }, scheduleRebuild));
}
for (const path of [
  "package.json",
  "tsconfig.json",
  "tsconfig.extension.json",
]) {
  watchers.push(watch(join(root, path), scheduleRebuild));
}
const localSourceMarker = join(
  root,
  ".vibewaiting/local-supercode-source",
);
const localBinaryMarker = join(
  root,
  "node_modules/.cache/vibewaiting/local-supercode-bin",
);
let localStackWatchdog = null;
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
  // `npm ci` replaces node_modules atomically and removes the ignored binary marker while this
  // watcher remains alive. Detect that broken invariant directly: waiting for an unrelated source
  // edit would otherwise let the extension restart against an older global/npm Supercode.
  localStackWatchdog = setInterval(async () => {
    if (!(await exists(localBinaryMarker))) scheduleLocalStackRebuild();
  }, 1_000);
  localStackWatchdog.unref?.();
  process.stdout.write(`local Supercode source: ${localSource}\n`);
}

process.stdout.write(
  `watching extension, messenger, host, and remembered local Supercode sources\n` +
    `open ${startUrl}; future successful builds reload automatically\n`,
);

function shutdown() {
  clearTimeout(debounce);
  if (localStackWatchdog) clearInterval(localStackWatchdog);
  for (const watcher of watchers) watcher.close();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
