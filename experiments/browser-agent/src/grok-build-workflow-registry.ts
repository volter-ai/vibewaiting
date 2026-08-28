// Copyright 2023-2026 SpaceXAI
// SPDX-License-Identifier: Apache-2.0
// Modified for the Vibewaiting browser port, 2026.
//
// Browser-VFS port of Grok Build's workflow registry and model-facing listing.

import {
  readGrokBuildBundleManifest,
  type GrokBuildBundleFileSystem,
} from "./grok-build-bundle.js";

const MAX_WORKFLOW_SOURCE_BYTES = 1024 * 1024;
const MAX_WORKFLOW_NAME_BYTES = 64;
const MAX_WORKFLOW_DESCRIPTION_BYTES = 1_024;
const MAX_WORKFLOW_WHEN_TO_USE_BYTES = 2_048;
const MAX_WORKFLOW_PHASES = 64;
const MAX_PHASE_TITLE_BYTES = 128;
const MAX_PHASE_DETAIL_BYTES = 1_024;
const MAX_LISTING_COMBINED_BYTES = 400;
const MIN_LISTING_FIELD_BYTES = 20;

export interface GrokBuildWorkflowFileSystem extends GrokBuildBundleFileSystem {
  readdirSync(path: string): string[];
}

export interface GrokBuildWorkflowPhase {
  title: string;
  detail?: string;
}

export interface GrokBuildWorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases: GrokBuildWorkflowPhase[];
}

export interface GrokBuildWorkflowDefinition {
  meta: GrokBuildWorkflowMeta;
  script: string;
  source: "builtin" | "bundled" | "project" | "user" | "inline" | "file";
  path?: string;
}

export interface GrokBuildBuiltinWorkflow {
  script: string;
  path?: string;
}

export interface GrokBuildWorkflowRegistryOptions {
  workspacePath?: string;
  userWorkflowPath?: string;
  builtins?: readonly GrokBuildBuiltinWorkflow[];
  /** Bundle paths whose current bytes match the signed manifest checksum. */
  managedBundledWorkflowPaths?: readonly string[];
}

type RhaiLiteral = null | boolean | number | string | RhaiLiteral[] | { [key: string]: RhaiLiteral };

class RhaiLiteralParser {
  private offset = 0;

  constructor(private readonly source: string) {}

  parseMetaStatement(): RhaiLiteral {
    this.space();
    if (!(this.word("let") || this.word("const"))) {
      throw new Error("first statement must be `let meta = #{ ... };`");
    }
    this.space();
    if (!this.word("meta")) throw new Error("first statement must be `let meta = #{ ... };`");
    this.space();
    this.take("=");
    const value = this.value();
    this.space();
    this.take(";");
    return value;
  }

  private value(): RhaiLiteral {
    this.space();
    if (this.source.startsWith("#{", this.offset)) return this.map();
    if (this.peek() === "[") return this.array();
    if (this.peek() === '"') return this.string();
    if (this.word("true")) return true;
    if (this.word("false")) return false;
    if (this.source.startsWith("()", this.offset)) { this.offset += 2; return null; }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(this.source.slice(this.offset));
    if (number) {
      this.offset += number[0].length;
      const parsed = Number(number[0]);
      if (!Number.isFinite(parsed)) throw new Error("meta contains a non-finite number");
      return parsed;
    }
    throw new Error(`meta must be a pure-literal map (unexpected token at byte ${this.offset})`);
  }

  private map(): { [key: string]: RhaiLiteral } {
    this.offset += 2;
    const result: { [key: string]: RhaiLiteral } = {};
    while (true) {
      this.space();
      if (this.peek() === "}") { this.offset += 1; return result; }
      const key = this.peek() === '"' ? this.string() : this.identifier();
      this.space();
      this.take(":");
      result[key] = this.value();
      this.space();
      if (this.peek() === ",") { this.offset += 1; continue; }
      if (this.peek() !== "}") throw new Error("expected `,` or `}` in meta map");
    }
  }

