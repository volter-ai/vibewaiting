// Copyright 2023-2026 SpaceXAI
// SPDX-License-Identifier: Apache-2.0
// Modified for the Vibewaiting browser port, 2026.

import { parse as parseToml } from "smol-toml";
import type { GrokBuildBundleFileSystem } from "./grok-build-bundle.js";
import type { GrokBuildAgentDefinition, GrokBuildCapabilityMode } from "./grok-build-agents.js";

export interface GrokBuildSubagentRole {
  description: string;
  defaultCapabilityMode?: GrokBuildCapabilityMode;
  model?: string;
  reasoningEffort?: string;
  promptFile?: string;
  defaultIsolation?: "none" | "worktree";
  sourceDirectory?: string;
  sourcePath?: string;
}

export interface GrokBuildSubagentPersona {
  instructions?: string;
  description?: string;
  instructionsFile?: string;
  inputs: Array<{ name: string; ioType: string; required: boolean; description: string }>;
  outputs: Array<{ name: string; ioType: string; required: boolean; description: string }>;
  defaultIsolation?: "none" | "worktree";
  model?: string;
  reasoningEffort?: string;
  sourceDirectory?: string;
  sourcePath?: string;
}

export interface GrokBuildSubagentDefinitions {
  roles: Readonly<Record<string, GrokBuildSubagentRole>>;
  personas: Readonly<Record<string, GrokBuildSubagentPersona>>;
}

export interface GrokBuildSubagentRuntimeOverrides {
  model?: string;
  reasoningEffort?: string;
  persona?: string;
  capabilityMode?: GrokBuildCapabilityMode;
  isolation?: "none" | "worktree";
  forkContext?: boolean;
}

export interface GrokBuildResolvedSubagentRuntime {
  model?: string;
  reasoningEffort?: string;
  persona?: string;
  capabilityMode?: GrokBuildCapabilityMode;
  isolation: "none" | "worktree";
  roleName?: string;
  roleInstructions?: string;
  roleWarning?: string;
  personaInstructions?: string;
  personaError?: string;
}

export interface GrokBuildSubagentDefinitionDiscoveryOptions {
  cwd?: string;
  grokHome?: string;
  bundledRoot?: string;
  projectTrusted?: boolean;
  inlineRoles?: Readonly<Record<string, GrokBuildSubagentRole>>;
  inlinePersonas?: Readonly<Record<string, GrokBuildSubagentPersona>>;
}

/** Mirrors config layering: inline > project > user > bundled. */
export function discoverGrokBuildSubagentDefinitions(
  vfs: GrokBuildBundleFileSystem & { readdirSync(path: string): string[] },
  options: GrokBuildSubagentDefinitionDiscoveryOptions = {},
): GrokBuildSubagentDefinitions {
  const inlineRoles = { ...(options.inlineRoles ?? {}) };
  const inlinePersonas = { ...(options.inlinePersonas ?? {}) };
  const grokHome = normalizePath(options.grokHome ?? "/.grok");
  const bundledRoot = normalizePath(options.bundledRoot ?? `${grokHome}/bundled`);
  const lowerRoles: Record<string, GrokBuildSubagentRole> = { ...inlineRoles };
  const lowerPersonas: Record<string, GrokBuildSubagentPersona> = { ...inlinePersonas };
  loadDirectory(vfs, `${grokHome}/roles`, "role", lowerRoles);
  loadDirectory(vfs, `${grokHome}/personas`, "persona", lowerPersonas);
  loadDirectory(vfs, `${bundledRoot}/roles`, "role", lowerRoles);
  loadDirectory(vfs, `${bundledRoot}/personas`, "persona", lowerPersonas);

  const projectRoles: Record<string, GrokBuildSubagentRole> = {};
  const projectPersonas: Record<string, GrokBuildSubagentPersona> = {};
  if (options.projectTrusted ?? true) {
    const cwd = normalizePath(options.cwd ?? "/");
    loadDirectory(vfs, `${cwd === "/" ? "" : cwd}/.grok/roles`, "role", projectRoles);
    loadDirectory(vfs, `${cwd === "/" ? "" : cwd}/.grok/personas`, "persona", projectPersonas);
  }
  for (const [name, role] of Object.entries(lowerRoles)) {
    if (!role.sourceDirectory || projectRoles[name] === undefined) projectRoles[name] = role;
  }
  for (const [name, persona] of Object.entries(lowerPersonas)) {
    if (!persona.sourcePath || projectPersonas[name] === undefined) projectPersonas[name] = persona;
  }
  return { roles: projectRoles, personas: projectPersonas };
}

