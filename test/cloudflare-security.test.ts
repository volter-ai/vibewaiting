import { describe, expect, it } from "vitest";
import {
  cookieValue,
  isTrustedMutation,
  normalizeWebFetchRedirectUrl,
  normalizeWebFetchUrl,
  normalizeImageMediaRequest,
  normalizeVideoMediaRequest,
  normalizeVideoDownloadUrl,
  normalizeGrokResponsesRequest,
  normalizeGrokTelemetryRoute,
  sameWebFetchHost,
  validSessionId,
} from "../cloudflare/security.js";

describe("Cloudflare browser-agent security boundary", () => {
  it("accepts the native streaming Responses envelope without rewriting it", () => {
    const request = {
      include: ["reasoning.encrypted_content"],
      input: [{ type: "message", role: "system", content: "native prompt" }, { type: "message", role: "user", content: "Build Pong" }],
      model: "grok-4.6",
      prompt_cache_key: "11111111-1111-4111-8111-111111111111",
      reasoning: { effort: "high", summary: "concise" },
      store: false,
      stream: true,
      tools: [{ type: "function", name: "read_file", parameters: {} }],
    };
    expect(normalizeGrokResponsesRequest(request)).toEqual(request);
  });

  it("rejects altered profiles, unknown fields, and malformed title calls", () => {
    const base = {
      include: ["reasoning.encrypted_content"],
      input: [{ type: "message", role: "user", content: "Build Pong" }],
      model: "grok-4.6",
      prompt_cache_key: "session",
      reasoning: { summary: "concise" },
      store: false,
      stream: true,
    };
    expect(() => normalizeGrokResponsesRequest({ ...base, model: "attacker-model" })).toThrow(/pinned streaming/u);
    expect(() => normalizeGrokResponsesRequest({ ...base, arbitrary: true })).toThrow(/Unsupported/u);
    expect(() => normalizeGrokResponsesRequest({ ...base, input: [] })).toThrow(/between 1/u);
    expect(() => normalizeGrokResponsesRequest(base, "session-title")).toThrow(/must not contain prompt_cache_key/u);
  });

  it("allows only the native compaction sampling profile", () => {
    const base = {
      include: ["reasoning.encrypted_content"],
      input: [{ type: "message", role: "user", content: "summarize" }],
      model: "grok-4.6",
      prompt_cache_key: "session",
      reasoning: { summary: "concise" },
      store: false,
      stream: true,
      temperature: 1,
      tool_choice: "auto",
    };
    expect(normalizeGrokResponsesRequest(base, "compaction")).toMatchObject({ temperature: 1, tool_choice: "auto" });
    expect(() => normalizeGrokResponsesRequest({ ...base, tool_choice: "none" }, "compaction")).toThrow(/compaction request/u);
  });

  it("requires an exact same-origin mutation and rejects opaque sandbox origins", () => {
    const trusted = new Request("https://agent.example/api/auth/logout", {
      method: "POST",
      headers: { Origin: "https://agent.example", "Sec-Fetch-Site": "same-origin" },
    });
    const crossOrigin = new Request("https://agent.example/api/auth/logout", {
      method: "POST",
      headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
    });
    const sandbox = new Request("https://agent.example/api/auth/logout", {
      method: "POST",
      headers: { Origin: "null" },
    });
    expect(isTrustedMutation(trusted)).toBe(true);
    expect(isTrustedMutation(crossOrigin)).toBe(false);
    expect(isTrustedMutation(sandbox)).toBe(false);
  });

  it("parses only the exact session cookie and validates 256-bit ids", () => {
    const sessionId = "a".repeat(43);
    expect(cookieValue(`other=x; __Host-vw_session=${sessionId}; suffix=y`, "__Host-vw_session")).toBe(sessionId);
    expect(validSessionId(sessionId)).toBe(true);
    expect(validSessionId("short")).toBe(false);
  });

  it("ports the native web_fetch URL upgrade, allowlist, and redirect boundary", () => {
    expect(normalizeWebFetchUrl("http://docs.rs/serde/latest").toString()).toBe("https://docs.rs/serde/latest");
    expect(normalizeWebFetchUrl("https://www.react.dev/learn").hostname).toBe("www.react.dev");
    expect(normalizeWebFetchUrl("https://vercel.com/docs/functions").pathname).toBe("/docs/functions");
    expect(() => normalizeWebFetchUrl("https://vercel.com/api")).toThrow(/not in the allowed/u);
    expect(() => normalizeWebFetchUrl("https://127.0.0.1/private")).toThrow(/Single-label|not in the allowed/u);
    expect(() => normalizeWebFetchUrl("https://user:secret@docs.rs/")).toThrow(/credentials/u);
    expect(() => normalizeWebFetchUrl("file:///etc/passwd")).toThrow(/scheme/u);

    const original = normalizeWebFetchUrl("https://docs.rs/start");
    const same = normalizeWebFetchRedirectUrl("http://docs.rs/final");
    const crossHost = normalizeWebFetchRedirectUrl("https://example.com/final");
    expect(same.toString()).toBe("https://docs.rs/final");
    expect(sameWebFetchHost(original, same)).toBe(true);
    expect(sameWebFetchHost(original, crossHost)).toBe(false);
  });

  it("accepts only the native stateless Imagine envelopes", () => {
    expect(normalizeImageMediaRequest({
      kind: "generate",
      prompt: "a moon",
      aspectRatio: "16:9",
    })).toEqual({ kind: "generate", prompt: "a moon", aspectRatio: "16:9" });
    expect(normalizeImageMediaRequest({
      kind: "edit",
      prompt: "blue",
      aspectRatio: "auto",
      images: ["data:image/jpeg;base64,/9j/"],
    })).toMatchObject({ kind: "edit", images: ["data:image/jpeg;base64,/9j/"] });
    expect(() => normalizeImageMediaRequest({
      kind: "generate",
      prompt: "x",
      aspectRatio: "16:9",
      model: "attacker-model",
    })).toThrow(/unsupported fields/u);
    expect(() => normalizeImageMediaRequest({
      kind: "edit",
      prompt: "x",
      aspectRatio: "auto",
      images: ["http://127.0.0.1/private"],
    })).toThrow(/HTTPS URL/u);

    expect(normalizeVideoMediaRequest({
      kind: "reference-to-video",
      prompt: "<AUDIO_0> speaks",
      duration: 6,
      aspectRatio: "16:9",
      resolution: "480p",
      images: [],
      voices: ["eve"],
    })).toMatchObject({ kind: "reference-to-video", voices: ["eve"] });
    expect(() => normalizeVideoMediaRequest({
      kind: "image-to-video",
      prompt: "move",
      duration: 8,
      resolution: "480p",
      image: "https://example.com/a.png",
    })).toThrow(/6 or 10/u);

    expect(normalizeVideoDownloadUrl("https://media.example.com/result.mp4").hostname).toBe("media.example.com");
    expect(() => normalizeVideoDownloadUrl("https://127.0.0.1/private.mp4")).toThrow(/not public/u);
    expect(() => normalizeVideoDownloadUrl("https://metadata.internal/video.mp4")).toThrow(/not public/u);
    expect(() => normalizeVideoDownloadUrl("https://user:secret@media.example/video.mp4")).toThrow(/credential-free/u);
  });

  it("allows only fixed telemetry endpoints with valid Grok session UUIDs", () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    expect(normalizeGrokTelemetryRoute("/api/grok/feedback/config", "GET")).toEqual({
      upstreamPath: "/v1/feedback/config",
      contentType: "application/json",
    });
    expect(normalizeGrokTelemetryRoute(`/api/grok/sessions/${sessionId}/signals`, "POST")?.upstreamPath)
      .toBe(`/v1/sessions/${sessionId}/signals`);
    expect(normalizeGrokTelemetryRoute(`/api/grok/sessions/${sessionId}/turn-deltas`, "POST")?.upstreamPath)
      .toBe(`/v1/sessions/${sessionId}/turn-deltas`);
    expect(normalizeGrokTelemetryRoute("/api/grok/traces", "POST")?.contentType).toBe("application/x-protobuf");
    expect(normalizeGrokTelemetryRoute("/api/grok/traces", "GET")).toBeUndefined();
    expect(normalizeGrokTelemetryRoute("/api/grok/sessions/not-a-uuid/signals", "POST")).toBeUndefined();
    expect(normalizeGrokTelemetryRoute(`/api/grok/sessions/${sessionId}/arbitrary`, "POST")).toBeUndefined();
  });
});