  private array(): RhaiLiteral[] {
    this.offset += 1;
    const result: RhaiLiteral[] = [];
    while (true) {
      this.space();
      if (this.peek() === "]") { this.offset += 1; return result; }
      result.push(this.value());
      this.space();
      if (this.peek() === ",") { this.offset += 1; continue; }
      if (this.peek() !== "]") throw new Error("expected `,` or `]` in meta array");
    }
  }

  private identifier(): string {
    const match = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(this.source.slice(this.offset));
    if (!match) throw new Error("expected a meta map key");
    this.offset += match[0].length;
    return match[0];
  }

  private string(): string {
    const start = this.offset;
    this.offset += 1;
    let escaped = false;
    while (this.offset < this.source.length) {
      const character = this.source[this.offset++]!;
      if (escaped) { escaped = false; continue; }
      if (character === "\\") { escaped = true; continue; }
      if (character === '"') {
        const raw = this.source.slice(start, this.offset);
        try { return JSON.parse(raw) as string; }
        catch { throw new Error("meta contains an invalid string literal"); }
      }
    }
    throw new Error("meta contains an unterminated string literal");
  }

  private word(value: string): boolean {
    if (!this.source.startsWith(value, this.offset)) return false;
    const next = this.source[this.offset + value.length];
    if (next && /[A-Za-z0-9_]/u.test(next)) return false;
    this.offset += value.length;
    return true;
  }

  private take(value: string): void {
    if (!this.source.startsWith(value, this.offset)) throw new Error(`expected \`${value}\` in meta statement`);
    this.offset += value.length;
  }

  private peek(): string | undefined { return this.source[this.offset]; }

  private space(): void {
    while (this.offset < this.source.length) {
      const rest = this.source.slice(this.offset);
      const whitespace = /^\s+/u.exec(rest);
      if (whitespace) { this.offset += whitespace[0].length; continue; }
      if (rest.startsWith("//")) {
        const newline = rest.indexOf("\n");
        this.offset += newline < 0 ? rest.length : newline + 1;
        continue;
      }
      if (rest.startsWith("/*")) {
        const end = rest.indexOf("*/", 2);
        if (end < 0) throw new Error("unterminated comment before workflow meta");
        this.offset += end + 2;
        continue;
      }
      return;
    }
  }
}

function utf8Length(value: string): number { return new TextEncoder().encode(value).byteLength; }

