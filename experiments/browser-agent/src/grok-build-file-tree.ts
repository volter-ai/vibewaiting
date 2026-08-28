import type { VirtualFS } from "almostnode";

interface DirectoryNode {
  depth: number;
  files: string[];
  directories: string[];
  children: Map<string, DirectoryNode>;
  extensions: Map<string, number>;
  totalFiles: number;
  expanded: boolean;
}

export function renderDirectory(vfs: VirtualFS, root: string, maxChars: number, workspace: string): string {
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

export function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

export function join(left: string, right: string): string {
  return normalize(`${left}/${right}`);
}

export function globMatches(path: string, glob: string): boolean {
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

export function matchesFileType(path: string, type: string): boolean {
  const extensions = FILE_TYPE_EXTENSIONS[type.toLocaleLowerCase()];
  if (!extensions) throw new Error(`Error calling tool: unrecognized file type: ${type}`);
  return extensions.includes(path.slice(path.lastIndexOf(".") + 1).toLocaleLowerCase());
}

export function countNewlines(value: string, end = value.length): number {
  let count = 0;
  for (let index = 0; index < end; index += 1) if (value[index] === "\n") count += 1;
  return count;
}

export function truncateUtf16(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function fitGrepOutput(lines: readonly string[], maxBytes: number): string {
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

export function isGitignored(vfs: VirtualFS, workspace: string, target: string): boolean {
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
