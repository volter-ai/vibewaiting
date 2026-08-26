import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SupercodeHarnessClient } from "@volter-ai-dev/supercode-harness-sdk";
import type { HarnessId } from "@volter-ai-dev/supercode-harness-sdk";
import {
  createRemoteAccessController,
  type RemoteAccessController,
  type RemoteAccessSnapshot,
} from "@volter-ai-dev/supercode-remote-access";
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
import { RemoteMessengerServer } from "./remote-messenger.js";
import type { RemoteDeviceSnapshot } from "./remote-devices.js";

const HARNESS_IDS = new Set<HarnessId>([
  "claude-code",
  "codex",
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
    (intent: { id: string; payload: unknown; source?: "local" | "remote" }) => void | Promise<void>
  >();
  private readonly timers = new Set<ReturnType<typeof setInterval>>();
  private removed = false;

  constructor(private readonly remote: RemoteMessengerServer) {
    remote.setIntentHandler((intent) => this.receive(intent.id, intent.payload, "remote"));
  }

  async push(patch: unknown): Promise<void> {
    if (this.removed) return;
    this.remote.push(patch);
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
      source?: "local" | "remote";
    }) => void | Promise<void>,
  ): void {
    this.intentHandlers.set(
      name,
      handler as (intent: {
        id: string;
        payload: unknown;
        source?: "local" | "remote";
      }) => void | Promise<void>,
    );
  }

  receive(id: string, payload: unknown, source: "local" | "remote"): void {
    const handler = this.intentHandlers.get("agent");
    if (handler)
      void Promise.resolve(handler({ id, payload, source })).catch((error: unknown) => {
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
    this.remote.setIntentHandler(null);
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
  if (process.env["SUPERCODE_BIN"]) return process.env["SUPERCODE_BIN"];
  const marker = fileURLToPath(
    new URL(
      "../node_modules/.cache/vibewaiting/local-supercode-bin",
      import.meta.url,
    ),
  );
  const localCommand = await readFile(marker, "utf8")
    .then((value) => value.trim() || undefined)
    .catch(() => undefined);
  if (localCommand) return localCommand;

  // The source marker is a deliberate local-development choice. Falling through to whatever
  // `supercode` happens to be installed on PATH after (for example) `npm ci` deletes node_modules
  // makes the browser silently exercise old protocol and activity behavior. A missing synced
  // binary is a broken development stack, not permission to change products underneath the user.
  const sourceMarker = fileURLToPath(
    new URL("../.vibewaiting/local-supercode-source", import.meta.url),
  );
  const configuredSource = await readFile(sourceMarker, "utf8")
    .then((value) => value.trim())
    .catch(() => "");
  if (configuredSource) {
    throw new Error(
      `Local Supercode is configured from ${configuredSource}, but its synced binary marker is missing. Run npm run sync:local before starting Vibewaiting.`,
    );
  }
  return undefined;
}

export async function runNativeHost(extensionOrigin: string | undefined): Promise<void> {
  if (!extensionOrigin)
    throw new Error("native host did not receive its browser extension origin");
  const decoder = new NativeMessageDecoder();
  const terminalService = new LocalTerminalService(extensionOrigin);
  await terminalService.start();
  const remoteServer = new RemoteMessengerServer(extensionOrigin);
  const remoteEndpoint = await remoteServer.start();
  const remoteAccess: RemoteAccessController = createRemoteAccessController({
    localOrigin: remoteEndpoint.localOrigin,
    publicPath: "/",
    tunnelId: await persistentRemoteTunnelId(),
  });
  let remoteAccessSnapshot = remoteAccess.snapshot();
  let remoteDevices: RemoteDeviceSnapshot = remoteServer.deviceSnapshot();
  let suppressRemoteDeviceEvents = false;
  const publishRemoteAccess = async (
    snapshot: RemoteAccessSnapshot,
    includePairing: boolean,
  ): Promise<void> => {
    const pairing =
      includePairing && snapshot.status === "connected" && snapshot.publicUrl
        ? remotePairingHandoff(snapshot.publicUrl, remoteServer.createPairingGrant())
        : undefined;
    await writeEvent({
      protocol: VIBEWAITING_EXTENSION_PROTOCOL,
      type: "remote-access",
      devices: remoteDevices,
      ...(pairing ? { pairing } : {}),
      passcode: remoteEndpoint.passcode,
      snapshot,
    });
  };
  remoteAccess.subscribe((snapshot) => {
    remoteAccessSnapshot = snapshot;
    remoteServer.setInstallableOrigin(
      snapshot.status === "connected" &&
      snapshot.stability === "stable" &&
      snapshot.publicUrl
        ? snapshot.publicUrl
        : null,
    );
    void publishRemoteAccess(snapshot, snapshot.status === "connected");
  });
  remoteServer.setDeviceSnapshotHandler((devices) => {
    remoteDevices = devices;
    if (!suppressRemoteDeviceEvents)
      void publishRemoteAccess(remoteAccessSnapshot, false);
  });
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
    const nextBridge = new NativeWidgetBridge(remoteServer);
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
      if (requested.remoteAccess) {
        void remoteAccess.configure(requested.remoteAccess).catch((error: unknown) => {
          process.stderr.write(`[vibewaiting] remote access failed: ${(error as Error)?.message ?? String(error)}\n`);
        });
      }
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
    if (command.type === "remote-access") {
      if (!command.configuration.enabled) {
        suppressRemoteDeviceEvents = true;
        remoteServer.revokeRemoteSessions();
        try {
          await remoteAccess.configure(command.configuration);
        } catch (error) {
          process.stderr.write(`[vibewaiting] remote access failed: ${(error as Error)?.message ?? String(error)}\n`);
        } finally {
          suppressRemoteDeviceEvents = false;
          await publishRemoteAccess(remoteAccessSnapshot, false);
        }
        return;
      }
      await remoteAccess.configure(command.configuration).catch((error: unknown) => {
        process.stderr.write(`[vibewaiting] remote access failed: ${(error as Error)?.message ?? String(error)}\n`);
      });
      return;
    }
    if (command.type === "remote-access-pairing") {
      await publishRemoteAccess(remoteAccessSnapshot, true);
      return;
    }
    if (command.type === "remote-access-revoke") {
      suppressRemoteDeviceEvents = true;
      try {
        remoteServer.revokeRemoteSessions();
      } finally {
        suppressRemoteDeviceEvents = false;
      }
      await publishRemoteAccess(
        remoteAccessSnapshot,
        remoteAccessSnapshot.status === "connected",
      );
      return;
    }
    bridge?.receive(command.id, command.payload, "local");
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
    remoteAccess.close();
    await remoteServer.stop();
    await stopDaemon();
    await terminalService.stop();
  }
}

function remotePairingHandoff(
  publicUrl: string,
  grant: { expiresAt: number; token: string },
): { expiresAt: number; url: string } {
  const url = new URL(publicUrl);
  url.hash = new URLSearchParams({ pair: grant.token }).toString();
  return { expiresAt: grant.expiresAt, url: url.href };
}

async function persistentRemoteTunnelId(): Promise<string> {
  const directory = join(homedir(), ".vibewaiting");
  const path = join(directory, "remote-tunnel-id");
  const existing = await readFile(path, "utf8").then((value) => value.trim()).catch(() => "");
  if (/^vw-[a-f0-9-]{36}$/i.test(existing)) return existing;
  const created = `vw-${randomUUID()}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, `${created}\n`, { encoding: "utf8", mode: 0o600 });
  return created;
}
