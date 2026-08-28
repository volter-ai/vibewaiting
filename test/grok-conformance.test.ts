import { describe, expect, it } from "vitest";
import {
  LaneProtocolState,
  ProtocolViolation,
  assertProtocolMatch,
  canonicalRequest,
  normalizeTelemetryMeasurements,
  ProtocolSymbolMatcher,
  splitLanePath,
} from "../src/grok-conformance.js";

function request(
  lane: "native" | "browser",
  state: LaneProtocolState,
  overrides: Record<string, string> = {},
) {
  const url = new URL(`http://127.0.0.1:4319/${lane}/v1/responses?beta=true`);
  return canonicalRequest(
    "POST",
    url,
    "/v1/responses",
    {
      authorization: "Bearer secret-value",
      "content-type": "application/json",
      "user-agent": lane === "native" ? "reqwest" : "Chrome",
      "x-grok-client-version": "1.0.5",
      "x-grok-client-identifier": "grok-shell",
      "x-grok-conv-id": lane === "native"
        ? "11111111-1111-4111-8111-111111111111"
        : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "x-grok-session-id": lane === "native"
        ? "22222222-2222-4222-8222-222222222222"
        : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "x-grok-req-id": lane === "native"
        ? "33333333-3333-4333-8333-333333333333"
        : "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      ...overrides,
    },
    Buffer.from(JSON.stringify({ model: "grok-build", stream: true })),
    state,
  );
}

