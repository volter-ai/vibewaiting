// Copyright 2023-2026 SpaceXAI
// SPDX-License-Identifier: Apache-2.0
// Modified for the Vibewaiting browser port, 2026.

import type { GrokBuildWorkflowFileSystem } from "./grok-build-workflow-registry.js";
import type { GrokBuildWorkflowHost, GrokBuildWorkflowHostEvent, GrokBuildWorkflowHostRequest } from "./grok-build-workflow-engine.js";
import type { GrokBuildContractVerdict } from "./grok-build-rhai-wasm.js";
import { GrokBuildSubagentAdmission } from "./grok-build-subagent-admission.js";

const MAX_AGENT_PROMPT_BYTES = 1024 * 1024;
const MAX_AGENT_RUNS = 2_048;
const MAX_PHASE_BYTES = 256;
const SCHEMA_CONTRACT_RETRIES = 1;
const MAX_TEMPLATE_OUTPUT_BYTES = 1024 * 1024;
const MAX_SCRATCH_NAME_BYTES = 255;
const MAX_SCRATCH_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SCRATCH_FILES = 64;
const MAX_SCRATCH_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_DIFF_BYTES = 256 * 1024;

interface CommandResult { stdout: string; stderr: string; exitCode: number }

export interface GrokBuildWorkflowSubagentResult {
  childSessionId: string;
  success: boolean;
  output: string;
  error?: string;
  cancelled?: boolean;
  backgrounded?: boolean;
  totalTokensUsed: number;
  durationMs: number;
  toolCalls?: number;
  turns?: number;
  usageIncomplete?: boolean;
}

export interface GrokBuildWorkflowBrowserHostOptions {
  vfs: GrokBuildWorkflowFileSystem;
  workspacePath?: string;
  spawnSubagent(input: Record<string, unknown>, signal: AbortSignal, id: string): Promise<string | GrokBuildWorkflowSubagentResult>;
  runCommand?(command: string, options: { cwd: string; signal: AbortSignal }): Promise<CommandResult>;
  templates?: Readonly<Record<string, string>>;
  allowForkContext?: boolean;
  validateContract?: (schema: unknown, finalText?: string) => GrokBuildContractVerdict;
  onEvent?: (event: GrokBuildWorkflowHostEvent) => void;
  maxConcurrentAgents?: number;
  onAgentLifecycle?: (event: {
    executionId: string;
    phase: "queued" | "started" | "finished";
    active: number;
    queued: number;
    success?: boolean;
  }) => void;
}

function payload(request: GrokBuildWorkflowHostRequest): Record<string, unknown> {
  if (!request.payload || typeof request.payload !== "object" || Array.isArray(request.payload)) throw new Error(`invalid ${request.kind} workflow payload`);
  return request.payload as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function utf8Length(value: string): number { return new TextEncoder().encode(value).byteLength; }

function contractPrompt(prompt: string, schema: unknown): string {
  return `${prompt}\n\n<output-contract>\nDo the work above with your tools first. Then end your final message with a single \`\`\`json fenced block containing exactly one JSON value that conforms to this JSON Schema (no prose inside the block):\n${JSON.stringify(schema)}\n</output-contract>`;
}

function correctionPrompt(error: string): string {
  return `Your final message did not satisfy the output contract: ${error}\nReply with a single \`\`\`json fenced block containing one JSON value conforming to the schema from <output-contract>, and nothing else.`;
}

function finiteNonnegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`workflow subagent ${field} must be a finite non-negative number`);
  return Math.floor(value);
}

function normalizeSubagentResult(
  result: string | GrokBuildWorkflowSubagentResult,
  id: string,
  fallbackDurationMs: number,
): GrokBuildWorkflowSubagentResult {
  if (typeof result === "string") {
    // Compatibility with the existing browser session callback. Exact usage
    // accounting is available when the callback returns the structured form.
    return { childSessionId: id, success: true, output: result, totalTokensUsed: 0, durationMs: fallbackDurationMs };
  }
  if (!result || typeof result !== "object") throw new Error("workflow subagent returned an invalid result");
  return {
    childSessionId: text(result.childSessionId, "workflow subagent childSessionId"),
    success: result.success === true,
    output: text(result.output, "workflow subagent output"),
    ...(typeof result.error === "string" ? { error: result.error } : {}),
    ...(result.cancelled === true ? { cancelled: true } : {}),
    ...(result.backgrounded === true ? { backgrounded: true } : {}),
    ...(result.usageIncomplete === true ? { usageIncomplete: true } : {}),
    totalTokensUsed: finiteNonnegative(result.totalTokensUsed, "totalTokensUsed"),
    durationMs: finiteNonnegative(result.durationMs, "durationMs"),
    ...(result.toolCalls !== undefined ? { toolCalls: finiteNonnegative(result.toolCalls, "toolCalls") } : {}),
    ...(result.turns !== undefined ? { turns: finiteNonnegative(result.turns, "turns") } : {}),
  };
}

