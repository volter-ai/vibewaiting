// Test doubles for the two ends of the bridge.
//
// The harness client is faked at the SDK boundary the client package itself documents as injectable
// ("accepts the low-level client by injection"), so the daemon tests drive the REAL
// `SupercodeController` — its capability derivation, turn state machine, and conversation
// projection are part of what is under test, not something re-implemented here.
import { EventEmitter } from "node:events";
import type {
  DiscoverableSessionDescriptor,
  HarnessClientAdapter,
} from "@volter-ai-dev/supercode-client";
import type {
  HarnessId,
  LocalHarness,
  ManagedSession,
  NormalizedRuntimeEvent,
  NormalizedSession,
  ObservedRuntimeEvent,
  RuntimeCapabilities,
  RuntimeAttachExistingParams,
  RuntimeResumeParams,
  RuntimeStartParams,
  SessionDescriptor,
  SessionFormat,
  SessionLocator,
  SessionMessageResult,
  SessionWatchEvent,
} from "@volter-ai-dev/supercode-harness-sdk";
import type { WidgetBridge } from "../src/daemon.js";

const ALL_CAPABILITIES: RuntimeCapabilities = {
  start_session: true,
  resume_session: true,
  attach_existing_process: false,
  send_input: true,
  stream_events: true,
  interrupt: true,
  respond_to_requests: true,
};

export function localHarness(id: HarnessId, over: Partial<LocalHarness> = {}): LocalHarness {
  return {
    id,
    display_name: id,
    supported: true,
    installed: true,
    executable: `/usr/local/bin/${id}`,
    version: "1.0.0",
    auth: "ready",
    runtime: "ready",
    protocol: "acp",
    capabilities: ALL_CAPABILITIES,
    effective_capabilities: ALL_CAPABILITIES,
    sessions: { global: 0, workspace: 0 },
    reason: null,
    repair: null,
    ...over,
  };
}

/** A live runtime the test scripts by hand: it records input and emits the events it is told to. */
export class FakeRuntime extends EventEmitter {
  readonly connection = "fake-connection";
  readonly handle: {
    harness: HarnessId;
    runtime_id: string;
    endpoint: { kind: "local_process"; pid: number; command: string[]; protocol: "acp" };
  };
  closed = false;
  readonly sent: string[] = [];
  interrupts = 0;
  #sequence = 0;

  constructor(harness: HarnessId = "claude-code", runtimeId = "runtime-1") {
    super();
    this.handle = {
      harness,
      runtime_id: runtimeId,
      endpoint: { kind: "local_process", pid: 1234, command: ["fake"], protocol: "acp" },
    };
  }

  async sendInput(text: string): Promise<{ turn_id: string | null }> {
    if (this.closed) throw new Error("runtime closed");
    this.sent.push(text);
    return { turn_id: `turn-${this.sent.length}` };
  }

  async interrupt(): Promise<Record<string, never>> {
    this.interrupts += 1;
    return {};
  }

  async respond(): Promise<Record<string, never>> {
    return {};
  }

  async close(): Promise<{ closed: boolean }> {
    this.closed = true;
    return { closed: true };
  }

