import { Runtime, type VirtualFS } from "almostnode";
import type { GrokBuildAcpMcpServer } from "./grok-build-agent-mcp.js";
import type { GrokBuildMcpServerConfig } from "./grok-build-mcp.js";

const STDIO_URL = "https://stdio.mcp.invalid/rpc";
const MAX_STDOUT_LINE_BYTES = 4 * 1024 * 1024;
const DECODE_ERROR_SAMPLE_CHARS = 200;

export interface GrokBuildMcpStdioProcess {
  write(data: string): void;
  close(): void;
}

export interface GrokBuildMcpStdioProcessCallbacks {
  stdout(data: string): void;
  stderr(data: string): void;
  exit(error?: unknown): void;
}

export interface GrokBuildMcpStdioAdapterOptions {
  name: string;
  spawn(callbacks: GrokBuildMcpStdioProcessCallbacks): GrokBuildMcpStdioProcess;
  onDecodeError?(event: { serverName: string; error: string; sample: string }): void;
  onStderr?(event: { serverName: string; data: string }): void;
}

interface PendingResponse {
  controller: ReadableStreamDefaultController<Uint8Array>;
  cleanup(): void;
}

/**
 * Project a persistent newline-delimited stdio transport through the existing
 * Streamable HTTP protocol client. POST streams own correlated responses; an
 * internal GET stream carries server notifications and reverse requests.
 */
export class GrokBuildMcpStdioFetchAdapter {
  readonly fetch: typeof fetch;
  private readonly encoder = new TextEncoder();
  private readonly pending = new Map<string, PendingResponse>();
  private readonly unsolicited: string[] = [];
  private process: GrokBuildMcpStdioProcess | undefined;
  private stdout = "";
  private eventController: ReadableStreamDefaultController<Uint8Array> | undefined;
  private closed = false;

