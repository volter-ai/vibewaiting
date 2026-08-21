import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ATTENTION_SETTLE_MS,
  DEFAULT_DISCOVER_INTERVAL_MS,
  DEFAULT_INTENT_POLL_MS,
  INTENT_QUEUE,
  bindIntentQueue,
  startDaemon,
  type AgentController,
  type Daemon,
  type WidgetBridge,
} from "../src/daemon.js";
import { DEFAULT_MAX_ENTRIES, DEFAULT_MAX_ENTRY_CHARS } from "../src/projection.js";
import type { ExportReceipt, WidgetState } from "../src/projection.js";
import type { MessengerPersistence, PersistedMessengerState } from "../src/persistence.js";
import { sessionKey } from "../src/sessions.js";
import { SupercodeController, type SupercodeClientSnapshot } from "@volter-ai-dev/supercode-client";
import type { SessionArtifact } from "@volter-ai-dev/supercode-harness-sdk";
import { FakeHarnessClient, FakeWidgetHost, descriptor, waitFor } from "./fakes.js";

const running: Daemon[] = [];

afterEach(async () => {
  while (running.length) await running.pop()?.stop();
});

interface Rig {
  daemon: Daemon;
  host: FakeWidgetHost;
  client: FakeHarnessClient;
  lastPush: () => WidgetState;
}

async function rig(options: { client?: FakeHarnessClient; harness?: string } = {}): Promise<Rig> {
  const client = options.client ?? new FakeHarnessClient();
  const host = new FakeWidgetHost();
  const daemon = await startDaemon({
    sessionId: "session-abc",
    html: "<!doctype html><html></html>",
    workspace: "/tmp/project",
    ...(options.harness ? { harness: options.harness } : {}),
    client,
    pushDebounceMs: 5,
    attachHost: async () => host,
  });
  running.push(daemon);
  return { daemon, host, client, lastPush: () => daemon.lastPushed() as WidgetState };
}

const OWN = descriptor({ sessionId: "runtime-1", cwd: "/tmp/project", title: "This window" });
const ATLAS = descriptor({
  sessionId: "atlas-1",
  cwd: "/home/dev/volter/atlas",
  title: "Rewrite the parser",
  text: "another window said this",
  updatedAtMs: 2_000_000,
});
const BRIDGE = descriptor({
  harness: "codex",
  sessionId: "bridge-1",
  cwd: "/home/dev/volter/bridge",
  title: "Bridge deploy",
  text: "codex over here",
  updatedAtMs: 1_500_000,
});

async function sessionRig(
  sessions: FakeHarnessClient["sessions"] = [OWN, ATLAS, BRIDGE],
  suppliedClient?: FakeHarnessClient,
  persistence?: MessengerPersistence,
  materializeArtifact?: (artifact: SessionArtifact) => Promise<ExportReceipt>,
): Promise<Rig> {
  const client = suppliedClient ?? new FakeHarnessClient({ sessions });
  const host = new FakeWidgetHost();
  const daemon = await startDaemon({
    sessionId: "session-abc",
    html: "<html></html>",
    workspace: "/tmp/project",
    client,
    pushDebounceMs: 5,
    home: "/home/dev",
    now: () => 2_000_000,
    attachHost: async () => host,
    ...(persistence ? { persistence } : {}),
    ...(materializeArtifact ? { materializeArtifact } : {}),
  });
  running.push(daemon);
  return { daemon, host, client, lastPush: () => daemon.lastPushed() as WidgetState };
}

class MemoryPersistence implements MessengerPersistence {
  state: PersistedMessengerState = { attention: [], drafts: {} };

  async load(): Promise<PersistedMessengerState> {
    return structuredClone(this.state);
  }

  async save(state: PersistedMessengerState): Promise<void> {
    this.state = structuredClone(state);
  }
}

function brokenController(reason: string): AgentController {
  return {
    getSnapshot: () => ({}) as SupercodeClientSnapshot,
    subscribe: () => (): void => undefined,
    initialize: async () => { throw new Error(reason); },
    dispatch: async () => { throw new Error(reason); },
    close: async (): Promise<void> => undefined,
  };
}

function hangingController(): AgentController {
  return {
    ...brokenController("unused"),
    initialize: () => new Promise<SupercodeClientSnapshot>(() => undefined),
  };
}