function scratchName(value: unknown): string {
  const name = text(value, "scratch file name");
  if (utf8Length(name) > MAX_SCRATCH_NAME_BYTES) throw new Error(`scratch file name exceeds ${MAX_SCRATCH_NAME_BYTES} bytes`);
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error(`scratch file name must be a single relative path component, got: ${name}`);
  }
  return name;
}

function truncateUtf8(value: string, maximum: number, marker: string): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maximum) return value;
  let end = maximum;
  while (end > 0) {
    try { return `${new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end))}${marker}`; }
    catch { end -= 1; }
  }
  return marker;
}

export class GrokBuildBrowserWorkflowHost implements GrokBuildWorkflowHost {
  private readonly workspacePath: string;
  private readonly agentRuns = new Map<string, number>();
  private readonly admissions = new Map<string, GrokBuildSubagentAdmission>();
  private readonly executionForkContext = new Map<string, boolean>();
  private readonly maxConcurrentAgents: number;

  constructor(private readonly options: GrokBuildWorkflowBrowserHostOptions) {
    this.workspacePath = options.workspacePath ?? "/";
    const configured = options.maxConcurrentAgents ?? 32;
    const hardware = typeof navigator === "undefined" ? 32 : Math.max(2, navigator.hardwareConcurrency || 32);
    this.maxConcurrentAgents = Math.max(1, Math.min(configured, hardware));
  }

  async call(request: GrokBuildWorkflowHostRequest, signal: AbortSignal): Promise<unknown> {
    switch (request.kind) {
      case "spawn_agent": return this.admitAgent(request, signal);
      case "render_template": return this.renderTemplate(request);
      case "write_scratch_file": return this.writeScratch(request);
      case "read_scratch_file": return this.readScratch(request);
      case "git_diff_since": return this.gitDiff(request, signal);
      default: throw new Error(`unsupported workflow host request: ${request.kind}`);
    }
  }

  event(event: GrokBuildWorkflowHostEvent): void {
    if (event.kind === "phase" || !event.replayed) this.options.onEvent?.(event);
  }

  beginExecution(executionId: string, options: { allowForkContext: boolean }): void {
    this.executionForkContext.set(executionId, options.allowForkContext);
  }

  endExecution(executionId: string): void {
    this.admissions.delete(executionId);
    this.agentRuns.delete(executionId);
    this.executionForkContext.delete(executionId);
  }

  private async admitAgent(request: GrokBuildWorkflowHostRequest, signal: AbortSignal): Promise<unknown> {
    const executionId = request.executionId ?? "__unscoped__";
    let admission = this.admissions.get(executionId);
    if (!admission) {
      admission = new GrokBuildSubagentAdmission(this.maxConcurrentAgents);
      this.admissions.set(executionId, admission);
    }
    if (admission.counts().running >= admission.maxConcurrent) {
      const counts = admission.counts();
      this.options.onAgentLifecycle?.({ executionId, phase: "queued", active: counts.running, queued: counts.queued + 1 });
    }
    return admission.run(signal, async () => {
      const started = admission!.counts();
      this.options.onAgentLifecycle?.({ executionId, phase: "started", active: started.running, queued: started.queued });
      let success = false;
      try {
        const result = await this.spawnAgent(request, signal);
        success = Boolean(result && typeof result === "object" && (result as { success?: unknown }).success === true);
        return result;
      } finally {
        const counts = admission!.counts();
        this.options.onAgentLifecycle?.({ executionId, phase: "finished", active: Math.max(0, counts.running - 1), queued: counts.queued, success });
      }
    });
  }

