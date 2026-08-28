import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GROK_BUILD_OTLP_ALLOWED_STRING_KEYS,
  redactGrokBuildOtlpSpan,
  type GrokBuildOtlpAttribute,
  type GrokBuildOtlpSpan,
} from "../experiments/browser-agent/src/grok-build-otlp-redaction.js";
import { encodeGrokBuildOtlpExport } from "../experiments/browser-agent/src/grok-build-otlp-protobuf.js";
import {
  createGrokBuildBrowserTraceExport,
  endGrokBuildMcpToolCallSpan,
  GrokBuildAgentTraceProducer,
  GrokBuildBrowserOtlpTracer,
  recordGrokBuildMcpConnectionSpan,
  startGrokBuildMcpToolCallSpan,
} from "../experiments/browser-agent/src/grok-build-otlp-trace.js";

describe("Grok Build internal OTLP browser subset", () => {
  it("pins the native default-deny string allowlist", () => {
    expect(GROK_BUILD_OTLP_ALLOWED_STRING_KEYS).toHaveLength(122);
    expect(createHash("sha256").update(GROK_BUILD_OTLP_ALLOWED_STRING_KEYS.join("\n")).digest("hex"))
      .toBe("90bbed136c7f9ea1917ec559e1a016ff4a654b335ce82a792c7685b9aa3ff431");
  });

  it("redacts all native text surfaces while retaining stable structure and numeric fields", () => {
    const span = sampleSpan({
      name: "session /Users/alice/project sk-CANARYabcdefghij1234567890",
      attributes: [
        { key: "session_id", value: "sess-1" },
        { key: "prompt", value: "CANARY_PROMPT user content" },
        { key: "command", value: "echo CANARY_COMMAND" },
        { key: "turn_number", value: 7 },
        { key: "is_background", value: true },
        { key: "url", value: "https://user:pass@example.com:8443/private/CANARY?q=secret#x" },
        { key: "gcs_path", value: "sessions/abc/artifact-kept.tar" },
        { key: "source", value: "Bearer abcdefghijklmnopqrstuvwxyz" },
        { key: "tool_names", value: ["read", "write"] },
      ],
      events: [{
        timeUnixNano: 12n,
        name: "received prompt: CANARY_EVENT",
        attributes: [
          { key: "code.filepath", value: "/Users/alice/src/foo.rs" },
          { key: "code.lineno", value: 42 },
          { key: "message", value: "CANARY_MESSAGE" },
        ],
      }],
      links: [{
        traceId: Uint8Array.from({ length: 16 }, (_, index) => index + 20),
        spanId: Uint8Array.from({ length: 8 }, (_, index) => index + 40),
        attributes: [{ key: "secret_payload", value: "CANARY_LINK" }, { key: "linked", value: true }],
      }],
      status: { code: 2, message: "failed /Users/alice/file with sk-CANARYabcdefghij1234567890" },
    });
    const redacted = redactGrokBuildOtlpSpan(span, { homePath: "/Users/alice", usernames: ["alice"] });
    const blob = stringifyBigInt(redacted);

    expect(redacted.name).toContain("~/project");
    expect(redacted.attributes).toEqual([
      { key: "session_id", value: "sess-1" },
      { key: "turn_number", value: 7 },
      { key: "is_background", value: true },
      { key: "url", value: "https://example.com:8443/" },
      { key: "gcs_path", value: "sessions/abc/artifact-kept.tar" },
      { key: "source", value: "Bearer [REDACTED_SECRET]" },
      { key: "tool_names", value: ["read", "write"] },
    ]);
    expect(redacted.events?.[0]?.name).toBe("~/src/foo.rs:42");
    expect(redacted.events?.[0]?.attributes.map(({ key }) => key)).toEqual(["code.filepath", "code.lineno"]);
    expect(redacted.links?.[0]?.attributes).toEqual([{ key: "linked", value: true }]);
    expect(redacted.status?.message).toContain("failed ~/file with [REDACTED_SECRET]");
    for (const canary of ["CANARY_PROMPT", "CANARY_COMMAND", "CANARY_EVENT", "CANARY_MESSAGE", "CANARY_LINK", "/Users/alice"]) {
      expect(blob).not.toContain(canary);
    }
    expect(redactGrokBuildOtlpSpan(sampleSpan({
      attributes: [{ key: "error", value: "user alice: failed" }],
    }), { usernames: ["alice"] }).attributes[0]?.value).toBe("user <user>: failed");
  });

  it("neuters raw event names without callsites and applies the no-env path backstop", () => {
    const redacted = redactGrokBuildOtlpSpan(sampleSpan({
      events: [{ timeUnixNano: 1n, name: "private user text", attributes: [] }],
      attributes: [{ key: "path", value: "/home/bob/private/file.ts" }],
    }));
    expect(redacted.events?.[0]?.name).toBe("event");
    expect(redacted.attributes).toEqual([{ key: "path", value: "/home/<user>/private/file.ts" }]);
  });

  it("encodes a structurally valid OTLP trace request with fixed IDs/timestamps and scrubbed attributes", () => {
    const span = sampleSpan({
      name: "tool.execution",
      flags: 1,
      attributes: [
        { key: "tool_name", value: "read_file" },
        { key: "prompt", value: "CANARY_MUST_NOT_EXPORT" },
        { key: "success", value: true },
        { key: "tool_result_size_bytes", value: 128 },
        { key: "ratio", value: 1.5 },
      ],
      status: { code: 1 },
    });
    const encoded = encodeGrokBuildOtlpExport({
      resource: [{ key: "service.name", value: "grok-cli" }],
      scope: { name: "grok-cli", version: "0.1.0" },
      spans: [span],
    });
    expect(new TextDecoder().decode(encoded)).not.toContain("CANARY_MUST_NOT_EXPORT");

    const request = decodeMessage(encoded);
    const resourceSpans = nested(requiredField(request, 1));
    const resource = nested(requiredField(resourceSpans, 1));
    const scopeSpans = nested(requiredField(resourceSpans, 2));
    const scope = nested(requiredField(scopeSpans, 1));
    const wireSpan = nested(requiredField(scopeSpans, 2));
    expect(decodeString(requiredField(nested(requiredField(resource, 1)), 1))).toBe("service.name");
    expect(decodeString(requiredField(scope, 1))).toBe("grok-cli");
    expect(bytes(requiredField(wireSpan, 1))).toEqual(span.traceId);
    expect(bytes(requiredField(wireSpan, 2))).toEqual(span.spanId);
    expect(decodeString(requiredField(wireSpan, 5))).toBe("tool.execution");
    expect(fixed64(requiredField(wireSpan, 7))).toBe(10n);
    expect(fixed64(requiredField(wireSpan, 8))).toBe(20n);
    expect(fixed32(requiredField(wireSpan, 16))).toBe(1);
    const wireAttributes = fields(wireSpan, 9).map(decodeAttribute);
    expect(wireAttributes).toEqual([
      ["tool_name", "read_file"],
      ["success", true],
      ["tool_result_size_bytes", 128n],
      ["ratio", 1.5],
    ]);
  });

  it("rejects malformed IDs and reversed times instead of emitting invalid OTLP", () => {
    expect(() => encodeGrokBuildOtlpExport({
      resource: [],
      scope: { name: "grok-cli" },
      spans: [sampleSpan({ traceId: new Uint8Array(15) })],
    })).toThrow("traceId must be 16 bytes");
    expect(() => encodeGrokBuildOtlpExport({
      resource: [],
      scope: { name: "grok-cli" },
      spans: [sampleSpan({ startTimeUnixNano: 21n, endTimeUnixNano: 20n })],
    })).toThrow("precedes startTimeUnixNano");
  });

  it("produces source-named browser spans without retaining prompt/tool content", () => {
    let now = 100n;
    let seed = 1;
    const producer = new GrokBuildAgentTraceProducer({
      sessionId: "sess-browser",
      modelId: "grok-4.6",
      responsesEndpoint: "https://api.x.ai/v1/responses?private=CANARY",
      nowUnixNano: () => now++,
      randomBytes: (length) => Uint8Array.from({ length }, () => seed++ & 0xff),
    });
    producer.record({ type: "run_start", task: "private prompt CANARY_TASK" });
    producer.record({ type: "turn_start", turn: 1 });
    producer.record({ type: "assistant", turn: 1, text: "private answer", reasoning: "private reasoning" });
    producer.record({ type: "tool_start", turn: 1, call: { callId: "call-1", name: "read_file", arguments: "{\"path\":\"CANARY_ARG\"}" } });
    producer.record({ type: "tool_end", turn: 1, call: { callId: "call-1", name: "read_file", arguments: "{}" }, result: { output: "CANARY_OUTPUT" } });
    producer.record({ type: "complete", turn: 1, text: "private final" });
    const spans = producer.finish();

    expect(spans.map(({ name }) => name)).toEqual([
      "session.spawn",
      "session.prepare_chat_completion",
      "tool.register",
      "tool.decision",
      "tools.execute",
      "fs.read_file",
      "tool.read_file",
      "tool.execution",
      "session.process_conversation_turn",
      "session.process_conversation_turn_with_recovery",
      "send_xai_notification_with_extra_meta",
      "feedback.maybe_request_feedback",
      "send_turn_delta_with_snapshot",
      "http.create_response_stream",
      "session.handle_prompt",
      "session",
    ]);
    const tool = spans.find(({ name }) => name === "tool.execution");
    expect(tool?.attributes).toContainEqual({ key: "tool_input_size_bytes", value: 21 });
    expect(tool?.attributes).toContainEqual({ key: "tool_result_size_bytes", value: 13 });
    const serialized = stringifyBigInt(spans);
    expect(serialized).not.toContain("CANARY_TASK");
    expect(serialized).not.toContain("CANARY_ARG");
    expect(serialized).not.toContain("CANARY_OUTPUT");

    const request = createGrokBuildBrowserTraceExport({
      clientName: "grok-browser",
      clientVersion: "1.2.3",
      serviceVersion: "1.2.3+9684fa3c",
      appEntrypoint: "agent",
      spans,
    });
    expect(request.resource).toEqual([
      { key: "service.name", value: "grok-cli" },
      { key: "service.version", value: "1.2.3+9684fa3c" },
      { key: "client.name", value: "grok-browser" },
      { key: "client.version", value: "1.2.3" },
      { key: "app.entrypoint", value: "agent" },
    ]);

    const limited = new GrokBuildAgentTraceProducer({
      sessionId: "sess-limit",
      modelId: "grok-4.6",
      responsesEndpoint: "/api/grok/responses",
    });
    limited.record({ type: "run_start", task: "task" });
    limited.record({ type: "turn_start", turn: 1 });
    limited.record({ type: "tool_start", turn: 1, call: { callId: "limit-call", name: "list_dir", arguments: "{}" } });
    limited.record({ type: "tool_end", turn: 1, call: { callId: "limit-call", name: "list_dir", arguments: "{}" }, result: { output: "ok" } });
    limited.record({ type: "limit", turns: 1 });
    const limitSpans = limited.finish();
    expect(limitSpans.map(({ name }) => name)).not.toEqual(expect.arrayContaining([
      "feedback.maybe_request_feedback", "send_turn_delta_with_snapshot", "send_xai_notification_with_extra_meta",
    ]));
    expect(limitSpans.find(({ name }) => name === "session.process_conversation_turn")?.attributes)
      .toEqual(expect.arrayContaining([
        { key: "response.has_tool_call", value: true },
        { key: "stop_reason", value: "tool_calls" },
      ]));
  });

  it("produces the native MCP connection and tool-call span projections", () => {
    let now = 1n;
    let seed = 1;
    const tracer = new GrokBuildBrowserOtlpTracer({
      nowUnixNano: () => now++,
      randomBytes: (length) => Uint8Array.from({ length }, () => seed++ & 0xff),
    });
    recordGrokBuildMcpConnectionSpan(tracer, {
      status: "connected",
      serverName: "linear",
      transportType: "http",
      serverScope: "project",
      durationMs: 17,
      toolCount: 4,
    });
    const call = startGrokBuildMcpToolCallSpan(tracer, { serverName: "linear", toolName: "create_issue" });
    endGrokBuildMcpToolCallSpan(tracer, call, { reconnectAttempted: true, authRetryAttempted: false });
    expect(tracer.drain().map(({ name, attributes }) => ({ name, attributes }))).toEqual([
      {
        name: "mcp.server_connection",
        attributes: [
          { key: "status", value: "connected" },
          { key: "server_name", value: "linear" },
          { key: "transport_type", value: "http" },
          { key: "server_scope", value: "project" },
          { key: "duration_ms", value: 17 },
          { key: "tool_count", value: 4 },
        ],
      },
      {
        name: "mcp.tool_call",
        attributes: [
          { key: "server_name", value: "linear" },
          { key: "tool_name", value: "create_issue" },
          { key: "reconnect", value: true },
          { key: "auth_retry", value: false },
        ],
      },
    ]);
  });
});

