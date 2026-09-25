import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { browserToolError, parseBrowserToolCall, type BrowserToolCall, type BrowserToolResult } from "./browser-tools.js";

/** The wire between `vibewaiting mcp` and the native host: one JSON line each way, then `pending` lines. */
export const BROWSER_BROKER_PROTOCOL = "vibewaiting/browser-broker-v1" as const;

const MAX_WIRE_BYTES = 1_000_000;
/** A call runs up to 30 s in the extension (a navigation waits for its load); the socket outlives it. */
const DEFAULT_TIMEOUT_MS = 40_000;
/** How long the caller's socket stays open after a `pending` line: the person's decision window, plus margin. */
const PERSON_TIMEOUT_MS = 125_000;

interface BrowserBrokerRequest {
  id: string;
  call: BrowserToolCall;
  acceptsPending: boolean;
  task: string | null;
}

/** Where a running native host publishes its broker: one file per host, readable only by this user. */
export interface BrowserBrokerDiscovery {
  protocol: typeof BROWSER_BROKER_PROTOCOL;
  workspace: string;
  host: "127.0.0.1";
  port: number;
  token: string;
  pid: number;
  createdAt: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function discoveryDirectory(): string {
  return join(homedir(), ".vibewaiting", "browser");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The broker an MCP server started in `cwd` uses: the live one whose
 * workspace holds `cwd` most closely, else the newest live one.
 */
export async function findBrowserBroker(cwd: string): Promise<BrowserBrokerDiscovery | null> {
  const directory = discoveryDirectory();
  const names = await readdir(directory).catch(() => [] as string[]);
  const found: BrowserBrokerDiscovery[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const parsed = record(await readFile(join(directory, name), "utf8").then((text) => JSON.parse(text) as unknown, () => null));
    if (parsed?.protocol !== BROWSER_BROKER_PROTOCOL || typeof parsed.workspace !== "string" ||
      typeof parsed.port !== "number" || typeof parsed.token !== "string" || typeof parsed.pid !== "number" ||
      typeof parsed.createdAt !== "string" || !alive(parsed.pid)) continue;
    found.push(parsed as unknown as BrowserBrokerDiscovery);
  }
  const here = await canonicalWorkspace(cwd);
  const holding = found
    .filter((entry) => here === entry.workspace || here.startsWith(entry.workspace.endsWith(sep) ? entry.workspace : `${entry.workspace}${sep}`))
    .sort((a, b) => b.workspace.length - a.workspace.length);
  return holding[0] ?? found.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

async function canonicalWorkspace(workspace: string): Promise<string> {
  const absolute = resolve(workspace);
  return await realpath(absolute).catch(() => absolute);
}

function writeSocket(socket: Socket, value: unknown): void {
  socket.end(`${JSON.stringify(value)}\n`);
}

/** Serves the person's active tab to `vibewaiting mcp` servers on this machine. */
export class BrowserBroker {
  private server: Server | null = null;
  private discoveryPath: string | null = null;
  private workspace: string | null = null;

  constructor(
    private readonly dispatch: (
      id: string,
      call: BrowserToolCall,
      caller: {
        /**
         * The call waits for the person: the MCP server keeps it open.
         * Null when the request did not declare `accepts: ["pending"]`.
         */
        pending: ((message: string) => void) | null;
        /** Aborted when the caller's connection closes before the answer. */
        signal: AbortSignal;
        /** The agent task the call belongs to, when the caller names one. */
        task: string | null;
      },
    ) => Promise<BrowserToolResult>,
  ) {}

  async start(workspace: string): Promise<void> {
    const canonical = await canonicalWorkspace(workspace);
    if (this.server && this.workspace === canonical) return;
    await this.stop();
    const token = randomBytes(32).toString("hex");
    const server = createServer((socket) => this.handleSocket(socket, token));
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolveListen();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Could not bind the Vibewaiting browser broker");
    }
    const directory = discoveryDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const path = join(directory, `${process.pid}-${randomUUID()}.json`);
    const temporary = `${path}.tmp`;
    const discovery: BrowserBrokerDiscovery = {
      protocol: BROWSER_BROKER_PROTOCOL,
      workspace: canonical,
      host: "127.0.0.1",
      port: address.port,
      token,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };
    await writeFile(temporary, `${JSON.stringify(discovery)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    this.server = server;
    this.discoveryPath = path;
    this.workspace = canonical;
  }

  async stop(): Promise<void> {
    const server = this.server;
    const path = this.discoveryPath;
    this.server = null;
    this.discoveryPath = null;
    this.workspace = null;
    if (server) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    if (path) await rm(path, { force: true }).catch(() => undefined);
  }

  private handleSocket(socket: Socket, token: string): void {
    socket.setTimeout(DEFAULT_TIMEOUT_MS, () => socket.destroy());
    socket.setEncoding("utf8");
    let data = "";
    socket.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > MAX_WIRE_BYTES) {
        socket.destroy();
        return;
      }
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      socket.pause();
      let request: BrowserBrokerRequest | null = null;
      try {
        const candidate = record(JSON.parse(data.slice(0, newline)));
        const call = parseBrowserToolCall(candidate?.call);
        if (candidate?.protocol === BROWSER_BROKER_PROTOCOL &&
          typeof candidate.id === "string" && candidate.token === token && call) {
          request = {
            id: candidate.id,
            call,
            acceptsPending: Array.isArray(candidate.accepts) && candidate.accepts.includes("pending"),
            task: typeof candidate.task === "string" && candidate.task.length <= 200 ? candidate.task : null,
          };
        }
      } catch {
        request = null;
      }
      if (!request) {
        writeSocket(socket, { protocol: BROWSER_BROKER_PROTOCOL, error: "Invalid browser broker request" });
        return;
      }
      const closed = new AbortController();
      let answered = false;
      socket.once("close", () => { if (!answered) closed.abort(); });
      const pending = (message: string): void => {
        if (socket.destroyed) return;
        socket.setTimeout(PERSON_TIMEOUT_MS);
        socket.write(`${JSON.stringify({
          protocol: BROWSER_BROKER_PROTOCOL,
          id: request!.id,
          pending: { reason: "approval", message },
        })}\n`);
      };
      void this.dispatch(request.id, request.call, {
        pending: request.acceptsPending ? pending : null,
        signal: closed.signal,
        task: request.task,
      })
        .then((result) => { answered = true; writeSocket(socket, {
          protocol: BROWSER_BROKER_PROTOCOL,
          id: request!.id,
          result,
        }); })
        .catch((error: unknown) => { answered = true; writeSocket(socket, {
          protocol: BROWSER_BROKER_PROTOCOL,
          id: request!.id,
          result: browserToolError(error instanceof Error ? error.message : String(error)),
        }); });
    });
  }
}
