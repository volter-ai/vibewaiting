import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { HarnessId, StructuredLaunch } from "@volter-ai-dev/supercode-harness-sdk";
import {
  TerminalWebSocketBridge,
  TmuxTerminalHost,
  type EmbeddedTerminalAttachmentGrant,
  type TerminalSession,
} from "@volter-ai-dev/supercode-terminal";
import { shortCwd } from "./sessions.js";

export interface TerminalServiceSnapshot {
  available: boolean;
  canOpenLocal: boolean;
  sessions: TerminalSession[];
  attachment: (EmbeddedTerminalAttachmentGrant & { sessionId: string }) | null;
  error: string | null;
}

export class LocalTerminalService {
  private readonly allowedOrigin: string;
  private readonly host: TmuxTerminalHost;
  private readonly bridge: TerminalWebSocketBridge;
  private attachment: TerminalServiceSnapshot["attachment"] = null;
  private error: string | null = null;

  private attachmentFor(
    sessionId: string,
    mode: "observe" | "control",
  ): NonNullable<TerminalServiceSnapshot["attachment"]> {
    return { ...this.bridge.issueAttachment(sessionId, { mode }), sessionId };
  }

  constructor(allowedOrigin: string) {
    if (!/^(chrome|moz)-extension:\/\/[^/]+\/?$/.test(allowedOrigin)) {
      throw new Error("terminal service requires its native messaging extension origin");
    }
    this.allowedOrigin = allowedOrigin.endsWith("/")
      ? allowedOrigin.slice(0, -1)
      : allowedOrigin;
    this.host = new TmuxTerminalHost({ ownerId: "vibewaiting-native" });
    this.bridge = new TerminalWebSocketBridge({
      host: this.host,
      allowedOrigins: this.allowedOrigin,
    });
  }

  async start(): Promise<void> {
    await this.bridge.start();
  }

  async snapshot(): Promise<TerminalServiceSnapshot> {
    try {
      const sessions = (await this.host.listSessions()).map((session) => ({
        ...session,
        cwd: shortCwd(session.cwd, homedir()) || null,
      }));
      this.error = null;
      return {
        attachment: this.attachment,
        available: true,
        canOpenLocal: process.platform === "darwin",
        error: null,
        sessions,
      };
    } catch (error) {
      this.error = message(error);
      return {
        attachment: null,
        available: false,
        canOpenLocal: process.platform === "darwin",
        error: this.error,
        sessions: [],
      };
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
    this.attachment = this.attachmentFor(session.id, "control");
    return await this.snapshot();
  }

  async launchSession(
    harness: HarnessId,
    launch: StructuredLaunch,
  ): Promise<TerminalServiceSnapshot> {
    const label = harness === "claude-code" ? "claude" : harness;
    const session = await this.host.createSession({
      command: {
        program: launch.program,
        arguments: launch.arguments,
      },
      cwd: launch.cwd,
      env: launch.env,
      name: `vibewaiting-${label}-${randomUUID().slice(0, 8)}`,
    });
    this.attachment = this.attachmentFor(session.id, "control");
    return await this.snapshot();
  }

  async attach(sessionId: string, mode: "observe" | "control"): Promise<TerminalServiceSnapshot> {
    this.attachment = this.attachmentFor(sessionId, mode);
    return await this.snapshot();
  }

  async close(sessionId: string): Promise<TerminalServiceSnapshot> {
    this.host.closeSession(sessionId);
    if (this.attachment?.sessionId === sessionId) this.attachment = null;
    return await this.snapshot();
  }

  async openLocal(sessionId: string): Promise<TerminalServiceSnapshot> {
    await this.host.openLocalTerminal(sessionId);
    return await this.snapshot();
  }

  async dismiss(): Promise<TerminalServiceSnapshot> {
    this.attachment = null;
    return await this.snapshot();
  }

  async stop(): Promise<void> {
    this.attachment = null;
    this.host.dispose();
    await this.bridge.stop();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
