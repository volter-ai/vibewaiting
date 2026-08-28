// Copyright 2023-2026 SpaceXAI
// Modified for the Vibewaiting browser port, 2026.

import type { GrokBuildEvent } from "./grok-build-agent.js";
import type { GrokCompletedResponse, GrokInferenceLatencyStats } from "../../../src/grok-browser-protocol.js";
import { encodeGrokBuildOtlpExport } from "./grok-build-otlp-protobuf.js";
import {
  createGrokBuildBrowserTraceExport,
  GrokBuildAgentTraceProducer,
  type GrokBuildAgentTraceProducerOptions,
} from "./grok-build-otlp-trace.js";
import type { GrokBuildOtlpSpan } from "./grok-build-otlp-redaction.js";

export interface GrokBuildFeedbackConfig extends Record<string, unknown> {
  config_id: string;
  config_version: number;
  enabled: boolean;
}

export interface GrokBuildSessionSignals extends Record<string, unknown> {
  clientType: "agent";
  totalTurns: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  toolFailureCount: number;
  compactionCount: number;
  modelsUsed: string[];
  primaryModelId: string;
}

export interface GrokBuildTurnDelta extends Record<string, unknown> {
  clientType: "agent";
  turnNumber: number;
  turnOutcome: string;
}

export interface GrokBuildTelemetryLifecycleOptions {
  client?: GrokBuildTelemetryClient;
  model?: string;
  syncIntervalMs?: number;
  now?: () => number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  signalAssistantCheckpoints?: readonly number[];
  trace?: Omit<GrokBuildAgentTraceProducerOptions, "sessionId" | "modelId"> & {
    clientName?: string;
    clientVersion?: string;
    serviceVersion?: string;
    appEntrypoint?: string;
  };
}

export interface GrokBuildTelemetryClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Browser transport for the native feedback/signals and OTLP HTTP endpoints.
 * Authentication remains relay-owned; the browser never receives the bearer.
 */
