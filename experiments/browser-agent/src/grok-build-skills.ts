// Copyright 2023-2026 SpaceXAI
// SPDX-License-Identifier: Apache-2.0
// Modified for the Vibewaiting browser port, 2026.
//
// Browser-VFS port of Grok Build skill discovery and listing announcement.

import type { GrokBuildBundleFileSystem } from "./grok-build-bundle.js";

const MAX_NAME_BYTES = 64;
const MAX_DESCRIPTION_BYTES = 1024;
const MAX_BODY_PEEK_BYTES = 2048;
const MAX_SKILL_WALK_DEPTH = 5;
const MAX_LISTING_COMBINED_BYTES = 400;
const MIN_DESCRIPTION_BYTES = 20;
const DEFAULT_LISTING_BUDGET_BYTES = 400_000;
const TRIGGER_PREFIXES = [
  "use this skill when", "use when", "auto-invoke when", "invoke when", "triggers on",
  "trigger on", "called when", "must trigger when", "must invoke when", "must be invoked when",
] as const;
const CURSOR_DEFAULT_SKILLS = new Set([
  "babysit", "canvas", "create-hook", "create-rule", "create-skill", "create-subagent", "loop",
  "migrate-to-skills", "sdk", "shell", "split-to-prs", "statusline", "update-cli-config", "update-cursor-settings",
]);
const CLAUDE_DEFAULT_SKILLS = new Set(["pdf", "docx", "xlsx", "pptx", "skill-creator"]);

export interface GrokBuildSkillInfo {
  name: string;
  description: string;
  whenToUse?: string;
  path: string;
  scope: "local" | "bundled";
  disableModelInvocation: boolean;
  enabled: boolean;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maximum: number): string {
  if (utf8Length(value) <= maximum) return value;
  const marker = "…";
  const markerBytes = utf8Length(marker);
  if (maximum < markerBytes) return new TextDecoder().decode(new TextEncoder().encode(value).subarray(0, maximum));
  const budget = maximum - markerBytes;
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const size = utf8Length(character);
    if (bytes + size > budget) break;
    output += character;
    bytes += size;
  }
  return `${output}${marker}`;
}

function normalizeSkillName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/gu, "-").replace(/-+/gu, "-").replace(/^-|-$/gu, "");
}

function validSkillName(value: string): boolean {
  return value.length > 0 && utf8Length(value) <= MAX_NAME_BYTES && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value) && !value.includes("--");
}

function unquoteScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed) as string; } catch { return trimmed.slice(1, -1); }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
  return trimmed.replace(/\s+#.*$/u, "");
}

function foldYamlBlock(lines: string[], literal: boolean): string {
  const nonEmpty = lines.filter((line) => line.trim()).map((line) => line.match(/^\s*/u)?.[0].length ?? 0);
  const indent = nonEmpty.length ? Math.min(...nonEmpty) : 0;
  const stripped = lines.map((line) => line.slice(Math.min(indent, line.length)).trimEnd());
  if (literal) return stripped.join("\n").trim();
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of stripped) {
    if (!line.trim()) {
      if (current.length) { paragraphs.push(current.join(" ")); current = []; }
    } else current.push(line.trim());
  }
  if (current.length) paragraphs.push(current.join(" "));
  return paragraphs.join("\n").trim();
}

function parseTopLevelFrontmatter(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = source.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/u.exec(lines[index] ?? "");
    if (!match) continue;
    const key = match[1]!;
    const raw = match[2] ?? "";
    if (/^[>|][+-]?\d*$/u.test(raw)) {
      const block: string[] = [];
      while (index + 1 < lines.length && (/^\s/u.test(lines[index + 1] ?? "") || !(lines[index + 1] ?? "").trim())) {
        block.push(lines[index + 1] ?? "");
        index += 1;
      }
      values[key] = foldYamlBlock(block, raw.startsWith("|"));
    } else if (raw.trim()) values[key] = unquoteScalar(raw);
  }
  return values;
}

