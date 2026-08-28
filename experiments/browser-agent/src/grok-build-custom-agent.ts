// Copyright 2023-2026 SpaceXAI
// SPDX-License-Identifier: Apache-2.0
// Modified for the Vibewaiting browser port, 2026.

import type { GrokTool } from "../../../src/grok-browser-protocol.js";
import type {
  GrokBuildEvent,
  GrokBuildToolCall,
  GrokBuildToolResult,
  GrokBuildToolRuntime,
} from "./grok-build-agent.js";
import type { GrokBuildAgentDefinition } from "./grok-build-agents.js";
import type { GrokBuildBundleFileSystem } from "./grok-build-bundle.js";
import { parseGrokBuildFrontmatterDocument, type GrokBuildSkillInfo } from "./grok-build-skills.js";

type JsonObject = Record<string, unknown>;

export interface GrokBuildCompletionRequirement {
  tool: string;
  reminder: string;
  recovery?: { maxRetries: number; baseDelayMs: number; maxDelayMs: number };
}

export interface GrokBuildConfiguredTools {
  tools: GrokTool[];
  runtime: GrokBuildToolRuntime;
  canonicalToolName(name: string): string;
}

export function configureGrokBuildAgentTools(
  baseTools: readonly GrokTool[],
  runtime: GrokBuildToolRuntime,
  definition: GrokBuildAgentDefinition,
): GrokBuildConfiguredTools {
  const entries = toolConfigEntries(definition.toolConfig);
  const byCanonical = new Map(baseTools.map((tool) => [toolName(tool), structuredClone(tool)]));
  const selected = entries
    ? [
        ...entries.flatMap((entry) => {
        const canonical = canonicalToolId(entry.id);
        const tool = byCanonical.get(canonical);
        return tool ? [{ tool, entry, canonical }] : [];
        }),
        ...(definition.injectDefaultTools || definition.memory
          ? baseTools.filter((tool) => !entries.some((entry) => canonicalToolId(entry.id) === toolName(tool)))
            .map((tool) => ({ tool: structuredClone(tool), canonical: toolName(tool), entry: undefined }))
          : []),
      ]
    : baseTools.map((tool) => ({ tool: structuredClone(tool), canonical: toolName(tool), entry: undefined }));
  const modelToCanonical = new Map<string, string>();
  const paramsToCanonical = new Map<string, ReadonlyMap<string, string>>();
  const tools = selected.map(({ tool, entry, canonical }) => {
    if (!entry || tool.type !== "function") return applyHostedOverride(tool, definition.toolOverrides);
    const modelName = stringField(entry, "name_override", "nameOverride") ?? canonical;
    const overrides = stringMap(entry.params_name_overrides ?? entry.paramsNameOverrides);
    const description = stringField(entry, "description_override", "descriptionOverride");
    modelToCanonical.set(modelName, canonical);
    if (overrides) paramsToCanonical.set(modelName, new Map(Object.entries(overrides).map(([from, to]) => [to, from])));
    const configured = structuredClone(tool);
    configured.name = modelName;
    if (description !== undefined) configured.description = description;
    if (overrides) configured.parameters = renameSchemaProperties(configured.parameters, overrides);
    return configured;
  });
  for (const tool of tools) {
    const name = toolName(tool);
    if (!modelToCanonical.has(name)) modelToCanonical.set(name, name);
  }
  const configuredRuntime: GrokBuildToolRuntime = {
    execute(call, signal) {
      const canonical = modelToCanonical.get(call.name) ?? call.name;
      const reverse = paramsToCanonical.get(call.name);
      return runtime.execute({ ...call, name: canonical, arguments: renameCallArguments(call.arguments, reverse) }, signal);
    },
  };
  return { tools, runtime: configuredRuntime, canonicalToolName: (name) => modelToCanonical.get(name) ?? name };
}

export function toolConfigCanonicalNames(config: Record<string, unknown> | undefined): string[] | undefined {
  return toolConfigEntries(config)?.map((entry) => canonicalToolId(entry.id));
}

export function formatGrokBuildPreloadedSkills(
  vfs: GrokBuildBundleFileSystem,
  names: readonly string[],
  discovered: readonly GrokBuildSkillInfo[],
): { injection: string; paths: Set<string> } {
  const parts: string[] = [];
  const paths = new Set<string>();
  for (const name of names) {
    const skill = discovered.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (!skill || !vfs.existsSync(skill.path) || !vfs.statSync(skill.path).isFile()) continue;
    const body = parseGrokBuildFrontmatterDocument(vfs.readFileSync(skill.path, "utf8")).body;
    if (!body) continue;
    paths.add(skill.path);
    parts.push(`<skill name="${skill.name}" description="${skill.description}" path="${skill.path}">\n${body}\n</skill>`);
  }
  return { injection: parts.length ? `\n\n${parts.join("\n\n")}\n\n` : "", paths };
}

