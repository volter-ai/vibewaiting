import type { VirtualFS } from "almostnode";

export type FileToolInput = Record<string, unknown>;

/** Native-shaped Grok Build file, tree, and grep tools over the browser VFS. */
export class GrokBuildFileSystemTools {
  constructor(private readonly vfs: VirtualFS, private readonly workspacePath = "/") {}

  readFile(input: FileToolInput): string {
    const path = this.resolve(requiredString(input.target_file, "target_file"));
    if (!this.vfs.existsSync(path)) throw new Error(`Error: ${path} does not exist.`);
    if (this.vfs.statSync(path).isDirectory()) throw new Error(`Error: ${path} is a directory, not a file.`);
    const content = this.vfs.readFileSync(path, "utf8");
    if (content === "") return "File is empty.";

    const skillMarkdown = isSkillMarkdown(path);
    const requestedOffset = input.offset === undefined ? undefined : integer(input.offset, 1);
    const offset = skillMarkdown ? undefined : requestedOffset;
    const limit = skillMarkdown ? Number.MAX_SAFE_INTEGER : Math.min(
      input.limit === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, integer(input.limit, 0)),
      1_000,
    );
    const startLine = resolveReadStartLine(content, offset);
    const totalLines = occurrences(content, "\n") + 1;
    const selected = grokReadLines(content, startLine, limit);
    if (selected === "") {
      if (requestedOffset !== undefined && requestedOffset >= 0 && requestedOffset > totalLines) {
        return `(no lines returned: the requested window is past the end of the file; the file has ${totalLines} lines)`;
      }
      return "(no lines returned)";
    }
    const tokenCount = new TextEncoder().encode(selected).byteLength >> 2;
    if (!skillMarkdown && tokenCount > 25_000) {
      const rangeSpecified = input.offset !== undefined || input.limit !== undefined;
      const singleLineHint = grokRawReadLineCount(content, startLine, limit) <= 1
        ? "\nNote: the requested read is a single very long line, so line-based offset/limit cannot narrow it further. Use the 'run_terminal_command' tool to extract the parts you need (e.g. `jq`, `python3`, or `cut -c`)."
        : "";
      if (rangeSpecified) {
        return `The requested line range (offset=${requestedOffset ?? 1}, limit=${input.limit ?? "to end"}) contains ${tokenCount} tokens, which exceeds the maximum allowed tokens (25000 tokens).\nTry a smaller \`limit\`, a different starting \`offset\`, or use the 'grep' tool to search for specific content.${singleLineHint}`;
      }
      return `File content (${tokenCount} tokens) exceeds maximum allowed tokens (25000 tokens).\nPlease use offset and limit parameters to read a shorter range, or use the 'grep' to search for specific content.${singleLineHint}`;
    }
    return selected;
  }

  searchReplace(input: FileToolInput): string {
    const inputPath = requiredString(input.file_path, "file_path");
    for (const component of inputPath.split("/").filter((value) => value && value !== "." && value !== "..")) {
      if (component.length > 255) throw new Error(`Error: file name exceeds the 255-character limit (${component.length} characters). Please use a shorter file name.`);
    }
    const path = this.resolve(inputPath);
    const oldText = requiredString(input.old_string, "old_string", true);
    const newText = requiredString(input.new_string, "new_string", true);
    if (oldText === newText) throw new Error("Old string and new string are the same");
    if (oldText === "") {
      this.vfs.writeFileSync(path, newText);
      return `The file ${inputPath} has been created successfully.`;
    }
    const original = this.vfs.readFileSync(path, "utf8");
    const hasCrLf = original.includes("\r\n");
    const content = hasCrLf ? original.replaceAll("\r\n", "\n") : original;
    const count = occurrences(content, oldText);
    if (count === 0) {
      throw new Error(`The string to replace was not found in the file, use the read_file tool to see the correct string. The user may have changed the file since you last read it.${nearestMatchHint(content, oldText)}`);
    }
    const replaceAll = bool(input.replace_all, false);
    if (!replaceAll && count !== 1) {
      throw new Error("The string to replace was found multiple times in the file. Use replace_all to replace all occurrences, or include more context to only edit one occurrence.");
    }
    const updated = replaceAll ? content.replaceAll(oldText, newText) : content.replace(oldText, newText);
    this.vfs.writeFileSync(path, hasCrLf ? updated.replaceAll("\n", "\r\n") : updated);
    return replaceAll && count > 1
      ? `The file ${inputPath} has been updated. All occurrences were successfully replaced.`
      : `The file ${inputPath} has been updated successfully.`;
  }

  listDir(input: FileToolInput): string {
    const path = this.resolve(requiredString(input.target_directory, "target_directory"));
    if (!this.vfs.existsSync(path)) throw new Error(`Error: ${path} does not exist.`);
    if (!this.vfs.statSync(path).isDirectory()) throw new Error(`Error: ${path} is a file, not a directory.`);
    const body = renderDirectory(this.vfs, path, 10_000, this.workspacePath);
    return `- ${path.endsWith("/") ? path : `${path}/`}${body ? `\n${body}` : ""}`;
  }

  grep(input: FileToolInput): string {
    const root = this.resolve(typeof input.path === "string" ? input.path : ".");
    if (!this.vfs.existsSync(root)) throw new Error(`Error: ${root} does not exist.`);
    const multiline = bool(input.multiline, false);
    const flags = `${bool(input["-i"], false) ? "i" : ""}${multiline ? "s" : ""}u`;
    let regex: RegExp;
    try {
      regex = new RegExp(requiredString(input.pattern, "pattern"), flags);
    } catch (error) {
      throw new Error(`Error calling tool: ${error instanceof Error ? error.message : String(error)} (exit 2, root: ${root})`);
    }
    const glob = typeof input.glob === "string" ? input.glob : undefined;
    const fileType = typeof input.type === "string" ? input.type : undefined;
    const outputMode = typeof input.output_mode === "string" ? input.output_mode : "content";
    const fileMode = outputMode === "files_with_matches" || outputMode === "count";
    const headLimit = Math.max(0, Math.min(integer(input.head_limit, fileMode ? 500 : 200), fileMode ? 10_000 : 2_000));
    const context = Math.max(0, integer(input["-C"], 0));
    const before = Math.max(0, integer(input["-B"], context));
    const after = Math.max(0, integer(input["-A"], context));
    const fileResults: Array<{ file: string; lines: string[]; matchCount: number }> = [];
    for (const file of this.files(root)) {
      if (glob && !globMatches(file, glob)) continue;
      if (fileType && !matchesFileType(file, fileType)) continue;
      const content = this.vfs.readFileSync(file, "utf8");
      if (content.includes("\0")) continue;
      const lines = content.split(/\r?\n/u);
      const matched = new Set<number>();
      if (multiline) {
        const global = new RegExp(regex.source, `${regex.flags}g`);
        for (const match of content.matchAll(global)) {
          const start = countNewlines(content, match.index ?? 0);
          const end = start + countNewlines(match[0], match[0].length);
          for (let index = start; index <= end; index += 1) matched.add(index);
          if (match[0] === "") global.lastIndex += 1;
        }
      } else {
        for (let index = 0; index < lines.length; index += 1) {
          regex.lastIndex = 0;
          if (regex.test(lines[index] ?? "")) matched.add(index);
        }
      }
      if (matched.size === 0) continue;
      const selected = new Set<number>();
      for (const index of matched) {
        for (let candidate = Math.max(0, index - before); candidate <= Math.min(lines.length - 1, index + after); candidate += 1) selected.add(candidate);
      }
      const rendered: string[] = [];
      let prior = -2;
      for (const index of [...selected].sort((left, right) => left - right)) {
        if (prior >= 0 && index > prior + 1) rendered.push("--");
        rendered.push(`${index + 1}${matched.has(index) ? ":" : "-"}${truncateUtf16(lines[index] ?? "", 1_000)}`);
        prior = index;
      }
      fileResults.push({ file, lines: rendered, matchCount: matched.size });
    }
    if (fileResults.length === 0) return `<workspace_result workspace_path="${escapeAttribute(root)}">\nNo matches found\n</workspace_result>`;

    let raw: string[];
    let summary: string;
    if (outputMode === "files_with_matches") {
      raw = fileResults.map((result) => result.file);
      const truncated = raw.length > headLimit;
      raw = raw.slice(0, headLimit);
      summary = `Found ${truncated ? "at least " : ""}${raw.length} files`;
    } else if (outputMode === "count") {
      raw = fileResults.map((result) => `${result.file}:${result.matchCount}`);
      const truncated = raw.length > headLimit;
      raw = raw.slice(0, headLimit);
      const sum = raw.reduce((total, line) => total + Number.parseInt(line.slice(line.lastIndexOf(":") + 1), 10), 0);
      summary = `Found ${sum} across ${truncated ? "at least " : ""}${raw.length} files`;
    } else {
      raw = fileResults.flatMap((result, index) => [...(index > 0 ? [""] : []), result.file, ...result.lines]);
      const truncated = raw.length > headLimit;
      raw = raw.slice(0, headLimit);
      summary = `Found ${truncated ? "at least " : ""}${raw.filter((line) => /^\d+:/u.test(line)).length} matching lines`;
    }
    return `<workspace_result workspace_path="${escapeAttribute(root)}">\n${fitGrepOutput([summary, ...raw], 40 * 1_024)}\n</workspace_result>`;
  }

  write(input: FileToolInput): string {
    const path = this.resolve(requiredString(input.file_path, "file_path"));
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    this.vfs.mkdirSync(parent, { recursive: true });
    this.vfs.writeFileSync(path, requiredString(input.content, "content", true));
    return `Wrote ${path}`;
  }

  private *files(path: string): Generator<string> {
    if (this.vfs.statSync(path).isFile()) { yield path; return; }
    for (const name of this.vfs.readdirSync(path).filter((entry: string) => !entry.startsWith(".")).sort()) {
      const child = join(path, name);
      if (isGitignored(this.vfs, this.workspacePath, child)) continue;
      yield* this.files(child);
    }
  }

  private resolve(path: string): string {
    return normalize(path.startsWith("/") ? path : join(this.workspacePath, path));
  }
}

