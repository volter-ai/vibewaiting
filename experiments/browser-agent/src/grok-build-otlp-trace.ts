import type { GrokBuildEvent } from "./grok-build-agent.js";
import type { GrokCompletedResponse } from "../../../src/grok-browser-protocol.js";
import type { GrokBuildMcpTraceSink } from "./grok-build-mcp.js";
import type { GrokBuildOtlpAttribute, GrokBuildOtlpSpan } from "./grok-build-otlp-redaction.js";
import type { GrokBuildOtlpExportRequest } from "./grok-build-otlp-protobuf.js";

export interface GrokBuildBrowserTracerOptions {
  nowUnixNano?: () => bigint;
  randomBytes?: (length: number) => Uint8Array;
}

export interface GrokBuildOpenSpan {
  readonly traceId: Uint8Array;
  readonly spanId: Uint8Array;
  readonly parentSpanId?: Uint8Array;
  readonly name: string;
  readonly startTimeUnixNano: bigint;
  readonly attributes: GrokBuildOtlpAttribute[];
  readonly kind: 0 | 1 | 2 | 3 | 4 | 5;
}

/** Small browser-native span recorder with native OTLP ID/timestamp shapes. */
export class GrokBuildBrowserOtlpTracer {
  private readonly now: () => bigint;
  private readonly random: (length: number) => Uint8Array;
  private readonly completed: GrokBuildOtlpSpan[] = [];

  constructor(options: GrokBuildBrowserTracerOptions = {}) {
    this.now = options.nowUnixNano ?? (() => BigInt(Date.now()) * 1_000_000n);
    this.random = options.randomBytes ?? browserRandomBytes;
  }

  startSpan(options: {
    name: string;
    parent?: GrokBuildOpenSpan;
    traceId?: Uint8Array;
    attributes?: GrokBuildOtlpAttribute[];
    kind?: 0 | 1 | 2 | 3 | 4 | 5;
  }): GrokBuildOpenSpan {
    const traceId = options.parent?.traceId ?? options.traceId ?? this.random(16);
    requireBytes("traceId", traceId, 16);
    const spanId = this.random(8);
    requireBytes("spanId", spanId, 8);
    return {
      traceId: traceId.slice(),
      spanId: spanId.slice(),
      ...(options.parent === undefined ? {} : { parentSpanId: options.parent.spanId.slice() }),
      name: options.name,
      startTimeUnixNano: this.now(),
      attributes: options.attributes?.map(cloneAttribute) ?? [],
      kind: options.kind ?? 1,
    };
  }

  endSpan(
    open: GrokBuildOpenSpan,
    options: {
      attributes?: GrokBuildOtlpAttribute[];
      status?: { code: 0 | 1 | 2; message?: string };
      endTimeUnixNano?: bigint;
    } = {},
  ): GrokBuildOtlpSpan {
    const span: GrokBuildOtlpSpan = {
      traceId: open.traceId.slice(),
      spanId: open.spanId.slice(),
      ...(open.parentSpanId === undefined ? {} : { parentSpanId: open.parentSpanId.slice() }),
      name: open.name,
      kind: open.kind,
      startTimeUnixNano: open.startTimeUnixNano,
      endTimeUnixNano: options.endTimeUnixNano ?? this.now(),
      attributes: [...open.attributes.map(cloneAttribute), ...(options.attributes ?? []).map(cloneAttribute)],
      flags: 1,
      ...(options.status === undefined ? {} : { status: { ...options.status } }),
    };
    this.completed.push(span);
    return span;
  }

  instantSpan(options: Parameters<GrokBuildBrowserOtlpTracer["startSpan"]>[0]): GrokBuildOtlpSpan {
    return this.endSpan(this.startSpan(options));
  }

  drain(): GrokBuildOtlpSpan[] {
    return this.completed.splice(0, this.completed.length);
  }
}