export function parseGrokBuildFrontmatterDocument(content: string): { frontmatter?: Record<string, string>; body: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return { body: trimmed };
  const rest = trimmed.slice(3);
  const closing = rest.indexOf("\n---");
  if (closing < 0) return { body: trimmed };
  return {
    frontmatter: parseTopLevelFrontmatter(rest.slice(0, closing).trim()),
    body: rest.slice(closing + 4).trimStart(),
  };
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[`*_~]/gu, "")
    .replace(/<[^>]+>/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function bodyDescription(body: string, name: string): string {
  const peekBytes = new TextEncoder().encode(body).subarray(0, MAX_BODY_PEEK_BYTES);
  const peek = new TextDecoder().decode(peekBytes);
  const blocks = peek.split(/\n\s*\n/u);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed || /^(?:[-*+] |\d+\. |>|```|~~~|\|)/u.test(trimmed) || /^#{1,6}\s/u.test(trimmed)) continue;
    const description = stripInlineMarkdown(trimmed.replace(/\n/gu, " "));
    if (description) return truncateUtf8(description, MAX_DESCRIPTION_BYTES);
  }
  for (const line of peek.split(/\r?\n/u)) {
    const heading = /^#{1,6}\s+(.+)$/u.exec(line.trim());
    if (heading) return truncateUtf8(stripInlineMarkdown(heading[1]!), MAX_DESCRIPTION_BYTES);
  }
  return name;
}

function parseSkill(path: string, content: string, scope: GrokBuildSkillInfo["scope"]): GrokBuildSkillInfo | undefined {
  const fallback = path.endsWith("/SKILL.md") ? path.split("/").at(-2) : path.split("/").at(-1)?.replace(/\.md$/u, "");
  if (!fallback) return;
  const document = parseGrokBuildFrontmatterDocument(content);
  const declared = document.frontmatter?.name;
  const candidates = [declared, fallback].filter((value): value is string => Boolean(value));
  const name = candidates.map(normalizeSkillName).find(validSkillName);
  if (!name) return;
  const description = document.frontmatter?.description?.trim()
    ? truncateUtf8(document.frontmatter.description.trim(), MAX_DESCRIPTION_BYTES)
    : bodyDescription(document.body, name);
  const whenToUse = document.frontmatter?.["when-to-use"] ?? document.frontmatter?.when_to_use;
  const disabled = document.frontmatter?.["disable-model-invocation"] === "true";
  if ((path.includes("/.cursor/") && CURSOR_DEFAULT_SKILLS.has(name)) || (path.includes("/.claude/") && CLAUDE_DEFAULT_SKILLS.has(name))) return;
  return {
    name,
    description,
    ...(whenToUse?.trim() ? { whenToUse: truncateUtf8(whenToUse.trim(), MAX_DESCRIPTION_BYTES) } : {}),
    path,
    scope,
    disableModelInvocation: disabled,
    enabled: true,
  };
}

function isDirectory(vfs: GrokBuildBundleFileSystem, path: string): boolean {
  try { return vfs.existsSync(path) && vfs.statSync(path).isDirectory(); } catch { return false; }
}

function isFile(vfs: GrokBuildBundleFileSystem, path: string): boolean {
  try { return vfs.existsSync(path) && vfs.statSync(path).isFile(); } catch { return false; }
}

function walkSkillFiles(vfs: GrokBuildBundleFileSystem & { readdirSync(path: string): string[] }, directory: string, depth = 0): string[] {
  if (depth > MAX_SKILL_WALK_DEPTH || !isDirectory(vfs, directory)) return [];
  const output: string[] = [];
  for (const name of [...vfs.readdirSync(directory)].sort()) {
    const path = `${directory}/${name}`;
    if (!isDirectory(vfs, path)) continue;
    const skill = `${path}/SKILL.md`;
    if (isFile(vfs, skill)) output.push(skill);
    output.push(...walkSkillFiles(vfs, path, depth + 1));
  }
  return output;
}

function commandFiles(vfs: GrokBuildBundleFileSystem & { readdirSync(path: string): string[] }, directory: string): string[] {
  if (!isDirectory(vfs, directory)) return [];
  return [...vfs.readdirSync(directory)].sort().flatMap((name) => {
    const path = `${directory}/${name}`;
    return name.endsWith(".md") && isFile(vfs, path) ? [path] : [];
  });
}

export function discoverGrokBuildSkills(
  vfs: GrokBuildBundleFileSystem & { readdirSync(path: string): string[] },
): GrokBuildSkillInfo[] {
  const sources: Array<{ config: string; scope: GrokBuildSkillInfo["scope"] }> = [
    { config: "/.grok", scope: "local" },
    { config: "/.agents", scope: "local" },
    { config: "/.claude", scope: "local" },
    { config: "/.cursor", scope: "local" },
    { config: "/.grok/bundled", scope: "bundled" },
  ];
  const result: GrokBuildSkillInfo[] = [];
  const seenPaths = new Set<string>();
  const seenNames = new Set<string>();
  for (const source of sources) {
    const paths = [
      ...walkSkillFiles(vfs, `${source.config}/skills`),
      ...commandFiles(vfs, `${source.config}/commands`),
    ];
    for (const path of paths) {
      if (seenPaths.has(path)) continue;
      seenPaths.add(path);
      const skill = parseSkill(path, vfs.readFileSync(path, "utf8"), source.scope);
      if (!skill || seenNames.has(skill.name)) continue;
      seenNames.add(skill.name);
      result.push(skill);
    }
  }
  return result;
}