function resolveReadStartLine(content: string, offset: number | undefined): number {
  const raw = offset ?? 1;
  if (raw === 0) return 1;
  if (raw > 0) return raw;
  let totalFields = content.split("\n").length;
  if (content !== "" && !content.endsWith("\n")) totalFields += 1;
  return Math.max(1, totalFields + raw + 1);
}

function grokReadLines(content: string, startLine: number, limit: number): string {
  return lineFields(content).slice(startLine - 1, startLine - 1 + limit).map((line, index) => {
    const lineNumber = startLine + index;
    return index === 0 || lineNumber % 10 === 0 ? `${lineNumber}→${line}` : line;
  }).join("\n");
}

function grokRawReadLineCount(content: string, startLine: number, limit: number): number {
  return lineFields(content).slice(startLine - 1, startLine - 1 + limit).length;
}

function lineFields(content: string): string[] {
  if (content === "") return [];
  const fields: string[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "\n") continue;
    const line = content.slice(start, index);
    fields.push(line.endsWith("\r") ? line.slice(0, -1) : line);
    start = index + 1;
  }
  if (start < content.length) fields.push(content.slice(start));
  else if (content.endsWith("\n")) fields.push("");
  return fields;
}

function isSkillMarkdown(path: string): boolean {
  const parts = normalize(path).split("/").filter(Boolean);
  const name = parts.at(-1) ?? "";
  return name === "SKILL.md" || (/\.md$/iu.test(name) && parts.includes("skills"));
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) >= 0) { count += 1; offset += needle.length; }
  return count;
}

