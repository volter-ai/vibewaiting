import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_HOST_NAME } from "./extension-protocol.js";

export const DEVELOPMENT_EXTENSION_ID = "dbcbmeiocgelabifljkclkacecapalgj";
export const FIREFOX_EXTENSION_ID = "vibewaiting@volter.ai";

export type NativeBrowser = "brave" | "chrome" | "chromium" | "firefox";
const NATIVE_BROWSERS: readonly NativeBrowser[] = [
  "brave",
  "chrome",
  "chromium",
  "firefox",
];

export interface NativeHostEnvironment {
  home: string;
  platform: NodeJS.Platform;
  nodePath: string;
  cliPath: string;
  extensionPath: string;
}

function nativeHostEnvironment(): NativeHostEnvironment {
  return {
    home: homedir(),
    platform: platform(),
    nodePath: process.execPath,
    cliPath: fileURLToPath(new URL("./cli.js", import.meta.url)),
    extensionPath: fileURLToPath(new URL("./extension/", import.meta.url)),
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function launcherSource(environment: NativeHostEnvironment): string {
  return `#!/bin/sh\nexec ${shellQuote(environment.nodePath)} ${shellQuote(environment.cliPath)} native-host "$@"\n`;
}

function manifestDirectory(
  browser: NativeBrowser,
  environment: NativeHostEnvironment,
): string {
  const home = environment.home;
  if (environment.platform === "darwin") {
    if (browser === "brave")
      return join(
        home,
        "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
      );
    if (browser === "chrome")
      return join(
        home,
        "Library/Application Support/Google/Chrome/NativeMessagingHosts",
      );
    if (browser === "chromium")
      return join(
        home,
        "Library/Application Support/Chromium/NativeMessagingHosts",
      );
    return join(
      home,
      "Library/Application Support/Mozilla/NativeMessagingHosts",
    );
  }
  if (environment.platform === "linux") {
    if (browser === "brave")
      return join(
        home,
        ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
      );
    if (browser === "chrome")
      return join(home, ".config/google-chrome/NativeMessagingHosts");
    if (browser === "chromium")
      return join(home, ".config/chromium/NativeMessagingHosts");
    return join(home, ".mozilla/native-messaging-hosts");
  }
  throw new Error(
    "Native host installation currently supports macOS and Linux",
  );
}

export async function installNativeHost(
  options: {
    extensionId?: string;
    browser?: NativeBrowser;
    environment?: NativeHostEnvironment;
  } = {},
): Promise<{
  manifestPath: string;
  launcherPath: string;
  extensionPath: string;
  extensionId: string;
}> {
  const browser = options.browser ?? "chrome";
  const environment = options.environment ?? nativeHostEnvironment();
  const extensionId =
    options.extensionId?.trim() ||
    (browser === "firefox" ? FIREFOX_EXTENSION_ID : DEVELOPMENT_EXTENSION_ID);
  if (!/^[a-p]{32}$/.test(extensionId) && browser !== "firefox") {
    throw new Error("Chrome extension id must be 32 letters in the a-p range");
  }
  const launcherPath = join(
    environment.home,
    ".local/share/vibewaiting/native-host",
  );
  const extensionPath = environment.extensionPath;
  await mkdir(dirname(launcherPath), { recursive: true });
  await writeFile(
    launcherPath,
    launcherSource(environment),
    { encoding: "utf8", mode: 0o755 },
  );
  await chmod(launcherPath, 0o755);

  const directory = manifestDirectory(browser, environment);
  const manifestPath = join(directory, `${NATIVE_HOST_NAME}.json`);
  const manifest =
    browser === "firefox"
      ? {
          name: NATIVE_HOST_NAME,
          description: "Vibewaiting local Supercode bridge",
          path: launcherPath,
          type: "stdio",
          allowed_extensions: [extensionId],
        }
      : {
          name: NATIVE_HOST_NAME,
          description: "Vibewaiting local Supercode bridge",
          path: launcherPath,
          type: "stdio",
          allowed_origins: [`chrome-extension://${extensionId}/`],
        };
  await mkdir(directory, { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return { manifestPath, launcherPath, extensionPath, extensionId };
}

export async function uninstallNativeHost(
  options: {
    browser?: NativeBrowser;
    environment?: NativeHostEnvironment;
    purgeState?: boolean;
  } = {},
): Promise<{
  launcherPath: string;
  manifestPath: string;
  removedLauncher: boolean;
  removedManifest: boolean;
  removedState: boolean;
  statePath: string;
}> {
  const browser = options.browser ?? "chrome";
  const environment = options.environment ?? nativeHostEnvironment();
  const launcherPath = join(
    environment.home,
    ".local/share/vibewaiting/native-host",
  );
  const manifestPath = join(
    manifestDirectory(browser, environment),
    `${NATIVE_HOST_NAME}.json`,
  );
  const statePath = join(environment.home, ".vibewaiting");

  const selectedManifest = await readJson(manifestPath);
  if (selectedManifest) {
    if (
      selectedManifest["name"] !== NATIVE_HOST_NAME ||
      selectedManifest["path"] !== launcherPath
    )
      throw new Error(
        `Refusing to remove native manifest not owned by Vibewaiting: ${manifestPath}`,
      );
    await rm(manifestPath);
  }

  let launcherInUse = false;
  for (const candidate of NATIVE_BROWSERS) {
    if (candidate === browser) continue;
    const candidatePath = join(
      manifestDirectory(candidate, environment),
      `${NATIVE_HOST_NAME}.json`,
    );
    let manifest: Record<string, unknown> | null;
    try {
      manifest = await readJson(candidatePath);
    } catch {
      launcherInUse = true;
      break;
    }
    if (
      manifest?.["name"] === NATIVE_HOST_NAME &&
      manifest["path"] === launcherPath
    ) {
      launcherInUse = true;
      break;
    }
  }

  let removedLauncher = false;
  if (!launcherInUse) {
    const launcher = await readText(launcherPath);
    if (launcher === launcherSource(environment)) {
      await rm(launcherPath);
      removedLauncher = true;
    }
  }

  if (options.purgeState) await rm(statePath, { recursive: true, force: true });
  return {
    launcherPath,
    manifestPath,
    removedLauncher,
    removedManifest: selectedManifest !== null,
    removedState: options.purgeState === true,
    statePath,
  };
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  const raw = await readText(path);
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Refusing to remove malformed native manifest: ${path}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Refusing to remove malformed native manifest: ${path}`);
  return value as Record<string, unknown>;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