describe("Grok Build conformance protocol", () => {
  it("accepts only explicit native and browser lanes", () => {
    expect(splitLanePath("/native/v1/responses")).toEqual({ lane: "native", upstreamPath: "/v1/responses" });
    expect(splitLanePath("/browser/v1/settings")).toEqual({ lane: "browser", upstreamPath: "/v1/settings" });
    expect(() => splitLanePath("/v1/responses")).toThrow(ProtocolViolation);
  });

  it("redacts bearer values and normalizes only runtime transport differences", () => {
    const native = request("native", new LaneProtocolState(), {
      "x-email": "native@example.com",
      "x-userid": "native-user",
    });
    const browser = request("browser", new LaneProtocolState(), {
      "x-email": "browser@example.com",
      "x-userid": "browser-user",
    });
    expect(native.headers.authorization).toBe("<bearer>");
    expect(native.headers["x-email"]).toBe("<identity:value:1>");
    expect(native.headers["x-userid"]).toBe("<identity:value:2>");
    expect(native.headers).not.toHaveProperty("user-agent");
    expect(JSON.stringify(native)).not.toContain("native@example.com");
    expect(() => assertProtocolMatch(native, browser)).not.toThrow();
  });

  it("fails closed on a single Grok protocol header difference", () => {
    const native = request("native", new LaneProtocolState());
    const browser = request("browser", new LaneProtocolState(), { "x-grok-client-version": "1.0.4" });
    expect(() => assertProtocolMatch(native, browser)).toThrowError(/diverged/u);
    try {
      assertProtocolMatch(native, browser);
    } catch (error) {
      expect((error as ProtocolViolation).differences).toContainEqual({
        pointer: "/headers/x-grok-client-version",
        expected: "1.0.5",
        actual: "1.0.4",
      });
    }
  });

  it("preserves opaque-ID reuse patterns without assuming UUID or uniqueness semantics", () => {
    const nativeState = new LaneProtocolState();
    const browserState = new LaneProtocolState();
    const matcher = new ProtocolSymbolMatcher();
    const nativeFirst = request("native", nativeState, { "x-grok-conv-id": "native-opaque" });
    const browserFirst = request("browser", browserState, { "x-grok-conv-id": "browser-opaque" });
    expect(() => matcher.assertMatch(nativeFirst, browserFirst)).not.toThrow();

    const nativeSecond = request("native", nativeState, { "x-grok-conv-id": "native-opaque" });
    const browserSecond = request("browser", browserState, {
      "x-grok-conv-id": "browser-opaque",
      "x-grok-req-id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });
    expect(() => matcher.assertMatch(nativeSecond, browserSecond)).toThrow(ProtocolViolation);
  });

  it("accepts long and empty native identifiers as opaque protocol values", () => {
    const state = new LaneProtocolState();
    const first = request("native", state, { "x-grok-conv-id": "x".repeat(2048) });
    const second = request("native", state, { "x-grok-conv-id": "" });
    expect(first.headers["x-grok-conv-id"]).toBe("<identifier:opaque:1>");
    expect(second.headers["x-grok-conv-id"]).toBe("<identifier:opaque:4>");
  });

  it("keeps prompt_cache_key aligned with the session identifier", () => {
    const state = new LaneProtocolState();
    const session = "11111111-1111-4111-8111-111111111111";
    const request = canonicalRequest(
      "POST",
      new URL("http://localhost/native/v1/responses"),
      "/v1/responses",
      { "content-type": "application/json", "x-grok-session-id": session },
      Buffer.from(JSON.stringify({ prompt_cache_key: session })),
      state,
    );
    expect(request.body).toEqual({ prompt_cache_key: "<identifier:uuid:1>" });
    expect(request.headers["x-grok-session-id"]).toBe("<identifier:uuid:1>");
  });

  it("matches symbol reuse independent of unrelated first-seen ordering", () => {
    const expectedState = new LaneProtocolState();
    const actualState = new LaneProtocolState();
    request("native", expectedState, { "x-grok-conv-id": "unrelated-native-id" });
    const matcher = new ProtocolSymbolMatcher();
    const expected = request("native", expectedState, {
      "x-grok-conv-id": "",
      "x-grok-req-id": "",
      "x-grok-session-id": "",
    });
    const actual = request("browser", actualState, {
      "x-grok-conv-id": "",
      "x-grok-req-id": "",
      "x-grok-session-id": "",
    });

    expect(() => matcher.assertMatch(expected, actual)).not.toThrow();
  });

  it("normalizes dynamic session path IDs while preserving their format", () => {
    const nativeState = new LaneProtocolState();
    const browserState = new LaneProtocolState();
    expect(nativeState.normalizePath("/v1/sessions/11111111-1111-4111-8111-111111111111/signals"))
      .toBe("/v1/sessions/<identifier:uuid:1>/signals");
    expect(browserState.normalizePath("/v1/sessions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/signals"))
      .toBe("/v1/sessions/<identifier:uuid:1>/signals");
  });

  it("symbolizes only replay-volatile telemetry measurements", () => {
    const make = (duration: number, calls: number, requestId: string) => canonicalRequest(
      "POST",
      new URL("http://localhost/browser/v1/sessions/11111111-1111-4111-8111-111111111111/turn-deltas"),
      "/v1/sessions/11111111-1111-4111-8111-111111111111/turn-deltas",
      { "content-type": "application/json" },
      Buffer.from(JSON.stringify({ turnDurationMs: duration, requestId, deltaToolCalls: calls })),
      new LaneProtocolState(),
    );
    expect(() => assertProtocolMatch(make(52_500, 6, "native"), make(183, 6, "browser"))).not.toThrow();
    expect(() => assertProtocolMatch(make(52_500, 6, "native"), make(183, 7, "browser"))).toThrow(ProtocolViolation);
  });

  it("normalizes recorded and live telemetry clocks with the same projection", () => {
    const recorded = { sessionDurationSeconds: 0, avgResponseTimeMs: 0, totalTurns: 0 };
    const live = { sessionDurationSeconds: 9, avgResponseTimeMs: 211, totalTurns: 0 };
    normalizeTelemetryMeasurements("/v1/sessions/native/signals", recorded);
    normalizeTelemetryMeasurements("/v1/sessions/browser/signals", live);
    expect(recorded).toEqual(live);
  });

  it("fails on one request-body field difference", () => {
    const native = request("native", new LaneProtocolState());
    const browser = { ...request("browser", new LaneProtocolState()), body: { model: "grok-build", stream: false } };
    expect(() => assertProtocolMatch(native, browser)).toThrow(ProtocolViolation);
  });
});