  constructor(private readonly options: GrokBuildMcpStdioAdapterOptions) {
    this.fetch = this.handleFetch.bind(this) as typeof fetch;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.process?.close();
    this.process = undefined;
    const error = new Error(`MCP stdio server '${this.options.name}' closed.`);
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.controller.error(error);
    }
    this.pending.clear();
    this.eventController?.close();
    this.eventController = undefined;
  }

  private ensureProcess(): GrokBuildMcpStdioProcess {
    if (this.closed) throw new Error(`MCP stdio server '${this.options.name}' is closed.`);
    if (this.process) return this.process;
    this.process = this.options.spawn({
      stdout: (data) => this.receiveStdout(data),
      stderr: (data) => this.options.onStderr?.({ serverName: this.options.name, data }),
      exit: (error) => this.processExited(error),
    });
    return this.process;
  }

  private async handleFetch(_input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const method = init.method ?? "GET";
    if (method === "GET") return this.openEventStream(init.signal ?? undefined);
    if (method === "DELETE") {
      this.close();
      return new Response(null, { status: 204 });
    }
    if (method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("The operation was aborted.", "AbortError");

    let payload: unknown;
    try {
      payload = JSON.parse(String(init.body ?? ""));
    } catch {
      return new Response("Invalid JSON-RPC payload", { status: 400 });
    }
    if (!isJsonRpcObject(payload)) return new Response("Invalid JSON-RPC payload", { status: 400 });

    const process = this.ensureProcess();
    if (payload.id === undefined || typeof payload.method !== "string") {
      process.write(`${JSON.stringify(payload)}\n`);
      return new Response(null, { status: 202, headers: sessionHeaders(this.options.name) });
    }

    const key = String(payload.id);
    if (this.pending.has(key)) throw new Error(`MCP stdio request id '${key}' is already pending.`);
    const signal = init.signal ?? undefined;
    let pending!: PendingResponse;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const abort = () => {
          this.pending.delete(key);
          controller.error(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        pending = {
          controller,
          cleanup: () => signal?.removeEventListener("abort", abort),
        };
        this.pending.set(key, pending);
      },
      cancel: () => {
        this.pending.delete(key);
        pending.cleanup();
      },
    });
    try {
      process.write(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      this.pending.delete(key);
      pending.cleanup();
      pending.controller.error(error);
      throw error;
    }
    return new Response(body, {
      status: 200,
      headers: { ...sessionHeaders(this.options.name), "Content-Type": "text/event-stream" },
    });
  }

  private openEventStream(signal: AbortSignal | undefined): Response {
    if (this.closed) return new Response(null, { status: 204 });
    let controllerRef!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controllerRef = controller;
        this.eventController?.close();
        this.eventController = controller;
        for (const message of this.unsolicited.splice(0)) this.enqueueSse(controller, message);
        const abort = () => {
          if (this.eventController === controller) this.eventController = undefined;
          controller.close();
        };
        signal?.addEventListener("abort", abort, { once: true });
      },
      cancel: () => {
        if (this.eventController === controllerRef) this.eventController = undefined;
      },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  }

  private receiveStdout(data: string): void {
    if (this.closed || !data) return;
    this.stdout += data;
    if (this.stdout.length > MAX_STDOUT_LINE_BYTES && !this.stdout.includes("\n")) {
      this.recordDecodeError("stdout line exceeds 4 MiB", this.stdout.slice(0, 512));
      this.stdout = "";
      return;
    }
    for (;;) {
      const newline = this.stdout.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdout.slice(0, newline).replace(/\r$/u, "");
      this.stdout = this.stdout.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.recordDecodeError(error instanceof Error ? error.message : String(error), line);
        continue;
      }
      if (!isJsonRpcObject(message)) {
        this.recordDecodeError("unrecognized JSON-RPC message", line);
        continue;
      }
      if (message.id !== undefined && typeof message.method !== "string") {
        const pending = this.pending.get(String(message.id));
        if (pending) {
          this.pending.delete(String(message.id));
          pending.cleanup();
          this.enqueueSse(pending.controller, line);
          pending.controller.close();
          continue;
        }
      }
      if (this.eventController) this.enqueueSse(this.eventController, line);
      else this.unsolicited.push(line);
    }
  }

  private enqueueSse(controller: ReadableStreamDefaultController<Uint8Array>, json: string): void {
    controller.enqueue(this.encoder.encode(`event: message\ndata: ${json}\n\n`));
  }

  private processExited(cause?: unknown): void {
    if (this.closed) return;
    this.process = undefined;
    const error = cause instanceof Error
      ? cause
      : new Error(`MCP stdio server '${this.options.name}' exited${cause === undefined ? "" : `: ${String(cause)}`}.`);
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.controller.error(error);
    }
    this.pending.clear();
    this.eventController?.error(error);
    this.eventController = undefined;
  }

  private recordDecodeError(error: string, sample: string): void {
    this.options.onDecodeError?.({
      serverName: this.options.name,
      error,
      sample: [...sample].slice(0, DECODE_ERROR_SAMPLE_CHARS).join(""),
    });
  }
}

export interface GrokBuildAlmostNodeStdioOptions {
  cwd: string;
  sessionId?: string;
  onDecodeError?: GrokBuildMcpStdioAdapterOptions["onDecodeError"];
  onStderr?: GrokBuildMcpStdioAdapterOptions["onStderr"];
}

/** Launch a browser-representable JavaScript MCP server in its own runtime. */
export function createGrokBuildAlmostNodeStdioConfig(
  vfs: VirtualFS,
  server: Extract<GrokBuildAcpMcpServer, { type: "stdio" }>,
  options: GrokBuildAlmostNodeStdioOptions,
): GrokBuildMcpServerConfig {
  const adapter = new GrokBuildMcpStdioFetchAdapter({
    name: server.name,
    spawn: (callbacks) => spawnAlmostNodeMcp(vfs, server, options, callbacks),
    ...(options.onDecodeError ? { onDecodeError: options.onDecodeError } : {}),
    ...(options.onStderr ? { onStderr: options.onStderr } : {}),
  });
  return {
    name: server.name,
    url: STDIO_URL,
    fetchImpl: adapter.fetch,
    transportType: "stdio",
    enableEventStream: true,
  };
}

