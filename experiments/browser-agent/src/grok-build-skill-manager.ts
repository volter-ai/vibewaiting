// Copyright 2023-2026 SpaceXAI
// SPDX-License-Identifier: Apache-2.0
// Modified for the Vibewaiting browser port, 2026.

import type { GrokBuildToolCall, GrokBuildToolResult } from "./grok-build-agent.js";
import type { GrokBuildBundleFileSystem } from "./grok-build-bundle.js";
import {
  createGrokBuildSkillReminder,
  discoverGrokBuildSkills,
  discoverGrokBuildSkillsNearPath,
  type GrokBuildSkillInfo,
} from "./grok-build-skills.js";

type SkillVfs = GrokBuildBundleFileSystem & { readdirSync(path: string): string[] };

/** Session-scoped port of Grok Build's startup, conditional, and path-driven skill lifecycle. */
export class GrokBuildSkillManager {
  private readonly startup: GrokBuildSkillInfo[];
  private readonly held = new Map<string, GrokBuildSkillInfo>();
  private readonly discoveredPaths = new Set<string>();
  private readonly announcedNames = new Set<string>();

  constructor(private readonly vfs: SkillVfs, private readonly workspacePath = "/") {
    const skills = discoverGrokBuildSkills(vfs);
    this.startup = skills.filter((skill) => !skill.paths?.length);
    for (const skill of skills) {
      this.discoveredPaths.add(skill.path);
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
      for (const skill of discoverGrokBuildSkillsNearPath(this.vfs, discoveryPath, this.workspacePath)) {
        if (this.discoveredPaths.has(skill.path)) continue;
        this.discoveredPaths.add(skill.path);
        if (skill.paths?.length && !paths.some((path) => matchesAnyPath(skill.paths!, path, this.workspacePath))) {
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

function matchesAnyPath(patterns: readonly string[], absolutePath: string, workspacePath: string): boolean {
  const root = normalizePath(workspacePath);
  const path = normalizePath(absolutePath);
  const relative = root === "/" ? path.slice(1) : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path.slice(1);
  let matched = false;
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const pattern = (negated ? raw.slice(1) : raw).replace(/^\.\//u, "").replace(/^\//u, "");
    if (globMatches(pattern, relative)) matched = !negated;
  }
  return matched;
}

function globMatches(pattern: string, path: string): boolean {
  const escape = (character: string): string => /[\\^$+?.()|{}\[\]]/u.test(character) ? `\\${character}` : character;
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character !== "*") { source += escape(character); continue; }
    if (pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") { index += 1; source += "(?:.*/)?"; } else source += ".*";
    } else source += "[^/]*";
  }
  const directoryPattern = !/[?*]/u.test(pattern) && !pattern.includes(".");
  return new RegExp(`^(?:${source})${directoryPattern ? "(?:/.*)?" : ""}$`, "u").test(path);
}
