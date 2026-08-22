import { once } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { SupercodeHarnessClient } from "@volter-ai-dev/supercode-harness-sdk";
import type { HarnessId } from "@volter-ai-dev/supercode-harness-sdk";
import { startDaemon, type Daemon, type WidgetBridge } from "./daemon.js";
import {
  parseNativeHostCommand,
  type ExtensionSettings,
  type NativeHostEvent,
  VIBEWAITING_EXTENSION_PROTOCOL,
} from "./extension-protocol.js";
import {
  chunkNativeEvent,
  encodeNativeMessage,
  NativeMessageDecoder,
} from "./native-messaging.js";
import { FileMessengerPersistence } from "./persistence.js";
import { LocalTerminalService } from "./terminal-service.js";

const HARNESS_IDS = new Set<HarnessId>([
  "claude-code",
  "codex",
  "gemini",
  "goose",
  "opencode",
  "pi",
  "grok",
  "supercode",
]);

type HostEventWithoutChunk = Exclude<NativeHostEvent, { type: "chunk" }>;

async function writeFrame(value: unknown): Promise<void> {
  if (!process.stdout.write(encodeNativeMessage(value)))
    await once(process.stdout, "drain");
}

async function writeEvent(event: HostEventWithoutChunk): Promise<void> {
  for (const part of chunkNativeEvent(event)) await writeFrame(part);
}

class NativeWidgetBridge implements WidgetBridge {
  private readonly intentHandlers = new Map<
    string,
    (intent: { id: string; payload: unknown }) => void | Promise<void>
  >();
  private readonly timers = new Set<ReturnType<typeof setInterval>>();
  private removed = false;

  async push(patch: unknown): Promise<void> {
    if (this.removed) return;
    await writeEvent({
      protocol: VIBEWAITING_EXTENSION_PROTOCOL,
      type: "patch",
      patch,
    });
  }

  onIntent(
    name: string,
    handler: (intent: {
      id: string | number;
      payload: unknown;
    }) => void | Promise<void>,
  ): void {
    this.intentHandlers.set(
      name,
      handler as (intent: {
        id: string;
        payload: unknown;
      }) => void | Promise<void>,
    );
  }

  receive(id: string, payload: unknown): void {
    const handler = this.intentHandlers.get("agent");
    if (handler)
      void Promise.resolve(handler({ id, payload })).catch((error: unknown) => {
        process.stderr.write(
          `[vibewaiting] intent failed: ${(error as Error)?.message ?? String(error)}\n`,
        );
      });
  }

  every(ms: number, fn: () => unknown): () => void {
    let running = false;
    const timer = setInterval(() => {
      if (running || this.removed) return;
      running = true;
      void Promise.resolve(fn()).finally(() => {
        running = false;
      });
    }, ms);
    timer.unref();
    this.timers.add(timer);
    return () => {
      clearInterval(timer);
      this.timers.delete(timer);
    };
  }

  async remove(): Promise<void> {
    if (this.removed) return;
    this.removed = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
    this.intentHandlers.clear();
  }
}

async function validateSettings(
  settings: ExtensionSettings,
): Promise<{
  workspace: string;
  harness?: HarnessId;
  policy?: "default" | "yolo";
}> {
  const workspace = settings.workspace.trim();
  if (!isAbsolute(workspace))
    throw new Error("Workspace must be an absolute local directory");
  const details = await stat(workspace).catch(() => null);
  if (!details?.isDirectory())
    throw new Error(`Workspace is not a directory: ${workspace}`);
  const harness = settings.harness;
  if (harness && !HARNESS_IDS.has(harness as HarnessId))
    throw new Error(`Unsupported harness: ${harness}`);
  return {
    workspace,
    ...(harness ? { harness: harness as HarnessId } : {}),
    ...(settings.policy ? { policy: settings.policy } : {}),
  };
}

async function localSupercodeCommand(): Promise<string | undefined> {
  const marker = fileURLToPath(
    new URL(
      "../node_modules/.cache/vibewaiting/local-supercode-bin",
      import.meta.url,
    ),
  );
  return (
    process.env["SUPERCODE_BIN"] ??
    (await readFile(marker, "utf8")
      .then((value) => value.trim() || undefined)
      .catch(() => undefined))
  );
}

