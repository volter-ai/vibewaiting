import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_HOST_NAME } from "./extension-protocol.js";

export const DEVELOPMENT_EXTENSION_ID = "dbcbmeiocgelabifljkclkacecapalgj";
export const FIREFOX_EXTENSION_ID = "vibewaiting@volter.ai";

export type NativeBrowser = "brave" | "chrome" | "chromium" | "firefox";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function manifestDirectory(browser: NativeBrowser): string {
  const home = homedir();
  if (platform() === "darwin") {
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
  if (platform() === "linux") {
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
  } = {},
): Promise<{
  manifestPath: string;
  launcherPath: string;
  extensionId: string;
}> {
  const browser = options.browser ?? "chrome";
  const extensionId =
    options.extensionId?.trim() ||
    (browser === "firefox" ? FIREFOX_EXTENSION_ID : DEVELOPMENT_EXTENSION_ID);
  if (!/^[a-p]{32}$/.test(extensionId) && browser !== "firefox") {
    throw new Error("Chrome extension id must be 32 letters in the a-p range");
  }
  const launcherPath = join(homedir(), ".local/share/vibewaiting/native-host");
  const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
  await mkdir(dirname(launcherPath), { recursive: true });
  await writeFile(
    launcherPath,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cliPath)} native-host "$@"\n`,
    { encoding: "utf8", mode: 0o755 },
  );
  await chmod(launcherPath, 0o755);

  const directory = manifestDirectory(browser);
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
  return { manifestPath, launcherPath, extensionId };
}
