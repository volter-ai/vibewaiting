#!/usr/bin/env node
// `vibewaiting` — mount an agent messenger in ordinary browser pages and bridge it to real local
// coding-agent sessions. The direct browser-extension path does not require Lucarne; the CLI path
// can still mint or adopt a Lucarne-managed browser session for automation and remote access.
//
// Everything the process owns is torn down on SIGINT, and ONLY what it created: a session passed in
// with `--session` is left running, because the human is probably still browsing in it.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SupercodeHarnessClient } from "@volter-ai-dev/supercode-harness-sdk";
import type { HarnessId } from "@volter-ai-dev/supercode-harness-sdk";
import { LucarneClient } from "lucarne";
import type { Session } from "lucarne";
import { startDaemon, type Daemon } from "./daemon.js";
import { runNativeHost } from "./native-host.js";
import { installNativeHost, type NativeBrowser } from "./native-install.js";
import { FileMessengerPersistence } from "./persistence.js";

const DEFAULT_ENGINE_URL = "http://127.0.0.1:7800";
/** A corner messenger must recover from a broken native handshake in one perceptual wait. */
export const DEFAULT_WIDGET_REQUEST_TIMEOUT_MS = 5_000;

export interface CliArgs {
  workspace: string;
  harness?: HarnessId;
  session?: string;
  policy?: "default" | "yolo";
  help: boolean;
}

const USAGE = `vibewaiting — vibe code without leaving your browser

Usage
  vibewaiting [options]
  vibewaiting native install [--browser brave|chrome|chromium|firefox] [--extension-id <id>]

Options
  --workspace <dir>   project directory the coding agent runs in (default: cwd)
  --harness <name>    claude-code | codex | gemini | goose | opencode | pi | grok
                      (default: first one ready)
  --session <id>      attach to an existing lucarne session instead of creating one
  --policy <name>     execution policy for the agent: default | yolo (default: the controller's)
  -h, --help          print this

Environment
  LUCARNE_URL         lucarne daemon base URL (default ${DEFAULT_ENGINE_URL})
  LUCARNE_TOKEN       bearer token, when the daemon requires one

The widget mounts on every page of the attached browser. Keep using that browser normally; the
printed remote-view URL is only for headless, remote, or diagnostic access.
`;

async function runNativeInstall(argv: readonly string[]): Promise<void> {
  let browser: NativeBrowser | undefined;
  let extensionId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`vibewaiting: ${flag} needs a value`);
    index += 1;
    if (flag === "--browser") {
      if (
        value !== "brave" &&
        value !== "chrome" &&
        value !== "chromium" &&
        value !== "firefox"
      ) {
        throw new Error(
          "vibewaiting: --browser must be brave, chrome, chromium, or firefox",
        );
      }
      browser = value;
    } else if (flag === "--extension-id") {
      extensionId = value;
    } else {
      throw new Error(`vibewaiting: unknown native install option ${flag}`);
    }
  }
  const installed = await installNativeHost({
    ...(browser ? { browser } : {}),
    ...(extensionId ? { extensionId } : {}),
  });
  process.stdout.write(
    `Vibewaiting native host installed\n  manifest → ${installed.manifestPath}\n  extension → ${installed.extensionId}\n`,
  );
}

/** Parse argv (already sliced past node + script). Throws on an unknown or value-less flag. */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { workspace: process.cwd(), help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--"))
        throw new Error(`vibewaiting: ${flag} needs a value`);
      i += 1;
      return v;
    };
    switch (flag) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--workspace":
        args.workspace = value();
        break;
      case "--harness":
        args.harness = value();
        break;
      case "--session":
        args.session = value();
        break;
      case "--policy": {
        const v = value();
        if (v !== "default" && v !== "yolo")
          throw new Error(`vibewaiting: --policy must be 'default' or 'yolo'`);
        args.policy = v;
        break;
      }
      default:
        throw new Error(`vibewaiting: unknown option ${flag}`);
    }
  }
  return args;
}

