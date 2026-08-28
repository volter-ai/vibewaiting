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
    const checked = checkNodeCommand(vfs, workspacePath, script);
    if (!checked) return;
    return {
      ...checked,
      stdout: `\n> ${npmRun[1]}\n> ${script}\n\n${checked.stdout}`,
    };
  }
  return checkNodeCommand(vfs, workspacePath, command.trim());
}

function checkNodeCommand(vfs: VirtualFS, workspacePath: string, command: string): BrowserBuiltinResult | undefined {
  const match = command.match(/^node\s+(?:--check|-c)\s+([^\s]+)$/u);
  if (!match?.[1]) return;
  const path = resolve(workspacePath, stripShellQuotes(match[1]));
  try {
    const source = vfs.readFileSync(path, "utf8");
    parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
    return { stdout: "", stderr: "", exitCode: 0 };
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 1,
    };
  }
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