export async function runNativeHost(extensionOrigin: string | undefined): Promise<void> {
  if (!extensionOrigin)
    throw new Error("native host did not receive its browser extension origin");
  const decoder = new NativeMessageDecoder();
  const terminalService = new LocalTerminalService(extensionOrigin);
  await terminalService.start();
  let daemon: Daemon | null = null;
  let bridge: NativeWidgetBridge | null = null;
  let activeDiscoveryClient: SupercodeHarnessClient | null = null;
  let fingerprint = "";
  let commandQueue = Promise.resolve();

  const stopDaemon = async (): Promise<void> => {
    const active = daemon;
    daemon = null;
    bridge = null;
    fingerprint = "";
    await active?.stop();
    await activeDiscoveryClient?.close().catch(() => undefined);
    activeDiscoveryClient = null;
  };

  const start = async (requested: ExtensionSettings): Promise<void> => {
    const settings = await validateSettings(requested);
    const nextFingerprint = JSON.stringify(settings);
    if (daemon && nextFingerprint === fingerprint) {
      await daemon.flush();
      await writeEvent({
        protocol: VIBEWAITING_EXTENSION_PROTOCOL,
        type: "status",
        phase: "ready",
      });
      return;
    }
    await stopDaemon();
    await writeEvent({
      protocol: VIBEWAITING_EXTENSION_PROTOCOL,
      type: "status",
      phase: "starting",
    });
    const command = await localSupercodeCommand();
    const client = new SupercodeHarnessClient({
      cwd: settings.workspace,
      requestTimeoutMs: 5_000,
      ...(command ? { command } : {}),
    });
    const discoveryClient = new SupercodeHarnessClient({
      cwd: settings.workspace,
      requestTimeoutMs: 5_000,
      ...(command ? { command } : {}),
    });
    const nextBridge = new NativeWidgetBridge();
    try {
      const nextDaemon = await startDaemon({
        sessionId: "web-extension",
        html: "",
        workspace: settings.workspace,
        ...(settings.harness ? { harness: settings.harness } : {}),
        ...(settings.policy ? { policy: settings.policy } : {}),
        client,
        discoveryClient,
        persistence: new FileMessengerPersistence(),
        attachHost: async () => nextBridge,
        intentPollMs: 0,
        log: (message) => process.stderr.write(`[vibewaiting] ${message}\n`),
        terminalService,
      });
      bridge = nextBridge;
      daemon = nextDaemon;
      activeDiscoveryClient = discoveryClient;
      fingerprint = nextFingerprint;
      await writeEvent({
        protocol: VIBEWAITING_EXTENSION_PROTOCOL,
        type: "status",
        phase: "ready",
      });
    } catch (error) {
      await client.close().catch(() => undefined);
      await discoveryClient.close().catch(() => undefined);
      await nextBridge.remove();
      throw error;
    }
  };

  const handle = async (value: unknown): Promise<void> => {
    const command = parseNativeHostCommand(value);
    if (!command) throw new Error("Invalid native host command");
    if (command.type === "start") {
      await start(command.settings);
      return;
    }
    bridge?.receive(command.id, command.payload);
  };

  process.stdin.on("data", (chunk: Buffer) => {
    try {
      for (const value of decoder.push(chunk)) {
        commandQueue = commandQueue
          .then(() => handle(value))
          .catch(async (error: unknown) => {
            await writeEvent({
              protocol: VIBEWAITING_EXTENSION_PROTOCOL,
              type: "status",
              phase: "error",
              message: (error as Error)?.message ?? String(error),
            });
          });
      }
    } catch (error) {
      commandQueue = commandQueue.then(async () => {
        await writeEvent({
          protocol: VIBEWAITING_EXTENSION_PROTOCOL,
          type: "status",
          phase: "error",
          message: (error as Error)?.message ?? String(error),
        });
      });
    }
  });

  try {
    await once(process.stdin, "end");
    await commandQueue;
    decoder.finish();
  } finally {
    await stopDaemon();
    await terminalService.stop();
  }
}
