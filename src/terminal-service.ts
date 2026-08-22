import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { homedir } from "node:os";
import type { Duplex } from "node:stream";
import { TmuxTerminalHost, type TerminalAttachmentGrant, type TerminalSession } from "@volter-ai-dev/supercode-terminal";
import { WebSocketServer } from "ws";
import { shortCwd } from "./sessions.js";

export interface TerminalServiceSnapshot {
  available: boolean;
  sessions: TerminalSession[];
  attachment: (TerminalAttachmentGrant & { baseUrl: string }) | null;
  error: string | null;
}

export class LocalTerminalService {
  private readonly allowedOrigin: string;
  private readonly host: TmuxTerminalHost;
  private readonly server: Server;
  private readonly sockets = new WebSocketServer({ noServer: true });
  private baseUrl = "";
  private attachment: TerminalServiceSnapshot["attachment"] = null;
  private error: string | null = null;

  constructor(allowedOrigin: string) {
    if (!/^(chrome|moz)-extension:\/\/[^/]+\/?$/.test(allowedOrigin)) {
      throw new Error("terminal service requires its native messaging extension origin");
    }
    this.allowedOrigin = allowedOrigin.endsWith("/")
      ? allowedOrigin.slice(0, -1)
      : allowedOrigin;
    this.host = new TmuxTerminalHost({ ownerId: "vibewaiting-native" });
    this.server = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    this.server.on("upgrade", (request, socket, head) => this.upgrade(request, socket, head));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("terminal server did not bind a local port");
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async snapshot(): Promise<TerminalServiceSnapshot> {
    try {
      const sessions = (await this.host.listSessions()).map((session) => ({
        ...session,
        cwd: shortCwd(session.cwd, homedir()) || null,
      }));
      this.error = null;
      return { attachment: this.attachment, available: true, error: null, sessions };
    } catch (error) {
      this.error = message(error);
      return { attachment: null, available: false, error: this.error, sessions: [] };
    }
  }

  async create(harness: "claude-code" | "codex", cwd: string): Promise<TerminalServiceSnapshot> {
    const program = harness === "claude-code" ? "claude" : "codex";
    const label = harness === "claude-code" ? "claude" : "codex";
    const session = await this.host.createSession({
      command: { program },
      cwd,
      name: `vibewaiting-${label}-${randomUUID().slice(0, 8)}`,
    });
    const grant = this.host.issueAttachment(session.id, { mode: "control" });
    this.attachment = { ...grant, baseUrl: this.baseUrl };
    return await this.snapshot();
  }

  async attach(sessionId: string, mode: "observe" | "control"): Promise<TerminalServiceSnapshot> {
    const grant = this.host.issueAttachment(sessionId, { mode });
    this.attachment = { ...grant, baseUrl: this.baseUrl };
    return await this.snapshot();
  }

  async close(sessionId: string): Promise<TerminalServiceSnapshot> {
    this.host.closeSession(sessionId);
    if (this.attachment) this.attachment = null;
    return await this.snapshot();
  }

  async dismiss(): Promise<TerminalServiceSnapshot> {
    this.attachment = null;
    return await this.snapshot();
  }

  async stop(): Promise<void> {
    this.attachment = null;
    this.host.dispose();
    for (const socket of this.sockets.clients) socket.terminate();
    this.sockets.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const origin = request.headers.origin ?? "";
    const url = new URL(request.url ?? "/", this.baseUrl);
    const attachmentId = url.searchParams.get("terminalId");
    if (
      url.pathname !== "/ws" ||
      !attachmentId ||
      origin !== this.allowedOrigin
    ) {
      socket.destroy();
      return;
    }
    this.sockets.handleUpgrade(request, socket, head, (webSocket) => {
      void this.host.attachSocket(attachmentId, webSocket).catch((error: unknown) => {
        if (webSocket.readyState === webSocket.OPEN) {
          webSocket.send(JSON.stringify({ message: message(error), type: "error" }));
          webSocket.close(1008, "terminal attachment rejected");
        }
      });
    });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
