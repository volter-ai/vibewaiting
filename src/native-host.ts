import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SupercodeHarnessClient } from "@volter/supercode-agent-sdk";
import type { HarnessId } from "@volter/supercode-agent-sdk";
import {
  createRemoteAccessController,
  inspectRemoteAccessCapabilities,
  type RemoteAccessController,
  type RemoteAccessCapability,
  type RemoteAccessSnapshot,
} from "@volter/supercode-agent-remote-access";
import { SupercodeTerminalController } from "@volter/supercode-agent-terminal";
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
import { RemoteMessengerServer } from "./remote-messenger.js";
import type { RemoteDeviceSnapshot } from "@volter/supercode-agent-remote-access/client";
import { formatWorkspacePath } from "@volter/supercode-agent-ui/controller";
import { BrowserBroker } from "./browser-broker.js";
import { browserToolError, type BrowserToolResult } from "./browser-tools.js";

const HARNESS_IDS = new Set<HarnessId>(["claude-code", "codex"]);
const STABLE_RELAY_ENV_KEYS = [
  "SUPERCODE_TUNNEL_SERVER_URL",
  "TUNNEL_SERVER_URL",
  "TERMFLEET_TUNNEL_SERVER_URL",
] as const;

type HostEventWithoutChunk = Exclude<NativeHostEvent, { type: "chunk" }>;

async function secureRemoteAccessRuntime(source: NodeJS.ProcessEnv, signal: AbortSignal): Promise<{
  capabilities: readonly RemoteAccessCapability[];
  env: NodeJS.ProcessEnv;
}> {
  const env = { ...source };
  const configured = STABLE_RELAY_ENV_KEYS.map((key) =>
    source[key]?.trim(),
  ).find((value): value is string => Boolean(value));
  let rejectedStableRelay = false;
  if (configured) {
    try {
      rejectedStableRelay = new URL(configured).protocol !== "https:";
    } catch {
      rejectedStableRelay = true;
    }
  }
  if (rejectedStableRelay)
    for (const key of STABLE_RELAY_ENV_KEYS) delete env[key];
  const capabilities = (await inspectRemoteAccessCapabilities(env, { signal })).map((capability) =>
    rejectedStableRelay && capability.provider === "stable"
      ? {
          detail: "Stable remote access requires an HTTPS relay URL",
          provider: "stable" as const,
          status: "needs-setup" as const,
        }
      : capability,
  );
  return { capabilities, env };
}

function isClosedNativeChannel(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return (
    code === "EPIPE" ||
    code === "ERR_STREAM_DESTROYED" ||
    code === "ERR_STREAM_WRITE_AFTER_END"
  );
}

class NativeMessageWriter {
  private closed = false;
  private failure: unknown;
  private readonly lifetime = new AbortController();

  constructor(private readonly output: typeof process.stdout) {
    // Closing a browser tab tears down the native pipe before every producer has necessarily
    // observed stdin ending. A broken pipe is normal lifecycle, not an uncaught host failure.
    output.on("error", (error: unknown) => {
      if (isClosedNativeChannel(error)) this.closed = true;
      else this.failure = error;
    });
  }

  async write(event: HostEventWithoutChunk): Promise<void> {
    for (const part of chunkNativeEvent(event)) {
      if (!(await this.writeFrame(part))) return;
    }
  }

  close(): void {
    this.closed = true;
    this.lifetime.abort();
  }

  private async writeFrame(value: unknown): Promise<boolean> {
    if (this.failure) throw this.failure;
    if (this.closed || this.output.destroyed || this.output.writableEnded)
      return false;
    try {
      if (!this.output.write(encodeNativeMessage(value)))
        await once(this.output, "drain", { signal: this.lifetime.signal });
      if (this.failure) throw this.failure;
      return !this.closed;
    } catch (error) {
      if (this.closed) return false;
      if (isClosedNativeChannel(error)) {
        this.closed = true;
        return false;
      }
      throw error;
    }
  }
}

class NativeWidgetBridge implements WidgetBridge {
  private readonly intentHandlers = new Map<
    string,
    (intent: {
      id: string;
      payload: unknown;
      source?: "local" | "remote";
    }) => void | Promise<void>
  >();
  private readonly timers = new Set<ReturnType<typeof setInterval>>();
  private removed = false;

  constructor(
    private readonly remote: RemoteMessengerServer,
    private readonly writer: NativeMessageWriter,
  ) {
    remote.setIntentHandler((intent) =>
      this.receive(intent.id, intent.payload, "remote"),
    );
  }