function requireString(map: Record<string, RhaiLiteral>, field: string): string {
  const value = map[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function optionalString(map: Record<string, RhaiLiteral>, field: string): string | undefined {
  const value = map[field];
  if (value === undefined || value === null) return;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function bounded(field: string, value: string, maximum: number): void {
  const actual = utf8Length(value);
  if (actual > maximum) throw new Error(`${field} must be at most ${maximum} UTF-8 bytes (got ${actual})`);
}

export function isValidGrokBuildWorkflowName(name: string): boolean {
  return utf8Length(name) <= MAX_WORKFLOW_NAME_BYTES
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(name)
    && !name.includes("--");
}

export function extractGrokBuildWorkflowMeta(script: string): GrokBuildWorkflowMeta {
  const literal = new RhaiLiteralParser(script).parseMetaStatement();
  if (!literal || Array.isArray(literal) || typeof literal !== "object") throw new Error("meta is not a valid map");
  const map = literal as Record<string, RhaiLiteral>;
  const allowed = new Set(["name", "description", "when_to_use", "phases"]);
  const unknown = Object.keys(map).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`meta is not a valid map: unknown field \`${unknown}\``);
  const name = requireString(map, "name");
  const description = requireString(map, "description");
  const whenToUse = optionalString(map, "when_to_use");
  bounded("meta.name", name, MAX_WORKFLOW_NAME_BYTES);
  if (!isValidGrokBuildWorkflowName(name)) throw new Error("meta.name must be lowercase ASCII letters or digits separated by single hyphens");
  bounded("meta.description", description, MAX_WORKFLOW_DESCRIPTION_BYTES);
  if (whenToUse !== undefined) bounded("meta.when_to_use", whenToUse, MAX_WORKFLOW_WHEN_TO_USE_BYTES);
  const rawPhases = map.phases ?? [];
  if (!Array.isArray(rawPhases)) throw new Error("meta.phases must be an array");
  if (rawPhases.length > MAX_WORKFLOW_PHASES) throw new Error(`meta.phases must contain at most ${MAX_WORKFLOW_PHASES} entries (got ${rawPhases.length})`);
  const titles = new Set<string>();
  const phases = rawPhases.map((raw, index): GrokBuildWorkflowPhase => {
    if (!raw || Array.isArray(raw) || typeof raw !== "object") throw new Error("meta.phases[] must be a map");
    const phase = raw as Record<string, RhaiLiteral>;
    const unknownPhase = Object.keys(phase).find((key) => key !== "title" && key !== "detail");
    if (unknownPhase) throw new Error(`meta.phases[${index}] contains unknown field \`${unknownPhase}\``);
    const title = requireString(phase, "title");
    const detail = optionalString(phase, "detail");
    if (titles.has(title)) throw new Error(`duplicate meta.phases[].title: ${JSON.stringify(title)}`);
    titles.add(title);
    bounded(`meta.phases[${index}].title`, title, MAX_PHASE_TITLE_BYTES);
    if (detail !== undefined) bounded(`meta.phases[${index}].detail`, detail, MAX_PHASE_DETAIL_BYTES);
    return { title, ...(detail !== undefined ? { detail } : {}) };
  });
  return { name, description, ...(whenToUse !== undefined ? { whenToUse } : {}), phases };
}

export function normalizeGrokBuildWorkflowPath(path: string, base = "/"): string {
  const input = path.startsWith("/") ? path : `${base.replace(/\/$/u, "")}/${path}`;
  const parts: string[] = [];
  for (const part of input.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root.replace(/\/$/u, "")}/`);
}

function isDirectory(vfs: GrokBuildWorkflowFileSystem, path: string): boolean {
  try { return vfs.existsSync(path) && vfs.statSync(path).isDirectory(); } catch { return false; }
}

function isFile(vfs: GrokBuildWorkflowFileSystem, path: string): boolean {
  try { return vfs.existsSync(path) && vfs.statSync(path).isFile(); } catch { return false; }
}

function projectRoot(vfs: GrokBuildWorkflowFileSystem, cwd: string): string {
  let candidate = normalizeGrokBuildWorkflowPath(cwd);
  while (true) {
    if (vfs.existsSync(`${candidate === "/" ? "" : candidate}/.git`)) return candidate;
    if (candidate === "/") return normalizeGrokBuildWorkflowPath(cwd);
    candidate = candidate.slice(0, candidate.lastIndexOf("/")) || "/";
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Mirrors native `is_managed_bundle_file`: manifest membership alone is not privilege. */
export async function managedGrokBuildBundledWorkflowPaths(vfs: GrokBuildWorkflowFileSystem): Promise<string[]> {
  const manifest = readGrokBuildBundleManifest(vfs);
  if (!manifest) return [];
  const paths = await Promise.all(Object.entries(manifest.checksums).flatMap(([relative, checksum]) => {
    if (!/^workflows\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.rhai$/u.test(relative)) return [];
    const path = `/.grok/bundled/${relative}`;
    if (!isFile(vfs, path)) return [];
    return [sha256Hex(vfs.readFileSync(path)).then((actual) => actual === checksum.toLowerCase() ? path : undefined)];
  }));
  return paths.filter((path): path is string => path !== undefined);
}

function readDefinition(
  vfs: GrokBuildWorkflowFileSystem,
  path: string,
  source: GrokBuildWorkflowDefinition["source"],
  enforceFilename: boolean,
): GrokBuildWorkflowDefinition {
  if (!isFile(vfs, path)) throw new Error(`failed to read ${path}: expected a regular file`);
  const bytes = vfs.readFileSync(path);
  if (bytes.byteLength > MAX_WORKFLOW_SOURCE_BYTES) throw new Error(`workflow source exceeds ${MAX_WORKFLOW_SOURCE_BYTES} bytes: ${path}`);
  const script = new TextDecoder().decode(bytes);
  const meta = extractGrokBuildWorkflowMeta(script);
  if (enforceFilename) {
    const filename = path.split("/").at(-1) ?? "";
    if (!filename.endsWith(".rhai") || !isValidGrokBuildWorkflowName(filename.slice(0, -5))) {
      throw new Error(`invalid workflow filename '${filename}': expected <safe-name>.rhai`);
    }
    if (filename !== `${meta.name}.rhai`) throw new Error(`saved workflow filename '${filename}' must match meta.name '${meta.name}'`);
  }
  return { meta, script, source, path };
}

function scanDirectory(
  vfs: GrokBuildWorkflowFileSystem,
  path: string,
  source: GrokBuildWorkflowDefinition["source"],
): { entries: GrokBuildWorkflowDefinition[]; duplicateNames: Set<string> } {
  if (!isDirectory(vfs, path)) return { entries: [], duplicateNames: new Set() };
  const parsed = [...vfs.readdirSync(path)].sort().flatMap((name) => {
    if (!name.endsWith(".rhai")) return [];
    try { return [readDefinition(vfs, `${path}/${name}`, source, true)]; } catch { return []; }
  });
  const counts = new Map<string, number>();
  for (const entry of parsed) counts.set(entry.meta.name, (counts.get(entry.meta.name) ?? 0) + 1);
  const duplicateNames = new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
  return { entries: parsed.filter((entry) => !duplicateNames.has(entry.meta.name)), duplicateNames };
}

export class GrokBuildWorkflowRegistry {
  private readonly entries: GrokBuildWorkflowDefinition[];
  private readonly duplicateNames = new Map<string, string>();
  readonly workspacePath: string;
  readonly projectWorkflowPath: string;
  readonly userWorkflowPath: string;

  constructor(private readonly vfs: GrokBuildWorkflowFileSystem, options: GrokBuildWorkflowRegistryOptions = {}) {
    this.workspacePath = normalizeGrokBuildWorkflowPath(options.workspacePath ?? "/");
    this.projectWorkflowPath = normalizeGrokBuildWorkflowPath(".grok/workflows", projectRoot(vfs, this.workspacePath));
    this.userWorkflowPath = normalizeGrokBuildWorkflowPath(options.userWorkflowPath ?? "/.grok/workflows");
    this.entries = [];
    const builtins = (options.builtins ?? []).flatMap((builtin) => {
      try {
        const meta = extractGrokBuildWorkflowMeta(builtin.script);
        return [{ meta, script: builtin.script, source: "builtin" as const, ...(builtin.path ? { path: builtin.path } : {}) }];
      } catch { return []; }
    });
    const compiledNames = new Set(builtins.map((entry) => entry.meta.name));
    const managedPaths = new Set((options.managedBundledWorkflowPaths ?? []).map((path) => normalizeGrokBuildWorkflowPath(path)));
    const bundled = scanDirectory(vfs, "/.grok/bundled/workflows", "bundled");
    bundled.entries = bundled.entries.map((entry) => compiledNames.has(entry.meta.name) && entry.path && managedPaths.has(entry.path)
      ? { ...entry, source: "builtin" }
      : entry);
    this.addScope(bundled, "bundled");
    this.merge(builtins);
    this.addScope(scanDirectory(vfs, this.projectWorkflowPath, "project"), "project");
    if (this.userWorkflowPath !== this.projectWorkflowPath) {
      this.addScope(scanDirectory(vfs, this.userWorkflowPath, "user"), "user");
    }
  }

  list(): GrokBuildWorkflowDefinition[] { return this.entries.map((entry) => ({ ...entry, meta: { ...entry.meta, phases: entry.meta.phases.map((phase) => ({ ...phase })) } })); }

  resolveByName(name: string): GrokBuildWorkflowDefinition {
    if (!isValidGrokBuildWorkflowName(name)) throw new Error(`invalid workflow name '${name}': expected 1-64 lowercase letters, digits, or single hyphens`);
    const duplicate = this.duplicateNames.get(name);
    if (duplicate) throw new Error(`ambiguous workflow '${name}': duplicate definitions in ${duplicate} scope`);
    const entry = this.entries.find((candidate) => candidate.meta.name === name);
    if (!entry) throw new Error(`unknown workflow: ${name}`);
    return entry;
  }

  resolveInline(script: string): GrokBuildWorkflowDefinition {
    if (utf8Length(script) > MAX_WORKFLOW_SOURCE_BYTES) throw new Error(`workflow source exceeds ${MAX_WORKFLOW_SOURCE_BYTES} bytes: <inline>`);
    return { meta: extractGrokBuildWorkflowMeta(script), script, source: "inline" };
  }

  resolveByPath(path: string, runRoot = "/.grok/workflow-runs"): GrokBuildWorkflowDefinition {
    const candidate = normalizeGrokBuildWorkflowPath(path, this.workspacePath);
    const roots = [projectRoot(this.vfs, this.workspacePath), runRoot, this.userWorkflowPath].map((root) => normalizeGrokBuildWorkflowPath(root));
    if (!roots.some((root) => under(candidate, root))) {
      throw new Error(`workflow path is not trusted: ${candidate} (outside the project, grok home, and session workflow runs)`);
    }
    const inRunRoot = under(candidate, normalizeGrokBuildWorkflowPath(runRoot));
    return readDefinition(this.vfs, candidate, "file", !inRunRoot);
  }

  private addScope(scope: ReturnType<typeof scanDirectory>, label: string): void {
    for (const name of scope.duplicateNames) this.duplicateNames.set(name, label);
    this.merge(scope.entries);
  }

  private merge(entries: readonly GrokBuildWorkflowDefinition[]): void {
    for (const entry of entries) {
      if (!this.entries.some((existing) => existing.meta.name === entry.meta.name)) this.entries.push(entry);
    }
  }
}

function truncateUtf8(value: string, maximum: number): string {
  if (utf8Length(value) <= maximum) return value;
  const marker = "…";
  let result = "";
  let bytes = 0;
  const budget = Math.max(0, maximum - utf8Length(marker));
  for (const character of value) {
    const size = utf8Length(character);
    if (bytes + size > budget) break;
    result += character;
    bytes += size;
  }
  return `${result}${marker}`;
}

function listingBudgets(workflow: GrokBuildWorkflowDefinition): [number, number] {
  const when = workflow.meta.whenToUse;
  if (!when) return [MAX_LISTING_COMBINED_BYTES, 0];
  const descriptionLength = Math.max(1, utf8Length(workflow.meta.description));
  const whenLength = Math.max(1, utf8Length(when));
  let description = Math.floor(MAX_LISTING_COMBINED_BYTES * descriptionLength / (descriptionLength + whenLength));
  let trigger = MAX_LISTING_COMBINED_BYTES - description;
  if (description < MIN_LISTING_FIELD_BYTES && trigger > MIN_LISTING_FIELD_BYTES) [description, trigger] = [MIN_LISTING_FIELD_BYTES, MAX_LISTING_COMBINED_BYTES - MIN_LISTING_FIELD_BYTES];
  else if (trigger < MIN_LISTING_FIELD_BYTES && description > MIN_LISTING_FIELD_BYTES) [description, trigger] = [MAX_LISTING_COMBINED_BYTES - MIN_LISTING_FIELD_BYTES, MIN_LISTING_FIELD_BYTES];
  return [description, trigger];
}

export function formatGrokBuildWorkflowListing(workflows: readonly GrokBuildWorkflowDefinition[]): string | undefined {
  if (!workflows.length) return;
  const entries = workflows.map((workflow) => {
    const [descriptionBudget, triggerBudget] = listingBudgets(workflow);
    let text = `- ${workflow.meta.name}: ${truncateUtf8(workflow.meta.description, descriptionBudget)}`;
    if (workflow.meta.whenToUse) text += `\n  Use when: ${truncateUtf8(workflow.meta.whenToUse, triggerBudget)}`;
    if (workflow.path) text += `\n  Absolute path: ${workflow.path}`;
    return text;
  });
  return `The following workflows are available:\n\n${entries.join("\n")}`;
}

export function mergeGrokBuildExtensionListings(skills?: string, workflows?: string): string | undefined {
  const present = [skills, workflows].filter((value): value is string => Boolean(value));
  return present.length ? present.join("\n\n") : undefined;
}