export function resolveGrokBuildSubagentRuntime(
  subagentType: string,
  definition: GrokBuildAgentDefinition,
  overrides: GrokBuildSubagentRuntimeOverrides,
  definitions: GrokBuildSubagentDefinitions,
  vfs: GrokBuildBundleFileSystem,
  cwd: string,
  parentModel?: string,
): GrokBuildResolvedSubagentRuntime {
  const roleName = definitions.roles[subagentType] ? subagentType
    : overrides.persona && definitions.roles[overrides.persona] ? overrides.persona : undefined;
  const role = roleName ? definitions.roles[roleName] : undefined;
  const persona = overrides.persona ? definitions.personas[overrides.persona] : undefined;
  const roleCapability = role?.defaultCapabilityMode;
  const requestedCapability = intersectGrokBuildCapabilityModes(overrides.capabilityMode, roleCapability);
  const capabilityMode = intersectGrokBuildCapabilityModes(requestedCapability, definition.capabilityMode);
  const personaResolution = resolvePersona(overrides.persona, persona, vfs, cwd);
  if (personaResolution.fatal) {
    return {
      isolation: "none",
      ...(overrides.persona ? { persona: overrides.persona } : {}),
      ...(personaResolution.error ? { personaError: personaResolution.error } : {}),
    };
  }
  const roleResolution = resolveRolePrompt(role, vfs, cwd);
  const definitionModel = typeof definition.model === "string" && definition.model !== "inherit" ? definition.model : undefined;
  const model = overrides.forkContext ? parentModel : overrides.model ?? role?.model ?? persona?.model ?? definitionModel ?? parentModel;
  const reasoningEffort = overrides.reasoningEffort ?? role?.reasoningEffort ?? persona?.reasoningEffort ?? definition.effort;
  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(overrides.persona ? { persona: overrides.persona } : {}),
    ...(capabilityMode ? { capabilityMode } : {}),
    isolation: overrides.isolation ?? role?.defaultIsolation ?? persona?.defaultIsolation ?? definition.isolation ?? "none",
    ...(roleName ? { roleName } : {}),
    ...(roleResolution.prompt ? { roleInstructions: roleResolution.prompt } : {}),
    ...(roleResolution.warning ? { roleWarning: roleResolution.warning } : {}),
    ...(personaResolution.instructions ? { personaInstructions: personaResolution.instructions } : {}),
    ...(personaResolution.error ? { personaError: personaResolution.error } : {}),
  };
}

export function intersectGrokBuildCapabilityModes(
  requested?: GrokBuildCapabilityMode,
  ceiling?: GrokBuildCapabilityMode,
): GrokBuildCapabilityMode | undefined {
  if (!requested) return ceiling;
  if (!ceiling) return requested;
  if (requested === "all") return ceiling;
  if (ceiling === "all") return requested;
  if (requested === "read-only" || ceiling === "read-only") return "read-only";
  return requested === ceiling ? requested : "read-only";
}

export interface GrokBuildSubagentResumeIdentity {
  subagentType: string;
  persona?: string;
  model?: string;
  cwd?: string;
}

export function validateGrokBuildSubagentResume(
  requestedType: string,
  requestedPersona: string | undefined,
  source: GrokBuildSubagentResumeIdentity,
): void {
  if (requestedType !== source.subagentType) {
    throw new Error(`Cannot resume with subagent_type '${requestedType}': source subagent was '${source.subagentType}'. Resumed sessions must use the same subagent type as the source.`);
  }
  if (requestedPersona !== undefined && requestedPersona !== source.persona) {
    throw new Error(`Cannot resume with persona '${requestedPersona}': source subagent used ${JSON.stringify(source.persona)}. Resumed sessions must use the same persona as the source.`);
  }
}

function loadDirectory(
  vfs: GrokBuildBundleFileSystem & { readdirSync(path: string): string[] },
  directory: string,
  kind: "role" | "persona",
  destination: Record<string, GrokBuildSubagentRole> | Record<string, GrokBuildSubagentPersona>,
): void {
  if (!vfs.existsSync(directory) || !vfs.statSync(directory).isDirectory()) return;
  for (const file of vfs.readdirSync(directory)) {
    if (!file.endsWith(".toml")) continue;
    const name = file.slice(0, -5);
    if (destination[name] !== undefined) continue;
    const path = `${directory}/${file}`;
    if (!vfs.statSync(path).isFile()) continue;
    try {
      const parsed = parseToml(vfs.readFileSync(path, "utf8")) as Record<string, unknown>;
      const value = kind === "role" ? parseRole(parsed, directory, path) : parsePersona(parsed, directory, path);
      if (value) destination[name] = value as never;
    } catch { /* Native discovery warns and skips malformed definitions. */ }
  }
}