/** Native `mcp.server_connection` closed-span projection. */
export function recordGrokBuildMcpConnectionSpan(
  tracer: GrokBuildBrowserOtlpTracer,
  options: {
    parent?: GrokBuildOpenSpan;
    status: string;
    serverName: string;
    transportType: string;
    serverScope: string;
    durationMs?: number;
    toolCount?: number;
    errorType?: string;
  },
): GrokBuildOtlpSpan {
  return tracer.instantSpan({
    name: "mcp.server_connection",
    ...(options.parent === undefined ? {} : { parent: options.parent }),
    attributes: [
      { key: "status", value: options.status },
      { key: "server_name", value: options.serverName },
      { key: "transport_type", value: options.transportType },
      { key: "server_scope", value: options.serverScope },
      ...(options.durationMs === undefined ? [] : [{ key: "duration_ms", value: options.durationMs }]),
      ...(options.toolCount === undefined ? [] : [{ key: "tool_count", value: options.toolCount }]),
      ...(options.errorType === undefined ? [] : [{ key: "error_type", value: options.errorType }]),
    ],
  });
}

/** Native `mcp.tool_call`; dispatch outcomes record reconnect/auth-retry only. */
export function startGrokBuildMcpToolCallSpan(
  tracer: GrokBuildBrowserOtlpTracer,
  options: { parent?: GrokBuildOpenSpan; serverName: string; toolName: string },
): GrokBuildOpenSpan {
  return tracer.startSpan({
    name: "mcp.tool_call",
    ...(options.parent === undefined ? {} : { parent: options.parent }),
    attributes: [
      { key: "server_name", value: options.serverName },
      { key: "tool_name", value: options.toolName },
    ],
  });
}

export function endGrokBuildMcpToolCallSpan(
  tracer: GrokBuildBrowserOtlpTracer,
  span: GrokBuildOpenSpan,
  outcome: { reconnectAttempted: boolean; authRetryAttempted: boolean },
): GrokBuildOtlpSpan {
  return tracer.endSpan(span, { attributes: [
    { key: "reconnect", value: outcome.reconnectAttempted },
    { key: "auth_retry", value: outcome.authRetryAttempted },
  ] });
}

/** Optional adapter injected into `GrokBuildMcpRegistry`; it owns no transport or timers. */
export function createGrokBuildMcpOtlpTraceSink(
  tracer: GrokBuildBrowserOtlpTracer,
  parent?: GrokBuildOpenSpan,
): GrokBuildMcpTraceSink {
  return {
    recordConnection(event) {
      recordGrokBuildMcpConnectionSpan(tracer, {
        ...(parent === undefined ? {} : { parent }),
        ...event,
      });
    },
    startToolCall(event) {
      const span = startGrokBuildMcpToolCallSpan(tracer, {
        ...(parent === undefined ? {} : { parent }),
        ...event,
      });
      return {
        end(outcome) {
          endGrokBuildMcpToolCallSpan(tracer, span, outcome);
        },
      };
    },
  };
}

export interface GrokBuildAgentTraceProducerOptions extends GrokBuildBrowserTracerOptions {
  sessionId: string;
  modelId: string;
  responsesEndpoint: string;
  tracer?: GrokBuildBrowserOtlpTracer;
  clientType?: "GrokPager" | "Generic";
  querySource?: "main" | "subagent";
  agentName?: string;
  reasoningEffort?: string;
  subagentType?: string;
}

/**
 * Produces the native span subset whose lifecycle exists in the browser event
 * stream. It intentionally never serializes prompt, reasoning, arguments, or
 * tool output content.
 */
export class GrokBuildAgentTraceProducer {
  readonly tracer: GrokBuildBrowserOtlpTracer;
  private readonly session: GrokBuildOpenSpan;
  private prompt: GrokBuildOpenSpan | undefined;
  private response: GrokBuildOpenSpan | undefined;
  private readonly tools = new Map<string, GrokBuildOpenSpan>();
  private runHadTool = false;
  private finished = false;

  constructor(private readonly options: GrokBuildAgentTraceProducerOptions) {
    this.tracer = options.tracer ?? new GrokBuildBrowserOtlpTracer(options);
    this.session = this.tracer.startSpan({
      name: "session",
      attributes: [{ key: "session_id", value: options.sessionId }],
    });
    this.tracer.instantSpan({
      name: "session.spawn",
      parent: this.session,
      attributes: [
        { key: "client_type", value: options.clientType ?? "Generic" },
        { key: "start_type", value: "new" },
      ],
    });
    this.tracer.instantSpan({ name: "session.prepare_chat_completion", parent: this.session });
    if (options.subagentType) {
      this.tracer.instantSpan({
        name: "subagent.handle_request",
        parent: this.session,
        attributes: [{ key: "subagent_type", value: options.subagentType }],
      });
    }
  }

