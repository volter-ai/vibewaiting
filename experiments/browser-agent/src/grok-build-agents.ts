// Copyright 2023-2026 SpaceXAI
// SPDX-License-Identifier: Apache-2.0
// Modified for the Vibewaiting browser port, 2026.

import type { GrokBuildBundleFileSystem } from "./grok-build-bundle.js";
import { GROK_BUILD_SUBAGENT_TEMPLATE, renderGrokBuildTemplate } from "./grok-build-subagent-template.js";
import { parse } from "yaml";

export type GrokBuildCapabilityMode = "read-only" | "read-write" | "execute" | "all";

export interface GrokBuildAgentCompletionRequirement {
  tool: string;
  reminder: string;
  recovery?: { maxRetries: number; baseDelayMs: number; maxDelayMs: number };
}

export interface GrokBuildAgentDiscoveryOptions {
  cwd?: string;
  gitRoot?: string;
  home?: string;
  grokHome?: string;
  toggles?: Readonly<Record<string, boolean>>;
}

export interface GrokBuildAgentDefinition {
  name: string;
  description: string;
  promptMode: "extend" | "full";
  promptBody?: string;
  toolConfig?: Record<string, unknown>;
  capabilityMode?: GrokBuildCapabilityMode;
  permissionMode: "default" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions" | "plan";
  skills: string[];
  discoverSkills: boolean;
  inheritSkills: boolean;
  agentsMd: boolean;
  injectDefaultTools: boolean;
  tools: string[];
  disallowedTools: string[];
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTurns?: number;
  isolation?: "none" | "worktree";
  background?: boolean;
  color?: "red" | "blue" | "green" | "yellow" | "purple" | "orange" | "pink" | "cyan";
  initialPrompt?: string;
  mcpServers: unknown[];
  mcpInheritance: "all" | "none" | { named: string[] } | { except: string[] };
  hooks?: Record<string, unknown>;
  memory?: "user" | "project" | "local";
  model?: string;
  completionRequirement?: GrokBuildAgentCompletionRequirement;
  toolOverrides?: Record<string, unknown>;
  source: "project" | "builtin" | "user" | "bundled";
  sourcePath?: string;
}

const GENERAL_PURPOSE_PROMPT = `Complete the assigned task directly. Do what was asked; nothing more, nothing less.
Respond with a detailed writeup when done.

Strengths:
- Searching across large codebases for code, configurations, and patterns
- Multi-file analysis and architecture investigation
- Multi-step research requiring exploration of many files
- Spawning child agents for parallel work when appropriate

Guidelines:
- Use \${{ tools.by_kind.search }} or \${{ tools.by_kind.list }} for broad searches; \${{ tools.by_kind.read }} for known paths.
- Start broad and narrow down. Try multiple search strategies.
- Be thorough: check multiple locations, consider different naming conventions.
- NEVER create files unless absolutely necessary. Prefer editing existing files.
- NEVER create documentation files (*.md) unless explicitly requested.
- Return absolute file paths and relevant code snippets in your final response.

Workspace boundary:
- Default scope is the workspace in <user_info>. Stay within it unless told otherwise.
- Do not run whole-filesystem searches unless the user clearly requires it.

Capability awareness:
- You have full capability: read, write, edit, and execute.
- When spawning child agents, choose the narrowest capability_mode that fits the task.

File-based collaboration:
- When working with review notes or handoff files, read the FULL file before acting.
- When responding to review feedback, append your responses under the relevant issue.`;

const EXPLORE_PROMPT = `You are a fast, read-only codebase exploration agent.

=== READ-ONLY MODE ===
You have NO file editing tools. Do not create, modify, or delete files.
Use \${{ tools.by_kind.execute }} only for read-only commands (ls, git status, git log, git diff, find, cat, head, tail).

Strengths:
- Rapidly finding files using glob patterns
- Searching code with regex patterns across large codebases
- Reading and analyzing file contents
- Tracing code paths and understanding architecture

Guidelines:
- Use \${{ tools.by_kind.list }} for file pattern matching, \${{ tools.by_kind.search }} for content search, \${{ tools.by_kind.read }} for known paths.
- Adapt search approach based on the thoroughness level specified by the caller:
  - "quick": 1-3 targeted searches, return first matches
  - "medium": explore 5-10 files, try alternate naming conventions
  - "very thorough": exhaustive search across multiple directories, naming patterns, and related files
- Start broad and narrow down. Try multiple search strategies if the first doesn't find results.
- Maximize parallel tool calls for speed — issue independent searches simultaneously.
- Return absolute file paths and relevant code snippets in your final response.

Workspace boundary:
- Your default search scope is the workspace in <user_info>. Do not search outside it unless asked.
- If not found in the workspace, report that rather than broadening scope.`;