  private async spawnAgent(request: GrokBuildWorkflowHostRequest, signal: AbortSignal): Promise<unknown> {
    const input = payload(request);
    const prompt = text(input.prompt, "agent prompt");
    if (!prompt.trim()) throw new Error("agent prompt must not be empty");
    if (utf8Length(prompt) > MAX_AGENT_PROMPT_BYTES) throw new Error(`agent prompt exceeds ${MAX_AGENT_PROMPT_BYTES} bytes`);
    const allowForkContext = request.executionId
      ? this.executionForkContext.get(request.executionId) === true
      : this.options.allowForkContext === true;
    if (input.fork_context === true && !allowForkContext) throw new Error("fork_context is restricted to built-in workflows");
    for (const field of ["label", "phase"] as const) {
      if (typeof input[field] === "string" && utf8Length(input[field] as string) > MAX_PHASE_BYTES) {
        throw new Error(`agent label and phase must each be at most ${MAX_PHASE_BYTES} bytes`);
      }
    }
    if (typeof input.capability_mode === "string" && !["read-only", "read-write", "execute", "all"].includes(input.capability_mode)) {
      throw new Error(`invalid capability_mode '${input.capability_mode}' (expected read-only, read-write, execute, or all)`);
    }
    if (typeof input.effort === "string" && !["none", "minimal", "low", "medium", "high", "xhigh"].includes(input.effort)) {
      throw new Error(`invalid workflow agent effort: ${input.effort}`);
    }
    const schema = input.output_schema;
    const validateContract = schema === undefined || schema === null
      ? this.options.validateContract
      : this.options.validateContract ?? (await import("./grok-build-rhai-wasm.js")).validateGrokBuildContract;
    if (schema !== undefined && schema !== null) {
      const compiled = validateContract!(schema);
      if (compiled.status === "invalid") throw new Error(compiled.error);
    }
    const id = crypto.randomUUID();
    let attempts = 0;
    let totalTokens = 0;
    let totalDuration = 0;
    let resumeFrom = typeof input.resume_from === "string" ? input.resume_from : undefined;
    let nextPrompt = schema === undefined || schema === null ? prompt : contractPrompt(prompt, schema);
    let forkContext = input.fork_context === true && resumeFrom === undefined;
    let final: GrokBuildWorkflowSubagentResult | undefined;
    let output: unknown;
    while (true) {
      attempts += 1;
      const quotaKey = request.executionId ?? "__unscoped__";
      const runs = this.agentRuns.get(quotaKey) ?? 0;
      if (runs >= MAX_AGENT_RUNS) throw new Error(`workflow agent-run quota exceeded (maximum ${MAX_AGENT_RUNS})`);
      this.agentRuns.set(quotaKey, runs + 1);
      const childId = attempts === 1 ? id : crypto.randomUUID();
      const started = performance.now();
      const raw = await this.options.spawnSubagent({
        prompt: nextPrompt,
        description: typeof input.label === "string" ? input.label : "Workflow agent",
        subagent_type: typeof input.agent_type === "string" ? input.agent_type : "general-purpose",
        background: false,
        ...(typeof input.capability_mode === "string" ? { capability_mode: input.capability_mode } : {}),
        ...(typeof input.model === "string" ? { model: input.model } : {}),
        ...(typeof input.effort === "string" ? { reasoning_effort: input.effort } : {}),
        ...(resumeFrom ? { resume_from: resumeFrom } : {}),
        ...(input.isolation_worktree === true ? { isolation: "worktree" } : {}),
        ...(forkContext ? { fork_context: true } : {}),
      }, signal, childId);
      final = normalizeSubagentResult(raw, childId, Math.max(0, Math.round(performance.now() - started)));
      totalTokens = Math.min(Number.MAX_SAFE_INTEGER, totalTokens + final.totalTokensUsed);
      totalDuration = Math.min(Number.MAX_SAFE_INTEGER, totalDuration + final.durationMs);
      if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
      if (final.backgrounded) {
        throw new Error(`subagent ${childId} was auto-backgrounded by the await budget; its result is not available to this run (engine bug — workflow spawns must await to completion)`);
      }
      if (schema === undefined || schema === null || !final.success) {
        output = final.success ? final.output : (final.error ?? final.output);
        break;
      }
      const verdict = validateContract!(schema, final.output);
      if (verdict.status === "valid") {
        output = verdict.value;
        break;
      }
      if (attempts <= SCHEMA_CONTRACT_RETRIES) {
        resumeFrom = final.childSessionId;
        forkContext = false;
        nextPrompt = correctionPrompt(verdict.error);
        continue;
      }
      final = { ...final, success: false };
      output = `structured output validation failed: ${verdict.error}`;
      break;
    }
    return {
      agent_id: id,
      success: final!.success,
      output,
      cancelled: final!.cancelled === true,
      tokens_used: totalTokens,
      duration_ms: totalDuration,
    };
  }

