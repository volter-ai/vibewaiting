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
  NormalizedRuntimeEvent,
  ObservedRuntimeEvent,
  RuntimeCapabilities,
  RuntimeStartParams,
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
  readonly handle = {
    harness: "claude-code" as HarnessId,
    runtime_id: "runtime-1",
    endpoint: { kind: "local_process" as const, pid: 1234, command: ["fake"], protocol: "acp" },
  };
  closed = false;
  readonly sent: string[] = [];
  #sequence = 0;

  async sendInput(text: string): Promise<{ turn_id: string | null }> {
    if (this.closed) throw new Error("runtime closed");
    this.sent.push(text);
    return { turn_id: `turn-${this.sent.length}` };
  }

  async interrupt(): Promise<Record<string, never>> {
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
    this.emit("event", { ...event, sessionId: "session-1", sequence: this.#sequence } as ObservedRuntimeEvent);
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

export interface FakeHarnessClientOptions {
  harnesses?: LocalHarness[];
  runtime?: FakeRuntime;
  /** Make `startManagedRuntime` reject, to exercise the daemon's "could not start" path. */
  failStart?: string;
}

/** The `HarnessClientAdapter` surface, with everything this milestone does not use refusing loudly. */
export class FakeHarnessClient implements HarnessClientAdapter {
  readonly runtime: FakeRuntime;
  readonly harnesses: LocalHarness[];
  readonly startedWith: RuntimeStartParams[] = [];
  closeCalls = 0;
  #failStart: string | undefined;

  constructor(options: FakeHarnessClientOptions = {}) {
    this.harnesses = options.harnesses ?? [localHarness("claude-code"), localHarness("codex")];
    this.runtime = options.runtime ?? new FakeRuntime();
    this.#failStart = options.failStart;
  }

  async listHarnesses(): Promise<{ harnesses: LocalHarness[] }> {
    return { harnesses: this.harnesses };
  }

  async discover(): Promise<{ sessions: DiscoverableSessionDescriptor[] }> {
    return { sessions: [] };
  }

  session(): never {
    throw new Error("FakeHarnessClient.session is not part of this test");
  }

  async startManagedRuntime(params: RuntimeStartParams): Promise<never> {
    this.startedWith.push(params);
    if (this.#failStart) throw new Error(this.#failStart);
    return this.runtime as unknown as never;
  }

  async resumeManagedRuntime(): Promise<never> {
    throw new Error("FakeHarnessClient.resumeManagedRuntime is not part of this test");
  }

  async attachManagedRuntime(): Promise<never> {
    throw new Error("FakeHarnessClient.attachManagedRuntime is not part of this test");
  }

  async branchSession(): Promise<never> {
    throw new Error("FakeHarnessClient.branchSession is not part of this test");
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