export function grokBuildAgentMemory(
  vfs: GrokBuildBundleFileSystem,
  definition: Pick<GrokBuildAgentDefinition, "name" | "memory">,
  cwd: string,
  grokHome = "/.grok",
): { directory?: string; injection: string } {
  if (!definition.memory) return { injection: "" };
  const root = normalizePath(cwd);
  const directory = definition.memory === "user" ? `${normalizePath(grokHome)}/agent-memory/${definition.name}`
    : definition.memory === "project" ? `${root === "/" ? "" : root}/.grok/agent-memory/${definition.name}`
      : `${root === "/" ? "" : root}/.grok/agent-memory-local/${definition.name}`;
  const memory = `${directory}/MEMORY.md`;
  if (!vfs.existsSync(memory) || !vfs.statSync(memory).isFile()) return { directory, injection: "" };
  const lines = vfs.readFileSync(memory, "utf8").split(/\r?\n/u).slice(0, 200).join("\n");
  const content = truncateUtf8(lines, 25 * 1024);
  return { directory, injection: content ? `\n\n<agent-memory>\nMemory directory: ${directory}\n\n${content}\n</agent-memory>` : "" };
}

export class GrokBuildCompletionTracker {
  private readonly called = new Set<string>();

  constructor(private readonly canonicalName: (name: string) => string = (name) => name) {}

  event(event: GrokBuildEvent): void {
    if (event.type === "tool_start") this.called.add(this.canonicalName(event.call.name));
  }

  async run<T extends { status: "complete" | "limit" }>(
    prompt: string,
    requirement: GrokBuildCompletionRequirement | undefined,
    signal: AbortSignal,
    runTurn: (prompt: string) => Promise<T>,
    sleep: (delayMs: number, signal: AbortSignal) => Promise<void> = abortableSleep,
  ): Promise<T> {
    let result: T | undefined;
    let failure: unknown;
    let nextPrompt = prompt;
    const recovery = requirement?.recovery;
    for (let attempt = 0; ; attempt += 1) {
      this.called.clear();
      try { result = await runTurn(nextPrompt); failure = undefined; }
      catch (error) { failure = error; }
      if (!requirement || !recovery || result?.status === "limit" || this.called.has(requirement.tool)) {
        if (failure !== undefined) throw failure;
        return result!;
      }
      if (attempt >= recovery.maxRetries) {
        if (failure !== undefined) throw failure;
        return result!;
      }
      const delay = Math.min(recovery.baseDelayMs * 2 ** attempt, recovery.maxDelayMs);
      await sleep(delay, signal);
      nextPrompt = requirement.reminder;
    }
  }
}

export type GrokBuildAgentHookEvent = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "SubagentStop";

