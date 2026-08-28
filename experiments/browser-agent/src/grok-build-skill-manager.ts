// Copyright 2023-2026 SpaceXAI
// SPDX-License-Identifier: Apache-2.0
// Modified for the Vibewaiting browser port, 2026.

import type { GrokBuildToolCall, GrokBuildToolResult } from "./grok-build-agent.js";
import {
  canonicalGrokBuildSkillPath,
  createGrokBuildSkillReminder,
  discoverGrokBuildSkillAtPath,
  discoverGrokBuildSkills,
  discoverGrokBuildSkillsNearPath,
  type GrokBuildSkillDiscoveryOptions,
  type GrokBuildSkillFileSystem,
  type GrokBuildSkillInfo,
} from "./grok-build-skills.js";

type SkillVfs = GrokBuildSkillFileSystem;

/** Session-scoped port of Grok Build's startup, conditional, and path-driven skill lifecycle. */
export class GrokBuildSkillManager {
  private readonly startup: GrokBuildSkillInfo[];
  private readonly held = new Map<string, GrokBuildSkillInfo>();
  private readonly discoveredPaths = new Set<string>();
  private readonly announcedNames = new Set<string>();
  private readonly checkedDirectories = new Set<string>();

  constructor(
    private readonly vfs: SkillVfs,
    private readonly workspacePath = "/",
    private readonly discoveryOptions: GrokBuildSkillDiscoveryOptions = {},
  ) {
    const skills = discoverGrokBuildSkills(vfs, { ...discoveryOptions, workingDirectory: workspacePath });
    this.startup = skills.filter((skill) => !skill.paths?.length);
    for (const skill of skills) {
      this.discoveredPaths.add(canonicalGrokBuildSkillPath(vfs, skill.path));
      if (skill.paths?.length) this.held.set(skill.path, skill);
    }
    for (const skill of this.startup) this.announcedNames.add(skill.name);
  }

  startupSkills(): readonly GrokBuildSkillInfo[] {
    return this.startup;
  }

  /** Native runs this reconciliation after successful path-producing tool calls. */
  afterToolCall(call: GrokBuildToolCall, result: GrokBuildToolResult): string | undefined {
    if (result.isError) return;
    const paths = activationPaths(call).map((path) => resolvePath(path, this.workspacePath));
    if (!paths.length) return;
    const newlyAvailable: GrokBuildSkillInfo[] = [];

    for (const skill of this.held.values()) {
      if (!skill.paths?.length || !paths.some((path) => matchesAnyPath(skill.paths!, path, this.workspacePath))) continue;
      this.held.delete(skill.path);
      if (!this.announcedNames.has(skill.name)) newlyAvailable.push(skill);
    }

    const rawDiscoveryPath = discoveryTarget(call);
    const discoveryPath = rawDiscoveryPath ? resolvePath(rawDiscoveryPath, this.workspacePath) : undefined;
    if (discoveryPath) {
      // Native special-cases a directly touched SKILL.md because the normal
      // ancestor walk intentionally never scans inside the skill directory.
      const direct = discoverGrokBuildSkillAtPath(this.vfs, discoveryPath);
      const discovered = direct ? [direct] : discoverGrokBuildSkillsNearPath(this.vfs, discoveryPath, this.workspacePath, {
        ...(this.discoveryOptions.claudeSkills === undefined ? {} : { claudeSkills: this.discoveryOptions.claudeSkills }),
        ...(this.discoveryOptions.gitRootPath === undefined ? {} : { gitRootPath: this.discoveryOptions.gitRootPath }),
        checkedDirectories: this.checkedDirectories,
      });
      for (const skill of discovered) {
        const canonical = canonicalGrokBuildSkillPath(this.vfs, skill.path);
        if (this.discoveredPaths.has(canonical)) continue;
        this.discoveredPaths.add(canonical);
        // Native activation runs before discovery. A newly discovered gated
        // skill is therefore always held until a later matching tool call.
        if (skill.paths?.length) {
          this.held.set(skill.path, skill);
        } else if (!this.announcedNames.has(skill.name)) {
          newlyAvailable.push(skill);
        }
      }
    }

    const deduplicated = newlyAvailable.filter((skill) => {
      if (this.announcedNames.has(skill.name)) return false;
      this.announcedNames.add(skill.name);
      return skill.enabled && !skill.disableModelInvocation;
    });
    return createGrokBuildSkillReminder(deduplicated);
  }
}

