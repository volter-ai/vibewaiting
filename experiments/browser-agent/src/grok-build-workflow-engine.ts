// Copyright 2023-2026 SpaceXAI
// SPDX-License-Identifier: Apache-2.0
// Modified for the Vibewaiting browser port, 2026.

import { extractGrokBuildWorkflowMeta } from "./grok-build-workflow-registry.js";

const MAX_HOST_CALLS = 10_000;

export interface GrokBuildWorkflowJournalEntry {
  seq: number;
  kind: string;
  requestHash: string;
  value: unknown;
}

export interface GrokBuildWorkflowHostRequest {
  seq: number;
  kind: string;
  requestHash: string;
  payload: unknown;
  executionId?: string;
}

export interface GrokBuildWorkflowHostEvent {
  kind: "phase" | "log" | "telemetry";
  payload: unknown;
  replayed: boolean;
  executionId?: string;
}

export type GrokBuildRhaiStep = (
  | { type: "host_requests"; requests: GrokBuildWorkflowHostRequest[] }
  | { type: "completed"; result: unknown }
  | { type: "paused"; kind: string; message: string }
  | { type: "budget_exceeded"; message: string }
  | { type: "cancelled" }
  | { type: "failed"; error: string }
) & {
  /** Entries produced without an async host result, notably await_user(). */
  journalEntries?: readonly GrokBuildWorkflowJournalEntry[];
  events?: readonly GrokBuildWorkflowHostEvent[];
};

/** Implemented by the generated upstream-Rhai WASM module. */
export interface GrokBuildRhaiContinuationModule {
  evaluate(input: {
    script: string;
    args: unknown;
    journal: readonly GrokBuildWorkflowJournalEntry[];
    maxOperations: number;
  }): GrokBuildRhaiStep | Promise<GrokBuildRhaiStep>;
}

export interface GrokBuildWorkflowHost {
  call(request: GrokBuildWorkflowHostRequest, signal: AbortSignal): Promise<unknown>;
  event?(event: GrokBuildWorkflowHostEvent): void | Promise<void>;
}

export type GrokBuildWorkflowOutcome =
  | { status: "completed"; result: unknown }
  | { status: "paused"; kind: string; message: string }
  | { status: "budget_exceeded"; message: string }
  | { status: "cancelled" }
  | { status: "failed"; error: string };

export interface GrokBuildWorkflowValidationReport {
  name: string;
  phases: number;
  outcomeSummary: string;
}

export interface GrokBuildWorkflowEngine {
  run(script: string, args: unknown, options: {
    agentBudget: number;
    signal: AbortSignal;
    executionId?: string;
    resume?: boolean;
  }): Promise<GrokBuildWorkflowOutcome>;
  validate(script: string, args: unknown, options: { agentBudget: number; signal: AbortSignal }): Promise<GrokBuildWorkflowValidationReport>;
}

const DEFAULT_PROBE_ARGS = {
  objective: "stub objective", query: "stub query", breadth: 2, target: "stub target",
  skeptic_count: 1, max_verify_attempts: 1, baseline_commit: "", test_command: "cargo test",
  diff_summary: "stub diff", since_commit: "abc123",
};

/**
 * Async browser driver for an upstream Rhai continuation-WASM build.
 *
 * Native xai-workflow already makes every result-bearing host call replayable.
 * A WASM build only needs to replace `blocking_recv` with a yield containing the
 * request. Re-evaluation then consumes this journal exactly as native resume
 * does. A parallel panel is yielded as one request array, preserving its barrier.
 */
export class GrokBuildJournalRhaiEngine implements GrokBuildWorkflowEngine {
  private readonly journals = new Map<string, GrokBuildWorkflowJournalEntry[]>();

  constructor(private readonly module: GrokBuildRhaiContinuationModule, private readonly host: GrokBuildWorkflowHost) {}

  async run(script: string, args: unknown, options: {
    agentBudget: number;
    signal: AbortSignal;
    executionId?: string;
    resume?: boolean;
  }): Promise<GrokBuildWorkflowOutcome> {
    return this.drive(script, args, options);
  }

  async validate(script: string, args: unknown, options: { agentBudget: number; signal: AbortSignal }): Promise<GrokBuildWorkflowValidationReport> {
    const meta = extractGrokBuildWorkflowMeta(script);
    const outcome = await this.drive(script, args ?? DEFAULT_PROBE_ARGS, options, true);
    if (outcome.status === "failed" || outcome.status === "cancelled" || outcome.status === "budget_exceeded") {
      const detail = outcome.status === "failed" ? outcome.error : outcome.status === "budget_exceeded" ? outcome.message : "cancelled";
      throw new Error(`dry-run: ${detail}`);
    }
    const summary = outcome.status === "completed"
      ? `completed: ${truncateSummary(JSON.stringify(outcome.result))}`
      : `paused (${outcome.kind}): ${truncateSummary(outcome.message)}`;
    return { name: meta.name, phases: meta.phases.length, outcomeSummary: summary };
  }

