import { parseGrokBuildFrontmatterDocument, type GrokBuildSkillFileSystem } from "./grok-build-skills.js";
import type { GrokBuildSlashSkillReference } from "./grok-build-slash-commands.js";

/** Exact browser-VFS port of native slash skill expansion and substitutions. */
export function buildGrokBuildSkillInformation(
  vfs: GrokBuildSkillFileSystem,
  references: readonly GrokBuildSlashSkillReference[],
  sessionId: string,
): string | undefined {
  const blocks: string[] = [];
  for (const reference of references) {
    try {
      if (!vfs.existsSync(reference.skillPath) || !vfs.statSync(reference.skillPath).isFile()) continue;
      const raw = vfs.readFileSync(reference.skillPath, "utf8");
      const parsedBody = parseGrokBuildFrontmatterDocument(raw).body;
      const separator = reference.skillPath.lastIndexOf("/");
      const skillDirectory = separator <= 0 ? "/" : reference.skillPath.slice(0, separator);
      const body = resolveGrokBuildSkillInternalLinks(parsedBody, skillDirectory, vfs);
      const content = applyGrokBuildSkillSubstitutions(body, reference.args, { skillDirectory, sessionId });
      blocks.push(reference.args
        ? `<skill name="${reference.name}" args="${reference.args}">\n${content}\n</skill>`
        : `<skill name="${reference.name}">\n${content}\n</skill>`);
    } catch {
      // Native logs and skips an unreadable skill body while preserving the
      // original prompt. Other successfully loaded references still expand.
    }
  }
  if (!blocks.length) return;
  const unique = new Set<string>();
  // Native indexes every parsed reference, including one whose body could not
  // be loaded, as long as at least one body succeeded.
  const index = references.flatMap((reference) => {
    const key = `${reference.name}\0${reference.skillPath}`;
    if (unique.has(key)) return [];
    unique.add(key);
    return [`<skill name="${reference.name}" path="${reference.skillPath}"/>`];
  });
  return `<skill_information>\n<skills_referenced>\n${index.join("\n")}\n</skills_referenced>\n${blocks.join("\n")}\n</skill_information>`;
}

/** Resolve existing relative Markdown links without allowing a skill escape. */
export function resolveGrokBuildSkillInternalLinks(
  body: string,
  skillDirectory: string,
  vfs: GrokBuildSkillFileSystem,
): string {
  const replaceDestination = (destination: string): string => {
    if (!destination || /^[a-z][a-z0-9+.-]*:/iu.test(destination) || destination.startsWith("#") || destination.startsWith("/")) return destination;
    const resolved = normalizePath(`${skillDirectory}/${destination}`);
    const root = normalizePath(skillDirectory);
    if (resolved !== root && !resolved.startsWith(`${root === "/" ? "" : root}/`)) return destination;
    return vfs.existsSync(resolved) ? resolved : destination;
  };
  let output = body.replace(/(!?\[[^\]]*\]\()([^\s)]+)([^)]*\))/gu, (_whole, prefix: string, destination: string, suffix: string) =>
    `${prefix}${replaceDestination(destination)}${suffix}`);
  output = output.replace(/^(\s*\[[^\]]+\]:\s*)(\S+)/gmu, (_whole, prefix: string, destination: string) =>
    `${prefix}${replaceDestination(destination)}`);
  return output;
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

export function applyGrokBuildSkillSubstitutions(
  source: string,
  args: string | undefined,
  context: { skillDirectory?: string; sessionId?: string } = {},
): string {
  const argsString = args ?? "";
  const argv = argsString ? argsString.split(/\s+/u) : [];
  const maximumIndex = Math.max(argv.length, 1) + 20;
  let content = source;
  let argumentsSubstituted = false;
  for (let index = maximumIndex - 1; index >= 0; index -= 1) {
    const token = `$ARGUMENTS[${index}]`;
    if (!content.includes(token)) continue;
    content = content.replaceAll(token, argv[index] ?? "");
    argumentsSubstituted = true;
  }
  for (let index = maximumIndex - 1; index >= 0; index -= 1) {
    const token = `$${index}`;
    let rest = content;
    let output = "";
    while (true) {
      const offset = rest.indexOf(token);
      if (offset < 0) { output += rest; break; }
      output += rest.slice(0, offset);
      const after = rest.slice(offset + token.length);
      if (/^\d/u.test(after)) output += token;
      else { output += argv[index] ?? ""; argumentsSubstituted = true; }
      rest = after;
    }
    content = output;
  }
  if (content.includes("$ARGUMENTS")) {
    content = content.replaceAll("$ARGUMENTS", argsString);
    argumentsSubstituted = true;
  }
  if (context.skillDirectory !== undefined) {
    content = content.replaceAll("${SKILL_DIR}", context.skillDirectory).replaceAll("${CLAUDE_SKILL_DIR}", context.skillDirectory);
  }
  if (context.sessionId !== undefined) {
    content = content.replaceAll("${SESSION_ID}", context.sessionId).replaceAll("${CLAUDE_SESSION_ID}", context.sessionId);
  }
  if (argsString && !argumentsSubstituted) content += `\n\n**ARGUMENTS:** ${argsString}`;
  return content;
}
