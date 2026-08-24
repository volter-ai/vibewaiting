import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  NativeTerminalSessionHost,
  type NativeSessionIdleProof,
} from "@termfleet/terminal/native-host.js";
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
  bindings: Array<{ conversationKey: string; sessionId: string }>;
  canOpenLocal: boolean;
  sessions: TerminalSession[];
  attachment: (EmbeddedTerminalAttachmentGrant & {
    conversationKey: string | null;
    sessionId: string;
  }) | null;
  error: string | null;
}

export class LocalTerminalService {
  private readonly allowedOrigin: string;
  private readonly host: TmuxTerminalHost;
  private readonly bridge: TerminalWebSocketBridge;
  private readonly nativeHost = new NativeTerminalSessionHost();
  private readonly nativeSessionIds = new Set<string>();
  private readonly conversationBySession = new Map<string, string>();
  private readonly pendingInitialInputs = new Map<
    string,
    { abort: AbortController; task: Promise<void> }
  >();
  private attachment: TerminalServiceSnapshot["attachment"] = null;
  private error: string | null = null;

  private attachmentFor(
    sessionId: string,
    mode: "observe" | "control",
  ): NonNullable<TerminalServiceSnapshot["attachment"]> {
    return {
      ...this.bridge.issueAttachment(sessionId, { mode }),
      conversationKey: this.conversationBySession.get(sessionId) ?? null,
      sessionId,
    };
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
      const ownedSessions = await this.host.listSessions();
      const sessions = ownedSessions.map((session) => ({
        ...session,
        cwd: shortCwd(session.cwd, homedir()) || null,
      }));
      this.conversationBySession.clear();
      for (const session of sessions) {
        if (session.contextKey)
          this.conversationBySession.set(session.id, session.contextKey);
      }
      return {
        attachment: this.attachment,
        available: true,
        bindings: [...this.conversationBySession].map(
          ([sessionId, conversationKey]) => ({ conversationKey, sessionId }),
        ),
        canOpenLocal: process.platform === "darwin",
        error: this.error,
        sessions,
      };
    } catch (error) {
      this.error = message(error);
      return {
        attachment: null,
        available: false,
        bindings: [],
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
    conversationKey: string | null = null,
    initialInput?: string,
  ): Promise<TerminalServiceSnapshot> {
    this.error = null;
    const label = harness === "claude-code" ? "claude" : harness;
    const session = await this.host.createSession({
      command: {
        program: launch.program,
        arguments: launch.arguments,
      },
      ...(conversationKey ? { contextKey: conversationKey } : {}),
      cwd: launch.cwd,
      env: launch.env,
      name: `vibewaiting-${label}-${randomUUID().slice(0, 8)}`,
    });
    if (session.contextKey)
      this.conversationBySession.set(session.id, session.contextKey);
    this.attachment = this.attachmentFor(session.id, "control");
    if (initialInput !== undefined)
      this.queueInitialInput(session.id, harness, initialInput);
    return await this.snapshot();
  }

  private queueInitialInput(sessionId: string, harness: HarnessId, input: string): void {
    const abort = new AbortController();
    const task = (async () => {
      const deadline = Date.now() + 5 * 60_000;
      while (!abort.signal.aborted && Date.now() < deadline) {
        const content = this.host.capture(sessionId, { lines: 80 });
        if (nativeComposerReady(harness, content)) {
          if (harness === "codex")
            await this.submitCodexInitialInput(sessionId, input, abort.signal);
          else
            await this.host.sendInput(sessionId, input, {
              deadlineMs: Date.now() + 15_000,
              submitMode: "retry",
            });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!abort.signal.aborted)
        throw new Error(`${harness} did not reach its input prompt`);
    })().catch((error: unknown) => {
      if (!abort.signal.aborted)
        this.error = `initial terminal message was not delivered: ${message(error)}`;
    }).finally(() => {
      if (this.pendingInitialInputs.get(sessionId)?.task === task)
        this.pendingInitialInputs.delete(sessionId);
    });
    this.pendingInitialInputs.set(sessionId, { abort, task });
  }

  private async submitCodexInitialInput(
    sessionId: string,
    input: string,
    signal: AbortSignal,
  ): Promise<void> {
    // Current Codex can expose and accept text in its composer while the selected model still says
    // "loading". An Enter sent during that interval is ignored. Insert the text exactly once, then
    // retry only the submit key until the TUI proves that the turn left the composer.
    await this.host.sendInput(sessionId, input, {
      deadlineMs: Date.now() + 15_000,
      submitMode: "single",
    });
    const deadline = Date.now() + 60_000;
    let sawPrompt = false;
    while (!signal.aborted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const content = this.host.capture(sessionId, { lines: 100 });
      const state = codexInitialInputState(content, input);
      sawPrompt ||= state.promptVisible;
      if (state.turnStarted || (sawPrompt && state.emptyComposerVisible)) return;
      await this.host.sendInput(sessionId, "\n", {
        deadlineMs: Date.now() + 15_000,
        // Termfleet's retry form sends tmux's named Enter key. Current Codex distinguishes it
        // from C-m during model startup when an xterm client is attached.
        submitMode: "retry",
      });
    }
    if (!signal.aborted)
      throw new Error("codex accepted the initial terminal text but did not start the turn");
  }

  canMoveSession(harness: HarnessId, sessionId: string, cwd: string): boolean {
    const agentSessionId = nativeAgentSessionId(harness, sessionId);
    return this.nativeSessionIds.has(agentSessionId)
      || this.nativeHost.hasSessionCandidate(agentSessionId, { cwd });
  }

  async refreshNativeSessions(): Promise<void> {
    const sessions = await this.nativeHost.listSessions();
    this.nativeSessionIds.clear();
    for (const session of sessions)
      this.nativeSessionIds.add(session.agentSessionId);
  }

  async moveSession(
    harness: HarnessId,
    nativeSessionId: string,
    launch: StructuredLaunch,
    conversationKey: string,
    proof: NativeSessionIdleProof,
  ): Promise<TerminalServiceSnapshot> {
    const agentSessionId = nativeAgentSessionId(harness, nativeSessionId);
    if (!this.nativeSessionIds.has(agentSessionId)) {
      throw new Error("this conversation is not running in a local terminal visible to Vibewaiting");
    }
    await this.nativeHost.relinquishSession(agentSessionId, proof);
    this.nativeSessionIds.delete(agentSessionId);
    return await this.launchSession(harness, launch, conversationKey);
  }

  async prepareMoveSession(
    harness: HarnessId,
    nativeSessionId: string,
    cwd: string,
    proof: NativeSessionIdleProof | null,
  ): Promise<NativeSessionIdleProof | null> {
    const agentSessionId = nativeAgentSessionId(harness, nativeSessionId);
    if (proof && this.nativeSessionIds.has(agentSessionId)) return proof;
    const resolution = await this.nativeHost.resolveSession(agentSessionId, { cwd });
    if (!resolution) return null;
    this.nativeSessionIds.add(resolution.session.agentSessionId);
    return resolution.proof;
  }

  async attach(sessionId: string, mode: "observe" | "control"): Promise<TerminalServiceSnapshot> {
    this.attachment = this.attachmentFor(sessionId, mode);
    return await this.snapshot();
  }

  async bindContext(sessionId: string, conversationKey: string): Promise<TerminalServiceSnapshot> {
    await this.host.bindContext(sessionId, conversationKey);
    this.conversationBySession.set(sessionId, conversationKey);
    if (this.attachment?.sessionId === sessionId) {
      this.attachment = { ...this.attachment, conversationKey };
    }
    return await this.snapshot();
  }

  async close(sessionId: string): Promise<TerminalServiceSnapshot> {
    this.pendingInitialInputs.get(sessionId)?.abort.abort();
    this.pendingInitialInputs.delete(sessionId);
    this.host.closeSession(sessionId);
    this.conversationBySession.delete(sessionId);
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
    for (const pending of this.pendingInitialInputs.values()) pending.abort.abort();
    await Promise.allSettled([...this.pendingInitialInputs.values()].map(({ task }) => task));
    this.pendingInitialInputs.clear();
    this.host.dispose();
    await this.bridge.stop();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nativeAgentSessionId(harness: HarnessId, sessionId: string): string {
  if (harness === "claude-code") return `claude:${sessionId}`;
  if (harness === "codex") return `codex:${sessionId}`;
  throw new Error(`${harness} native terminal handoff is not supported`);
}

function nativeComposerReady(harness: HarnessId, content: string): boolean {
  if (harness === "codex") return content.includes("› Ask Codex to do anything");
  if (harness === "claude-code") return /(?:^|\n)❯\s/u.test(content);
  return false;
}

function codexInitialInputState(
  content: string,
  input: string,
): { emptyComposerVisible: boolean; promptVisible: boolean; turnStarted: boolean } {
  const firstLine = input.replace(/(?:\r\n|\n|\r)$/u, "").split(/\r?\n/u, 1)[0] ?? "";
  const marker = `› ${firstLine.slice(0, 24)}`;
  const promptAt = marker.length > 2 ? content.lastIndexOf(marker) : -1;
  const emptyComposerAt = content.lastIndexOf("› Ask Codex to do anything");
  const tail = promptAt >= 0 ? content.slice(promptAt + marker.length) : "";
  return {
    // xterm attachment/resizes can leave the pre-input screen in tmux history. Only a composer
    // rendered after the submitted prompt proves that the prompt has left the active editor.
    emptyComposerVisible: emptyComposerAt > promptAt,
    promptVisible: promptAt >= 0,
    turnStarted: promptAt >= 0 && /(?:^|\n)\s*[•◦✦⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s/u.test(tail),
  };
}