function parseRole(value: Record<string, unknown>, sourceDirectory: string, sourcePath: string): GrokBuildSubagentRole | undefined {
  const capability = optionalEnum(value.default_capability_mode, ["read-only", "read-write", "execute", "all"] as const);
  const isolation = optionalEnum(value.default_isolation, ["none", "worktree"] as const);
  if (capability === null || isolation === null) return;
  return {
    description: typeof value.description === "string" ? value.description : "",
    ...(capability ? { defaultCapabilityMode: capability } : {}),
    ...(text(value.model) ? { model: text(value.model)! } : {}),
    ...(text(value.reasoning_effort) ? { reasoningEffort: text(value.reasoning_effort)! } : {}),
    ...(text(value.prompt_file) ? { promptFile: text(value.prompt_file)! } : {}),
    ...(isolation ? { defaultIsolation: isolation } : {}),
    sourceDirectory, sourcePath,
  };
}

function parsePersona(value: Record<string, unknown>, sourceDirectory: string, sourcePath: string): GrokBuildSubagentPersona | undefined {
  const isolation = optionalEnum(value.default_isolation, ["none", "worktree"] as const);
  if (isolation === null) return;
  const inputs = parseIo(value.inputs);
  const outputs = parseIo(value.outputs);
  if (!inputs || !outputs) return;
  return {
    ...(text(value.instructions) ? { instructions: text(value.instructions)! } : {}),
    ...(text(value.description) ? { description: text(value.description)! } : {}),
    ...(text(value.instructions_file) ? { instructionsFile: text(value.instructions_file)! } : {}),
    inputs, outputs,
    ...(isolation ? { defaultIsolation: isolation } : {}),
    ...(text(value.model) ? { model: text(value.model)! } : {}),
    ...(text(value.reasoning_effort) ? { reasoningEffort: text(value.reasoning_effort)! } : {}),
    sourceDirectory, sourcePath,
  };
}

function parseIo(value: unknown): GrokBuildSubagentPersona["inputs"] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return;
  const output: GrokBuildSubagentPersona["inputs"] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const entry = item as Record<string, unknown>;
    if (typeof entry.name !== "string" || typeof entry.description !== "string") return;
    output.push({ name: entry.name, description: entry.description, ioType: text(entry.io_type) ?? "file", required: entry.required === true });
  }
  return output;
}

function resolvePersona(
  name: string | undefined,
  persona: GrokBuildSubagentPersona | undefined,
  vfs: GrokBuildBundleFileSystem,
  cwd: string,
): { instructions?: string; error?: string; fatal: boolean } {
  if (!name) return { fatal: false };
  if (!persona) return { error: `persona "${name}" not found in config`, fatal: false };
  const parts = persona.instructions ? [persona.instructions] : [];
  if (persona.instructionsFile) {
    const path = resolvePath(persona.sourceDirectory ?? cwd, persona.instructionsFile);
    try { parts.push(vfs.readFileSync(path, "utf8")); }
    catch (error) { return { error: `persona "${name}": failed to read instructions_file "${persona.instructionsFile}": ${error instanceof Error ? error.message : String(error)}`, fatal: true }; }
  }
  return parts.length ? { instructions: parts.join("\n\n"), fatal: false }
    : { error: `persona "${name}" has no instructions or instructions_file`, fatal: false };
}

function resolveRolePrompt(role: GrokBuildSubagentRole | undefined, vfs: GrokBuildBundleFileSystem, cwd: string): { prompt?: string; warning?: string } {
  if (!role?.promptFile) return {};
  const path = resolvePath(role.sourceDirectory ?? cwd, role.promptFile);
  try { return { prompt: vfs.readFileSync(path, "utf8") }; }
  catch (error) { return { warning: `role prompt_file "${role.promptFile}": ${error instanceof Error ? error.message : String(error)}` }; }
}

function resolvePath(base: string, path: string): string { return path.startsWith("/") ? normalizePath(path) : normalizePath(`${base}/${path}`); }
function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of `/${path}`.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return `/${parts.join("/")}`;
}
function text(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function optionalEnum<const T extends readonly string[]>(value: unknown, allowed: T): T[number] | undefined | null {
  return value === undefined ? undefined : typeof value === "string" && allowed.includes(value) ? value as T[number] : null;
}