  record(event: GrokBuildEvent): void {
    if (event.type === "run_start") {
      this.closePrompt();
      this.runHadTool = false;
      this.prompt = this.tracer.startSpan({
        name: "session.handle_prompt",
        parent: this.session,
        attributes: [
          { key: "session_id", value: this.options.sessionId },
          { key: "prompt_length", value: new TextEncoder().encode(event.task).byteLength },
        ],
      });
    } else if (event.type === "turn_start") {
      this.closeResponse(false);
      this.response = this.startResponse();
    } else if (event.type === "response_end") {
      // Title, summary, and compaction samples do not emit turn_start, but the
      // native sampler still creates the same HTTP response-stream span.
      if (this.response === undefined) this.response = this.startResponse();
      this.closeResponse(true);
      if (event.kind === "foreground") this.recordTokenUsage(event.response);
    } else if (event.type === "tool_start") {
      this.runHadTool = true;
      this.tracer.instantSpan({ name: "tool.register", parent: this.prompt ?? this.session });
      this.tracer.instantSpan({
        name: "tool.decision",
        parent: this.prompt ?? this.session,
        attributes: [
          { key: "decision", value: "allow" },
          { key: "source", value: "config" },
          { key: "tool_name", value: event.call.name },
        ],
      });
      if (event.call.name !== "spawn_subagent") {
        this.tracer.instantSpan({
          name: "tools.execute",
          parent: this.prompt ?? this.session,
          attributes: [{ key: "model_id", value: this.options.modelId }],
        });
      }
      this.recordToolInnerSpan(event.call.name, event.call.arguments);
      this.tools.set(event.call.callId, this.tracer.startSpan({
        name: "tool.execution",
        parent: this.prompt ?? this.session,
        attributes: [
          { key: "session_id", value: this.options.sessionId },
          { key: "tool_name", value: event.call.name },
          { key: "tool_use_id", value: event.call.callId },
          { key: "tool_call_id", value: event.call.callId },
          { key: "retry", value: false },
          { key: "tool_input_size_bytes", value: new TextEncoder().encode(event.call.arguments).byteLength },
        ],
      }));
    } else if (event.type === "tool_end") {
      const span = this.tools.get(event.call.callId);
      if (span !== undefined) {
        const success = event.result.isError !== true;
        this.tracer.endSpan(span, { attributes: [
          { key: "success", value: success },
          { key: "outcome", value: success ? "success" : "error" },
          { key: "tool_result_size_bytes", value: new TextEncoder().encode(event.result.output).byteLength },
        ] });
        this.tools.delete(event.call.callId);
      }
    } else if (event.type === "complete" || event.type === "limit") {
      this.recordRunCompletion();
      this.closePrompt();
    }
  }

  finish(): GrokBuildOtlpSpan[] {
    if (this.finished) return this.tracer.drain();
    this.closePrompt();
    this.tracer.endSpan(this.session);
    this.finished = true;
    return this.tracer.drain();
  }

  /** Drain spans completed at a turn boundary while keeping the session open. */
  drain(): GrokBuildOtlpSpan[] {
    return this.tracer.drain();
  }

  /** Close an interrupted prompt without ending the reusable agent session. */
  interrupt(): GrokBuildOtlpSpan[] {
    this.closePrompt();
    return this.tracer.drain();
  }

  private startResponse(): GrokBuildOpenSpan {
    return this.tracer.startSpan({
      name: "http.create_response_stream",
      parent: this.prompt ?? this.session,
      attributes: [
        { key: "endpoint", value: this.options.responsesEndpoint },
        { key: "model_id", value: this.options.modelId },
      ],
    });
  }

  private closeResponse(success: boolean): void {
    if (this.response === undefined) return;
    this.tracer.endSpan(this.response, {
      attributes: [
        { key: "success", value: success },
        ...(success ? [{ key: "status_code", value: 200 }] : []),
      ],
      ...(success ? {} : { status: { code: 2 as const, message: "response stream did not complete" } }),
    });
    this.response = undefined;
  }

