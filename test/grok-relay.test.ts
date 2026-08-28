import { describe, expect, it } from "vitest";
import {
  credentialFromAuthJson,
  grokBundleHeaders,
  grokBootstrapHeaders,
  grokUpstreamHeaders,
  normalizeGrokRequest,
  relayMetadataFromHeaders,
} from "../experiments/browser-agent/grok-relay.js";

describe("browser Grok relay", () => {
  it("preserves native synthetic-wake request identifiers", () => {
    const id = "33333333-3333-4333-8333-333333333333";
    expect(relayMetadataFromHeaders({
      "x-browser-agent-request": `task-completed-${id}`,
    }).requestId).toBe(`task-completed-${id}`);
    expect(relayMetadataFromHeaders({
      "x-browser-agent-request": `subagent-completed-${id}`,
    }).requestId).toBe(`subagent-completed-${id}`);
    expect(relayMetadataFromHeaders({
      "x-browser-agent-request": `scheduler-fired-${id}`,
    }).requestId).toBe(`scheduler-fired-${id}`);
    expect(relayMetadataFromHeaders({
      "x-browser-agent-request": "workflow-completed-wf_0123456789abcdef0123456789abcdef-2",
    }).requestId).toBe("workflow-completed-wf_0123456789abcdef0123456789abcdef-2");
    expect(relayMetadataFromHeaders({
      "x-browser-agent-request": "plan-resume-1787893200000",
    }).requestId).toBe("plan-resume-1787893200000");
    expect(relayMetadataFromHeaders({
      "x-browser-agent-request": "notifications-44444444-4444-4444-8444-444444444444",
    }).requestId).toBe("notifications-44444444-4444-4444-8444-444444444444");
  });
  it("extracts a credential without depending on the issuer key", () => {
    expect(credentialFromAuthJson({
      "https://auth.x.ai::client": {
        key: "secret-token",
        email: "subscriber@example.com",
        user_id: "user-1",
      },
    })).toEqual({ token: "secret-token", email: "subscriber@example.com", userId: "user-1" });
  });

  it("restricts browser requests to the native streaming Responses profile", () => {
    const normalized = normalizeGrokRequest({
      include: ["reasoning.encrypted_content"],
      input: [{ type: "message", role: "user", content: "Inspect the project" }],
      model: "grok-4.6",
      prompt_cache_key: "session-1",
      reasoning: { effort: "high", summary: "concise" },
      store: false,
      stream: true,
      tools: [{ type: "function", name: "run_terminal_command", parameters: {} }],
    });

    expect(normalized).toMatchObject({ model: "grok-4.6", store: false, stream: true });
    expect(() => normalizeGrokRequest({
      include: ["reasoning.encrypted_content"],
      input: [{ type: "message", role: "user", content: "No" }],
      model: "other-model",
      prompt_cache_key: "session-1",
      reasoning: { summary: "concise" },
      store: false,
      stream: true,
    })).toThrow(/pinned streaming/u);

    expect(normalizeGrokRequest({
      include: ["reasoning.encrypted_content"],
      input: [{ type: "message", role: "user", content: "<user_query>\nInspect the project\n</user_query>" }],
      max_output_tokens: 100,
      model: "grok-4.6",
      reasoning: { summary: "concise" },
      store: false,
      stream: true,
      temperature: 1,
      tool_choice: { name: "session_title", type: "function" },
      tools: [{ type: "function", name: "session_title", parameters: {} }],
    }, "session-title")).not.toHaveProperty("prompt_cache_key");
  });

  it("sends the proxy authentication and captured turn headers", () => {
    const headers = grokUpstreamHeaders(
      { token: "secret-token", userId: "user-1" },
      {
        conversationId: "11111111-1111-4111-8111-111111111111",
        requestId: "33333333-3333-4333-8333-333333333333",
        sessionId: "22222222-2222-4222-8222-222222222222",
        turnIndex: 3,
      },
      "1.0.5",
    );

    expect(headers.get("authorization")).toBe("Bearer secret-token");
    expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(headers.get("x-grok-client-version")).toBe("1.0.5");
    expect(headers.get("x-grok-client-identifier")).toBe("grok-shell");
    expect(headers.get("x-grok-client-mode")).toBe("headless");
    expect(headers.get("x-grok-model-override")).toBe("grok-4.6");
    expect(headers.get("x-grok-conv-id")).toBe("11111111-1111-4111-8111-111111111111");
    expect(headers.get("x-grok-turn-idx")).toBe("3");
  });

  it("matches native models and settings bootstrap header differences", () => {
    const credential = { token: "secret-token", userId: "user-1", email: "subscriber@example.com" };
    const models = grokBootstrapHeaders(credential, "models", "1.0.5");
    const settings = grokBootstrapHeaders(credential, "settings", "1.0.5");

    expect(models.get("x-userid")).toBe("user-1");
    expect(models.get("x-email")).toBe("subscriber@example.com");
    expect(models.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(models.has("x-grok-client-identifier")).toBe(false);
    expect(settings.get("x-grok-client-identifier")).toBe("grok-shell");
  });

  it("matches native archive and legacy bundle authentication differences", () => {
    const credential = { token: "secret-token", userId: "user-1", email: "subscriber@example.com" };
    const archive = grokBundleHeaders(credential, "archive", "1.0.5");
    const legacy = grokBundleHeaders(credential, "legacy", "1.0.5");

    expect(archive.get("accept")).toBe("*/*");
    expect(archive.get("authorization")).toBe("Bearer secret-token");
    expect(archive.get("x-email")).toBe("subscriber@example.com");
    expect(archive.get("x-grok-client-mode")).toBe("headless");
    expect(archive.get("x-grok-client-version")).toBe("1.0.5");
    expect(archive.get("x-userid")).toBe("user-1");
    expect(archive.has("x-xai-token-auth")).toBe(false);
    expect(archive.has("x-grok-client-identifier")).toBe(false);
    expect(legacy.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(legacy.get("x-grok-client-identifier")).toBe("grok-shell");
  });

  it("keeps native session-title headers free of foreground turn identity", () => {
    const headers = grokUpstreamHeaders(
      { token: "secret-token", userId: "user-1" },
      {
        conversationId: "11111111-1111-4111-8111-111111111111",
        requestId: "33333333-3333-4333-8333-333333333333",
        sessionId: "22222222-2222-4222-8222-222222222222",
        turnIndex: 3,
      },
      "1.0.5",
      "session-title",
    );

    expect(headers.get("x-grok-conv-id")).toBe("");
    expect(headers.get("x-grok-req-id")).toBe("");
    expect(headers.get("x-grok-session-id")).toBe("");
    expect(headers.has("x-grok-turn-idx")).toBe(false);
    expect(headers.has("traceparent")).toBe(false);
    expect(headers.has("x-grok-user-id")).toBe(false);
  });

  it("uses prefixed side-call identity without a foreground turn index", () => {
    const headers = grokUpstreamHeaders(
      { token: "secret-token", userId: "user-1" },
      {
        conversationId: "turn-summary-11111111-1111-4111-8111-111111111111",
        requestId: "xai-turn-summary-33333333-3333-4333-8333-333333333333",
        sessionId: "22222222-2222-4222-8222-222222222222",
        turnIndex: 1,
      },
      "1.0.5",
      "turn-summary",
    );
    expect(headers.get("x-grok-conv-id")).toMatch(/^turn-summary-/u);
    expect(headers.get("x-grok-req-id")).toMatch(/^xai-turn-summary-/u);
    expect(headers.has("x-grok-turn-idx")).toBe(false);
  });

  it("translates trusted browser compaction state into native omit and fixed headers", () => {
    const metadata = {
      conversationId: "11111111-1111-4111-8111-111111111111",
      requestId: "33333333-3333-4333-8333-333333333333",
      sessionId: "22222222-2222-4222-8222-222222222222",
      turnIndex: 2,
    };
    const omittedAt = grokUpstreamHeaders(
      { token: "secret-token", userId: "user-1" }, metadata, "1.0.5", "main", "grok-4.6",
      null, "headless", "grok-shell", 0,
    );
    expect(omittedAt.has("x-compaction-at")).toBe(false);
    expect(omittedAt.get("x-compactions-remaining")).toBe("0");

    const fixed = grokUpstreamHeaders(
      { token: "secret-token", userId: "user-1" }, metadata, "1.0.5", "compaction", "grok-4.6",
      321_000, "headless", "grok-shell", null,
    );
    expect(fixed.get("x-compaction-at")).toBe("321000");
    expect(fixed.has("x-compactions-remaining")).toBe(false);
  });
});