function nearestMatchHint(content: string, oldText: string): string {
  const keyword = (oldText.split(/\r?\n/u)[0] ?? "").split(/\s+/u).filter(Boolean).sort((a, b) => b.length - a.length)[0] ?? "";
  if (!keyword) return "";
  const lines = content.split("\n");
  const index = lines.findIndex((line) => line.includes(keyword));
  if (index < 0) return "";
  const full = `\n\nNearest match: line ${index + 1}: ${lines[index]?.replace(/\s+$/u, "") ?? ""}`;
  return full.length <= 200 ? full : `${full.slice(0, 199)}…`;
}

interface DirectoryNode {
  depth: number;
  files: string[];
  directories: string[];
  children: Map<string, DirectoryNode>;
  extensions: Map<string, number>;
  totalFiles: number;
  expanded: boolean;
}

function renderDirectory(vfs: VirtualFS, root: string, maxChars: number, workspace: string): string {
  const tree = directoryNode(0);
  let deepItems = 0;
  let truncated = false;
  const visit = (path: string, node: DirectoryNode, depth: number): void => {
    const names = vfs.readdirSync(path).filter((name: string) => !name.startsWith("."))
      .filter((name: string) => !isGitignored(vfs, workspace, join(path, name)))
      .sort((a: string, b: string) => a.toLocaleLowerCase().localeCompare(b.toLocaleLowerCase()));
    for (const name of names) {
      if (depth >= 1 && ++deepItems > 100_000) { truncated = true; return; }
      const childPath = join(path, name);
      if (vfs.statSync(childPath).isDirectory()) {
        const key = `${name}/`;
        const child = directoryNode(node.depth + 1);
        node.directories.push(key);
        node.children.set(key, child);
        visit(childPath, child, depth + 1);
        mergeExtensions(node, child);
      } else {
        node.files.push(name);
        addExtension(node, name);
      }
      if (truncated) return;
    }
  };
  visit(root, tree, 0);
  sortNode(tree);
  tree.expanded = true;
  const cutoff = truncated ? "\nNote: there are more than 100000 items in the directory, so not all files may be shown.\n" : "";
  const initial = renderExpanded(tree);
  if (initial.length > maxChars) return `${renderTruncatedRoot(tree, maxChars)}${cutoff}`.trimEnd();
  let remaining = maxChars - initial.length;
  const queue = tree.directories.map((name) => [name]);
  while (queue.length > 0) {
    const path = queue.shift()!;
    const node = navigateNode(tree, path);
    if (!node) continue;
    node.expanded = true;
    const expanded = renderExpanded(node);
    const summaryCost = directorySummaryCost(node);
    if (expanded.length > remaining + summaryCost) { node.expanded = false; continue; }
    remaining += summaryCost - expanded.length;
    for (const name of node.directories) queue.push([...path, name]);
  }
  return `${renderExpanded(tree)}${cutoff}`.trimEnd();
}

