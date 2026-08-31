import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseBrowserOperationCall,
  SUPERCODE_BROWSER_PROVIDER_PROTOCOL,
  type BrowserOperationCall,
  type BrowserOperationResult,
} from "@volter-ai-dev/supercode-playwright-shim";

const MAX_WIRE_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 12_000;

interface BrowserProviderRequest {
  protocol: typeof SUPERCODE_BROWSER_PROVIDER_PROTOCOL;
  id: string;
  token: string;
  call: BrowserOperationCall;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function discoveryDirectory(): string {
  const explicit = process.env["SUPERCODE_HOME"];
  if (explicit) return join(explicit, "providers", "browser");
  const xdg = process.env["XDG_CONFIG_HOME"];
  const root = xdg ? join(xdg, "supercode") : join(homedir(), ".config", "supercode");
  return join(root, "providers", "browser");
}

async function canonicalWorkspace(workspace: string): Promise<string> {
  const absolute = resolve(workspace);
  return await realpath(absolute).catch(() => absolute);
}

function writeSocket(socket: Socket, value: unknown): void {
  socket.end(`${JSON.stringify(value)}\n`);
}

/** Publishes Vibewaiting's active-tab executor as a Supercode browser provider. */
export class BrowserProviderBroker {
  private server: Server | null = null;
  private discoveryPath: string | null = null;
  private workspace: string | null = null;

  constructor(
    private readonly dispatch: (
      id: string,
      call: BrowserOperationCall,
    ) => Promise<BrowserOperationResult>,
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
      throw new Error("Could not bind the Vibewaiting browser provider");
    }
    const directory = discoveryDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const workspaceHash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
    const path = join(directory, `${workspaceHash}-${process.pid}-${randomUUID()}.json`);
    const temporary = `${path}.tmp`;
    await writeFile(temporary, `${JSON.stringify({
      protocol: SUPERCODE_BROWSER_PROVIDER_PROTOCOL,
      workspace: canonical,
      host: "127.0.0.1",
      port: address.port,
      token,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      provider: {
        id: "vibewaiting.active-tab",
        name: "Vibewaiting active tab",
        fidelity: {
          target: "active-or-leased-http-page",
          domEvents: "synthetic",
          accessibility: "dom-derived",
          cdp: false,
          arbitraryEvaluate: false,
          trustedInput: false,
        },
      },
    })}\n`, { encoding: "utf8", mode: 0o600 });
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
      let request: BrowserProviderRequest | null = null;
      try {
        const candidate = record(JSON.parse(data.slice(0, newline)));
        const call = parseBrowserOperationCall(candidate?.call);
        if (candidate?.protocol === SUPERCODE_BROWSER_PROVIDER_PROTOCOL &&
          typeof candidate.id === "string" && candidate.token === token && call) {
          request = {
            protocol: SUPERCODE_BROWSER_PROVIDER_PROTOCOL,
            id: candidate.id,
            token,
            call,
          };
        }
      } catch {
        request = null;
      }
      if (!request) {
        writeSocket(socket, { ok: false, error: "Invalid browser provider request" });
        return;
      }
      void this.dispatch(request.id, request.call)
        .then((result) => writeSocket(socket, {
          protocol: SUPERCODE_BROWSER_PROVIDER_PROTOCOL,
          id: request!.id,
          result,
        }))
        .catch((error: unknown) => writeSocket(socket, {
          protocol: SUPERCODE_BROWSER_PROVIDER_PROTOCOL,
          id: request!.id,
          result: {
            ok: false,
            operation: request!.call.operation,
            error: {
              code: "FAILED",
              message: error instanceof Error ? error.message : String(error),
            },
          },
        }));
    });
  }
}
