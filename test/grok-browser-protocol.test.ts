import { describe, expect, it } from "vitest";
import {
  collectGrokResponsesStream,
  createGrokResponsesHeaders,
  createGrokResponsesRequest,
  createGrokSessionTitleHeaders,
  createGrokSessionTitleRequest,
  createGrokSideCallHeaders,
  functionCallOutput,
  responseToConversationInput,
} from "../src/grok-browser-protocol.js";

describe("browser Grok Build Responses protocol", () => {
  it("builds the native Responses request defaults and flat tool format", () => {
    const request = createGrokResponsesRequest({
      sessionId: "session-1",
      reasoningEffort: "high",
      input: [
        { type: "message", role: "system", content: "system" },
        { type: "reasoning", content: [{ text: "summary" }] },
      ],
      tools: [{ type: "function", name: "read_file", description: "Read", parameters: { type: "object" } }],
    });

    expect(request).toEqual({
      include: ["reasoning.encrypted_content"],
      input: [
        { type: "message", role: "system", content: "system" },
        { type: "reasoning", content: [{ type: "reasoning_text", text: "summary" }] },
      ],
      model: "grok-4.6",
      prompt_cache_key: "session-1",
      reasoning: { effort: "high", summary: "concise" },
      store: false,
      stream: true,
      tools: [{ type: "function", name: "read_file", description: "Read", parameters: { type: "object" } }],
    });
  });

  it("uses the native headers and keeps request identity stable for a tool loop", () => {
    const identity = {
      conversationId: "conversation-1",
      requestId: "request-1",
      sessionId: "session-1",
      promptIndex: 3,
    };
    const first = createGrokResponsesHeaders(identity, { userId: "user-1" });
    const second = createGrokResponsesHeaders(identity, { userId: "user-1" });
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      Accept: "text/event-stream",
      "x-grok-client-identifier": "grok-shell",
      "x-grok-client-mode": "headless",
      "x-grok-model-override": "grok-4.6",
      "x-grok-req-id": "request-1",
      "x-grok-turn-idx": "3",
      "x-grok-doom-loop-check": "1024",
    });
  });

  it("builds the distinct native session-title side call", () => {
    const request = createGrokSessionTitleRequest("Build Pong");
    expect(request).toMatchObject({
      input: [
        { type: "message", role: "system" },
        { type: "message", role: "user", content: "<user_query>\nBuild Pong\n</user_query>" },
      ],
      max_output_tokens: 100,
      reasoning: { summary: "concise" },
      temperature: 1,
      tool_choice: { name: "session_title", type: "function" },
      tools: [{ type: "function", name: "session_title" }],
    });
    expect(request).not.toHaveProperty("prompt_cache_key");
    expect(createGrokSessionTitleHeaders()).toMatchObject({
      "x-grok-agent-id": "",
      "x-grok-conv-id": "",
      "x-grok-req-id": "",
      "x-grok-session-id": "",
    });
  });

  it("keeps turn-summary identities but omits the foreground turn header", () => {
    const headers = createGrokSideCallHeaders({
      conversationId: "turn-summary-id",
      requestId: "xai-turn-summary-id",
      sessionId: "session-id",
    });
    expect(headers["x-grok-conv-id"]).toBe("turn-summary-id");
    expect(headers["x-grok-req-id"]).toBe("xai-turn-summary-id");
    expect(headers["x-grok-session-id"]).toBe("session-id");
    expect(headers).not.toHaveProperty("x-grok-turn-idx");
  });

  it("replays reasoning, assistant output, calls, and tool output in native order", () => {
    const items = responseToConversationInput({
      output: [
        { type: "reasoning", id: "r1", status: "completed", encrypted_content: "opaque" },
        { type: "message", content: [{ type: "output_text", text: "Inspecting." }] },
        { type: "function_call", call_id: "call-1", name: "read_file", arguments: "{\"path\":\"a\"}" },
      ],
    });
    items.push(functionCallOutput("call-1", "contents"));
    expect(items).toEqual([
      { type: "reasoning", id: "r1", encrypted_content: "opaque" },
      { type: "message", role: "assistant", content: "Inspecting." },
      { type: "function_call", call_id: "call-1", name: "read_file", arguments: "{\"path\":\"a\"}" },
      { type: "function_call_output", call_id: "call-1", output: "contents" },
    ]);
  });

  it("embeds read_file images inside the function_call_output content list", () => {
    expect(functionCallOutput("image-call", [
      { type: "input_text", text: "Read image file: /frame.png" },
      { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" },
    ])).toEqual({
      type: "function_call_output",
      call_id: "image-call",
      output: [
        { type: "input_text", text: "Read image file: /frame.png" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" },
      ],
    });
  });

  it("parses split Responses SSE chunks and requires a completed response", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"Think\"}\n\n"));
        controller.enqueue(encoder.encode("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Do\"}\n\n"));
        controller.enqueue(encoder.encode("data: {\"type\":\"response.completed\",\"response\":{\"output\":[]}}\n\n"));
        controller.close();
      },
    });
    await expect(collectGrokResponsesStream(stream)).resolves.toEqual({
      response: { output: [] },
      text: "Do",
      reasoning: "Think",
    });
  });

  it("ports native output-only chunk latency and percentile rounding", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"response.reasoning_summary_text.delta","delta":"Think"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"A"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"B"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"C"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{"output":[]}}\n\n'));
        controller.close();
      },
    });
    const times = [110, 130, 160, 260];
    const result = await collectGrokResponsesStream(stream, undefined, {
      startedAt: 100,
      now: () => times.shift()!,
      attempts: 2,
    });
    expect(result.metrics).toEqual({
      timeToFirstTokenMs: 10,
      timeToLastByteMs: 160,
      chunkCount: 3,
      itlIntervalsMs: [20, 30],
      itlP50Ms: 30,
      itlP99Ms: 30,
      itlMaxMs: 30,
      itlMeanMs: 25,
      attempts: 2,
    });
  });
});