function sampleSpan(overrides: Partial<GrokBuildOtlpSpan> = {}): GrokBuildOtlpSpan {
  return {
    traceId: Uint8Array.from({ length: 16 }, (_, index) => index + 1),
    spanId: Uint8Array.from({ length: 8 }, (_, index) => index + 30),
    name: "test",
    kind: 1,
    startTimeUnixNano: 10n,
    endTimeUnixNano: 20n,
    attributes: [],
    ...overrides,
  };
}

type Field = { number: number; wire: 0; value: bigint } | { number: number; wire: 1; value: bigint }
  | { number: number; wire: 2; value: Uint8Array } | { number: number; wire: 5; value: number };

function decodeMessage(bytesValue: Uint8Array): Field[] {
  const output: Field[] = [];
  let offset = 0;
  while (offset < bytesValue.length) {
    const tag = readVarint(bytesValue, offset);
    offset = tag.offset;
    const number = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (wire === 0) {
      const value = readVarint(bytesValue, offset);
      output.push({ number, wire: 0, value: value.value });
      offset = value.offset;
    } else if (wire === 1) {
      if (offset + 8 > bytesValue.length) throw new Error("truncated fixed64");
      let value = 0n;
      for (let index = 0; index < 8; index++) value |= BigInt(bytesValue[offset + index]!) << BigInt(index * 8);
      output.push({ number, wire: 1, value });
      offset += 8;
    } else if (wire === 2) {
      const length = readVarint(bytesValue, offset);
      offset = length.offset;
      const end = offset + Number(length.value);
      if (end > bytesValue.length) throw new Error("truncated bytes");
      output.push({ number, wire: 2, value: bytesValue.slice(offset, end) });
      offset = end;
    } else if (wire === 5) {
      if (offset + 4 > bytesValue.length) throw new Error("truncated fixed32");
      const view = new DataView(bytesValue.buffer, bytesValue.byteOffset + offset, 4);
      output.push({ number, wire: 5, value: view.getUint32(0, true) });
      offset += 4;
    } else throw new Error(`unsupported wire type ${wire}`);
  }
  return output;
}