  /** Emit one runtime event exactly as the SDK's managed runtime would (identity fields added here). */
  emitEvent(event: NormalizedRuntimeEvent): void {
    this.#sequence += 1;
    this.emit("event", { ...event, sessionId: this.handle.runtime_id, sequence: this.#sequence } as ObservedRuntimeEvent);
  }

  assistantMessage(text: string): void {
    this.emitEvent({
      type: "message",
      kind: "message",
      role: "assistant",
      text,
      content: text,
      metadata: {},
      payload: null,
      raw: { kind: "message", payload: null },
    });
  }

  turnCompleted(): void {
    this.emitEvent({
      type: "turn_completed",
      kind: "turn.completed",
      turnId: null,
      outcome: "completed",
      message: null,
      payload: null,
      raw: { kind: "turn.completed", payload: null },
    });
  }
}

/** A persisted session the fake box has on disk, in the shape global discovery returns. */
export function descriptor(over: {
  harness?: HarnessId;
  sessionId?: string;
  cwd?: string | null;
  title?: string | null;
  model?: string | null;
  updatedAtMs?: number | null;
  messageCount?: number | null;
  text?: string;
  liveEndpoint?: string | null;
  liveStatus?: "busy" | "idle" | null;
} = {}): SessionDescriptor & { text: string } {
  const harness = over.harness ?? "claude-code";
  const sessionId = over.sessionId ?? "sess-1";
  return {
    locator: {
      harness,
      session_id: sessionId,
      storage: { kind: "file", path: `/home/dev/.${harness}/${sessionId}.jsonl` },
    },
    cwd: over.cwd === undefined ? "/home/dev/projects/atlas" : over.cwd,
    title: over.title === undefined ? "Atlas refactor" : over.title,
    updated_at_ms: over.updatedAtMs === undefined ? 1_000_000 : over.updatedAtMs,
    message_count: over.messageCount === undefined ? 12 : over.messageCount,
    model: over.model === undefined ? "claude-opus-5" : over.model,
    ...(over.liveEndpoint !== undefined ? { live_endpoint: over.liveEndpoint } : {}),
    ...(over.liveStatus !== undefined ? { live_status: over.liveStatus } : {}),
    text: over.text ?? "hello from another window",
  };
}

export interface FakeHarnessClientOptions {
  harnesses?: LocalHarness[];
  runtime?: FakeRuntime;
  /** Make `startManagedRuntime` reject, to exercise the daemon's "could not start" path. */
  failStart?: string;
  /** What global discovery finds on this fake box. */
  sessions?: Array<SessionDescriptor & { text?: string }>;
}

/** The `HarnessClientAdapter` surface, with everything this milestone does not use refusing loudly. */
export class FakeHarnessClient implements HarnessClientAdapter {
  readonly runtime: FakeRuntime;
  readonly harnesses: LocalHarness[];
  readonly startedWith: RuntimeStartParams[] = [];
  readonly startedRuntimes: FakeRuntime[] = [];
  readonly resumedWith: RuntimeResumeParams[] = [];
  readonly resumedRuntimes: FakeRuntime[] = [];
  readonly attachedWith: RuntimeAttachExistingParams[] = [];
  readonly attachedRuntimes: FakeRuntime[] = [];
  readonly branchedWith: Array<{ locator: SessionLocator; target_harness?: SessionFormat }> = [];
  /** Persisted sessions on this fake box — what `discover` returns and `session()` can load/follow. */
  sessions: Array<SessionDescriptor & { text?: string }>;
  /** Every discovery query seen, so a test can prove the GLOBAL scan carries no workspace. */
  readonly discoverQueries: Array<{ workspace?: string; limit?: number }> = [];
  /** Followers currently streaming. The leak check: this must settle back to one attachment's worth. */
  activeFollows = 0;
  closeCalls = 0;
  readonly messages: Array<{ locator: SessionLocator; text: string }> = [];
  #failStart: string | undefined;

  constructor(options: FakeHarnessClientOptions = {}) {
    this.harnesses = options.harnesses ?? [localHarness("claude-code"), localHarness("codex")];
    this.runtime = options.runtime ?? new FakeRuntime();
    this.#failStart = options.failStart;
    this.sessions = options.sessions ?? [];
  }

  async listHarnesses(): Promise<{ harnesses: LocalHarness[] }> {
    return { harnesses: this.harnesses };
  }

  /** Global when `workspace` is absent (the Sessions panel), workspace-scoped when a controller asks. */
  async discover(query: { workspace?: string; limit?: number } = {}): Promise<{
    sessions: DiscoverableSessionDescriptor[];
  }> {
    this.discoverQueries.push(query);
    const scoped =
      query.workspace === undefined ? this.sessions : this.sessions.filter((s) => s.cwd === query.workspace);
    return { sessions: scoped.slice(0, query.limit ?? scoped.length).map(({ text: _text, ...rest }) => rest) };
  }

  session(locator: SessionLocator): ManagedSession {
    const found = this.sessions.find(
      (s) => s.locator.harness === locator.harness && s.locator.session_id === locator.session_id,
    );
    if (!found) throw new Error(`no such session: ${locator.harness}/${locator.session_id}`);
    return new FakeManagedSession(this, found) as unknown as ManagedSession;
  }

  async messageSession(locator: SessionLocator, text: string): Promise<SessionMessageResult> {
    this.messages.push({ locator, text });
    return {
      delivered_to_bus: true,
      target: {
        session_id: locator.session_id,
        name: "fake-live-peer",
        pid: 4242,
        cwd: "/home/dev/projects/atlas",
        status: "busy",
      },
      courier: { model: "haiku", report: "SENT" },
    };
  }

  async startManagedRuntime(params: RuntimeStartParams): Promise<never> {
    this.startedWith.push(params);
    if (this.#failStart) throw new Error(this.#failStart);
    const runtime = this.startedWith.length === 1
      ? this.runtime
      : new FakeRuntime(params.harness, `started-${this.startedWith.length}`);
    this.startedRuntimes.push(runtime);
    return runtime as unknown as never;
  }

  async resumeManagedRuntime(params: RuntimeResumeParams): Promise<never> {
    this.resumedWith.push(params);
    const runtime = new FakeRuntime(params.harness, params.runtime_id);
    this.resumedRuntimes.push(runtime);
    return runtime as unknown as never;
  }

  async attachManagedRuntime(params: RuntimeAttachExistingParams): Promise<never> {
    this.attachedWith.push(params);
    const runtime = new FakeRuntime(params.harness, params.runtime_id);
    this.attachedRuntimes.push(runtime);
    return runtime as unknown as never;
  }

  async branchSession(params: { locator: SessionLocator; target_harness?: SessionFormat }): Promise<never> {
    this.branchedWith.push(params);
    const source = await this.session(params.locator).load();
    return {
      parent: params.locator,
      session: source,
      bootstrap_prompt: "Continue this imported conversation without losing context.",
    } as never;
  }

  async importSession(): Promise<never> {
    throw new Error("FakeHarnessClient.importSession is not part of this test");
  }

  async exportSession(): Promise<never> {
    throw new Error("FakeHarnessClient.exportSession is not part of this test");
  }

  async translateSession(): Promise<never> {
    throw new Error("FakeHarnessClient.translateSession is not part of this test");
  }

  async handoffSession(): Promise<never> {
    throw new Error("FakeHarnessClient.handoffSession is not part of this test");
  }

  async resumeInstructions(): Promise<never> {
    throw new Error("FakeHarnessClient.resumeInstructions is not part of this test");
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

/**
 * The passive half of the transport: load a persisted transcript, then stream it until the follower
 * is aborted. The daemon's mirror is a real `SupercodeController` driving exactly this, so the
 * "does a second attach leak a follower?" question is answered by `activeFollows`, not by a comment.
 */
class FakeManagedSession {
  readonly #client: FakeHarnessClient;
  readonly #record: SessionDescriptor & { text?: string };

  constructor(client: FakeHarnessClient, record: SessionDescriptor & { text?: string }) {
    this.#client = client;
    this.#record = record;
  }

  get locator(): SessionLocator {
    return this.#record.locator;
  }

  async load(): Promise<NormalizedSession> {
    return this.#session();
  }

  async *follow(options: { signal?: AbortSignal } = {}): AsyncGenerator<SessionWatchEvent> {
    this.#client.activeFollows += 1;
    try {
      yield { type: "session_snapshot", sequence: 1, reason: "initial", session: this.#session() };
      const { signal } = options;
      await new Promise<void>((resolve) => {
        if (!signal || signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    } finally {
      this.#client.activeFollows -= 1;
    }
  }

  #session(): NormalizedSession {
    return {
      source: "claude_code",
      session_id: this.#record.locator.session_id,
      model: this.#record.model,
      cwd: this.#record.cwd,
      system_prompt: null,
      agent_id: null,
      parent_tool_use_id: null,
      lineage: {},
      messages: [{ role: "assistant", content: this.#record.text ?? "…", metadata: {} }],
      subagents: [],
      raw_record_count: 1,
      parse_error_lines: 0,
      fidelity: "semantic",
      residue: [],
    };
  }
}

/** A `WidgetBridge` that records pushes and lets the test fire intents the way the host's drain would. */
export class FakeWidgetHost implements WidgetBridge {
  readonly pushes: unknown[] = [];
  readonly handlers = new Map<string, (i: { id: string | number; payload: unknown }) => void | Promise<void>>();
  removed = 0;
  #intentId = 0;

  async push(patch: unknown): Promise<void> {
    this.pushes.push(patch);
  }

  onIntent(name: string, cb: (i: { id: string | number; payload: unknown }) => void | Promise<void>): void {
    this.handlers.set(name, cb);
  }

  /** Recorded `every` registrations — the daemon's re-push heartbeat lands here; tests tick manually. */
  readonly ticks: Array<{ ms: number; fn: () => unknown; stopped: boolean }> = [];

  every(ms: number, fn: () => unknown): () => void {
    const entry = { ms, fn, stopped: false };
    this.ticks.push(entry);
    return () => {
      entry.stopped = true;
    };
  }

  async remove(): Promise<void> {
    this.removed += 1;
  }

  /** Deliver one queued intent, exactly as `WidgetHost`'s drain tick does. */
  async fireIntent(name: string, payload: unknown): Promise<void> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`no handler for intent queue '${name}'`);
    this.#intentId += 1;
    await handler({ id: this.#intentId, payload });
  }
}

/** Poll until `predicate` holds — the controller applies runtime events through its own async queue. */
export async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