/** The built srcdoc bundle, built on the spot the first time (a fresh install has no `dist/widget.html`). */
async function loadWidgetHtml(): Promise<string> {
  const path = fileURLToPath(new URL("./widget.html", import.meta.url));
  try {
    return await readFile(path, "utf8");
  } catch {
    process.stdout.write("building widget bundle…\n");
    // Resolved at runtime (`widget/` is a sibling of `dist/`, outside this program's rootDir) — the
    // builder is only needed on a fresh install, so it stays off the CLI's static import graph.
    const mod = (await import(
      new URL("../widget/build.mjs", import.meta.url).href
    )) as {
      buildWidget: (opts?: {
        outFile?: string;
      }) => Promise<{ outFile: string; bytes: number }>;
    };
    const { outFile } = await mod.buildWidget({ outFile: path });
    return await readFile(outFile, "utf8");
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "native-host") {
    await runNativeHost(argv[1]);
    return;
  }
  if (argv[0] === "native" && argv[1] === "install") {
    await runNativeInstall(argv.slice(2));
    return;
  }
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  const baseUrl = process.env["LUCARNE_URL"] ?? DEFAULT_ENGINE_URL;
  const token = process.env["LUCARNE_TOKEN"];
  const lucarne = new LucarneClient({ baseUrl, ...(token ? { token } : {}) });
  const localCommandMarker = fileURLToPath(
    new URL(
      "../node_modules/.cache/vibewaiting/local-supercode-bin",
      import.meta.url,
    ),
  );
  const command =
    process.env["SUPERCODE_BIN"] ??
    (await readFile(localCommandMarker, "utf8")
      .then((value) => value.trim() || undefined)
      .catch(() => undefined));

  const html = await loadWidgetHtml();

  let session: Session;
  let createdSession = false;
  try {
    if (args.session) {
      session = await lucarne.get(args.session);
    } else {
      session = await lucarne.create({ backend: "native" });
      createdSession = true;
    }
  } catch (e) {
    throw new Error(
      `cannot reach the lucarne daemon at ${baseUrl} (${(e as Error)?.message ?? e}) — start one with \`npx lucarne serve\``,
    );
  }

  // The browser is already usable once Lucarne has exposed the session. Say that before any agent
  // RPC so a slow or broken harness can never make startup look frozen. A native session's normal
  // window is the product surface; Lucarne's view URL is a secondary remote/diagnostic surface.
  process.stdout.write(
    session.backend === "native"
      ? `\n  browser: ${createdSession ? "opened" : "attached"} · keep using its normal window\n  remote view (optional) → ${session.viewUrl}\n`
      : `\n  browser view → ${session.viewUrl}\n`,
  );
  process.stdout.write(
    `  widget: connecting · workspace ${args.workspace} · session ${session.id}` +
      `${createdSession ? " (created)" : " (adopted)"}\n\n  ctrl-c to stop\n`,
  );

  const harnessClient = new SupercodeHarnessClient({
    cwd: args.workspace,
    requestTimeoutMs: DEFAULT_WIDGET_REQUEST_TIMEOUT_MS,
    ...(command ? { command } : {}),
  });
  const discoveryClient = new SupercodeHarnessClient({
    cwd: args.workspace,
    requestTimeoutMs: DEFAULT_WIDGET_REQUEST_TIMEOUT_MS,
    ...(command ? { command } : {}),
  });
  let daemon: Daemon;
  try {
    daemon = await startDaemon({
      sessionId: session.id,
      engine: { baseUrl, token },
      html,
      workspace: args.workspace,
      harness: args.harness,
      policy: args.policy,
      client: harnessClient,
      discoveryClient,
      persistence: new FileMessengerPersistence(),
      log: (m) => process.stdout.write(`${m}\n`),
    });
  } catch (e) {
    await harnessClient.close().catch(() => undefined);
    await discoveryClient.close().catch(() => undefined);
    if (createdSession)
      await lucarne.destroy(session.id).catch(() => undefined);
    throw e;
  }

  const state = daemon.lastPushed();
  process.stdout.write(`  widget: ${state?.pill.label ?? "starting"}\n`);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write("\nstopping…\n");
    await daemon.stop();
    await discoveryClient.close().catch(() => undefined);
    // Only what this process created: an adopted session belongs to whoever is browsing in it.
    if (createdSession)
      await lucarne.destroy(session.id).catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e: unknown) => {
  process.stderr.write(`${(e as Error)?.message ?? String(e)}\n`);
  process.exit(1);
});