function readVarint(input: Uint8Array, initialOffset: number): { value: bigint; offset: number } {
  let value = 0n;
  let shift = 0n;
  let offset = initialOffset;
  for (;;) {
    const byte = input[offset++];
    if (byte === undefined) throw new Error("truncated varint");
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7n;
  }
}

function fields(input: Field[], number: number): Field[] {
  return input.filter((field) => field.number === number);
}

function requiredField(input: Field[], number: number): Field {
  const field = fields(input, number)[0];
  if (field === undefined) throw new Error(`missing field ${number}`);
  return field;
}

function bytes(field: Field): Uint8Array {
  if (field.wire !== 2) throw new Error("expected bytes");
  return field.value;
}

function nested(field: Field): Field[] {
  return decodeMessage(bytes(field));
}

function decodeString(field: Field): string {
  return new TextDecoder().decode(bytes(field));
}

function fixed64(field: Field): bigint {
  if (field.wire !== 1) throw new Error("expected fixed64");
  return field.value;
}

function fixed32(field: Field): number {
  if (field.wire !== 5) throw new Error("expected fixed32");
  return field.value;
}

function decodeAttribute(field: Field): [string, string | boolean | bigint | number] {
  const keyValue = nested(field);
  const key = decodeString(requiredField(keyValue, 1));
  const anyValue = nested(requiredField(keyValue, 2));
  const value = anyValue[0];
  if (value === undefined) throw new Error("missing AnyValue");
  if (value.number === 1) return [key, decodeString(value)];
  if (value.number === 2 && value.wire === 0) return [key, value.value !== 0n];
  if (value.number === 3 && value.wire === 0) return [key, value.value];
  if (value.number === 4 && value.wire === 1) {
    const data = new ArrayBuffer(8);
    const view = new DataView(data);
    let raw = value.value;
    for (let index = 0; index < 8; index++) {
      view.setUint8(index, Number(raw & 0xffn));
      raw >>= 8n;
    }
    return [key, view.getFloat64(0, true)];
  }
  throw new Error(`unsupported AnyValue field ${value.number}`);
}

function stringifyBigInt(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item);
}