  private async drive(
    script: string,
    args: unknown,
    options: { agentBudget: number; signal: AbortSignal; executionId?: string; resume?: boolean },
    canned = false,
  ): Promise<GrokBuildWorkflowOutcome> {
    const journal = options.executionId && options.resume
      ? [...(this.journals.get(options.executionId) ?? [])]
      : [];
    let spent = journal.filter((entry) => entry.kind === "spawn_agent").length;
    const persist = (): void => {
      if (options.executionId) this.journals.set(options.executionId, [...journal]);
    };
    while (journal.length <= MAX_HOST_CALLS) {
      if (options.signal.aborted) return { status: "cancelled" };
      const step = await this.module.evaluate({ script, args, journal, maxOperations: canned ? 10_000_000 : 100_000_000 });
      if (!canned && this.host.event) {
        await Promise.all((step.events ?? []).map((event) => this.host.event!({
          ...event,
          ...(options.executionId ? { executionId: options.executionId } : {}),
        })));
      }
      for (const entry of step.journalEntries ?? []) {
        if (entry.seq !== journal.length) return { status: "failed", error: `workflow journal is not dense: expected sequence ${journal.length}, found ${entry.seq}` };
        journal.push({ ...entry });
      }
      if (step.journalEntries?.length) persist();
      if (step.type === "completed") return { status: "completed", result: step.result };
      if (step.type === "paused") return { status: "paused", kind: step.kind, message: step.message };
      if (step.type === "budget_exceeded") return { status: "budget_exceeded", message: step.message };
      if (step.type === "cancelled") return { status: "cancelled" };
      if (step.type === "failed") return { status: "failed", error: step.error };
      if (!step.requests.length) return { status: "failed", error: "Rhai continuation yielded no host requests" };
      if (journal.length + step.requests.length > MAX_HOST_CALLS) return { status: "failed", error: `workflow exceeded the maximum of ${MAX_HOST_CALLS} result-bearing host calls` };
      const agentCalls = step.requests.filter((request) => request.kind === "spawn_agent").length;
      if (spent + agentCalls > options.agentBudget) {
        return { status: "budget_exceeded", message: `workflow agent budget exceeded: requested ${spent + agentCalls}, maximum ${options.agentBudget}` };
      }
      spent += agentCalls;
      for (let index = 0; index < step.requests.length; index += 1) {
        if (step.requests[index]!.seq !== journal.length + index) {
          return { status: "failed", error: `workflow journal is not dense: expected sequence ${journal.length + index}, found ${step.requests[index]!.seq}` };
        }
      }
      const values = await Promise.all(step.requests.map(async (request) => {
        if (canned) return cannedHostResult(request, spent, options.agentBudget);
        if (request.kind === "budget") {
          return { total: options.agentBudget, spent, reserved: 0, remaining: Math.max(0, options.agentBudget - spent) };
        }
        const liveRequest = options.executionId ? { ...request, executionId: options.executionId } : request;
        try { return await this.host.call(liveRequest, options.signal); }
        catch (error) {
          if (options.signal.aborted) return { __xai_workflow_parallel_terminal: "cancelled" };
          return { __xai_workflow_host_error: error instanceof Error ? error.message : String(error) };
        }
      }));
      for (let index = 0; index < step.requests.length; index += 1) {
        const request = step.requests[index]!;
        journal.push({ seq: request.seq, kind: request.kind, requestHash: request.requestHash, value: values[index] });
      }
      persist();
    }
    return { status: "failed", error: `workflow exceeded the maximum of ${MAX_HOST_CALLS} result-bearing host calls` };
  }
}

function cannedHostResult(request: GrokBuildWorkflowHostRequest, spent: number, total: number): unknown {
  switch (request.kind) {
    case "spawn_agent": return { agent_id: "stub", success: true, output: { achieved: true, evidence: "stub evidence", questions: ["q1", "q2"], claims: [], uncertainties: [], verdicts: [], failures: ["test_a"], issues: "none", stub: true }, cancelled: false, tokens_used: 1, duration_ms: 1 };
    case "budget": return { total, spent, reserved: 0, remaining: Math.max(0, total - spent) };
    case "render_template": return "stub template";
    case "write_scratch_file": return `scratch/${String((request.payload as { name?: unknown })?.name ?? "file")}`;
    case "read_scratch_file": return "stub content";
    case "git_diff_since": return "";
    default: return null;
  }
}

function truncateSummary(value: string | undefined): string {
  const text = value ?? "null";
  return [...text].length > 200 ? `${[...text].slice(0, 200).join("")}…` : text;
}