function directoryNode(depth: number): DirectoryNode {
  return { depth, files: [], directories: [], children: new Map(), extensions: new Map(), totalFiles: 0, expanded: false };
}

function addExtension(node: DirectoryNode, name: string): void {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLocaleLowerCase() : "no-ext";
  node.totalFiles += 1;
  node.extensions.set(extension, (node.extensions.get(extension) ?? 0) + 1);
}

function mergeExtensions(parent: DirectoryNode, child: DirectoryNode): void {
  parent.totalFiles += child.totalFiles;
  for (const [extension, count] of child.extensions) parent.extensions.set(extension, (parent.extensions.get(extension) ?? 0) + count);
}

function sortNode(node: DirectoryNode): void {
  const compare = (a: string, b: string): number => a.toLocaleLowerCase().localeCompare(b.toLocaleLowerCase());
  node.files.sort(compare);
  node.directories.sort(compare);
  for (const child of node.children.values()) sortNode(child);
}

function directoryItems(node: DirectoryNode): string[] {
  return [...node.files, ...node.directories].sort((a, b) => a.toLocaleLowerCase().localeCompare(b.toLocaleLowerCase()));
}

function directorySummary(node: DirectoryNode): string {
  if (node.extensions.size === 0) return "";
  const entries = [...node.extensions].sort(([a, left], [b, right]) => right - left || a.localeCompare(b));
  const top = entries.slice(0, 3);
  const shown = top.reduce((sum, [, count]) => sum + count, 0);
  const parts = top.map(([extension, count]) => `${count} *${extension === "no-ext" ? "no-ext" : `.${extension}`}`);
  return `[${node.totalFiles} ${node.totalFiles === 1 ? "file" : "files"} in subtree: ${parts.join(", ")}${shown < node.totalFiles ? ", ..." : ""}]`;
}

function renderExpanded(node: DirectoryNode): string {
  let output = "";
  for (const name of directoryItems(node)) {
    output += `${"  ".repeat(node.depth + 1)}- ${name}\n`;
    const child = node.children.get(name);
    if (child) output += child.expanded ? renderExpanded(child) : renderSummary(child);
  }
  return output;
}

function renderSummary(node: DirectoryNode): string {
  const summary = directorySummary(node);
  return summary ? `${"  ".repeat(node.depth + 1)}${summary}\n` : "";
}

function directorySummaryCost(node: DirectoryNode): number {
  const summary = directorySummary(node);
  return summary ? (node.depth + 1) * 2 + summary.length + 1 : 0;
}

function navigateNode(root: DirectoryNode, path: readonly string[]): DirectoryNode | undefined {
  let node = root;
  for (const name of path) {
    const child = node.children.get(name);
    if (!child) return;
    node = child;
  }
  return node;
}

