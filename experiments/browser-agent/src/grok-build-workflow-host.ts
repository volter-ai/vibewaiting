// Copyright 2023-2026 SpaceXAI
// SPDX-License-Identifier: Apache-2.0
// Modified for the Vibewaiting browser port, 2026.

import type { GrokBuildWorkflowFileSystem } from "./grok-build-workflow-registry.js";
import type { GrokBuildWorkflowHost, GrokBuildWorkflowHostEvent, GrokBuildWorkflowHostRequest } from "./grok-build-workflow-engine.js";

const MAX_AGENT_PROMPT_BYTES = 1024 * 1024;
const MAX_SCRATCH_NAME_BYTES = 255;
const MAX_SCRATCH_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SCRATCH_FILES = 64;
const MAX_SCRATCH_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_DIFF_BYTES = 256 * 1024;

interface CommandResult { stdout: string; stderr: string; exitCode: number }

export interface GrokBuildWorkflowBrowserHostOptions {
  vfs: GrokBuildWorkflowFileSystem;
  workspacePath?: string;
  spawnSubagent(input: Record<string, unknown>, signal: AbortSignal, id: string): Promise<string>;
  runCommand?(command: string, options: { cwd: string; signal: AbortSignal }): Promise<CommandResult>;
  templates?: Readonly<Record<string, string>>;
  onEvent?: (event: GrokBuildWorkflowHostEvent) => void;
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

function parseStructuredOutput(output: string, schema: unknown): unknown {
  if (!schema) return output;
  const fenced = /```json\s*([\s\S]*?)```/iu.exec(output)?.[1];
  try { return JSON.parse((fenced ?? output).trim()) as unknown; }
  catch (error) { throw new Error(`workflow subagent did not return valid structured JSON: ${error instanceof Error ? error.message : String(error)}`); }
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

  constructor(private readonly options: GrokBuildWorkflowBrowserHostOptions) {
    this.workspacePath = options.workspacePath ?? "/";
  }

  async call(request: GrokBuildWorkflowHostRequest, signal: AbortSignal): Promise<unknown> {
    switch (request.kind) {
      case "spawn_agent": return this.spawnAgent(request, signal);
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

  private async spawnAgent(request: GrokBuildWorkflowHostRequest, signal: AbortSignal): Promise<unknown> {
    const input = payload(request);
    const prompt = text(input.prompt, "agent prompt");
    if (!prompt.trim()) throw new Error("agent prompt must not be empty");
    if (utf8Length(prompt) > MAX_AGENT_PROMPT_BYTES) throw new Error(`agent prompt exceeds ${MAX_AGENT_PROMPT_BYTES} bytes`);
    if (input.fork_context === true) throw new Error("fork_context is restricted to built-in workflows");
    const id = crypto.randomUUID();
    const started = performance.now();
    const output = await this.options.spawnSubagent({
      prompt,
      description: typeof input.label === "string" ? input.label : "Workflow agent",
      subagent_type: typeof input.agent_type === "string" ? input.agent_type : "general-purpose",
      background: false,
      ...(typeof input.capability_mode === "string" ? { capability_mode: input.capability_mode } : {}),
      ...(typeof input.model === "string" ? { model: input.model } : {}),
      ...(typeof input.effort === "string" ? { reasoning_effort: input.effort } : {}),
      ...(typeof input.resume_from === "string" ? { resume_from: input.resume_from } : {}),
      ...(input.isolation_worktree === true ? { isolation: "worktree" } : {}),
      ...(input.output_schema ? { output_schema: input.output_schema } : {}),
    }, signal, id);
    return {
      agent_id: id,
      success: true,
      output: parseStructuredOutput(output, input.output_schema),
      cancelled: false,
      tokens_used: 0,
      duration_ms: Math.max(0, Math.round(performance.now() - started)),
    };
  }

  private renderTemplate(request: GrokBuildWorkflowHostRequest): string {
    const input = payload(request);
    const name = text(input.name, "template name");
    let rendered = this.options.templates?.[name];
    if (rendered === undefined) throw new Error(`unknown workflow template: ${name}`);
    if (input.vars && typeof input.vars === "object" && !Array.isArray(input.vars)) {
      for (const [key, value] of Object.entries(input.vars as Record<string, unknown>)) {
        rendered = rendered.replaceAll(`{${key}}`, typeof value === "string" ? value : JSON.stringify(value));
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