  async push(patch: unknown): Promise<void> {
    if (this.removed) return;
    this.remote.push(patch);
    await this.writer.write({
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
      void Promise.resolve(handler({ id, payload, source })).catch(
        (error: unknown) => {
          process.stderr.write(
            `[vibewaiting] intent failed: ${(error as Error)?.message ?? String(error)}\n`,
          );
        },
      );
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

async function validateSettings(settings: ExtensionSettings): Promise<{
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

export async function localAgentCommand(): Promise<string> {
  if (process.env["SUPERCODE_CODING_BIN"]) return process.env["SUPERCODE_CODING_BIN"];
  const marker = fileURLToPath(
    new URL(
      "../node_modules/.cache/vibewaiting/local-agent-bin",
      import.meta.url,
    ),
  );
  const localCommand = await readFile(marker, "utf8")
    .then((value) => value.trim() || undefined)
    .catch(() => undefined);
  if (localCommand) return localCommand;

  // The source marker is a deliberate local-development choice. Falling through to whatever
  // `supercode-agent` happens to be installed on PATH after (for example) `npm ci` deletes node_modules
  // makes the browser silently exercise old protocol and activity behavior. A missing synced
  // binary is a broken development stack, not permission to change products underneath the user.
  const sourceMarker = fileURLToPath(
    new URL("../.vibewaiting/local-agent-source", import.meta.url),
  );
  const configuredSource = await readFile(sourceMarker, "utf8")
    .then((value) => value.trim())
    .catch(() => "");
  if (configuredSource) {
    throw new Error(
      `Local Supercode Agent is configured from ${configuredSource}, but its synced binary marker is missing. Run npm run sync:local before starting Vibewaiting.`,
    );
  }
  return fileURLToPath(import.meta.resolve("@volter/supercode-agent/bin/supercode-agent.js"));
}

export async function runNativeHost(
  extensionOrigin: string | undefined,
): Promise<void> {
  if (!extensionOrigin)
    throw new Error("native host did not receive its browser extension origin");
  const decoder = new NativeMessageDecoder();
  const writer = new NativeMessageWriter(process.stdout);
  const lifetime = new AbortController();
  let remoteAccess: RemoteAccessController | undefined;
  let commandQueue = Promise.resolve();
  let handle!: (value: unknown) => Promise<void>;
  let initializedReady!: () => void;
  const initialized = new Promise<void>(resolve => { initializedReady = resolve; });
  const stopped = new Promise<void>(resolve => lifetime.signal.addEventListener("abort", () => resolve(), { once: true }));
  const stop = (): void => {
    lifetime.abort(new Error("Native messaging host closed"));
    writer.close();
    void remoteAccess?.close().catch(() => undefined);
  };
  const stopWithError = (error: Error): void => { failure = error; lifetime.abort(error); writer.close(); void remoteAccess?.close().catch(() => undefined); };
  const cleanups: Array<() => Promise<void>> = [];
  let failure: unknown;
  const receive = (chunk: Buffer): void => {
    try {
      for (const value of decoder.push(chunk)) {
        commandQueue = commandQueue
          .then(async () => { await initialized; if (!lifetime.signal.aborted) await handle(value); })
          .catch(async (error: unknown) => {
            await writer.write({
              protocol: VIBEWAITING_EXTENSION_PROTOCOL,
              type: "status",
              phase: "error",
              message: (error as Error)?.message ?? String(error),
            });
          });
      }
    } catch (error) {
      commandQueue = commandQueue.then(async () => {
        await writer.write({
          protocol: VIBEWAITING_EXTENSION_PROTOCOL,
          type: "status",
          phase: "error",
          message: (error as Error)?.message ?? String(error),
        });
      });
    }
  };
  process.stdin.on("data", receive);
  process.stdin.once("end", stop);
  process.stdin.once("error", stopWithError);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    const terminalService = new SupercodeTerminalController({
      allowedOrigins: extensionOrigin,
      formatCwd: (cwd) => formatWorkspacePath(cwd, homedir()) || null,
    });
    cleanups.push(() => terminalService.stop());
    await terminalService.start();
    lifetime.signal.throwIfAborted();
    const remoteServer = new RemoteMessengerServer(extensionOrigin);
    cleanups.push(() => remoteServer.stop());
    const remoteEndpoint = await remoteServer.start();
    const remoteRuntime = await secureRemoteAccessRuntime(process.env, lifetime.signal);
    lifetime.signal.throwIfAborted();
    const controller = createRemoteAccessController({
      capabilities: remoteRuntime.capabilities,
      env: remoteRuntime.env,
      localOrigin: remoteEndpoint.localOrigin,
      publicPath: "/",
      tunnelId: await persistentRemoteTunnelId(),
    });
    remoteAccess = controller;
    cleanups.push(() => controller.close());
    let remoteAccessSnapshot = controller.snapshot();
    let remoteDevices: RemoteDeviceSnapshot = remoteServer.deviceSnapshot();
    let suppressRemoteDeviceEvents = false;
    const publishRemoteAccess = async (
      snapshot: RemoteAccessSnapshot,
      includePairing: boolean,
    ): Promise<void> => {
      const pairing =
        includePairing && snapshot.status === "connected" && snapshot.publicUrl
          ? remotePairingHandoff(
              snapshot.publicUrl,
              remoteServer.createPairingGrant(),
            )
          : undefined;
      await writer.write({
        protocol: VIBEWAITING_EXTENSION_PROTOCOL,
        type: "remote-access",
        devices: remoteDevices,
        ...(pairing ? { pairing } : {}),
        passcode: remoteEndpoint.passcode,
        snapshot,
      });
    };
    controller.subscribe((snapshot) => {
      remoteAccessSnapshot = snapshot;
      remoteServer.setInstallableOrigin(
        snapshot.status === "connected" &&
          snapshot.stability === "stable" &&
          snapshot.publicUrl
          ? snapshot.publicUrl
          : null,
      );
      void publishRemoteAccess(snapshot, snapshot.status === "connected").catch(
        (error: unknown) => {
          process.stderr.write(
            `[vibewaiting] remote access update failed: ${(error as Error)?.message ?? String(error)}\n`,
          );
        },
      );
    });
    remoteServer.setDeviceSnapshotHandler((devices) => {
      remoteDevices = devices;
      if (!suppressRemoteDeviceEvents)
        void publishRemoteAccess(remoteAccessSnapshot, false).catch(
          (error: unknown) => {
            process.stderr.write(
              `[vibewaiting] remote device update failed: ${(error as Error)?.message ?? String(error)}\n`,
            );
          },
        );
    });
    let daemon: Daemon | null = null;
    let bridge: NativeWidgetBridge | null = null;
    let activeDiscoveryClient: SupercodeHarnessClient | null = null;
    let fingerprint = "";
    const pendingBrowserOperations = new Map<
      string,
      {
        resolve: (result: BrowserToolResult) => void;
        pending: ((message: string) => void) | null;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    /** Tells the extension an agent's call ended unanswered: an approval it waits on is void. */
    const cancelBrowserOperation = (id: string): void => {
      void writer
        .write({ protocol: VIBEWAITING_EXTENSION_PROTOCOL, type: "browser-operation-cancelled", id })
        .catch(() => undefined);
    };
    const browserTimeout = (
      id: string,
      milliseconds: number,
      message: string,
    ): ReturnType<typeof setTimeout> =>
      setTimeout(() => {
        const pending = pendingBrowserOperations.get(id);
        if (!pending) return;
        pendingBrowserOperations.delete(id);
        cancelBrowserOperation(id);
        pending.resolve(browserToolError(message));
      }, milliseconds);
    const browserBroker = new BrowserBroker(async (id, call, { pending, signal, task }) => {
      if (pendingBrowserOperations.has(id))
        throw new Error(`Duplicate browser operation id: ${id}`);
      return await new Promise<BrowserToolResult>((resolve) => {
        const timer = browserTimeout(
          id,
          35_000,
          "The Vibewaiting extension did not answer in 35 seconds.",
        );
        pendingBrowserOperations.set(id, { resolve, pending, timer });
        signal.addEventListener("abort", () => {
          const current = pendingBrowserOperations.get(id);
          if (!current) return;
          pendingBrowserOperations.delete(id);
          clearTimeout(current.timer);
          cancelBrowserOperation(id);
          current.resolve(browserToolError("The caller stopped waiting."));
        }, { once: true });
        void writer
          .write({
            protocol: VIBEWAITING_EXTENSION_PROTOCOL,
            type: "browser-operation-request",
            id,
            call,
            acceptsPending: pending !== null,
            task,
          })
          .catch((error: unknown) => {
            const pending = pendingBrowserOperations.get(id);
            if (!pending) return;
            pendingBrowserOperations.delete(id);
            clearTimeout(pending.timer);
            pending.resolve(browserToolError(error instanceof Error ? error.message : String(error)));
          });
      });
    });

    const stopBrowserBroker = async (): Promise<void> => {
      for (const pending of pendingBrowserOperations.values()) {
        clearTimeout(pending.timer);
        pending.resolve(browserToolError("The Vibewaiting browser broker stopped."));
      }
      pendingBrowserOperations.clear();
      await browserBroker.stop();
    };

    const stopDaemon = async (): Promise<void> => {
      const active = daemon;
      daemon = null;
      bridge = null;
      fingerprint = "";
      const discovery = activeDiscoveryClient;
      activeDiscoveryClient = null;
      const failures: unknown[] = [];
      for (const close of [() => stopBrowserBroker(), () => active?.stop(), () => discovery?.close()]) {
        try { await close(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, "Native daemon cleanup failed");
    };

    cleanups.push(stopDaemon);

    const start = async (requested: ExtensionSettings): Promise<void> => {
      const settings = await validateSettings(requested);
      const nextFingerprint = JSON.stringify(settings);
      if (daemon && nextFingerprint === fingerprint) {
        await daemon.flush();
        await writer.write({
          protocol: VIBEWAITING_EXTENSION_PROTOCOL,
          type: "status",
          phase: "ready",
        });
        return;
      }
      await stopDaemon();
      await writer.write({
        protocol: VIBEWAITING_EXTENSION_PROTOCOL,
        type: "status",
        phase: "starting",
      });
      const command = await localAgentCommand();
      const client = new SupercodeHarnessClient({
        cwd: settings.workspace,
        requestTimeoutMs: 5_000,
        command,
      });
      const discoveryClient = new SupercodeHarnessClient({
        cwd: settings.workspace,
        requestTimeoutMs: 5_000,
        command,
      });
      const nextBridge = new NativeWidgetBridge(remoteServer, writer);
      let nextDaemon: Daemon | null = null;
      try {
        nextDaemon = await startDaemon({
          html: "",
          workspace: settings.workspace,
          ...(settings.harness ? { harness: settings.harness } : {}),
          ...(settings.policy ? { policy: settings.policy } : {}),
          client,
          discoveryClient,
          persistence: new FileMessengerPersistence(),
          attachHost: async () => nextBridge,
          log: (message) => process.stderr.write(`[vibewaiting] ${message}\n`),
          terminalService,
        });
        await browserBroker.start(settings.workspace);
        bridge = nextBridge;
        daemon = nextDaemon;
        activeDiscoveryClient = discoveryClient;
        fingerprint = nextFingerprint;
        await writer.write({
          protocol: VIBEWAITING_EXTENSION_PROTOCOL,
          type: "status",
          phase: "ready",
        });
        if (requested.remoteAccess) {
          void controller
            .configure(requested.remoteAccess)
            .catch((error: unknown) => {
              process.stderr.write(
                `[vibewaiting] remote access failed: ${(error as Error)?.message ?? String(error)}\n`,
              );
            });
        }
      } catch (error) {
        if (daemon === nextDaemon) await stopDaemon();
        else {
          await stopBrowserBroker();
          await nextDaemon?.stop().catch(() => undefined);
        }
        await client.close().catch(() => undefined);
        await discoveryClient.close().catch(() => undefined);
        await nextBridge.remove();
        throw error;
      }
    };

    handle = async (value: unknown): Promise<void> => {
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
            await controller.configure(command.configuration);
          } catch (error) {
            process.stderr.write(
              `[vibewaiting] remote access failed: ${(error as Error)?.message ?? String(error)}\n`,
            );
          } finally {
            suppressRemoteDeviceEvents = false;
            await publishRemoteAccess(remoteAccessSnapshot, false);
          }
          return;
        }
        await controller
          .configure(command.configuration)
          .catch((error: unknown) => {
            process.stderr.write(
              `[vibewaiting] remote access failed: ${(error as Error)?.message ?? String(error)}\n`,
            );
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
      if (command.type === "browser-operation-pending") {
        // The extension asked the person to approve this call; it answers
        // within its 90 s decision window.
        const pending = pendingBrowserOperations.get(command.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        pending.timer = browserTimeout(
          command.id,
          110_000,
          "The Vibewaiting extension did not answer after asking the person.",
        );
        pending.pending?.(command.message);
        return;
      }
      if (command.type === "browser-operation-response") {
        const pending = pendingBrowserOperations.get(command.id);
        if (!pending) return;
        pendingBrowserOperations.delete(command.id);
        clearTimeout(pending.timer);
        pending.resolve(command.result);
        return;
      }
      bridge?.receive(command.id, command.payload, "local");
    };

    initializedReady();
    await stopped;
    await commandQueue;
    decoder.finish();
  } catch (error) {
    if (error !== lifetime.signal.reason) failure = error;
  } finally {
    stop();
    initializedReady();
    process.stdin.removeListener("data", receive);
    process.stdin.pause();
    process.stdin.removeListener("end", stop);
    process.stdin.removeListener("error", stopWithError);
    const failures: unknown[] = failure === undefined ? [] : [failure];
    try { await commandQueue; } catch (error) { failures.push(error); }
    writer.close();
    for (const close of cleanups.reverse()) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    if (failures.length) throw new AggregateError(failures, "Native host shutdown failed");
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
  const existing = await readFile(path, "utf8")
    .then((value) => value.trim())
    .catch(() => "");
  if (/^vw-[a-f0-9-]{36}$/i.test(existing)) return existing;
  const created = `vw-${randomUUID()}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, `${created}\n`, { encoding: "utf8", mode: 0o600 });
  return created;
}
