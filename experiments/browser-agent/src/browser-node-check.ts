import { parse } from "acorn";
import type { VirtualFS } from "almostnode";

export interface BrowserBuiltinResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Fill AlmostNode's current `node --check` gap without pretending to execute Node. */
export function tryBrowserNodeCheck(
  vfs: VirtualFS,
  workspacePath: string,
  command: string,
): BrowserBuiltinResult | undefined {
  const npmRun = command.trim().match(/^npm\s+run\s+([A-Za-z0-9:_-]+)$/u);
  if (npmRun?.[1]) {
    const packagePath = resolve(workspacePath, "package.json");
    if (!vfs.existsSync(packagePath)) return;
    const manifest = JSON.parse(vfs.readFileSync(packagePath, "utf8")) as { scripts?: Record<string, unknown> };
    const script = manifest.scripts?.[npmRun[1]];
    if (typeof script !== "string") return;
    const checked = checkNodeCommands(vfs, workspacePath, script);
    if (!checked) return;
    return {
      ...checked,
      stdout: `\n> ${npmRun[1]}\n> ${script}\n\n${checked.stdout}`,
    };
  }
  return checkNodeCommands(vfs, workspacePath, command.trim());
}

function checkNodeCommands(vfs: VirtualFS, workspacePath: string, command: string): BrowserBuiltinResult | undefined {
  const commands = splitShellAnd(command);
  const results = commands.map((part) => checkNodeCommand(vfs, workspacePath, part));
  if (results.some((result) => result === undefined)) return;
  for (const result of results as BrowserBuiltinResult[]) if (result.exitCode !== 0) return result;
  return { stdout: results.map((result) => result!.stdout).join(""), stderr: "", exitCode: 0 };
}

function checkNodeCommand(vfs: VirtualFS, workspacePath: string, command: string): BrowserBuiltinResult | undefined {
  const match = command.match(/^node\s+(?:--check|-c)\s+((?:"[^"]*"|'[^']*'|[^\s>]+))(?:\s*(2>|>|&>)\s*((?:"[^"]*"|'[^']*'|[^\s]+)))?$/u);
  if (!match?.[1]) return;
  const path = resolve(workspacePath, stripShellQuotes(match[1]));
  let result: BrowserBuiltinResult;
  try {
    const source = vfs.readFileSync(path, "utf8");
    parse(source, { ecmaVersion: "latest", sourceType: nodeSourceType(vfs, path), allowHashBang: true });
    result = { stdout: "", stderr: "", exitCode: 0 };
  } catch (error) {
    result = {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 1,
    };
  }
  const redirect = match[2];
  const target = match[3] ? resolve(workspacePath, stripShellQuotes(match[3])) : undefined;
  if (redirect && target) {
    const parent = target.slice(0, target.lastIndexOf("/")) || "/";
    vfs.mkdirSync(parent, { recursive: true });
    if (redirect === ">") { vfs.writeFileSync(target, result.stdout); result.stdout = ""; }
    else if (redirect === "2>") { vfs.writeFileSync(target, result.stderr); result.stderr = ""; }
    else { vfs.writeFileSync(target, result.stdout + result.stderr); result.stdout = ""; result.stderr = ""; }
  }
  return result;
}

function nodeSourceType(vfs: VirtualFS, path: string): "script" | "module" {
  if (path.endsWith(".mjs")) return "module";
  if (path.endsWith(".cjs")) return "script";
  let directory = path.slice(0, path.lastIndexOf("/")) || "/";
  while (true) {
    const manifestPath = `${directory === "/" ? "" : directory}/package.json` || "/package.json";
    if (vfs.existsSync(manifestPath) && vfs.statSync(manifestPath).isFile()) {
      try {
        const manifest = JSON.parse(vfs.readFileSync(manifestPath, "utf8")) as { type?: unknown };
        return manifest.type === "module" ? "module" : "script";
      } catch { return "script"; }
    }
    if (directory === "/") return "script";
    directory = directory.slice(0, directory.lastIndexOf("/")) || "/";
  }
}

function splitShellAnd(command: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote = "";
  for (let index = 0; index + 1 < command.length; index += 1) {
    const character = command[index] ?? "";
    if (quote) { if (character === quote) quote = ""; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "&" && command[index + 1] === "&") {
      parts.push(command.slice(start, index).trim());
      start = index + 2;
      index += 1;
    }
  }
  parts.push(command.slice(start).trim());
  return parts;
}

function stripShellQuotes(value: string): string {
  return value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1)
    : value;
}

function resolve(root: string, path: string): string {
  const parts: string[] = [];
  const value = path.startsWith("/") ? path : `${root}/${path}`;
  for (const part of value.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return `/${parts.join("/")}`;
}