export interface GrokBuildAgentHookRunner {
  run(command: string, options: { cwd: string; signal: AbortSignal; timeoutMs: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export async function runGrokBuildAgentHooks(
  hooks: Record<string, unknown> | undefined,
  event: GrokBuildAgentHookEvent,
  subject: string,
  cwd: string,
  runner: GrokBuildAgentHookRunner,
  signal: AbortSignal,
): Promise<{ denied?: string }> {
  const groups = hooks?.[event];
  if (!Array.isArray(groups)) return {};
  for (const group of groups) {
    if (!isRecord(group) || !hookMatches(group.matcher, subject) || !Array.isArray(group.hooks)) continue;
    for (const raw of group.hooks) {
      if (!isRecord(raw) || raw.type !== "command" || typeof raw.command !== "string") continue;
      const timeoutMs = Math.max(1, Math.min(3_600_000, typeof raw.timeout === "number" ? raw.timeout * 1_000 : event === "SubagentStop" ? 600_000 : event === "UserPromptSubmit" ? 30_000 : 5_000));
      let outcome: Awaited<ReturnType<GrokBuildAgentHookRunner["run"]>>;
      try { outcome = await runner.run(raw.command, { cwd, signal, timeoutMs }); }
      catch { continue; } // Native hook failures fail open.
      if (event !== "PreToolUse" && event !== "UserPromptSubmit" && event !== "SubagentStop") continue;
      const parsed = parseDecision(outcome.stdout);
      const blocked = event === "PreToolUse" ? parsed?.decision === "deny"
        : parsed?.decision === "block" || parsed?.continue === false;
      if (blocked || outcome.exitCode === 2) {
        return { denied: parsed?.reason?.trim() || outcome.stderr.trim().split("\n")[0] || `Blocked by ${event} hook` };
      }
    }
  }
  return {};
}

export class GrokBuildHookedRuntime implements GrokBuildToolRuntime {
  constructor(
    private readonly inner: GrokBuildToolRuntime,
    private readonly hooks: Record<string, unknown> | undefined,
    private readonly cwd: string,
    private readonly runner: GrokBuildAgentHookRunner,
  ) {}

  async execute(call: GrokBuildToolCall, signal: AbortSignal): Promise<GrokBuildToolResult> {
    const gate = await runGrokBuildAgentHooks(this.hooks, "PreToolUse", call.name, this.cwd, this.runner, signal);
    if (gate.denied) return { output: gate.denied, isError: true };
    const result = await this.inner.execute(call, signal);
    await runGrokBuildAgentHooks(this.hooks, result.isError ? "PostToolUseFailure" : "PostToolUse", call.name, this.cwd, this.runner, signal);
    return result;
  }
}

function toolConfigEntries(config: Record<string, unknown> | undefined): JsonObject[] | undefined {
  if (!config) return;
  return Array.isArray(config.tools) ? config.tools.filter(isRecord) : [];
}

function canonicalToolId(value: unknown): string {
  const id = typeof value === "string" ? value : "";
  return id.includes(":") ? id.slice(id.lastIndexOf(":") + 1) : id;
}

function toolName(tool: GrokTool): string {
  return tool.type === "function" && "name" in tool && typeof tool.name === "string" ? tool.name : tool.type;
}

function applyHostedOverride(tool: GrokTool, raw: Record<string, unknown> | undefined): GrokTool {
  if (tool.type === "web_search") {
    const options = recordAt(raw, "webSearch", "web_search");
    const allowed = stringArray(options?.allowedDomains ?? options?.allowed_domains);
    const excluded = stringArray(options?.excludedDomains ?? options?.excluded_domains);
    if ((allowed?.length ?? 0) > 0 || (excluded?.length ?? 0) > 0) {
      return { type: "web_search", filters: { ...(allowed?.length ? { allowed_domains: allowed.slice(0, 5) } : {}), ...(excluded?.length ? { excluded_domains: excluded.slice(0, 5) } : {}) } };
    }
  }
  if (tool.type === "x_search") {
    const options = recordAt(raw, "xSearch", "x_search");
    const bound = recordAt(options, "dateBound", "date_bound");
    const from = stringField(bound, "fromDate", "from_date");
    const to = stringField(bound, "toDate", "to_date");
    return { type: "x_search", ...(from ? { from_date: from } : {}), ...(to ? { to_date: to } : {}) };
  }
  return tool;
}

function renameSchemaProperties(schema: unknown, overrides: Record<string, string>): unknown {
  if (!isRecord(schema)) return schema;
  const output = structuredClone(schema);
  if (isRecord(output.properties)) {
    output.properties = Object.fromEntries(Object.entries(output.properties).map(([name, value]) => [overrides[name] ?? name, value]));
  }
  if (Array.isArray(output.required)) output.required = output.required.map((name) => typeof name === "string" ? overrides[name] ?? name : name);
  return output;
}

function renameCallArguments(source: string, reverse: ReadonlyMap<string, string> | undefined): string {
  if (!reverse?.size) return source;
  try {
    const value = JSON.parse(source || "{}") as unknown;
    if (!isRecord(value)) return source;
    return JSON.stringify(Object.fromEntries(Object.entries(value).map(([name, item]) => [reverse.get(name) ?? name, item])));
  } catch { return source; }
}

function hookMatches(raw: unknown, subject: string): boolean {
  if (raw === undefined || raw === null || raw === "" || raw === "*") return true;
  if (typeof raw !== "string") return false;
  const alias = subject === "run_terminal_command" ? "Bash" : subject;
  try { return new RegExp(raw, "u").test(subject) || new RegExp(raw, "u").test(alias); }
  catch { return raw === subject || raw === alias; }
}

function parseDecision(source: string): ({ decision?: string; reason?: string; continue?: boolean } | undefined) {
  try {
    const value = JSON.parse(source.trim()) as unknown;
    return isRecord(value) ? value as { decision?: string; reason?: string; continue?: boolean } : undefined;
  } catch { return; }
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function truncateUtf8(value: string, maximum: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maximum) return value;
  let end = maximum;
  while (end > 0) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, end)); }
    catch { end -= 1; }
  }
  return "";
}

function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(done, delayMs);
    signal.addEventListener("abort", aborted, { once: true });
    function done(): void { signal.removeEventListener("abort", aborted); resolve(); }
    function aborted(): void { clearTimeout(timer); reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError")); }
  });
}

function isRecord(value: unknown): value is JsonObject { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function recordAt(value: unknown, ...keys: string[]): JsonObject | undefined {
  if (!isRecord(value)) return;
  for (const key of keys) if (isRecord(value[key])) return value[key] as JsonObject;
  return;
}
function stringField(value: unknown, ...keys: string[]): string | undefined {
  if (!isRecord(value)) return;
  for (const key of keys) if (typeof value[key] === "string") return value[key] as string;
  return;
}
function stringArray(value: unknown): string[] | undefined { return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined; }
function stringMap(value: unknown): Record<string, string> | undefined {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string") ? value as Record<string, string> : undefined;
}