const PLAN_PROMPT = `You are a read-only software architect. Explore the codebase and design implementation plans.

=== READ-ONLY MODE ===
You have NO file editing tools. Do not create, modify, or delete files.
Use \${{ tools.by_kind.execute }} only for read-only commands (ls, git status, git log, git diff, find, cat, head, tail).

Process:
1. **Understand** the requirements and any assigned perspective.
2. **Explore**: read provided files, find patterns with \${{ tools.by_kind.list }}/\${{ tools.by_kind.search }}/\${{ tools.by_kind.read }}, trace relevant code paths.
3. **Design**: consider trade-offs, follow existing patterns, create implementation approach.
4. **Detail**: step-by-step strategy, dependencies, sequencing, potential challenges.

## Required Output
End your response with:
### Critical Files for Implementation
- path/to/file - [reason]

Workspace boundary:
- Your default analysis scope is the workspace in <user_info>. Stay within it unless asked otherwise.
- Note explicitly if the design requires understanding external dependencies.`;

const BUILTINS: readonly GrokBuildAgentDefinition[] = [
  {
    name: "general-purpose",
    description: "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. Has access to all tools including TaskTool for recursive subagent spawning.",
    promptMode: "full",
    promptBody: GENERAL_PURPOSE_PROMPT,
    permissionMode: "default",
    skills: [], discoverSkills: true, inheritSkills: true,
    model: "inherit",
    agentsMd: true,
    injectDefaultTools: true, tools: [], disallowedTools: [], mcpServers: [], mcpInheritance: "all",
    source: "builtin",
  },
  {
    name: "explore",
    description: "Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. \"src/components/**/*.tsx\"), search code for keywords (eg. \"API endpoints\"), or answer questions about the codebase (eg. \"how do API endpoints work?\"). When calling this agent, specify the desired thoroughness level: \"quick\" for basic searches, \"medium\" for moderate exploration, or \"very thorough\" for comprehensive analysis across multiple locations and naming conventions. Read-only — has access to: run_terminal_cmd, read_file, list_dir, grep.",
    promptMode: "full",
    promptBody: EXPLORE_PROMPT,
    permissionMode: "plan",
    skills: [], discoverSkills: true, inheritSkills: false,
    agentsMd: true,
    injectDefaultTools: true, tools: [], disallowedTools: [], mcpServers: [], mcpInheritance: "all",
    source: "builtin",
  },
  {
    name: "plan",
    description: "Software architect agent for designing implementation plans. Returns step-by-step plans, identifies critical files, and considers architectural trade-offs. Read-only.",
    promptMode: "full",
    promptBody: PLAN_PROMPT,
    permissionMode: "plan",
    skills: [], discoverSkills: true, inheritSkills: false,
    model: "inherit",
    agentsMd: true,
    injectDefaultTools: true, tools: [], disallowedTools: [], mcpServers: [], mcpInheritance: "all",
    source: "builtin",
  },
];

