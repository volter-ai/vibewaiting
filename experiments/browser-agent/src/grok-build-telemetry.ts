// Copyright 2023-2026 SpaceXAI
// Modified for the Vibewaiting browser port, 2026.

import type { GrokBuildEvent } from "./grok-build-agent.js";

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
  private readonly startedAt = Date.now();
  private readonly tools = new Set<string>();
  private totalTurns = 0;
  private userMessages = 0;
  private assistantMessages = 0;
  private toolCalls = 0;
  private toolFailures = 0;
  private compactions = 0;
  private errors = 0;

  constructor(private readonly model = "grok-4.6") {}

  record(event: GrokBuildEvent): void {
    if (event.type === "run_start") this.userMessages += 1;
    else if (event.type === "assistant") this.assistantMessages += 1;
    else if (event.type === "tool_end") {
      this.toolCalls += 1;
      this.tools.add(event.call.name);
      if (event.result.isError) this.toolFailures += 1;
    } else if (event.type === "compaction_end") {
      this.compactions = event.compactions;
    } else if (event.type === "complete" || event.type === "limit") {
      this.totalTurns += 1;
    } else if (event.type === "retry" && event.attempt === event.maxRetries) {
      this.errors += 1;
    }
  }

  snapshot(now = Date.now()): GrokBuildSessionSignals {
    return {
      ...createInitialGrokBuildSignals(this.model),
      totalTurns: this.totalTurns,
      userMessageCount: this.userMessages,
      assistantMessageCount: this.assistantMessages,
      errorCount: this.errors,
      toolCallCount: this.toolCalls,
      toolFailureCount: this.toolFailures,
      compactionCount: this.compactions,
      sessionDurationSeconds: Math.max(0, Math.floor((now - this.startedAt) / 1_000)),
      ...(this.tools.size > 0 ? { toolsUsed: [...this.tools] } : {}),
    };
  }
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