  private renderTemplate(request: GrokBuildWorkflowHostRequest): string {
    const input = payload(request);
    const name = text(input.name, "template name");
    let rendered = this.options.templates?.[name];
    if (rendered === undefined) throw new Error(`unknown workflow template: ${name}`);
    if (utf8Length(rendered) > MAX_TEMPLATE_OUTPUT_BYTES) throw new Error(`template exceeds ${MAX_TEMPLATE_OUTPUT_BYTES} bytes`);
    if (input.vars && typeof input.vars === "object" && !Array.isArray(input.vars)) {
      for (const [key, value] of Object.entries(input.vars as Record<string, unknown>)) {
        rendered = rendered.replaceAll(`{${key}}`, typeof value === "string" ? value : JSON.stringify(value));
        if (utf8Length(rendered) > MAX_TEMPLATE_OUTPUT_BYTES) throw new Error(`rendered template exceeds ${MAX_TEMPLATE_OUTPUT_BYTES} bytes`);
      }
    }
    return rendered;
  }

  private scratchDirectory(request: GrokBuildWorkflowHostRequest): string {
    if (!request.executionId || !/^wf_[a-zA-Z0-9_-]+$/u.test(request.executionId)) throw new Error("workflow scratch request has no valid run id");
    return `/.grok/workflow-runs/${request.executionId}/scratch`;
  }

  private writeScratch(request: GrokBuildWorkflowHostRequest): string {
    const input = payload(request);
    const name = scratchName(input.name);
    const content = text(input.content, "scratch content");
    if (utf8Length(content) > MAX_SCRATCH_FILE_BYTES) throw new Error(`scratch file exceeds ${MAX_SCRATCH_FILE_BYTES} byte limit`);
    const directory = this.scratchDirectory(request);
    this.options.vfs.mkdirSync(directory, { recursive: true });
    const names = this.options.vfs.readdirSync(directory);
    const target = `${directory}/${name}`;
    const others = names.filter((entry) => entry !== name);
    if (!this.options.vfs.existsSync(target) && names.length >= MAX_SCRATCH_FILES) throw new Error(`scratch file quota exceeded (maximum ${MAX_SCRATCH_FILES})`);
    const otherBytes = others.reduce((sum, entry) => sum + this.options.vfs.readFileSync(`${directory}/${entry}`).byteLength, 0);
    if (otherBytes + utf8Length(content) > MAX_SCRATCH_TOTAL_BYTES) throw new Error(`scratch byte quota exceeded (maximum ${MAX_SCRATCH_TOTAL_BYTES})`);
    this.options.vfs.writeFileSync(target, content);
    return `scratch/${name}`;
  }

  private readScratch(request: GrokBuildWorkflowHostRequest): string {
    const name = scratchName(payload(request).name);
    const path = `${this.scratchDirectory(request)}/${name}`;
    if (!this.options.vfs.existsSync(path) || !this.options.vfs.statSync(path).isFile()) throw new Error("scratch path is not a regular file");
    if (this.options.vfs.readFileSync(path).byteLength > MAX_SCRATCH_FILE_BYTES) throw new Error(`scratch file exceeds ${MAX_SCRATCH_FILE_BYTES} byte read limit`);
    return this.options.vfs.readFileSync(path, "utf8");
  }

  private async gitDiff(request: GrokBuildWorkflowHostRequest, signal: AbortSignal): Promise<string> {
    if (!this.options.runCommand) throw new Error("git_diff_since is unavailable in this browser container");
    const commit = text(payload(request).commit, "commit");
    if (!commit || !/^[a-zA-Z0-9]+$/u.test(commit)) throw new Error(`git_diff_since expects a commit hash, got: ${commit}`);
    const result = await this.options.runCommand(`git diff ${commit}`, { cwd: this.workspacePath, signal });
    if (result.exitCode !== 0) throw new Error(`git diff exited with ${result.exitCode}: ${result.stderr}`);
    return truncateUtf8(result.stdout, MAX_DIFF_BYTES, "\n… [diff truncated]");
  }
}