  private closePrompt(): void {
    this.closeResponse(false);
    for (const span of this.tools.values()) {
      this.tracer.endSpan(span, {
        attributes: [{ key: "success", value: false }, { key: "outcome", value: "error" }],
        status: { code: 2, message: "tool call did not complete" },
      });
    }
    this.tools.clear();
    if (this.prompt !== undefined) this.tracer.endSpan(this.prompt);
    this.prompt = undefined;
  }

  private recordRunCompletion(): void {
    const parent = this.prompt ?? this.session;
    this.tracer.instantSpan({
      name: "session.process_conversation_turn",
      parent,
      attributes: [
        { key: "agent.name", value: this.options.agentName ?? "grok-build-plan" },
        { key: "effort", value: this.options.reasoningEffort ?? "high" },
        { key: "model_id", value: this.options.modelId },
        { key: "query_source", value: this.options.querySource ?? "main" },
        { key: "response.has_tool_call", value: this.runHadTool },
        { key: "stop_reason", value: "stop" },
      ],
    });
    for (const name of [
      "session.process_conversation_turn_with_recovery",
      "send_xai_notification_with_extra_meta",
      "feedback.maybe_request_feedback",
      "send_turn_delta_with_snapshot",
    ]) this.tracer.instantSpan({ name, parent });
  }

  private recordTokenUsage(response: GrokCompletedResponse): void {
    const usage = response.usage;
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) return;
    const record = usage as Record<string, unknown>;
    const details = record.output_tokens_details;
    const reasoning = details && typeof details === "object" && !Array.isArray(details)
      ? numericAttribute((details as Record<string, unknown>).reasoning_tokens)
      : undefined;
    const completion = numericAttribute(record.output_tokens);
    this.tracer.instantSpan({
      name: "record_token_usage",
      parent: this.prompt ?? this.session,
      attributes: [
        ...(completion === undefined ? [] : [{ key: "completion_tokens", value: completion }]),
        ...(reasoning === undefined ? [] : [{ key: "reasoning_tokens", value: reasoning }]),
      ],
    });
  }

  private recordToolInnerSpan(name: string, argumentsJson: string): void {
    const parent = this.prompt ?? this.session;
    if (name === "spawn_subagent") {
      const parsed = parseArguments(argumentsJson);
      this.tracer.instantSpan({
        name: "tool.task",
        parent,
        attributes: typeof parsed.subagent_type === "string" ? [{ key: "subagent_type", value: parsed.subagent_type }] : [],
      });
    } else if (name === "get_command_or_subagent_output") {
      this.tracer.instantSpan({ name: "tool.get_task_output", parent });
    } else if (name === "read_file") {
      const parsed = parseArguments(argumentsJson);
      this.tracer.instantSpan({ name: "fs.read_file", parent });
      this.tracer.instantSpan({
        name: "tool.read_file",
        parent,
        attributes: typeof parsed.target_file === "string" ? [{ key: "path", value: parsed.target_file }] : [],
      });
    }
  }
}

function numericAttribute(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function createGrokBuildBrowserTraceExport(options: {
  clientName: string;
  clientVersion: string;
  serviceVersion: string;
  appEntrypoint: string;
  spans: GrokBuildOtlpSpan[];
}): GrokBuildOtlpExportRequest {
  return {
    resource: [
      { key: "service.name", value: "grok-cli" },
      { key: "service.version", value: options.serviceVersion },
      { key: "client.name", value: options.clientName },
      { key: "client.version", value: options.clientVersion },
      { key: "app.entrypoint", value: options.appEntrypoint },
    ],
    scope: { name: "grok-cli" },
    spans: options.spans,
  };
}

function browserRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function cloneAttribute(attribute: GrokBuildOtlpAttribute): GrokBuildOtlpAttribute {
  const value = Array.isArray(attribute.value) ? [...attribute.value] : attribute.value;
  return { key: attribute.key, value: value as GrokBuildOtlpAttribute["value"] };
}

function requireBytes(name: string, value: Uint8Array, length: number): void {
  if (value.byteLength !== length) throw new RangeError(`${name} must be ${length} bytes`);
}
