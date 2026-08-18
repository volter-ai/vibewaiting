#!/usr/bin/env node
// `vibewaiting` — mint (or adopt) a lucarne browser session, mount the agent widget on every page
// of it, and bridge that widget to a real coding-agent session in your workspace.
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
import { FileMessengerPersistence } from "./persistence.js";

const DEFAULT_ENGINE_URL = "http://127.0.0.1:7800";

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

Options
  --workspace <dir>   project directory the coding agent runs in (default: cwd)
  --harness <name>    claude-code | codex | opencode | pi | grok (default: first one ready)
  --session <id>      attach to an existing lucarne session instead of creating one
  --policy <name>     execution policy for the agent: default | yolo (default: the controller's)
  -h, --help          print this

Environment
  LUCARNE_URL         lucarne daemon base URL (default ${DEFAULT_ENGINE_URL})
  LUCARNE_TOKEN       bearer token, when the daemon requires one

The widget mounts on every page of the session; open the printed URL to browse with it.
`;

/** Parse argv (already sliced past node + script). Throws on an unknown or value-less flag. */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { workspace: process.cwd(), help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`vibewaiting: ${flag} needs a value`);
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
        if (v !== "default" && v !== "yolo") throw new Error(`vibewaiting: --policy must be 'default' or 'yolo'`);
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
    const mod = (await import(new URL("../widget/build.mjs", import.meta.url).href)) as {
      buildWidget: (opts?: { outFile?: string }) => Promise<{ outFile: string; bytes: number }>;
    };
    const { outFile } = await mod.buildWidget({ outFile: path });
    return await readFile(outFile, "utf8");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  const baseUrl = process.env["LUCARNE_URL"] ?? DEFAULT_ENGINE_URL;
  const token = process.env["LUCARNE_TOKEN"];
  const lucarne = new LucarneClient({ baseUrl, ...(token ? { token } : {}) });

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

  const harnessClient = new SupercodeHarnessClient({ cwd: args.workspace });
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
      persistence: new FileMessengerPersistence(),
      log: (m) => process.stdout.write(`${m}\n`),
    });
  } catch (e) {
    await harnessClient.close().catch(() => undefined);
    if (createdSession) await lucarne.destroy(session.id).catch(() => undefined);
    throw e;
  }

  const state = daemon.lastPushed();
  process.stdout.write(`\n  browse here → ${session.viewUrl}\n`);
  process.stdout.write(
    `  widget: ${state?.pill.label ?? "starting"} · workspace ${args.workspace} · session ${session.id}` +
      `${createdSession ? " (created)" : " (adopted)"}\n\n  ctrl-c to stop\n`,
  );

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write("\nstopping…\n");
    await daemon.stop();
    // Only what this process created: an adopted session belongs to whoever is browsing in it.
    if (createdSession) await lucarne.destroy(session.id).catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e: unknown) => {
  process.stderr.write(`${(e as Error)?.message ?? String(e)}\n`);
  process.exit(1);
});
