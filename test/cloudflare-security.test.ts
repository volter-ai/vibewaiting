import { describe, expect, it } from "vitest";
import {
  cookieValue,
  isTrustedMutation,
  managedMcpCatalogCallIds,
  normalizeGrokManagedMcpCallRequest,
  normalizeGrokLocalMcpRelayRequest,
  normalizeGrokLocalMcpUrl,
  isPublicGrokRelayIpAddress,
  normalizeWebFetchRedirectUrl,
  normalizeWebFetchUrl,
  normalizeImageMediaRequest,
  grokImageMediaModel,
  parseGrokMediaModelOverrides,
  parseGrokRelayRemoteSettings,
  normalizeVideoMediaRequest,
  normalizeVideoDownloadUrl,
  normalizeGrokResponsesRequest,
  normalizeGrokTelemetryRoute,
  sameWebFetchHost,
  validSessionId,
  validGrokRequestId,
} from "../cloudflare/security.js";

describe("Cloudflare browser-agent security boundary", () => {
  it("accepts only native UUID and synthetic-wake request identifiers", () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const eventId = "44444444-4444-4444-8444-444444444444";
    expect(validGrokRequestId(id)).toBe(id);
    expect(validGrokRequestId(`task-completed-${id}`)).toBe(`task-completed-${id}`);
    expect(validGrokRequestId(`subagent-completed-${id}`)).toBe(`subagent-completed-${id}`);
    expect(validGrokRequestId(`scheduler-fired-${id}`)).toBe(`scheduler-fired-${id}`);
    expect(validGrokRequestId("workflow-completed-wf_0123456789abcdef0123456789abcdef-2")).toBe("workflow-completed-wf_0123456789abcdef0123456789abcdef-2");
    expect(validGrokRequestId("plan-resume-1787893200000")).toBe("plan-resume-1787893200000");
    expect(validGrokRequestId(`notifications-${eventId}`)).toBe(`notifications-${eventId}`);
    expect(validGrokRequestId(`attacker-${id}`)).toBeUndefined();
    expect(validGrokRequestId(`notifications-not-a-uuid`)).toBeUndefined();
    expect(validGrokRequestId(`monitor-${id}-${eventId}`)).toBeUndefined();
    expect(validGrokRequestId("workflow-completed-wf_escape-2")).toBeUndefined();
    expect(validGrokRequestId("plan-resume-yesterday")).toBeUndefined();
    expect(validGrokRequestId("task-completed-not-a-uuid")).toBeUndefined();
  });
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

  it("allows only bounded managed MCP call IDs issued by the cached xAI catalog", () => {
    expect(managedMcpCatalogCallIds({ tools: [
      { call_id: "gmail.search" }, { call_id: "gmail.search" }, { call_id: 42 },
    ] })).toEqual(["gmail.search"]);
    expect(normalizeGrokManagedMcpCallRequest({
      call_id: "gmail.search", arguments: { query: "xai" },
    }, ["gmail.search"])).toEqual({ call_id: "gmail.search", arguments: { query: "xai" } });
    expect(() => normalizeGrokManagedMcpCallRequest({
      call_id: "hidden.call", arguments: {},
    }, ["gmail.search"])).toThrow(/not issued/u);
    expect(() => normalizeGrokManagedMcpCallRequest({
      call_id: "gmail.search", arguments: {}, upstream: "https://evil.example",
    }, ["gmail.search"])).toThrow(/only call_id and arguments/u);
  });

  it("constrains local MCP relay targets, methods, headers, and public addresses", () => {
    expect(normalizeGrokLocalMcpRelayRequest({
      url: "https://mcp.example.com/rpc",
      method: "POST",
      headers: { Authorization: "Bearer secret", "MCP-Protocol-Version": "2025-11-25" },
      body: "{}",
    })).toEqual({
      url: "https://mcp.example.com/rpc", method: "POST",
      headers: { Authorization: "Bearer secret", "MCP-Protocol-Version": "2025-11-25" }, body: "{}",
    });
    expect(() => normalizeGrokLocalMcpRelayRequest({ url: "https://mcp.example.com", method: "PUT", headers: {} })).toThrow(/method/u);
    expect(() => normalizeGrokLocalMcpRelayRequest({ url: "https://mcp.example.com", method: "GET", headers: { Cookie: "stolen" } })).toThrow(/not allowed/u);
    expect(() => normalizeGrokLocalMcpRelayRequest({ url: "https://mcp.example.com", method: "GET", headers: {}, body: "x" })).toThrow(/cannot contain/u);
    for (const target of ["http://mcp.example.com", "https://localhost/mcp", "https://127.0.0.1/mcp", "https://mcp.example.com:8443/mcp", "https://user:pass@mcp.example.com/mcp"]) {
      expect(() => normalizeGrokLocalMcpUrl(target), target).toThrow();
    }
    for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.0.1", "169.254.169.254", "192.0.2.1", "2001:db8::1", "::1", "::ffff:127.0.0.1", "::192.168.0.1", "1:2:3", "gggg::1"]) {
      expect(isPublicGrokRelayIpAddress(address), address).toBe(false);
    }
    expect(isPublicGrokRelayIpAddress("8.8.8.8")).toBe(true);
    expect(isPublicGrokRelayIpAddress("2606:4700:4700::1111")).toBe(true);
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
    expect(() => normalizeWebFetchUrl("https://127.0.0.1/private")).toThrow(/Single-label|not in the allowed|not public/u);
    expect(() => normalizeWebFetchUrl("https://user:secret@docs.rs/")).toThrow(/credentials/u);
    expect(() => normalizeWebFetchUrl("file:///etc/passwd")).toThrow(/scheme/u);
    expect(normalizeWebFetchUrl("https://example.com/docs", ["example.com/docs"]).pathname).toBe("/docs");
    expect(() => normalizeWebFetchUrl("https://example.com/api", ["example.com/docs"])).toThrow(/not in the allowed/u);
    expect(() => normalizeWebFetchUrl("https://127.0.0.1/private", ["127.0.0.1"])).toThrow(/not public/u);

    const original = normalizeWebFetchUrl("https://docs.rs/start");
    const same = normalizeWebFetchRedirectUrl("http://docs.rs/final");
    const crossHost = normalizeWebFetchRedirectUrl("https://example.com/final");
    expect(same.toString()).toBe("https://docs.rs/final");
    expect(sameWebFetchHost(original, same)).toBe(true);
    expect(sameWebFetchHost(original, crossHost)).toBe(false);
  });

  it("accepts only the native stateless Imagine envelopes", () => {
    expect(parseGrokRelayRemoteSettings({
      web_fetch_allowed_domains: [],
      web_fetch_proxy: "https://proxy.example.com",
    })).toMatchObject({ webFetch: { allowedDomains: [], proxyEndpoint: "https://proxy.example.com" } });
    const mediaModels = parseGrokMediaModelOverrides({
      image_gen_model_override: "grok-imagine-image",
      image_edit_model_override: "grok-imagine-image-edit",
    });
    expect(grokImageMediaModel(mediaModels, "generate")).toBe("grok-imagine-image");
    expect(grokImageMediaModel(mediaModels, "edit")).toBe("grok-imagine-image-edit");
    expect(grokImageMediaModel(parseGrokMediaModelOverrides({ image_gen_model_override: "" }), "generate"))
      .toBe("grok-imagine-image-quality");
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
