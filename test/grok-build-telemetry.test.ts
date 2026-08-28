import { describe, expect, it, vi } from "vitest";
import {
  GrokBuildSignalTracker,
  GrokBuildTelemetryClient,
  GrokBuildTelemetryLifecycle,
  createInitialGrokBuildSignals,
} from "../experiments/browser-agent/src/grok-build-telemetry.js";

describe("Grok Build browser telemetry source port", () => {
  it("creates the native startup signals payload", () => {
    expect(createInitialGrokBuildSignals()).toMatchObject({
      clientType: "agent",
      totalTurns: 0,
      userMessageCount: 0,
      assistantMessageCount: 0,
      toolCallCount: 0,
      toolFailureCount: 0,
      compactionCount: 0,
      modelsUsed: ["grok-4.6"],
      primaryModelId: "grok-4.6",
      inferenceIdleTimeoutConfiguredSecs: 3600,
      doomLoopRecoveryFired: false,
      gcsQueuePendingBytes: 0,
    });
  });

  it("tracks native session counters and stable tool discovery order", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000);
    const tracker = new GrokBuildSignalTracker();
    tracker.record({ type: "run_start", task: "Build Pong" });
    tracker.record({ type: "assistant", turn: 1, text: "working", reasoning: "" });
    tracker.record({ type: "tool_end", turn: 1, call: { callId: "a", name: "read_file", arguments: "{}" }, result: { output: "ok" } });
    tracker.record({ type: "tool_end", turn: 2, call: { callId: "b", name: "write", arguments: "{}" }, result: { output: "failed", isError: true } });
    tracker.record({ type: "compaction_end", tokens: 10, compactions: 1 });
    tracker.record({ type: "complete", turn: 2, text: "done" });
    expect(tracker.snapshot(4_900)).toMatchObject({
      totalTurns: 1,
      userMessageCount: 1,
      assistantMessageCount: 1,
      toolCallCount: 2,
      toolFailureCount: 1,
      compactionCount: 1,
      sessionDurationSeconds: 3,
      toolsUsed: ["read_file", "write"],
    });
    vi.restoreAllMocks();
  });

  it("builds native per-turn deltas from foreground responses only", () => {
    let now = 1_000;
    const tracker = new GrokBuildSignalTracker("grok-4.6", () => now);
    tracker.record({ type: "run_start", task: "Build Pong" });
    tracker.record({
      type: "response_end",
      kind: "session-title",
      response: { usage: { output_tokens: 99 } },
      metrics: { timeToFirstTokenMs: 1, timeToLastByteMs: 2, chunkCount: 2, itlIntervalsMs: [1], attempts: 1 },
    });
    tracker.record({
      type: "response_end",
      kind: "foreground",
      response: {
        usage: { total_tokens: 50_000, output_tokens: 30, output_tokens_details: { reasoning_tokens: 20 } },
        metadata: { system_fingerprint: "fp_source" },
      },
      metrics: { timeToFirstTokenMs: 100, timeToLastByteMs: 500, chunkCount: 3, itlIntervalsMs: [10, 30], attempts: 1 },
    });
    tracker.record({ type: "assistant", turn: 1, text: "working", reasoning: "" });
    tracker.record({ type: "tool_end", turn: 1, call: { callId: "a", name: "read_file", arguments: "{}" }, result: { output: "ok" } });
    now = 2_500;
    expect(tracker.takeTurnDelta("completed", "request-1")).toMatchObject({
      turnNumber: 1,
      deltaToolCalls: 1,
      deltaSuccessfulToolUses: 1,
      deltaAssistantMessages: 1,
      timeToFirstTokenMs: 100,
      totalResponseTimeMs: 500,
      itlP50Ms: 30,
      contextWindowUsage: 10,
      responseTokens: 10,
      thinkingTokens: 20,
      modelFingerprint: "fp_source",
      requestId: "request-1",
      toolsUsedThisTurn: ["read_file"],
      toolOutcomes: '[{"toolName":"read_file","successes":1,"failures":0}]',
    });
    expect(tracker.snapshot()).toMatchObject({ latencySampleCount: 1, totalChunkCount: 3, itlSampleCount: 1 });
  });

  it("runs initial, periodic, turn-delta, and final lifecycle calls without blocking events", async () => {
    const calls: string[] = [];
    const client = {
      loadFeedbackConfig: async () => { calls.push("config"); return { config_id: "v1", config_version: 1, enabled: false }; },
      updateSignals: async (_id: string, body: Record<string, unknown>) => { calls.push(`signals:${body.totalTurns}`); },
      sendTurnDelta: async (_id: string, body: Record<string, unknown>) => { calls.push(`delta:${body.turnNumber}`); },
    } as unknown as GrokBuildTelemetryClient;
    let tick: (() => void) | undefined;
    const lifecycle = new GrokBuildTelemetryLifecycle("11111111-1111-4111-8111-111111111111", {
      client,
      setInterval: ((callback: TimerHandler) => { tick = callback as () => void; return 1; }) as typeof setInterval,
      clearInterval: vi.fn() as typeof clearInterval,
    });
    lifecycle.start();
    await lifecycle.ready();
    lifecycle.record({ type: "run_start", task: "task" }, "request");
    tick?.();
    lifecycle.record({ type: "complete", turn: 1, text: "done" }, "request");
    await lifecycle.flush();
    await lifecycle.shutdown();
    expect(calls).toEqual(["config", "signals:0", "signals:1", "delta:1", "signals:1"]);
  });

  it("can stop after an explicitly completed final sync without sending it twice", async () => {
    const signals: number[] = [];
    const client = {
      loadFeedbackConfig: async () => ({ config_id: "v1", config_version: 1, enabled: false }),
      updateSignals: async (_id: string, body: Record<string, unknown>) => { signals.push(Number(body.totalTurns)); },
      sendTurnDelta: async () => undefined,
    } as unknown as GrokBuildTelemetryClient;
    const lifecycle = new GrokBuildTelemetryLifecycle("11111111-1111-4111-8111-111111111111", {
      client,
      setInterval: (() => 1) as unknown as typeof setInterval,
      clearInterval: vi.fn() as typeof clearInterval,
    });
    await lifecycle.ready();
    lifecycle.record({ type: "run_start", task: "task" });
    await lifecycle.sync(true);
    await lifecycle.shutdown({ finalSync: false });
    expect(signals).toEqual([0, 1]);
  });

  it("records root agent events and exports completed spans through the telemetry client", async () => {
    const batches: string[][] = [];
    const client = {
      loadFeedbackConfig: async () => ({ config_id: "v1", config_version: 1, enabled: false }),
      updateSignals: async () => undefined,
      sendTurnDelta: async () => undefined,
      exportAgentTraceSpans: async (spans: Array<{ name: string }>) => { batches.push(spans.map(({ name }) => name)); },
    } as unknown as GrokBuildTelemetryClient;
    const lifecycle = new GrokBuildTelemetryLifecycle("11111111-1111-4111-8111-111111111111", {
      client,
      model: "grok-4.6",
      trace: { responsesEndpoint: "/api/grok/responses" },
      setInterval: (() => 1) as unknown as typeof setInterval,
      clearInterval: vi.fn() as typeof clearInterval,
    });
    lifecycle.record({ type: "run_start", task: "private task" });
    lifecycle.record({ type: "turn_start", turn: 1 });
    lifecycle.record({ type: "assistant", turn: 1, text: "private", reasoning: "" });
    lifecycle.record({ type: "complete", turn: 1, text: "done" });
    await lifecycle.flush();
    await lifecycle.shutdown({ finalSync: false });
    expect(batches).toEqual([
      ["sampling.await_first_output", "http.create_response_stream", "session.handle_prompt"],
      ["session"],
    ]);
  });

  it("takes replay checkpoints after the prior tool batch and before the next response", async () => {
    const signals: Array<Record<string, unknown>> = [];
    const client = {
      loadFeedbackConfig: async () => ({ config_id: "v1", config_version: 1, enabled: false }),
      updateSignals: async (_id: string, body: Record<string, unknown>) => { signals.push(body); },
      sendTurnDelta: async () => undefined,
    } as unknown as GrokBuildTelemetryClient;
    const lifecycle = new GrokBuildTelemetryLifecycle("11111111-1111-4111-8111-111111111111", {
      client,
      signalAssistantCheckpoints: [3],
      setInterval: (() => 1) as unknown as typeof setInterval,
      clearInterval: vi.fn() as typeof clearInterval,
    });
    await lifecycle.ready();
    lifecycle.record({ type: "run_start", task: "task" });
    const response = {
      type: "response_end" as const,
      kind: "foreground",
      response: { usage: { total_tokens: 100, output_tokens: 10 } },
      metrics: { timeToFirstTokenMs: 10, timeToLastByteMs: 20, chunkCount: 2, itlIntervalsMs: [10], attempts: 1 },
    };
    for (let index = 0; index < 3; index += 1) {
      lifecycle.record(response);
      lifecycle.record({ type: "assistant", turn: index + 1, text: "", reasoning: "" });
    }
    lifecycle.record({ type: "tool_end", turn: 3, call: { callId: "tool", name: "read_file", arguments: "{}" }, result: { output: "ok" } });
    lifecycle.record(response);
    await lifecycle.flush();
    expect(signals[1]).toMatchObject({ assistantMessageCount: 3, toolCallCount: 1, latencySampleCount: 3, totalChunkCount: 6 });
  });

  it("uses only the fixed feedback, signals, delta, and trace relay paths", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/feedback/config")) {
        return Response.json({ config_id: "v1", config_version: 1, enabled: false });
      }
      return String(url).endsWith("/traces") ? new Response(null, { status: 204 }) : Response.json({ ok: true });
    });
    const client = new GrokBuildTelemetryClient({ baseUrl: "/relay", fetch: fetchMock as typeof fetch });
    await expect(client.loadFeedbackConfig()).resolves.toMatchObject({ enabled: false });
    await client.updateSignals("session/id", createInitialGrokBuildSignals());
    await client.sendTurnDelta("session/id", { clientType: "agent", turnNumber: 1, turnOutcome: "completed" });
    await client.exportTraces(new Uint8Array([1, 2, 3]));

    expect(requests.map(({ url }) => url)).toEqual([
      "/relay/feedback/config",
      "/relay/sessions/session%2Fid/signals",
      "/relay/sessions/session%2Fid/turn-deltas",
      "/relay/traces",
    ]);
    expect(new Headers(requests[3]?.init?.headers).get("Content-Type")).toBe("application/x-protobuf");
    expect(requests.every(({ init }) => init?.credentials === "include")).toBe(true);
  });

  it("preserves the native status and response body on failures", async () => {
    const client = new GrokBuildTelemetryClient({
      fetch: vi.fn(async () => new Response("forbidden", { status: 403 })) as typeof fetch,
    });
    await expect(client.loadFeedbackConfig()).rejects.toThrow("status 403: forbidden");
  });
});