function triggerSuffix(description: string): { description: string; trigger: string } | undefined {
  const lower = description.toLowerCase();
  let position = -1;
  for (const prefix of TRIGGER_PREFIXES) {
    const candidate = lower.indexOf(prefix);
    if (candidate >= 0 && (position < 0 || candidate < position)) position = candidate;
  }
  if (position <= 0) return;
  const before = description.slice(0, position).trimEnd().replace(/\.$/u, "");
  const trigger = description.slice(position);
  return before && trigger ? { description: before, trigger } : undefined;
}

function stripTriggerPrefix(value: string): string {
  const trimmed = value.trimStart();
  const lower = trimmed.toLowerCase();
  for (const prefix of TRIGGER_PREFIXES) {
    if (!lower.startsWith(prefix)) continue;
    const next = lower[prefix.length];
    if (next && /[a-z0-9]/iu.test(next)) continue;
    const result = trimmed.slice(prefix.length).replace(/^[:,\s]+/u, "");
    if (result) return result;
  }
  return trimmed;
}

function proportionalBudgets(descriptionBytes: number, triggerBytes: number, total: number): [number, number] {
  if (!triggerBytes) return [total, 0];
  const combined = Math.max(1, descriptionBytes) + Math.max(1, triggerBytes);
  let description = Math.floor(total * Math.max(1, descriptionBytes) / combined);
  let trigger = total - description;
  if (description < MIN_DESCRIPTION_BYTES && trigger > MIN_DESCRIPTION_BYTES) [description, trigger] = [MIN_DESCRIPTION_BYTES, total - MIN_DESCRIPTION_BYTES];
  else if (trigger < MIN_DESCRIPTION_BYTES && description > MIN_DESCRIPTION_BYTES) [description, trigger] = [total - MIN_DESCRIPTION_BYTES, MIN_DESCRIPTION_BYTES];
  return [description, trigger];
}

function formatSkill(skill: GrokBuildSkillInfo, combinedBudget = MAX_LISTING_COMBINED_BYTES): string {
  const extracted = triggerSuffix(skill.description);
  const description = extracted?.description ?? skill.description;
  const trigger = skill.whenToUse ?? extracted?.trigger;
  const [descriptionBudget, triggerBudget] = proportionalBudgets(utf8Length(description), trigger ? utf8Length(trigger) : 0, combinedBudget);
  const first = `- ${skill.name}: ${truncateUtf8(description, descriptionBudget)}`;
  if (!trigger) return `${first}\n  Absolute path: ${skill.path}`;
  return `${first}\n  Use when: ${truncateUtf8(stripTriggerPrefix(trigger), triggerBudget)}\n  Absolute path: ${skill.path}`;
}

export function formatGrokBuildSkillListing(
  skills: readonly GrokBuildSkillInfo[],
  budgetBytes = DEFAULT_LISTING_BUDGET_BYTES,
): string | undefined {
  const available = skills.filter((skill) => skill.enabled && !skill.disableModelInvocation);
  if (!available.length) return;
  const header = "The following skills are available for use:\n\n";
  const full = available.map((skill) => formatSkill(skill)).join("\n");
  if (utf8Length(header) + utf8Length(full) <= budgetBytes) return `${header}${full}`;
  const overhead = available.reduce((total, skill) => total + utf8Length(`- ${skill.name}: \n  Absolute path: ${skill.path}\n`) + (skill.whenToUse ? utf8Length("  Use when: \n") : 0), 0);
  const perSkill = Math.floor(Math.max(0, budgetBytes - utf8Length(header) - overhead) / available.length);
  if (perSkill >= MIN_DESCRIPTION_BYTES) return `${header}${available.map((skill) => formatSkill(skill, perSkill)).join("\n")}`;
  let names = "";
  let included = 0;
  for (const skill of available) {
    const line = `- ${skill.name}`;
    const candidate = names ? `${names}\n${line}` : line;
    if (utf8Length(header) + utf8Length(candidate) > budgetBytes) break;
    names = candidate;
    included += 1;
  }
  if (included < available.length) names += `\n... and ${available.length - included} more skills in /.grok/bundled/skills`;
  return `${header}${names}`;
}

export function createGrokBuildSkillReminder(skills: readonly GrokBuildSkillInfo[]): string | undefined {
  const listing = formatGrokBuildSkillListing(skills);
  return listing ? `<system-reminder>\n${listing}\n</system-reminder>` : undefined;
}
