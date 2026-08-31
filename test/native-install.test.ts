import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installNativeHost,
  type NativeHostEnvironment,
  uninstallNativeHost,
} from "../src/native-install.js";

describe("native host lifecycle", () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0))
      await rm(root, { recursive: true, force: true });
  });

  it("unregisters browsers without leaking or deleting a shared modified launcher", async () => {
    const home = await mkdtemp(join(tmpdir(), "vibewaiting-native-"));
    roots.push(home);
    const environment: NativeHostEnvironment = {
      home,
      platform: "linux",
      nodePath: "/usr/bin/node",
      cliPath: join(home, "package/dist/cli.js"),
      extensionPath: join(home, "package/dist/extension"),
    };
    const chrome = await installNativeHost({ browser: "chrome", environment });
    const brave = await installNativeHost({ browser: "brave", environment });
    const statePath = join(home, ".vibewaiting");
    await mkdir(statePath);
    await writeFile(join(statePath, "messenger-state-v2.json"), "{}\n");

    const first = await uninstallNativeHost({ browser: "chrome", environment });
    expect(first).toMatchObject({
      removedLauncher: false,
      removedManifest: true,
      removedState: false,
    });
    await expect(access(chrome.manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(brave.manifestPath)).resolves.toBeUndefined();
    await expect(access(first.launcherPath)).resolves.toBeUndefined();
    await expect(access(statePath)).resolves.toBeUndefined();

    const last = await uninstallNativeHost({
      browser: "brave",
      environment,
      purgeState: true,
    });
    expect(last).toMatchObject({
      removedLauncher: true,
      removedManifest: true,
      removedState: true,
    });
    await expect(access(last.launcherPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(statePath)).rejects.toMatchObject({ code: "ENOENT" });

    const reinstalled = await installNativeHost({ browser: "chrome", environment });
    await writeFile(reinstalled.launcherPath, "#!/bin/sh\n# user-managed\n");
    const modified = await uninstallNativeHost({ browser: "chrome", environment });
    expect(modified.removedLauncher).toBe(false);
    expect(await readFile(reinstalled.launcherPath, "utf8")).toContain("user-managed");
  });
});