export class GrokBuildTelemetryClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: GrokBuildTelemetryClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "/api/grok").replace(/\/$/u, "");
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async loadFeedbackConfig(signal?: AbortSignal): Promise<GrokBuildFeedbackConfig> {
    const value = await this.sendJson(`${this.baseUrl}/feedback/config`, {
      method: "GET",
      ...(signal ? { signal } : {}),
    }, "Fetching feedback config");
    if (!isObject(value)
      || typeof value.config_id !== "string"
      || !Number.isSafeInteger(value.config_version)
      || typeof value.enabled !== "boolean") {
      throw new Error("Fetching feedback config returned an invalid response.");
    }
    return value as GrokBuildFeedbackConfig;
  }

  async updateSignals(sessionId: string, update: GrokBuildSessionSignals, signal?: AbortSignal): Promise<unknown> {
    return this.sendJson(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/signals`, jsonPost(update, signal), "Signals update");
  }

  async sendTurnDelta(sessionId: string, delta: GrokBuildTurnDelta, signal?: AbortSignal): Promise<unknown> {
    return this.sendJson(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/turn-deltas`, jsonPost(delta, signal), "Sending turn delta");
  }

  async exportTraces(payload: Uint8Array, signal?: AbortSignal): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/traces`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-protobuf" },
      body: payload.slice().buffer,
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw await responseError(response, "Exporting traces");
  }

  async exportAgentTraceSpans(
    spans: readonly GrokBuildOtlpSpan[],
    options: { clientName?: string; clientVersion?: string; serviceVersion?: string; appEntrypoint?: string } = {},
    signal?: AbortSignal,
  ): Promise<void> {
    if (spans.length === 0) return;
    await this.exportTraces(encodeGrokBuildOtlpExport(createGrokBuildBrowserTraceExport({
      clientName: options.clientName ?? "grok-browser",
      clientVersion: options.clientVersion ?? "browser-port",
      serviceVersion: options.serviceVersion ?? "browser-port+9684fa3c",
      appEntrypoint: options.appEntrypoint ?? "agent",
      spans: [...spans],
    })), signal);
  }

  private async sendJson(url: string, init: RequestInit, context: string): Promise<unknown> {
    const response = await this.fetchImpl(url, { credentials: "include", ...init });
    if (!response.ok) throw await responseError(response, context);
    if (response.status === 204) return undefined;
    return response.json().catch(() => { throw new Error(`${context} returned invalid JSON.`); });
  }
}

/** Source-ordered zero-value payload emitted by native Grok Build at startup. */
export function createInitialGrokBuildSignals(model = "grok-4.6"): GrokBuildSessionSignals {
  return {
    clientType: "agent",
    totalTurns: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    cancellationCount: 0,
    consecutiveCancellations: 0,
    errorCount: 0,
    toolFailureCount: 0,
    toolCallCount: 0,
    compactionCount: 0,
    regenerationCount: 0,
    editAndRetryCount: 0,
    positiveRatings: 0,
    negativeRatings: 0,
    longPausesCount: 0,
    sessionDurationSeconds: 0,
    modelsUsed: [model],
    primaryModelId: model,
    avgTimeToFirstTokenMs: 0,
    avgResponseTimeMs: 0,
    minTimeToFirstTokenMs: 0,
    maxTimeToFirstTokenMs: 0,
    latencySampleCount: 0,
    totalChunkCount: 0,
    itlSampleCount: 0,
    agentLinesAdded: 0,
    agentLinesRemoved: 0,
    agentLinesAddedReverted: 0,
    agentLinesRemovedReverted: 0,
    humanLinesAdded: 0,
    humanLinesRemoved: 0,
    humanLinesAddedReverted: 0,
    humanLinesRemovedReverted: 0,
    agentFilesTouched: 0,
    humanFilesTouched: 0,
    totalFilesTouched: 0,
    inferenceIdleTimeouts: 0,
    inferenceIdleTimeoutConfiguredSecs: 3600,
    doomLoopRecoveryFired: false,
    doomLoopRecoveryAttempts: 0,
    doomLoopRecoveryAcceptedAfterBudget: 0,
    doomLoopRecoveryAbortedChunks: 0,
    gcsQueueEnqueued: 0,
    gcsQueueUploaded: 0,
    gcsQueueFailed: 0,
    gcsQueueFallbacks: 0,
    gcsQueueCircuitBreakerTrips: 0,
    gcsQueuePending: 0,
    gcsQueuePendingBytes: 0,
    gcsQueueOrphansCleaned: 0,
  };
}

/** Deterministic session counters; latency/ITL measurements are supplied separately. */
export class GrokBuildSignalTracker {
  private readonly startedAt: number;
  private readonly tools = new Set<string>();
  private readonly latency: Array<{ ttfb: number; ttlb: number }> = [];
  private readonly itlIntervals: number[] = [];
  private totalChunkCount = 0;
  private itlSampleCount = 0;
  private totalTurns = 0;
  private userMessages = 0;
  private assistantMessages = 0;
  private toolCalls = 0;
  private toolFailures = 0;
  private compactions = 0;
  private totalTokensBeforeCompaction = 0;
  private errors = 0;
  private cancellations = 0;
  private longPauses = 0;
  private consecutiveCancellations = 0;
  private lastTurnAt: number | undefined;
  private turnStartedAt: number | undefined;
  private turnBaseline = zeroTurnBaseline();
  private turnTools = new Set<string>();
  private turnToolOutcomes = new Map<string, { successes: number; failures: number }>();
  private turnItlIntervals: number[] = [];
  private turnTtfb: number | undefined;
  private turnTtlb: number | undefined;
  private responseTokens: number | undefined;
  private thinkingTokens: number | undefined;
  private modelFingerprint: string | undefined;
  private contextTokensUsed = 0;
  private contextWindowTokens = 500_000;
  private pendingCompactionTokens: number | undefined;

  constructor(private readonly model = "grok-4.6", private readonly now = () => Date.now()) {
    this.startedAt = now();
  }

  record(event: GrokBuildEvent): void {
    if (event.type === "run_start") {
      const now = this.now();
      if (this.lastTurnAt !== undefined && now - this.lastTurnAt >= 60_000) {
        this.longPauses += 1;
        this.turnBaseline.longPauses += 1;
      }
      this.lastTurnAt = now;
      this.turnStartedAt = now;
      this.totalTurns += 1;
      this.userMessages += 1;
      this.resetPerTurn();
    }
    else if (event.type === "assistant") this.assistantMessages += 1;
    else if (event.type === "response_end" && event.kind === "foreground") this.recordResponse(event.response, event.metrics);
    else if (event.type === "tool_end") {
      this.toolCalls += 1;
      this.tools.add(event.call.name);
      this.turnTools.add(event.call.name);
      const outcome = this.turnToolOutcomes.get(event.call.name) ?? { successes: 0, failures: 0 };
      if (event.result.isError) {
        this.toolFailures += 1;
        this.errors += 1;
        outcome.failures += 1;
      } else outcome.successes += 1;
      this.turnToolOutcomes.set(event.call.name, outcome);
    } else if (event.type === "compaction_start") {
      this.pendingCompactionTokens = event.tokens;
    } else if (event.type === "compaction_end") {
      this.compactions = event.compactions;
      this.totalTokensBeforeCompaction += this.pendingCompactionTokens ?? 0;
      this.pendingCompactionTokens = undefined;
    }
  }

  snapshot(now = Date.now()): GrokBuildSessionSignals {
    return {
      ...createInitialGrokBuildSignals(this.model),
      totalTurns: this.totalTurns,
      userMessageCount: this.userMessages,
      assistantMessageCount: this.assistantMessages,
      errorCount: this.errors,
      cancellationCount: this.cancellations,
      consecutiveCancellations: this.consecutiveCancellations,
      longPausesCount: this.longPauses,
      toolCallCount: this.toolCalls,
      toolFailureCount: this.toolFailures,
      compactionCount: this.compactions,
      sessionDurationSeconds: Math.max(0, Math.floor((now - this.startedAt) / 1_000)),
      ...(this.tools.size > 0 ? { toolsUsed: [...this.tools] } : {}),
      ...this.sessionLatencyFields(),
    };
  }

  ensureLongPauses(count: number): void {
    if (!Number.isSafeInteger(count) || count <= this.longPauses) return;
    const delta = count - this.longPauses;
    this.longPauses = count;
    this.turnBaseline.longPauses += delta;
  }

  takeTurnDelta(outcome: "completed" | "cancelled" | "error", requestId?: string, now = this.now()): GrokBuildTurnDelta {
    if (outcome === "cancelled") {
      this.cancellations += 1;
      this.consecutiveCancellations += 1;
    } else {
      if (outcome === "error") this.errors += 1;
      this.consecutiveCancellations = 0;
    }
    const current = this.snapshot(now);
    const successful = this.toolCalls - this.turnBaseline.toolCalls - (this.toolFailures - this.turnBaseline.toolFailures);
    const sortedItl = [...this.turnItlIntervals].sort((left, right) => left - right);
    const outcomes = [...this.turnToolOutcomes].sort(([left], [right]) => left.localeCompare(right)).map(([toolName, counts]) => ({ toolName, ...counts }));
    const delta: GrokBuildTurnDelta = {
      clientType: "agent",
      turnNumber: this.totalTurns,
      deltaToolCalls: this.toolCalls - this.turnBaseline.toolCalls,
      deltaToolFailures: this.toolFailures - this.turnBaseline.toolFailures,
      deltaErrors: this.errors - this.turnBaseline.errors,
      deltaCancellations: this.cancellations - this.turnBaseline.cancellations,
      deltaRegenerations: 0,
      deltaCompactions: this.compactions - this.turnBaseline.compactions,
      deltaEditAndRetries: 0,
      deltaPositiveRatings: 0,
      deltaNegativeRatings: 0,
      deltaAssistantMessages: this.assistantMessages - this.turnBaseline.assistantMessages,
      deltaLongPauses: this.turnBaseline.longPauses,
      deltaSuccessfulToolUses: successful,
      consecutiveCancellations: this.consecutiveCancellations,
      ...(this.turnTtfb === undefined ? {} : { timeToFirstTokenMs: this.turnTtfb }),
      ...(this.turnTtlb === undefined ? {} : { totalResponseTimeMs: this.turnTtlb }),
      ...itlFields(sortedItl, false),
      contextWindowUsage: Math.min(100, Math.floor(this.contextTokensUsed * 100 / this.contextWindowTokens)),
      modelId: this.model,
      turnDurationMs: Math.max(0, Math.floor(now - (this.turnStartedAt ?? now))),
      turnOutcome: outcome,
      ...(this.modelFingerprint ? { modelFingerprint: this.modelFingerprint } : {}),
      ...(this.turnTools.size > 0 ? { toolsUsedThisTurn: [...this.turnTools].sort().slice(0, 100) } : {}),
      ...(outcomes.length > 0 ? { toolOutcomes: JSON.stringify(outcomes) } : {}),
      cumulativeToolCalls: this.toolCalls,
      cumulativeErrors: this.errors,
      sessionDurationSeconds: current.sessionDurationSeconds,
      totalTokensBeforeCompaction: this.totalTokensBeforeCompaction,
      metadata: { startPromptMode: "agent", endPromptMode: "agent" },
      ...(requestId ? { requestId } : {}),
      feedbackRequestsSent: 0,
      ...(this.responseTokens === undefined ? {} : { responseTokens: this.responseTokens }),
      ...(this.thinkingTokens === undefined ? {} : { thinkingTokens: this.thinkingTokens }),
      deltaAgentLinesAdded: 0,
      deltaAgentLinesRemoved: 0,
      deltaAgentLinesAddedReverted: 0,
      deltaAgentLinesRemovedReverted: 0,
      deltaHumanLinesAdded: 0,
      deltaHumanLinesRemoved: 0,
      deltaHumanLinesAddedReverted: 0,
      deltaHumanLinesRemovedReverted: 0,
      deltaAgentFilesTouched: 0,
      deltaHumanFilesTouched: 0,
      deltaTotalFilesTouched: 0,
      locTrackingEnabled: false,
    };
    this.turnBaseline = {
      toolCalls: this.toolCalls,
      toolFailures: this.toolFailures,
      errors: this.errors,
      cancellations: this.cancellations,
      compactions: this.compactions,
      assistantMessages: this.assistantMessages,
      longPauses: 0,
    };
    return delta;
  }

  private resetPerTurn(): void {
    this.turnTools.clear();
    this.turnToolOutcomes.clear();
    this.turnItlIntervals = [];
    this.turnTtfb = undefined;
    this.turnTtlb = undefined;
    this.responseTokens = undefined;
    this.thinkingTokens = undefined;
    this.modelFingerprint = undefined;
  }

  private recordResponse(response: GrokCompletedResponse, metrics: GrokInferenceLatencyStats): void {
    if (metrics.timeToFirstTokenMs !== undefined) {
      this.turnTtfb = metrics.timeToFirstTokenMs;
      this.turnTtlb = metrics.timeToLastByteMs;
      this.latency.push({ ttfb: metrics.timeToFirstTokenMs, ttlb: metrics.timeToLastByteMs });
    }
    if (metrics.itlIntervalsMs.length > 0) {
      this.itlIntervals.push(...metrics.itlIntervalsMs);
      this.turnItlIntervals.push(...metrics.itlIntervalsMs);
      this.totalChunkCount += metrics.chunkCount;
      this.itlSampleCount += 1;
    }
    const usage = objectValue(response.usage);
    const output = integerValue(usage?.output_tokens);
    const reasoning = integerValue(objectValue(usage?.output_tokens_details)?.reasoning_tokens);
    if (output !== undefined) {
      this.responseTokens = (this.responseTokens ?? 0) + Math.max(0, output - (reasoning ?? 0));
      this.thinkingTokens = (this.thinkingTokens ?? 0) + (reasoning ?? 0);
    }
    this.contextTokensUsed = integerValue(usage?.total_tokens) ?? this.contextTokensUsed;
    const metadata = objectValue(response.metadata);
    if (typeof metadata?.system_fingerprint === "string") this.modelFingerprint = metadata.system_fingerprint;
  }

  private sessionLatencyFields(): Record<string, number> {
    if (this.latency.length === 0) return {};
    const ttfb = this.latency.map((sample) => sample.ttfb);
    const ttlb = this.latency.map((sample) => sample.ttlb);
    const fields: Record<string, number> = {
      avgTimeToFirstTokenMs: floorMean(ttfb),
      avgResponseTimeMs: floorMean(ttlb),
      minTimeToFirstTokenMs: Math.min(...ttfb),
      maxTimeToFirstTokenMs: Math.max(...ttfb),
      latencySampleCount: this.latency.length,
    };
    if (this.itlIntervals.length > 0) {
      const sorted = [...this.itlIntervals].sort((left, right) => left - right);
      Object.assign(fields, {
        ...itlFields(sorted, true),
        totalChunkCount: this.totalChunkCount,
        itlSampleCount: this.itlSampleCount,
      });
    }
    return fields;
  }
}

/** Non-blocking browser equivalent of native FeedbackManager's lifecycle. */
export class GrokBuildTelemetryLifecycle {
  readonly tracker: GrokBuildSignalTracker;
  private readonly client: GrokBuildTelemetryClient;
  private readonly syncIntervalMs: number;
  private readonly setIntervalImpl: typeof globalThis.setInterval;
  private readonly clearIntervalImpl: typeof globalThis.clearInterval;
  private interval: ReturnType<typeof globalThis.setInterval> | undefined;
  private boot: Promise<void> | undefined;
  private started = false;
  private stopped = false;
  private pending = new Set<Promise<unknown>>();
  private readonly signalAssistantCheckpoints = new Map<number, number>();
  private readonly traceProducer: GrokBuildAgentTraceProducer | undefined;
  private readonly traceMetadata: Pick<NonNullable<GrokBuildTelemetryLifecycleOptions["trace"]>, "clientName" | "clientVersion" | "serviceVersion" | "appEntrypoint">;

  constructor(readonly sessionId: string, options: GrokBuildTelemetryLifecycleOptions = {}) {
    this.client = options.client ?? new GrokBuildTelemetryClient();
    this.syncIntervalMs = options.syncIntervalMs ?? 60_000;
    this.setIntervalImpl = options.setInterval ?? globalThis.setInterval.bind(globalThis);
    this.clearIntervalImpl = options.clearInterval ?? globalThis.clearInterval.bind(globalThis);
    for (const checkpoint of options.signalAssistantCheckpoints ?? []) {
      this.signalAssistantCheckpoints.set(checkpoint, (this.signalAssistantCheckpoints.get(checkpoint) ?? 0) + 1);
    }
    this.tracker = new GrokBuildSignalTracker(options.model, options.now);
    this.traceProducer = options.trace ? new GrokBuildAgentTraceProducer({
      sessionId,
      modelId: options.model ?? "grok-4.6",
      responsesEndpoint: options.trace.responsesEndpoint,
      ...(options.trace.tracer ? { tracer: options.trace.tracer } : {}),
      ...(options.trace.nowUnixNano ? { nowUnixNano: options.trace.nowUnixNano } : {}),
      ...(options.trace.randomBytes ? { randomBytes: options.trace.randomBytes } : {}),
    }) : undefined;
    this.traceMetadata = options.trace ?? {};
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    const initial = this.tracker.snapshot();
    this.boot = (async () => {
      await this.client.loadFeedbackConfig().catch(() => undefined);
      await this.client.updateSignals(this.sessionId, initial);
    })().catch(() => undefined).finally(() => {
      if (!this.stopped) this.interval = this.setIntervalImpl(() => this.background(this.client.updateSignals(this.sessionId, this.tracker.snapshot())), this.syncIntervalMs);
    });
    this.background(this.boot);
  }

  async ready(): Promise<void> {
    if (!this.started) this.start();
    await this.boot;
  }

  record(event: GrokBuildEvent, requestId?: string): void {
    if (!this.started) this.start();
    // Native's periodic sender can observe a completed tool batch while the
    // next inference request is in flight. During deterministic corpus replay
    // there is no wall-clock network wait, so reproduce that boundary just
    // before the next foreground response is folded into the counters.
    if (event.type === "response_end" && event.kind === "foreground") {
      const count = this.tracker.snapshot().assistantMessageCount;
      for (let remaining = this.signalAssistantCheckpoints.get(count) ?? 0; remaining > 0; remaining -= 1) {
        this.background(this.client.updateSignals(this.sessionId, this.tracker.snapshot()));
      }
      this.signalAssistantCheckpoints.delete(count);
    }
    this.tracker.record(event);
    this.traceProducer?.record(event);
    if (event.type === "complete" || event.type === "limit") {
      const outcome = event.type === "complete" ? "completed" : "error";
      this.background(this.client.sendTurnDelta(this.sessionId, this.tracker.takeTurnDelta(outcome, requestId)));
      this.exportTraceSpans(this.traceProducer?.drain() ?? []);
    }
  }

  ensureLongPauses(count: number): void {
    this.tracker.ensureLongPauses(count);
  }

  end(outcome: "cancelled" | "error", requestId?: string): void {
    if (!this.started) this.start();
    this.background(this.client.sendTurnDelta(this.sessionId, this.tracker.takeTurnDelta(outcome, requestId)));
    this.exportTraceSpans(this.traceProducer?.interrupt() ?? []);
  }

  async sync(force = false): Promise<void> {
    const snapshot = this.tracker.snapshot();
    if (force && snapshot.totalTurns === 0 && snapshot.toolCallCount === 0) return;
    await this.client.updateSignals(this.sessionId, snapshot);
  }

  /** Emit native signal snapshots whose recorded boundary occurs after the final response fold. */
  async syncPendingSignalCheckpoints(): Promise<number> {
    const snapshot = this.tracker.snapshot();
    const count = this.signalAssistantCheckpoints.get(snapshot.assistantMessageCount) ?? 0;
    if (count === 0) return 0;
    this.signalAssistantCheckpoints.delete(snapshot.assistantMessageCount);
    for (let index = 0; index < count; index += 1) {
      await this.client.updateSignals(this.sessionId, snapshot);
    }
    return count;
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  async shutdown(options: { finalSync?: boolean } = {}): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.boot;
    if (this.interval !== undefined) this.clearIntervalImpl(this.interval);
    if (options.finalSync !== false) {
      await Promise.race([this.sync(true).catch(() => undefined), timeout(2_000)]);
    }
    this.exportTraceSpans(this.traceProducer?.finish() ?? []);
    await this.flush();
  }

  private background(operation: Promise<unknown>): void {
    const safe = operation.catch(() => undefined).finally(() => this.pending.delete(safe));
    this.pending.add(safe);
  }

  private exportTraceSpans(spans: readonly GrokBuildOtlpSpan[]): void {
    if (spans.length === 0) return;
    this.background(this.client.exportAgentTraceSpans(spans, this.traceMetadata));
  }
}

interface TurnBaseline {
  toolCalls: number;
  toolFailures: number;
  errors: number;
  cancellations: number;
  compactions: number;
  assistantMessages: number;
  longPauses: number;
}

function zeroTurnBaseline(): TurnBaseline {
  return { toolCalls: 0, toolFailures: 0, errors: 0, cancellations: 0, compactions: 0, assistantMessages: 0, longPauses: 0 };
}

function itlFields(sorted: readonly number[], session: boolean): Record<string, number> {
  if (sorted.length === 0) return {};
  const prefix = session ? ["lastItlP50Ms", "lastItlP99Ms", "worstItlMaxMs", "avgItlMeanMs"] : ["itlP50Ms", "itlP99Ms", "itlMaxMs", "itlMeanMs"];
  return {
    [prefix[0]!]: sorted[Math.floor(sorted.length / 2)]!,
    [prefix[1]!]: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)]!,
    [prefix[2]!]: sorted[sorted.length - 1]!,
    [prefix[3]!]: floorMean(sorted),
  };
}

function floorMean(values: readonly number[]): number {
  return Math.floor(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function timeout(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function jsonPost(value: unknown, signal?: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
    ...(signal ? { signal } : {}),
  };
}

async function responseError(response: Response, context: string): Promise<Error> {
  const text = await response.text().catch(() => "Unknown error");
  return new Error(`${context} failed with status ${response.status}: ${text || "Unknown error"}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