async function failingAttachRig(): Promise<Rig> {
  const client = new FakeHarnessClient({ sessions: [OWN, ATLAS, BRIDGE] });
  const host = new FakeWidgetHost();
  const daemon = await startDaemon({
    sessionId: "session-abc",
    html: "<html></html>",
    workspace: "/tmp/project",
    client,
    pushDebounceMs: 5,
    attachTimeoutMs: 5,
    home: "/home/dev",
    now: () => 2_000_000,
    attachHost: async () => host,
    createController: ({ workspace }) => workspace === ATLAS.cwd
      ? hangingController()
      : new SupercodeController({ client, workspace, ownsClient: false }) as unknown as AgentController,
  });
  running.push(daemon);
  return { daemon, host, client, lastPush: () => daemon.lastPushed() as WidgetState };
}

describe("bridge invariants", () => {
  it("keeps large historical images out of state and resolves only a projected reference on demand", async () => {
    const largeUrl = `data:image/png;base64,${"A".repeat(300_000)}`;
    const snapshot = {
      schema: "supercode.client-state.v1",
      revision: 1,
      workspace: "/tmp/project",
      availability: "ready",
      operation: null,
      harnesses: [],
      sessions: [],
      activeSessionKey: null,
      activeHarness: "codex",
      activeSessionId: "history-1",
      activeSession: null,
      taskPlan: { source: "none", items: [], residue: [], observedAt: null },
      connection: { mode: "mirror", strategy: null, follow: "following", ownsRuntime: false, messaging: null },
      turn: { state: "idle", id: null, startedAt: null },
      conversation: [{ id: "message-1", kind: "message", role: "user", text: "inspect this", content: "inspect this", metadata: {}, visibility: "conversation", images: [{ id: "image-1", label: "history.png", url: largeUrl }] }],
      requests: [],
      availableActions: {},
      error: null,
      terminalLaunch: null,
      delivery: null,
      reductionReceipt: null,
    } as unknown as SupercodeClientSnapshot;
    const controller: AgentController = {
      getSnapshot: () => snapshot,
      subscribe: () => (): void => undefined,
      initialize: async () => snapshot,
      dispatch: async () => snapshot,
      close: async () => undefined,
    };
    const host = new FakeWidgetHost();
    const daemon = await startDaemon({
      sessionId: "session-images",
      html: "<html></html>",
      workspace: "/tmp/project",
      controller,
      attachHost: async () => host,
      discoverIntervalMs: 0,
      persistence: false,
    });
    running.push(daemon);

    const image = daemon.lastPushed()!.transcript[0]!.images![0]!;
    expect(image).toMatchObject({ label: "history.png", mediaType: "image/png", byteSize: 225_000, reference: expect.any(String) });
    expect(image.url).toBeUndefined();
    expect(JSON.stringify(host.pushes)).not.toContain("AAAAAA");

    await host.fireIntent(INTENT_QUEUE, { action: "resolveImage", requestId: "request-1", reference: image.reference });
    expect(host.pushes).toContainEqual({ imageResolution: expect.objectContaining({ requestId: "request-1", status: "resolved", dataUrl: largeUrl }) });

    await host.fireIntent(INTENT_QUEUE, { action: "resolveImage", requestId: "request-2", reference: "guessed" });
    expect(host.pushes).toContainEqual({ imageResolution: { requestId: "request-2", status: "failed", message: "This image is no longer in the visible transcript window." } });
  });

  it("drains the untrusted page queue at the messenger cadence without replaying an intent", async () => {
    let tick: (() => unknown) | null = null;
    let fallbackRegistered = false;
    let stopped = false;
    const host: WidgetBridge = {
      push: async () => undefined,
      onIntent: () => { fallbackRegistered = true; },
      every: (ms, fn) => {
        expect(ms).toBe(DEFAULT_INTENT_POLL_MS);
        tick = fn;
        return () => { stopped = true; };
      },
      drainIntentsWithContext: async () => [{
        items: [{ id: "stable-id", payload: { action: "send", text: "hello" } }],
      }],
      remove: async () => undefined,
    };
    const received: unknown[] = [];
    const stop = bindIntentQueue(host, INTENT_QUEUE, (intent) => { received.push(intent.payload); });

    await tick!();
    await tick!();
    stop();
    expect({ fallbackRegistered, stopped, received }).toEqual({
      fallbackRegistered: false,
      stopped: true,
      received: [{ action: "send", text: "hello" }],
    });
  });

  it("discovers usable conversations before a failing runtime handshake and retains its real identity", async () => {
    const client = new FakeHarnessClient({ sessions: [ATLAS], failStart: "native handshake failed" });
    const { host, lastPush } = await rig({ client, harness: "codex" });
    const phases = host.pushes.map((push) => (push as WidgetState).startup);
    expect(phases.indexOf("discovering")).toBeLessThan(phases.indexOf("starting"));
    expect(host.pushes.some((push) => (push as Partial<WidgetState>).harness === "codex")).toBe(true);
    expect(host.pushes.some((push) => (push as Partial<WidgetState>).sessions?.length === 1)).toBe(true);
    expect(lastPush()).toMatchObject({ startup: "ready", harness: "codex", error: expect.any(String) });
  });

  it("coalesces streamed revisions into a bounded wire payload", async () => {
    const { daemon, host, client, lastPush } = await rig();
    const before = host.pushes.length;
    for (let index = 0; index < DEFAULT_MAX_ENTRIES + 5; index += 1) {
      client.runtime.assistantMessage(`${index}:${"x".repeat(DEFAULT_MAX_ENTRY_CHARS + 50)}`);
    }
    await waitFor(() => lastPush().transcript.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await daemon.flush();

    expect(host.pushes.length - before).toBeLessThanOrEqual(2);
    expect(lastPush().transcript).toHaveLength(DEFAULT_MAX_ENTRIES);
    expect(JSON.stringify(lastPush()).length).toBeLessThan(DEFAULT_MAX_ENTRIES * (DEFAULT_MAX_ENTRY_CHARS + 500));
  });

  it("publishes a completed harness slice while coalescing the still-running inventory refresh", async () => {
    const { daemon, host, client } = await sessionRig([OWN, ATLAS]);
    for (let index = 0; index < 30; index += 1) client.runtime.assistantMessage(`${index}:${"x".repeat(1_000)}`);
    await waitFor(() => (daemon.lastPushed()?.transcript.length ?? 0) > 0);
    await daemon.flush();
    const fullBytes = JSON.stringify(daemon.lastPushed()).length;

    const originalDiscover = client.discover.bind(client);
    let globalCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    client.discover = async (query = {}) => {
      if (query.workspace !== undefined) return originalDiscover(query);
      globalCalls += 1;
      if (query.harnesses?.[0] === "codex") await gate;
      return originalDiscover(query);
    };
    client.sessions = [OWN, { ...ATLAS, updated_at_ms: (ATLAS.updated_at_ms ?? 0) + 1 }];
    const pushesBeforeRefresh = host.pushes.length;
    const tick = host.ticks.find((item) => item.ms === DEFAULT_DISCOVER_INTERVAL_MS);
    const first = Promise.resolve(tick?.fn());
    await waitFor(() => host.pushes.slice(pushesBeforeRefresh).some((push) =>
      (push as Partial<WidgetState>).sessions?.some((session) => session.updatedAt === 2_000_001) ?? false));
    const second = Promise.resolve(tick?.fn());
    expect(globalCalls).toBe(8);
    release();
    await Promise.all([first, second]);

    const patch = host.pushes.at(-1) as Record<string, unknown>;
    expect(globalCalls).toBe(8);
    expect(patch).not.toHaveProperty("transcript");
    expect(JSON.stringify(patch).length).toBeLessThan(fullBytes / 5);
  });
});

describe("messenger session state machine", () => {
  it("pages both global history and one long transcript without multiplying followers", async () => {
    const messages = Array.from({ length: 260 }, (_, index) => `message-${index}`);
    const long = descriptor({
      sessionId: "long-session",
      cwd: "/home/dev/volter/long",
      title: null,
      latestMessageCandidates: [
        {
          role: "user",
          content: "<local-command-caveat>runtime context</local-command-caveat>",
          metadata: { isMeta: "true" },
        },
        { role: "assistant", content: "The transcript list is fast now", metadata: {} },
      ],
      messages,
      messageCount: messages.length,
      updatedAtMs: 3_000_000,
    });
    const history = [long, ...Array.from({ length: 64 }, (_, index) => descriptor({
      sessionId: `history-${index}`,
      cwd: `/home/dev/history/project-${index}`,
      updatedAtMs: 2_000_000 - index,
    }))];
    const { daemon, host, client, lastPush } = await sessionRig(history);

    expect(lastPush().sessions).toHaveLength(30);
    expect(lastPush().sessions[0]?.preview).toBe("The transcript list is fast now");
    await host.fireIntent(INTENT_QUEUE, { action: "loadSessions" });
    await host.fireIntent(INTENT_QUEUE, { action: "loadSessions" });
    expect(lastPush().sessions).toHaveLength(65);

    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(long.locator) });
    expect(lastPush().transcript).toHaveLength(120);
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(long.locator) });
    expect(lastPush()).toMatchObject({ mode: "mirror", attached: { key: sessionKey(long.locator) } });
    expect(client.activeFollows).toBe(1);
    await host.fireIntent(INTENT_QUEUE, { action: "loadEarlier" });
    await host.fireIntent(INTENT_QUEUE, { action: "loadEarlier" });
    await daemon.flush();
    expect(lastPush().transcript).toHaveLength(260);
    expect(lastPush().history.hasEarlier).toBe(false);
    expect(client.activeFollows).toBe(1);
  });

  it("messages a proven live peer without taking ownership or fabricating a local transcript row", async () => {
    const live = descriptor({
      sessionId: "live-1",
      cwd: "/home/dev/volter/live",
      liveEndpoint: "cc-peer:v1:4242:live-1:%2Ftmp%2Fpeer.sock",
      liveStatus: "busy",
    });
    const { daemon, host, client, lastPush } = await sessionRig([OWN, live]);
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(live.locator) });
    await host.fireIntent(INTENT_QUEUE, { action: "send", text: "please wrap up" });
    await daemon.flush();

    expect(daemon.activeController().getSnapshot().connection).toMatchObject({
      mode: "mirror",
      messaging: "live_peer",
    });
    expect(client.messages).toEqual([{ locator: live.locator, text: "please wrap up" }]);
    expect(lastPush().transcript.some((entry) => entry.text === "please wrap up")).toBe(false);
  });

  it("retains a resumed conversation across switching and closes it only with the daemon", async () => {
    const { daemon, host, client, lastPush } = await sessionRig();
    const atlasKey = sessionKey(ATLAS.locator);
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: atlasKey });
    const lifecycleStart = host.pushes.length;
    await host.fireIntent(INTENT_QUEUE, { action: "resume" });
    const lifecycle = host.pushes.slice(lifecycleStart) as Array<Record<string, unknown>>;
    const acceptedAt = lifecycle.findIndex((patch) => typeof patch.bridgeAck === "string");
    const completionAt = lifecycle.findIndex((patch) => patch.bridgeDone === lifecycle[acceptedAt]?.bridgeAck);
    expect(acceptedAt).toBeGreaterThanOrEqual(0);
    expect(completionAt).toBeGreaterThan(acceptedAt);
    const continued = daemon.activeController();
    const context = [{ id: "readme", kind: "file", label: "README.md", detail: "# Contract\nKeep the UI modular." }];
    const images = [{ id: "diagram", label: "architecture.png", url: "data:image/png;base64,aGVsbG8=" }];
    await host.fireIntent(INTENT_QUEUE, { action: "send", text: "", context, images });
    expect(continued.getSnapshot().conversation).toContainEqual(expect.objectContaining({
      kind: "message",
      role: "user",
      text: "",
      context,
      images,
    }));
    await host.fireIntent(INTENT_QUEUE, { action: "release" });

    client.resumedRuntimes[0]?.assistantMessage("background result");
    await waitFor(() => continued.getSnapshot().conversation.some(
      (entry) => entry.kind === "message" && entry.text === "background result",
    ));
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: atlasKey });
    await daemon.flush();
    expect(daemon.activeController()).toBe(continued);
    expect(lastPush().transcript.some((entry) => entry.text === "background result")).toBe(true);

    await daemon.stop();
    running.length = 0;
    expect(client.resumedRuntimes[0]?.closed).toBe(true);
  });

  it("branches a mirror and rekeys the retained controller when its native session appears", async () => {
    const { daemon, host, client, lastPush } = await sessionRig();
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(ATLAS.locator) });
    await host.fireIntent(INTENT_QUEUE, { action: "branch", targetHarness: "codex" });
    const branch = daemon.activeController();
    const persisted = descriptor({
      harness: "codex",
      sessionId: "started-2",
      cwd: ATLAS.cwd,
      updatedAtMs: 2_000_001,
    });
    client.sessions.push(persisted);
    await daemon.refreshSessions();
    await host.fireIntent(INTENT_QUEUE, { action: "release" });
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(persisted.locator) });

    expect(client.branchedWith).toEqual([{ locator: ATLAS.locator, target_harness: "codex" }]);
    expect(daemon.activeController()).toBe(branch);
    expect(lastPush()).toMatchObject({ mode: "control", strategy: "branch", harness: "codex" });
  });

  it("starts reduced continuation only from a verified reversible receipt", async () => {
    const { daemon, host, client, lastPush } = await sessionRig();
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(ATLAS.locator) });
    await host.fireIntent(INTENT_QUEUE, { action: "reduce", targetHarness: "codex" });
    await daemon.flush();

    expect(client.reducedWith).toEqual([{ locator: ATLAS.locator, target_harness: "codex" }]);
    expect(client.startedRuntimes.at(-1)?.sent).toHaveLength(1);
    expect(lastPush()).toMatchObject({
      mode: "control",
      strategy: "reduce",
      reductionReceipt: {
        sourceTokens: 100_000,
        reducedTokens: 10_000,
        verified: true,
        reversible: true,
        targetHarness: "codex",
      },
    });
  });

  it("joins and detaches from a controller-proven endpoint without stopping its peer", async () => {
    const shared = descriptor({
      sessionId: "shared-1",
      cwd: "/home/dev/volter/shared",
      liveEndpoint: "supercode-live://fake/shared-1",
      liveStatus: "idle",
    });
    const { daemon, host, client, lastPush } = await sessionRig([OWN, shared]);
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(shared.locator) });
    await host.fireIntent(INTENT_QUEUE, { action: "join" });
    expect(lastPush()).toMatchObject({ mode: "control", strategy: "attach", canDetach: true });
    await host.fireIntent(INTENT_QUEUE, { action: "detach" });
    await daemon.flush();

    expect(client.attachedWith).toHaveLength(1);
    expect(client.attachedRuntimes[0]?.closed).toBe(true);
    expect(lastPush()).toMatchObject({ mode: "mirror", strategy: null, canAttach: true });
  });

  it("never materializes a lossy export", async () => {
    const client = new FakeHarnessClient({ sessions: [OWN, ATLAS] });
    client.exportSession = async (params): Promise<never> => ({
      artifact: {
        source_harness: params.locator.harness,
        target_harness: params.target_harness,
        session_id: params.locator.session_id,
        content: "lossy",
        suggested_filename: "lossy.jsonl",
        files: [],
        fidelity: "semantic",
        residue: ["native data omitted"],
      },
    }) as never;
    let materialized = false;
    const { daemon, host, lastPush } = await sessionRig(client.sessions, client, undefined, async () => {
      materialized = true;
      throw new Error("unreachable");
    });
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(ATLAS.locator) });
    await host.fireIntent(INTENT_QUEUE, { action: "export", targetHarness: "codex" });
    await daemon.flush();

    expect(materialized).toBe(false);
    expect(lastPush().exportReceipt).toBeNull();
    expect(lastPush().error).not.toBeNull();
  });

  it("persists a draft under its conversation across daemon and iframe replacement", async () => {
    const store = new MemoryPersistence();
    const first = await sessionRig([OWN, ATLAS], undefined, store);
    await first.host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(ATLAS.locator) });
    await first.host.fireIntent(INTENT_QUEUE, { action: "draft", text: "unfinished" });
    await first.daemon.stop();

    const second = await sessionRig([OWN, ATLAS], undefined, store);
    await second.host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(ATLAS.locator) });
    expect(second.lastPush().savedDraft).toBe("unfinished");
  });

  it("turns a timed-out attach into row state, then clears it without leaking followers", async () => {
    const { daemon, client, lastPush } = await failingAttachRig();
    await daemon.attach(sessionKey(ATLAS.locator));
    expect(lastPush().attachError).toMatchObject({ key: sessionKey(ATLAS.locator) });

    await Promise.all([
      daemon.attach(sessionKey(ATLAS.locator)),
      daemon.attach(sessionKey(BRIDGE.locator)),
    ]);
    await daemon.flush();
    expect(lastPush().attachError).toBeNull();
    expect(lastPush().attached?.key).toBe(sessionKey(BRIDGE.locator));
    expect(client.activeFollows).toBe(1);
  });

  it("does not turn heartbeat churn into unread attention and acknowledges settled growth", async () => {
    const { host, client, lastPush } = await sessionRig();
    client.sessions = [OWN, { ...ATLAS, updated_at_ms: 2_000_050 }, BRIDGE];
    await host.ticks.find((tick) => tick.ms === DEFAULT_DISCOVER_INTERVAL_MS)?.fn();
    expect(lastPush().attention).toEqual([]);

    const grown = { ...ATLAS, message_count: (ATLAS.message_count ?? 0) + 1 };
    client.sessions = [OWN, { ...grown, updated_at_ms: 2_000_000 - DEFAULT_ATTENTION_SETTLE_MS }, BRIDGE];
    await host.ticks.find((tick) => tick.ms === DEFAULT_DISCOVER_INTERVAL_MS)?.fn();
    const key = sessionKey(ATLAS.locator);
    expect(lastPush().attention).toContainEqual(expect.objectContaining({ key, kind: "unseen" }));

    await host.fireIntent(INTENT_QUEUE, { action: "ack", key });
    expect(lastPush().attention).toEqual([]);
  });

  it("marks completed conversations only while they are in the background", async () => {
    const { host, client, lastPush } = await sessionRig();
    client.sessions = [OWN, { ...ATLAS, updated_at_ms: 2_000_050 }, BRIDGE];
    await host.ticks.find((tick) => tick.ms === DEFAULT_DISCOVER_INTERVAL_MS)?.fn();
    expect(lastPush().attention).toEqual([]);

    const ownedKey = sessionKey(OWN.locator);
    await host.fireIntent(INTENT_QUEUE, { action: "panelVisible" });
    await host.fireIntent(INTENT_QUEUE, { action: "send", text: "visible task" });
    client.runtime.assistantMessage("visible result");
    client.runtime.turnCompleted();
    await waitFor(() => lastPush().busy === false);
    expect(lastPush().attention).toEqual([]);

    await host.fireIntent(INTENT_QUEUE, { action: "panelHidden" });
    await host.fireIntent(INTENT_QUEUE, { action: "send", text: "background task" });
    client.runtime.assistantMessage("background result");
    client.runtime.turnCompleted();
    await waitFor(() => lastPush().attention.some((item) => item.key === ownedKey));
    expect(lastPush().attention).toEqual([expect.objectContaining({ key: ownedKey, kind: "finished" })]);
    await host.fireIntent(INTENT_QUEUE, { action: "ack", key: ownedKey });

    const key = sessionKey(ATLAS.locator);
    await host.fireIntent(INTENT_QUEUE, { action: "panelVisible" });
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key });
    client.sessions = [OWN, { ...ATLAS, live_status: "busy" }, BRIDGE];
    await host.ticks.find((tick) => tick.ms === DEFAULT_DISCOVER_INTERVAL_MS)?.fn();
    client.sessions = [OWN, { ...ATLAS, live_status: "idle" }, BRIDGE];
    await host.ticks.find((tick) => tick.ms === DEFAULT_DISCOVER_INTERVAL_MS)?.fn();
    expect(lastPush().attention).toEqual([]);

    await host.fireIntent(INTENT_QUEUE, { action: "panelHidden" });
    client.sessions = [OWN, { ...ATLAS, live_status: "busy" }, BRIDGE];
    await host.ticks.find((tick) => tick.ms === DEFAULT_DISCOVER_INTERVAL_MS)?.fn();
    client.sessions = [OWN, { ...ATLAS, live_status: "idle" }, BRIDGE];
    await host.ticks.find((tick) => tick.ms === DEFAULT_DISCOVER_INTERVAL_MS)?.fn();
    expect(lastPush().attention).toContainEqual(expect.objectContaining({ key, kind: "finished" }));

    await host.fireIntent(INTENT_QUEUE, { action: "ack", key });
    expect(lastPush().attention).toEqual([]);
  });
});