function spawnAlmostNodeMcp(
  vfs: VirtualFS,
  server: Extract<GrokBuildAcpMcpServer, { type: "stdio" }>,
  options: GrokBuildAlmostNodeStdioOptions,
  callbacks: GrokBuildMcpStdioProcessCallbacks,
): GrokBuildMcpStdioProcess {
  const launch = resolveJavascriptLaunch(vfs, server.command, server.args, options.cwd);
  const env = Object.fromEntries(server.env.map(({ name, value }) => [name, value]));
  if (options.sessionId) env.GROK_SESSION_ID = options.sessionId;
  const stderrPath = `/.grok/logs/mcp/${sanitizeMcpLogFilename(server.name)}.stderr.log`;
  vfs.mkdirSync("/.grok/logs/mcp", { recursive: true });
  vfs.writeFileSync(stderrPath, "");
  let exited = false;
  const runtime = new Runtime(vfs, {
    cwd: options.cwd,
    env,
    onStdout: callbacks.stdout,
    onStderr: (data: string) => {
      const previous = vfs.readFileSync(stderrPath, "utf8");
      vfs.writeFileSync(stderrPath, previous + data);
      callbacks.stderr(data);
    },
  });
  const process = runtime.getProcess();
  process.argv = [process.execPath, launch.script, ...launch.args];
  const exitListener = (code: unknown) => {
    if (exited) return;
    exited = true;
    callbacks.exit(Number(code) === 0 ? undefined : new Error(`MCP process exited with code ${String(code)}.`));
  };
  process.once("exit", exitListener);
  try {
    runtime.runFile(launch.script);
  } catch (error) {
    process.off("exit", exitListener);
    exited = true;
    callbacks.exit(error);
    throw error;
  }
  return {
    write(data) {
      if (exited) throw new Error(`MCP stdio server '${server.name}' is not running.`);
      process.stdin.emit("data", data);
    },
    close() {
      if (exited) return;
      exited = true;
      process.stdin.emit("end");
      process.stdin.emit("close");
      process.emit("SIGTERM");
      process.removeAllListeners();
    },
  };
}

function resolveJavascriptLaunch(
  vfs: VirtualFS,
  command: string,
  args: readonly string[],
  cwd: string,
): { script: string; args: string[] } {
  const commandName = basename(command).toLowerCase();
  if (["npx", "bunx"].includes(commandName)) {
    return resolvePackageRunnerLaunch(vfs, args, cwd, 0);
  }
  if (commandName === "npm" && args[0] === "exec") {
    return resolvePackageRunnerLaunch(vfs, args.slice(1), cwd, 0);
  }
  if (["pnpm", "yarn"].includes(commandName) && args[0] === "dlx") {
    return resolvePackageRunnerLaunch(vfs, args.slice(1), cwd, 0);
  }
  if (commandName === "node" || commandName === "nodejs") {
    const separator = args.indexOf("--");
    const candidateIndex = separator >= 0 ? separator + 1 : args.findIndex((arg) => !arg.startsWith("-"));
    const candidate = candidateIndex >= 0 ? args[candidateIndex] : undefined;
    if (!candidate) throw new Error("Browser stdio MCP node command is missing its script path.");
    return {
      script: requireVfsFile(vfs, resolvePath(cwd, candidate)),
      args: args.slice(candidateIndex + 1),
    };
  }

  const direct = resolvePath(cwd, command);
  if (vfs.existsSync(direct) && !vfs.statSync(direct).isDirectory()) {
    return resolveBinShim(vfs, direct, args);
  }
  for (const directory of ancestorDirectories(cwd)) {
    const shim = resolvePath(directory, `node_modules/.bin/${command}`);
    if (vfs.existsSync(shim) && !vfs.statSync(shim).isDirectory()) {
      return resolveBinShim(vfs, shim, args);
    }
  }
  throw new Error(
    `MCP stdio command '${command}' is not browser-representable. Install a JavaScript bin in the virtual project or configure node with a virtual script path.`,
  );
}