function inputObject(call: GrokBuildToolCall): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(call.arguments || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return;
  }
}

function pathField(call: GrokBuildToolCall): string | undefined {
  const input = inputObject(call);
  return [input?.file_path, input?.path, input?.target_file, input?.target_directory]
    .find((value): value is string => typeof value === "string");
}

function activationPaths(call: GrokBuildToolCall): string[] {
  if (!["read_file", "list_dir", "search_replace", "write"].includes(call.name)) return [];
  const path = pathField(call);
  return path ? [normalizePath(path)] : [];
}

function discoveryTarget(call: GrokBuildToolCall): string | undefined {
  return ["read_file", "list_dir", "search_replace"].includes(call.name) ? pathField(call) : undefined;
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function resolvePath(path: string, workspacePath: string): string {
  if (path.startsWith("/")) return normalizePath(path);
  const root = normalizePath(workspacePath);
  return normalizePath(`${root}/${path}`);
}

export function grokBuildSkillPathsMatch(patterns: readonly string[], absolutePath: string, workspacePath: string): boolean {
  const root = normalizePath(workspacePath);
  const path = normalizePath(absolutePath);
  if (root !== "/" && path !== root && !path.startsWith(`${root}/`)) return false;
  const relative = root === "/" ? path.slice(1) : path === root ? "" : path.slice(root.length + 1);
  const rules = patterns.flatMap(parseGitignoreRule);
  const candidates = [relative];
  let parent = relative;
  while (parent.includes("/")) {
    parent = parent.slice(0, parent.lastIndexOf("/"));
    candidates.push(parent);
  }
  // `matched_path_or_any_parents`: the closest path with any matching rule
  // decides; within a path, the last matching rule wins.
  for (let index = 0; index < candidates.length; index += 1) {
    let outcome: boolean | undefined;
    for (const rule of rules) {
      if (rule.matches(candidates[index]!, index > 0)) outcome = !rule.negated;
    }
    if (outcome !== undefined) return outcome;
  }
  return false;
}

function matchesAnyPath(patterns: readonly string[], absolutePath: string, workspacePath: string): boolean {
  return grokBuildSkillPathsMatch(patterns, absolutePath, workspacePath);
}

interface GitignoreRule {
  negated: boolean;
  matches(path: string, directory: boolean): boolean;
}

function trimUnescapedTrailingSpaces(value: string): string {
  let end = value.length;
  while (end > 0 && /\s/u.test(value[end - 1]!)) {
    let slashes = 0;
    for (let index = end - 2; index >= 0 && value[index] === "\\"; index -= 1) slashes += 1;
    if (slashes % 2 === 1) break;
    end -= 1;
  }
  return value.slice(0, end);
}

function expandBraces(pattern: string): string[] {
  let opening = -1;
  let depth = 0;
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] === "\\") { index += 1; continue; }
    if (pattern[index] === "[") { inClass = true; continue; }
    if (pattern[index] === "]") { inClass = false; continue; }
    if (!inClass && pattern[index] === "{" && depth++ === 0) opening = index;
    else if (!inClass && pattern[index] === "}" && --depth === 0 && opening >= 0) {
      const inner = pattern.slice(opening + 1, index);
      const choices: string[] = [];
      let item = "";
      let nested = 0;
      let nestedClass = false;
      for (let cursor = 0; cursor < inner.length; cursor += 1) {
        const character = inner[cursor]!;
        if (character === "\\") { item += character + (inner[++cursor] ?? ""); continue; }
        if (character === "[") nestedClass = true;
        else if (character === "]") nestedClass = false;
        else if (!nestedClass && character === "{") nested += 1;
        else if (!nestedClass && character === "}") nested -= 1;
        if (character === "," && nested === 0 && !nestedClass) { choices.push(item); item = ""; } else item += character;
      }
      choices.push(item);
      return choices.filter(Boolean).flatMap((choice) => expandBraces(`${pattern.slice(0, opening)}${choice}${pattern.slice(index + 1)}`));
    }
  }
  return [pattern];
}