function parseDefinition(content: string, source: GrokBuildAgentDefinition["source"], path: string): GrokBuildAgentDefinition | undefined {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return;
  const afterOpening = trimmed.slice(3);
  const closing = afterOpening.indexOf("\n---");
  if (closing < 0) return;
  let frontmatter: Record<string, unknown>;
  try {
    const value = parse(afterOpening.slice(0, closing));
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    frontmatter = value as Record<string, unknown>;
  } catch { return; }
  const name = string(frontmatter.name)?.trim();
  const description = string(frontmatter.description)?.trim();
  if (!name || !description) return;
  const promptMode = enumValue(frontmatter.promptMode, ["extend", "full"] as const, "extend");
  const permissionMode = enumValue(frontmatter.permissionMode, ["default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "plan"] as const, "default");
  const capabilityMode = optionalEnum(frontmatter.capabilityMode, ["read-only", "read-write", "execute", "all"] as const);
  const effort = optionalEnum(frontmatter.effort, ["low", "medium", "high", "xhigh", "max"] as const);
  const isolation = optionalEnum(frontmatter.isolation, ["none", "worktree"] as const);
  const memory = optionalEnum(frontmatter.memory, ["user", "project", "local"] as const);
  if (!promptMode || !permissionMode || capabilityMode === null || effort === null || isolation === null || memory === null) return;
  const body = afterOpening.slice(closing + 4).replace(/^\r?\n/u, "").trim();
  const maxTurns = positiveInteger(frontmatter.maxTurns);
  if (frontmatter.maxTurns !== undefined && maxTurns === undefined) return;
  const mcpInheritance = parseMcpInheritance(frontmatter.mcpInheritance);
  if (mcpInheritance === undefined) return;
  for (const key of ["discoverSkills", "inheritSkills", "agentsMd", "injectDefaultTools"] as const) {
    if (frontmatter[key] !== undefined && typeof frontmatter[key] !== "boolean") return;
  }
  if (frontmatter.skills !== undefined && !stringArray(frontmatter.skills)) return;
  if (frontmatter.tools !== undefined && !stringOrArray(frontmatter.tools)) return;
  if (frontmatter.disallowedTools !== undefined && !stringOrArray(frontmatter.disallowedTools)) return;
  if (frontmatter.background !== undefined && frontmatter.background !== null && typeof frontmatter.background !== "boolean") return;
  if (frontmatter.initialPrompt !== undefined && frontmatter.initialPrompt !== null && typeof frontmatter.initialPrompt !== "string") return;
  if (frontmatter.model !== undefined && frontmatter.model !== null && typeof frontmatter.model !== "string") return;
  if (frontmatter.mcpServers !== undefined && !validMcpServers(frontmatter.mcpServers)) return;
  const toolConfig = parseToolConfig(frontmatter.toolConfig);
  if (frontmatter.toolConfig !== undefined && !toolConfig) return;
  const completionRequirement = parseCompletionRequirement(frontmatter.completionRequirement);
  if (frontmatter.completionRequirement !== undefined && !completionRequirement) return;
  const toolOverrides = parseToolOverrides(frontmatter.toolOverrides);
  if (frontmatter.toolOverrides !== undefined && !toolOverrides) return;
  return {
    name,
    description,
    promptMode,
    ...(body ? { promptBody: body } : {}),
    ...(toolConfig ? { toolConfig } : {}),
    ...(capabilityMode ? { capabilityMode } : {}),
    permissionMode,
    skills: stringArray(frontmatter.skills) ?? [],
    discoverSkills: boolean(frontmatter.discoverSkills, true),
    inheritSkills: boolean(frontmatter.inheritSkills, true),
    agentsMd: boolean(frontmatter.agentsMd, true),
    injectDefaultTools: boolean(frontmatter.injectDefaultTools, true),
    tools: strings(frontmatter.tools),
    disallowedTools: strings(frontmatter.disallowedTools),
    ...(effort ? { effort } : {}),
    ...(maxTurns ? { maxTurns } : {}),
    ...(isolation ? { isolation } : {}),
    ...(typeof frontmatter.background === "boolean" ? { background: frontmatter.background } : {}),
    ...(optionalEnum(frontmatter.color, ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"] as const) ?? undefined
      ? { color: optionalEnum(frontmatter.color, ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"] as const)! } : {}),
    ...(string(frontmatter.initialPrompt) ? { initialPrompt: string(frontmatter.initialPrompt)! } : {}),
    mcpServers: Array.isArray(frontmatter.mcpServers) ? frontmatter.mcpServers : [],
    mcpInheritance,
    ...(plainRecord(frontmatter.hooks) ? { hooks: plainRecord(frontmatter.hooks)! } : {}),
    ...(memory ? { memory } : {}),
    ...(typeof frontmatter.model === "string" ? { model: frontmatter.model } : {}),
    ...(completionRequirement ? { completionRequirement } : {}),
    ...(toolOverrides ? { toolOverrides } : {}),
    source,
    sourcePath: path,
  };
}

function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function boolean(value: unknown, fallback: boolean): boolean { return value === undefined ? fallback : value === true; }
function strings(value: unknown): string[] {
  if (typeof value === "string") return [...value.matchAll(/(?:agent|task)\([^)]*\)|[^,]+/giu)].map((match) => match[0].trim()).filter(Boolean);
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}
function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : value === undefined ? [] : undefined;
}
function stringOrArray(value: unknown): boolean {
  return typeof value === "string" || Array.isArray(value) && value.every((item) => typeof item === "string");
}
function validMcpServers(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string"
    || Boolean(item && typeof item === "object" && !Array.isArray(item)));
}
function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function positiveInteger(value: unknown): number | undefined { return Number.isInteger(value) && (value as number) > 0 && (value as number) <= 0xffff_ffff ? value as number : undefined; }
function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] | undefined {
  return value === undefined ? fallback : typeof value === "string" && allowed.includes(value) ? value as T[number] : undefined;
}
function optionalEnum<const T extends readonly string[]>(value: unknown, allowed: T): T[number] | undefined | null {
  return value === undefined || value === null ? undefined : typeof value === "string" && allowed.includes(value) ? value as T[number] : null;
}
function parseMcpInheritance(value: unknown): GrokBuildAgentDefinition["mcpInheritance"] | undefined {
  if (value === undefined || value === "all") return "all";
  if (value === "none") return "none";
  const object = plainRecord(value);
  if (!object || Object.keys(object).length !== 1) return;
  if (Array.isArray(object.named) && object.named.every((item) => typeof item === "string")) return { named: object.named };
  if (Array.isArray(object.except) && object.except.every((item) => typeof item === "string")) return { except: object.except };
  return;
}

function parseToolConfig(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return;
  const object = plainRecord(value);
  if (!object || !Array.isArray(object.tools)) return;
  if (!object.tools.every((entry) => {
    const tool = plainRecord(entry);
    if (!tool || typeof tool.id !== "string" || !tool.id) return false;
    for (const key of ["name_override", "nameOverride", "description_override", "descriptionOverride", "behavior_version", "behaviorVersion"] as const) {
      if (tool[key] !== undefined && tool[key] !== null && typeof tool[key] !== "string") return false;
    }
    const names = tool.params_name_overrides ?? tool.paramsNameOverrides;
    return names === undefined || Boolean(plainRecord(names) && Object.values(names as Record<string, unknown>).every((item) => typeof item === "string"));
  })) return;
  return object;
}

function parseCompletionRequirement(value: unknown): GrokBuildAgentCompletionRequirement | undefined {
  if (value === undefined) return;
  const object = plainRecord(value);
  if (!object || typeof object.tool !== "string" || !object.tool || typeof object.reminder !== "string") return;
  if (object.recovery === undefined || object.recovery === null) return { tool: object.tool, reminder: object.reminder };
  const recovery = plainRecord(object.recovery);
  if (!recovery) return;
  const values = [recovery.maxRetries, recovery.baseDelayMs, recovery.maxDelayMs];
  if (!values.every((item) => Number.isSafeInteger(item) && (item as number) >= 0)) return;
  return {
    tool: object.tool,
    reminder: object.reminder,
    recovery: {
      maxRetries: recovery.maxRetries as number,
      baseDelayMs: recovery.baseDelayMs as number,
      maxDelayMs: recovery.maxDelayMs as number,
    },
  };
}

function parseToolOverrides(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return;
  const object = plainRecord(value);
  if (!object || Object.keys(object).some((key) => !["xSearch", "x_search", "webSearch", "web_search"].includes(key))) return;
  const web = plainRecord(object.webSearch ?? object.web_search);
  if (object.webSearch !== undefined || object.web_search !== undefined) {
    if (!web || Object.keys(web).some((key) => !["allowedDomains", "allowed_domains", "excludedDomains", "excluded_domains"].includes(key))) return;
    const allowed = web.allowedDomains ?? web.allowed_domains;
    const excluded = web.excludedDomains ?? web.excluded_domains;
    const allowedList = stringArray(allowed);
    const excludedList = stringArray(excluded);
    if (allowed !== undefined && (!allowedList || allowedList.length > 5)) return;
    if (excluded !== undefined && (!excludedList || excludedList.length > 5)) return;
    if ((allowed as unknown[] | undefined)?.length && (excluded as unknown[] | undefined)?.length) return;
  }
  const x = plainRecord(object.xSearch ?? object.x_search);
  if (object.xSearch !== undefined || object.x_search !== undefined) {
    if (!x || Object.keys(x).some((key) => !["dateBound", "date_bound"].includes(key))) return;
    const boundValue = x.dateBound ?? x.date_bound;
    if (boundValue !== undefined) {
      const bound = plainRecord(boundValue);
      if (!bound || Object.keys(bound).some((key) => !["fromDate", "from_date", "toDate", "to_date"].includes(key))) return;
      const from = bound.fromDate ?? bound.from_date;
      const to = bound.toDate ?? bound.to_date;
      if (from !== undefined && !validDate(from) || to !== undefined && !validDate(to)) return;
      if (typeof from === "string" && typeof to === "string" && from > to) return;
    }
  }
  return object;
}

function validDate(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || value.startsWith("0000-")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function readDefinitions(
  vfs: GrokBuildBundleFileSystem & { readdirSync(path: string): string[] },
  directory: string,
  source: GrokBuildAgentDefinition["source"],
): GrokBuildAgentDefinition[] {
  if (!vfs.existsSync(directory) || !vfs.statSync(directory).isDirectory()) return [];
  return [...vfs.readdirSync(directory)].flatMap((name) => {
    const path = `${directory}/${name}`;
    if (!name.endsWith(".md") || !vfs.statSync(path).isFile()) return [];
    const definition = parseDefinition(vfs.readFileSync(path, "utf8"), source, path);
    return definition ? [definition] : [];
  });
}

export function discoverGrokBuildAgents(
  vfs: GrokBuildBundleFileSystem & { readdirSync(path: string): string[] },
  options: GrokBuildAgentDiscoveryOptions = {},
): GrokBuildAgentDefinition[] {
  const cwd = normalizePath(options.cwd ?? "/");
  const project = projectAgentDirectories(vfs, cwd, options.gitRoot).flatMap((directory) => readDefinitions(vfs, directory, "project"));
  const userDirectories: string[] = [];
  const grokHome = normalizePath(options.grokHome ?? "/.grok");
  const home = options.home ? normalizePath(options.home) : undefined;
  userDirectories.push(`${grokHome}/agents`);
  if (home && `${home}/.grok` !== grokHome) userDirectories.push(`${home}/.grok/agents`);
  if (home) userDirectories.push(`${home}/.claude/agents`);
  const user = userDirectories.flatMap((directory) => readDefinitions(vfs, directory, "user"));
  const bundledDirectories = [`${grokHome}/bundled/agents`, ...(home && `${home}/.grok` !== grokHome ? [`${home}/.grok/bundled/agents`] : [])];
  const bundled = bundledDirectories.flatMap((directory) => readDefinitions(vfs, directory, "bundled"));
  const discovered = deduplicate([...project, ...user, ...bundled]);
  const entries = BUILTINS.map((definition) => ({ ...definition }));
  for (const definition of discovered) {
    const builtinIndex = entries.findIndex((candidate) => candidate.name === definition.name);
    if (builtinIndex >= 0) {
      if (definition.source === "project") entries[builtinIndex] = definition;
      continue;
    }
    entries.push(definition);
  }
  const toggles = options.toggles ?? {};
  return entries.filter((definition) => toggles[definition.name] ?? true);
}

function deduplicate(definitions: GrokBuildAgentDefinition[]): GrokBuildAgentDefinition[] {
  const seen = new Set<string>();
  return definitions.filter((definition) => !seen.has(definition.name) && Boolean(seen.add(definition.name)));
}

function normalizePath(path: string): string {
  const result: string[] = [];
  for (const part of `/${path}`.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") result.pop(); else result.push(part);
  }
  return `/${result.join("/")}`;
}

function projectAgentDirectories(
  vfs: GrokBuildBundleFileSystem & { readdirSync(path: string): string[] },
  cwd: string,
  explicitRoot?: string,
): string[] {
  const chain: string[] = [];
  let cursor = cwd;
  let detectedRoot: string | undefined;
  while (true) {
    chain.push(cursor);
    if (vfs.existsSync(`${cursor === "/" ? "" : cursor}/.git`)) { detectedRoot = cursor; break; }
    if (cursor === "/") break;
    cursor = cursor.slice(0, cursor.lastIndexOf("/")) || "/";
  }
  const root = normalizePath(explicitRoot ?? detectedRoot ?? "/");
  const bounded = chain.slice(0, Math.max(0, chain.indexOf(root)) + 1 || chain.length);
  return bounded.flatMap((directory) => [".grok/agents", ".claude/agents"].map((suffix) => `${directory === "/" ? "" : directory}/${suffix}`));
}

const TOOL_NAMES: Record<string, string> = {
  execute: "run_terminal_command",
  read: "read_file",
  edit: "search_replace",
  list: "list_dir",
  search: "grep",
  web_search: "web_search",
  plan: "todo_write",
};

export interface GrokBuildAgentPromptContext {
  roleInstructions?: string;
  personaInstructions?: string;
  osName?: string;
  shellPath?: string;
  workingDirectory?: string;
  currentDate?: string;
  memoryEnabled?: boolean;
  toolNamesByKind?: Readonly<Record<string, string | undefined>>;
}

export function renderGrokBuildAgentPrompt(definition: GrokBuildAgentDefinition, context: GrokBuildAgentPromptContext = {}): string | undefined {
  const render = (template: string): string => template.replace(/\$\{\{\s*tools\.by_kind\.([a-z_]+)\s*\}\}/gu, (match, kind: string) => TOOL_NAMES[kind] ?? match);
  const body = definition.promptBody ? render(definition.promptBody) : "";
  if (definition.promptMode === "full") return body;
  const base = renderGrokBuildSubagentBasePrompt(context);
  return body ? `${base}\n\n${body}` : base;
}

/** Browser-VFS equivalent of the native repo-root-to-cwd AGENTS.md reminder. */
export function renderGrokBuildAgentProjectInstructions(
  vfs: GrokBuildBundleFileSystem & { readdirSync(path: string): string[] },
  cwd: string,
): string | undefined {
  const normalizedCwd = normalizePath(cwd);
  const dirs: string[] = [];
  let cursor = normalizedCwd;
  while (true) {
    dirs.push(cursor);
    if (vfs.existsSync(`${cursor === "/" ? "" : cursor}/.git`) || cursor === "/") break;
    cursor = cursor.slice(0, cursor.lastIndexOf("/")) || "/";
  }
  dirs.reverse();
  const files: Array<{ path: string; content: string }> = [];
  const seen = new Set<string>();
  for (const directory of dirs) {
    const root = directory === "/" ? "" : directory;
    for (const relative of ["AGENTS.md", "Agents.md", "AGENT.md", "CLAUDE.md", "Claude.md", ".claude/CLAUDE.md"]) {
      const path = `${root}/${relative}`;
      if (!seen.has(path) && vfs.existsSync(path) && vfs.statSync(path).isFile()) {
        seen.add(path);
        files.push({ path, content: vfs.readFileSync(path, "utf8") });
      }
    }
    for (const relative of [".grok/rules", ".claude/rules", ".cursor/rules"]) {
      const ruleDirectory = `${root}/${relative}`;
      if (!vfs.existsSync(ruleDirectory) || !vfs.statSync(ruleDirectory).isDirectory()) continue;
      for (const name of [...vfs.readdirSync(ruleDirectory)].sort()) {
        const path = `${ruleDirectory}/${name}`;
        if (!name.endsWith(".md") || seen.has(path) || !vfs.statSync(path).isFile()) continue;
        seen.add(path);
        const content = vfs.readFileSync(path, "utf8");
        const closing = content.trimStart().startsWith("---") ? content.indexOf("\n---", 3) : -1;
        const body = closing >= 0 ? content.slice(closing + 4).trimStart() : content;
        files.push({ path, content: body });
      }
    }
  }
  if (!files.length) return;
  const neutralize = (value: string): string => value.replace(/<(\s*\/?\s*system[-_]reminder)/giu, "&lt;$1");
  let result = "\n\n<system-reminder>\nAs you answer the user's questions, you can use the following context (ordered from repo root to current directory - deeper files take precedence on conflicts):\n";
  for (const file of files) result += `\n## From: ${neutralize(file.path)}\n${neutralize(file.content)}\n`;
  result += "\nFollow these instructions exactly. When working in subdirectories not listed above, check for additional project instruction files (AGENTS.md, Claude.md, etc.).\n</system-reminder>";
  return result;
}

function renderGrokBuildSubagentBasePrompt(context: GrokBuildAgentPromptContext): string {
  const byKind = { ...TOOL_NAMES, background_task_action: "get_command_or_subagent_output", ...context.toolNamesByKind };
  return renderGrokBuildTemplate(GROK_BUILD_SUBAGENT_TEMPLATE, {
    tools: { by_kind: byKind },
    params: { execute: { is_background: "background" } },
    memory_enabled: context.memoryEnabled ?? false,
    role_instructions: context.roleInstructions ?? "",
    persona_instructions: context.personaInstructions ?? "",
    os_name: context.osName ?? "",
    shell_path: context.shellPath ?? "",
    working_directory: context.workingDirectory ?? "",
    current_date: context.currentDate ?? "",
  });
}
