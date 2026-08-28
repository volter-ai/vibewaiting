import { describe, expect, it, vi } from "vitest";
import {
  GrokBuildSignalTracker,
  GrokBuildTelemetryClient,
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