function hasBalancedBraces(pattern: string): boolean {
  let depth = 0;
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "\\") { index += 1; continue; }
    if (character === "[") inClass = true;
    else if (character === "]") inClass = false;
    else if (!inClass && character === "{") depth += 1;
    else if (!inClass && character === "}" && --depth < 0) return false;
  }
  return depth === 0;
}

function hasOnlyLegalDoubleStars(pattern: string): boolean {
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "\\") { index += 1; continue; }
    if (character === "[") { inClass = true; continue; }
    if (character === "]") { inClass = false; continue; }
    if (inClass || character !== "*" || pattern[index + 1] !== "*") continue;
    let end = index + 2;
    while (pattern[end] === "*") end += 1;
    if (end - index !== 2) return false;
    const previous = index === 0 ? undefined : pattern[index - 1];
    const next = pattern[end];
    const legal = (index === 0 && end === pattern.length)
      || (index === 0 && next === "/")
      || (previous === "/" && end === pattern.length)
      || (previous === "/" && next === "/");
    if (!legal) return false;
    index = end - 1;
  }
  return true;
}

function globRegexSource(pattern: string): string {
  const literal = (character: string): string => /[\\^$+?.()|{}\[\]]/u.test(character) ? `\\${character}` : character;
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "\\") { source += literal(pattern[++index] ?? "\\"); continue; }
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        while (pattern[index + 1] === "*") index += 1;
        if (pattern[index + 1] === "/") { index += 1; source += "(?:[^/]+/)*"; }
        else source += ".*";
      } else source += "[^/]*";
      continue;
    }
    if (character === "?") { source += "[^/]"; continue; }
    if (character === "[") {
      let end = index + 1;
      if (pattern[end] === "!" || pattern[end] === "^") end += 1;
      if (pattern[end] === "]") end += 1;
      while (end < pattern.length && pattern[end] !== "]") end += pattern[end] === "\\" ? 2 : 1;
      if (end < pattern.length) {
        let body = pattern.slice(index + 1, end);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        source += `[${body}]`;
        index = end;
        continue;
      }
    }
    source += literal(character);
  }
  return source;
}

function parseGitignoreRule(rawLine: string): GitignoreRule[] {
  let line = trimUnescapedTrailingSpaces(rawLine);
  if (!line || line.startsWith("#")) return [];
  let negated = false;
  if (line.startsWith("!")) { negated = true; line = line.slice(1); }
  else if (line.startsWith("\\!") || line.startsWith("\\#")) line = line.slice(1);
  if (!line) return [];
  const directoryOnly = line.endsWith("/");
  if (directoryOnly) {
    line = line.slice(0, -1);
    if (line.endsWith("\\")) line = line.slice(0, -1);
  }
  const anchored = line.startsWith("/");
  if (anchored) line = line.slice(1);
  if (!hasBalancedBraces(line) || !hasOnlyLegalDoubleStars(line)) return [];
  const pathPattern = anchored || line.includes("/");
  return expandBraces(line).flatMap((expanded) => {
    try {
      const regex = new RegExp(`^${globRegexSource(expanded)}$`, "u");
      return [{
        negated,
        matches(path: string, directory: boolean): boolean {
          if (directoryOnly && !directory) return false;
          return regex.test(pathPattern ? path : path.slice(path.lastIndexOf("/") + 1));
        },
      } satisfies GitignoreRule];
    } catch {
      // `GitignoreBuilder::add_line` ignores malformed individual patterns.
      return [];
    }
  });
}