function resolvePackageRunnerLaunch(
  vfs: VirtualFS,
  args: readonly string[],
  cwd: string,
  start: number,
): { script: string; args: string[] } {
  let packageIndex = -1;
  for (let index = start; index < args.length; index += 1) {
    const value = args[index];
    if (value === undefined) continue;
    if (value === "--") continue;
    if (["-y", "--yes", "--no-install", "--prefer-online", "--prefer-offline"].includes(value)) continue;
    if (["-p", "--package"].includes(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("-")) continue;
    packageIndex = index;
    break;
  }
  const packageSpec = packageIndex >= 0 ? args[packageIndex] : undefined;
  if (!packageSpec) throw new Error("Browser stdio MCP package runner is missing its package command.");
  const packageName = packageNameFromSpec(packageSpec);
  for (const directory of ancestorDirectories(cwd)) {
    const packageRoot = resolvePath(directory, `node_modules/${packageName}`);
    const manifestPath = `${packageRoot}/package.json`;
    if (!vfs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(vfs.readFileSync(manifestPath, "utf8")) as { bin?: string | Record<string, string> };
    const binName = packageName.split("/").at(-1) ?? packageName;
    const entry = typeof manifest.bin === "string"
      ? manifest.bin
      : manifest.bin?.[binName] ?? Object.values(manifest.bin ?? {})[0];
    if (!entry) throw new Error(`Installed package '${packageName}' does not declare a JavaScript bin.`);
    return {
      script: requireVfsFile(vfs, resolvePath(packageRoot, entry)),
      args: args.slice(packageIndex + 1),
    };
  }
  throw new Error(
    `MCP package '${packageName}' is not installed in the virtual project. Install it before launching the browser stdio server.`,
  );
}

function resolveBinShim(vfs: VirtualFS, path: string, args: readonly string[]): { script: string; args: string[] } {
  const source = vfs.readFileSync(path, "utf8");
  const almostNodeStub = /^node\s+["']([^"']+)["']\s+["']\$@["']\s*$/u.exec(source.trim());
  if (almostNodeStub?.[1]) return { script: requireVfsFile(vfs, almostNodeStub[1]), args: [...args] };
  return { script: path, args: [...args] };
}

function packageNameFromSpec(spec: string): string {
  if (spec.startsWith("@")) {
    const versionBoundary = spec.indexOf("@", 1);
    return versionBoundary < 0 ? spec : spec.slice(0, versionBoundary);
  }
  const versionBoundary = spec.indexOf("@");
  return versionBoundary < 0 ? spec : spec.slice(0, versionBoundary);
}

function sanitizeMcpLogFilename(name: string): string {
  const sanitized = [...name].slice(0, 96).map((character) =>
    /[a-zA-Z0-9._-]/u.test(character) ? character : "_"
  ).join("");
  return sanitized || "server";
}

function sessionHeaders(name: string): Record<string, string> {
  return { "Mcp-Session-Id": `browser-stdio-${encodeURIComponent(name)}` };
}

function isJsonRpcObject(value: unknown): value is Record<string, unknown> & { id?: string | number; method?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  if (object.jsonrpc !== "2.0") return false;
  if (object.id !== undefined && typeof object.id !== "string" && typeof object.id !== "number") return false;
  return typeof object.method === "string" || object.id !== undefined;
}

function resolvePath(cwd: string, path: string): string {
  const source = path.startsWith("/") ? path : `${cwd}/${path}`;
  const parts: string[] = [];
  for (const part of source.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function basename(path: string): string {
  return path.replace(/\\/gu, "/").split("/").filter(Boolean).at(-1) ?? path;
}

function ancestorDirectories(path: string): string[] {
  const directories: string[] = [];
  let current = resolvePath("/", path);
  for (;;) {
    directories.push(current);
    if (current === "/") return directories;
    current = current.slice(0, current.lastIndexOf("/")) || "/";
  }
}

function requireVfsFile(vfs: VirtualFS, path: string): string {
  if (!vfs.existsSync(path) || vfs.statSync(path).isDirectory()) {
    throw new Error(`Browser stdio MCP script '${path}' was not found in the virtual filesystem.`);
  }
  return path;
}