function renderTruncatedRoot(root: DirectoryNode, maxChars: number): string {
  let output = "";
  for (const name of directoryItems(root)) {
    let chunk = `  - ${name}\n`;
    const child = root.children.get(name);
    const summary = child ? directorySummary(child) : "";
    if (summary) chunk += `    ${summary}\n`;
    if (output.length + chunk.length > maxChars) break;
    output += chunk;
  }
  return `${output}    ...\n\n    Note: this directory is too large to list fully. Try list_dir on a narrower path, or use grep / run_terminal_command.`;
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function join(left: string, right: string): string {
  return normalize(`${left}/${right}`);
}

function globMatches(path: string, glob: string): boolean {
  return expandBraceGlob(glob).some((candidate) => {
    const pattern = candidate.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("**", "\u0000")
      .replaceAll("*", "[^/]*").replaceAll("?", "[^/]").replaceAll("\u0000", ".*");
    return new RegExp(`(?:^|/)${pattern}$`, "u").test(path);
  });
}

function expandBraceGlob(glob: string): string[] {
  const match = /\{([^{}]+)\}/u.exec(glob);
  if (!match || match.index === undefined) return [glob];
  return match[1]!.split(",").flatMap((choice) => expandBraceGlob(`${glob.slice(0, match.index)}${choice}${glob.slice(match.index + match[0].length)}`));
}

const FILE_TYPE_EXTENSIONS: Record<string, readonly string[]> = {
  c: ["c", "h"], cpp: ["cc", "cpp", "cxx", "h", "hpp"], css: ["css"], go: ["go"],
  html: ["htm", "html"], java: ["java"], js: ["cjs", "js", "jsx", "mjs"], json: ["json"],
  markdown: ["md", "markdown"], py: ["py", "pyi"], rust: ["rs"], sh: ["bash", "sh", "zsh"],
  ts: ["cts", "mts", "ts", "tsx"], yaml: ["yaml", "yml"],
};

function matchesFileType(path: string, type: string): boolean {
  const extensions = FILE_TYPE_EXTENSIONS[type.toLocaleLowerCase()];
  if (!extensions) throw new Error(`Error calling tool: unrecognized file type: ${type}`);
  return extensions.includes(path.slice(path.lastIndexOf(".") + 1).toLocaleLowerCase());
}

function countNewlines(value: string, end = value.length): number {
  let count = 0;
  for (let index = 0; index < end; index += 1) if (value[index] === "\n") count += 1;
  return count;
}

function truncateUtf16(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function fitGrepOutput(lines: readonly string[], maxBytes: number): string {
  const encoder = new TextEncoder();
  const output: string[] = [];
  let bytes = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const next = encoder.encode(line).byteLength;
    if (bytes + next > maxBytes) {
      const remaining = lines.slice(index).filter((candidate) => /^\d+:/u.test(candidate)).length;
      if (remaining > 0) output.push(`... [${remaining} lines truncated] ...`);
      break;
    }
    output.push(line);
    bytes += next;
  }
  return output.join("\n");
}

function isGitignored(vfs: VirtualFS, workspace: string, target: string): boolean {
  const normalizedWorkspace = normalize(workspace);
  if (target === normalizedWorkspace || !target.startsWith(`${normalizedWorkspace === "/" ? "" : normalizedWorkspace}/`)) return false;
  const relativeTarget = target.slice(normalizedWorkspace === "/" ? 1 : normalizedWorkspace.length + 1);
  const components = relativeTarget.split("/");
  let ignored = false;
  for (let depth = 0; depth < components.length; depth += 1) {
    const directoryRelative = components.slice(0, depth).join("/");
    const ignorePath = join(normalizedWorkspace, `${directoryRelative ? `${directoryRelative}/` : ""}.gitignore`);
    if (!vfs.existsSync(ignorePath) || vfs.statSync(ignorePath).isDirectory()) continue;
    const pathFromIgnore = components.slice(depth).join("/");
    for (const raw of vfs.readFileSync(ignorePath, "utf8").split(/\r?\n/u)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const negated = line.startsWith("!");
      const pattern = negated ? line.slice(1) : line;
      const directoryOnly = pattern.endsWith("/");
      const cleaned = pattern.replace(/^\//u, "").replace(/\/$/u, "");
      const candidate = directoryOnly ? pathFromIgnore.split("/").slice(0, -1).join("/") || pathFromIgnore : pathFromIgnore;
      if (globMatches(candidate, cleaned) || (!cleaned.includes("/") && candidate.split("/").includes(cleaned))) ignored = !negated;
    }
  }
  return ignored;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function requiredString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw new Error(`${name} must be a${allowEmpty ? "" : " non-empty"} string`);
  return value;
}

function integer(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value)) throw new Error("Expected an integer");
  return value as number;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
