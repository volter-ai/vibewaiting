// Copyright 2023-2026 SpaceXAI
// SPDX-License-Identifier: Apache-2.0
// Modified for the Vibewaiting browser port, 2026.

import type { GrokBuildBundleFileSystem } from "./grok-build-bundle.js";
import { parseGrokBuildFrontmatterDocument } from "./grok-build-skills.js";

export interface GrokBuildAgentDefinition {
  name: string;
  description: string;
  promptMode: "extend" | "full";
  promptBody?: string;
  permissionMode: "default" | "plan" | "bypassPermissions";
  model?: string;
  agentsMd: boolean;
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
    model: "inherit",
    agentsMd: true,
    source: "builtin",
  },
  {
    name: "explore",
    description: "Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. \"src/components/**/*.tsx\"), search code for keywords (eg. \"API endpoints\"), or answer questions about the codebase (eg. \"how do API endpoints work?\"). When calling this agent, specify the desired thoroughness level: \"quick\" for basic searches, \"medium\" for moderate exploration, or \"very thorough\" for comprehensive analysis across multiple locations and naming conventions. Read-only — has access to: run_terminal_cmd, read_file, list_dir, grep.",
    promptMode: "full",
    promptBody: EXPLORE_PROMPT,
    permissionMode: "plan",
    agentsMd: true,
    source: "builtin",
  },
  {
    name: "plan",
    description: "Software architect agent for designing implementation plans. Returns step-by-step plans, identifies critical files, and considers architectural trade-offs. Read-only.",
    promptMode: "full",
    promptBody: PLAN_PROMPT,
    permissionMode: "plan",
    model: "inherit",
    agentsMd: true,
    source: "builtin",
  },
];

function scalarBoolean(value: string | undefined, fallback: boolean): boolean {
  return value === undefined ? fallback : value === "true";
}

function parseDefinition(content: string, source: GrokBuildAgentDefinition["source"], path: string): GrokBuildAgentDefinition | undefined {
  const document = parseGrokBuildFrontmatterDocument(content);
  const name = document.frontmatter?.name?.trim();
  const description = document.frontmatter?.description?.trim();
  if (!name || !description || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(name)) return;
  const promptMode = document.frontmatter?.prompt_mode === "full" ? "full" : "extend";
  const permission = document.frontmatter?.permission_mode;
  const permissionMode = permission === "plan" || permission === "bypassPermissions" ? permission : "default";
  return {
    name,
    description,
    promptMode,
    ...(document.body.trim() ? { promptBody: document.body.trim() } : {}),
    permissionMode,
    ...(document.frontmatter?.model ? { model: document.frontmatter.model } : {}),
    agentsMd: scalarBoolean(document.frontmatter?.agents_md, true),
    source,
    sourcePath: path,
  };
}

function readDefinitions(
  vfs: GrokBuildBundleFileSystem & { readdirSync(path: string): string[] },
  directory: string,
  source: GrokBuildAgentDefinition["source"],
): GrokBuildAgentDefinition[] {
  if (!vfs.existsSync(directory) || !vfs.statSync(directory).isDirectory()) return [];
  return [...vfs.readdirSync(directory)].sort().flatMap((name) => {
    const path = `${directory}/${name}`;
    if (!name.endsWith(".md") || !vfs.statSync(path).isFile()) return [];
    const definition = parseDefinition(vfs.readFileSync(path, "utf8"), source, path);
    return definition ? [definition] : [];
  });
}

export function discoverGrokBuildAgents(
  vfs: GrokBuildBundleFileSystem & { readdirSync(path: string): string[] },
): GrokBuildAgentDefinition[] {
  const ordered = [
    ...readDefinitions(vfs, "/.grok/agents", "project"),
    ...BUILTINS,
    ...readDefinitions(vfs, "/.claude/agents", "user"),
    ...readDefinitions(vfs, "/.grok/bundled/agents", "bundled"),
  ];
  const seen = new Set<string>();
  return ordered.filter((definition) => !seen.has(definition.name) && Boolean(seen.add(definition.name)));
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

export function renderGrokBuildAgentPrompt(definition: GrokBuildAgentDefinition): string | undefined {
  if (!definition.promptBody) return;
  return definition.promptBody.replace(/\$\{\{\s*tools\.by_kind\.([a-z_]+)\s*\}\}/gu, (match, kind: string) => TOOL_NAMES[kind] ?? match);
}
