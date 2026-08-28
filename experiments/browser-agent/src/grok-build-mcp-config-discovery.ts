import type { VirtualFS } from "almostnode";
import type { GrokBuildAcpMcpServer } from "./grok-build-agent-mcp.js";
import {
  materializeGrokBuildMcpServer,
  parseDisabledGrokBuildMcpServers,
  parseDisabledGrokBuildMcpTools,
  parseGrokBuildMcpEntries,
  parseGrokBuildMcpPreferences,
  parseGrokBuildMcpToml,
  type GrokBuildMcpConfigPolicy,
  type GrokBuildMcpPreferences,
  type GrokBuildParsedMcpEntry,
} from "./grok-build-mcp-config-parse.js";

export interface GrokBuildDiscoveredMcpServer {
  server: GrokBuildAcpMcpServer;
  policy: GrokBuildMcpConfigPolicy;
  scope: "user" | "project";
  source: "toml" | "claude" | "cursor" | "mcp-json";
  path: string;
}

export interface GrokBuildMcpDiscoveryResult {
  servers: GrokBuildDiscoveredMcpServer[];
  acpServers: GrokBuildAcpMcpServer[];
  skipped: Array<{ name: string; path: string; reason: "invalid" | "disabled" | "setup-required" | "untrusted-project" }>;
}

/** Native config order: TOML > Claude > Cursor > .mcp.json; nearest project entry wins. */
export function discoverGrokBuildMcpServers(
  vfs: VirtualFS,
  options: {
    cwd?: string;
    environment?: Readonly<Record<string, string>>;
    projectTrusted?: boolean;
  } = {},
): GrokBuildMcpDiscoveryResult {
  const cwd = normalizePath(options.cwd ?? "/");
  const chain = projectChain(vfs, cwd);
  const globalPath = "/.grok/config.toml";
  const globalRoot = readToml(vfs, globalPath);
  const disabledServers = new Set(parseDisabledGrokBuildMcpServers(globalRoot));
  const disabledTools = parseDisabledGrokBuildMcpTools(globalRoot);
  const preferences = readPreferences(vfs);
  const candidates = new Map<string, Candidate>();

  addEntries(candidates, parseGrokBuildMcpEntries(globalRoot, "mcp_servers"), "user", "toml", globalPath, true);
  for (const directory of [...chain].reverse()) {
    const path = join(directory, ".grok/config.toml");
    if (path === globalPath) continue;
    addEntries(candidates, parseGrokBuildMcpEntries(readToml(vfs, path), "mcp_servers"), "project", "toml", path, true);
  }

  const claudePath = "/.claude.json";
  const claude = readJson(vfs, claudePath);
  if (isRecord(claude)) {
    const project = isRecord(claude.projects) ? claude.projects[cwd] : undefined;
    addEntries(candidates, parseGrokBuildMcpEntries(project, "mcpServers"), "project", "claude", claudePath, false);
    addEntries(candidates, parseGrokBuildMcpEntries(claude, "mcpServers"), "user", "claude", claudePath, false);
  }

  const cursorPaths = [...new Set([join(cwd, ".cursor/mcp.json"), "/.cursor/mcp.json"])];
  cursorPaths.forEach((path, index) => addEntries(
    candidates,
    parseGrokBuildMcpEntries(readJson(vfs, path), "mcpServers"),
    index === 0 ? "project" : "user",
    "cursor",
    path,
    false,
  ));

  // Closest-first plus first-wins gives native's reverse walk semantics.
  for (const directory of chain) {
    const path = join(directory, ".mcp.json");
    addEntries(candidates, parseGrokBuildMcpEntries(readJson(vfs, path), "mcpServers"), "project", "mcp-json", path, false);
  }

  const servers: GrokBuildDiscoveredMcpServer[] = [];
  const skipped: GrokBuildMcpDiscoveryResult["skipped"] = [];
  for (const candidate of candidates.values()) {
    if (disabledServers.has(candidate.entry.name) || candidate.entry.config.enabled === false) {
      skipped.push({ name: candidate.entry.name, path: candidate.path, reason: "disabled" });
      continue;
    }
    if (candidate.scope === "project" && options.projectTrusted === false) {
      skipped.push({ name: candidate.entry.name, path: candidate.path, reason: "untrusted-project" });
      continue;
    }
    const materialized = materializeGrokBuildMcpServer(candidate.entry, {
      ...(options.environment ? { environment: options.environment } : {}),
      preferences,
      ...(disabledTools[candidate.entry.name] ? { disabledTools: disabledTools[candidate.entry.name] } : {}),
    });
    if (!materialized) {
      skipped.push({
        name: candidate.entry.name,
        path: candidate.path,
        reason: candidate.entry.config.setup === undefined ? "invalid" : "setup-required",
      });
      continue;
    }
    servers.push({ ...candidate, server: materialized.server, policy: materialized.policy });
  }
  return { servers, acpServers: servers.map((entry) => entry.server), skipped };
}

interface Candidate {
  entry: GrokBuildParsedMcpEntry;
  scope: "user" | "project";
  source: GrokBuildDiscoveredMcpServer["source"];
  path: string;
}

function addEntries(
  target: Map<string, Candidate>, entries: readonly GrokBuildParsedMcpEntry[],
  scope: Candidate["scope"], source: Candidate["source"], path: string, replace: boolean,
): void {
  for (const entry of entries) {
    if (replace || !target.has(entry.name)) target.set(entry.name, { entry, scope, source, path });
  }
}

function projectChain(vfs: VirtualFS, cwd: string): string[] {
  const cwdFirst: string[] = [];
  let current = cwd;
  for (;;) {
    cwdFirst.push(current);
    if (exists(vfs, join(current, ".git"))) return cwdFirst;
    if (current === "/") break;
    current = parent(current);
  }
  // Native checks only cwd when no git repository can be resolved.
  return [cwd];
}

function readPreferences(vfs: VirtualFS): GrokBuildMcpPreferences {
  return parseGrokBuildMcpPreferences(readJson(vfs, "/.grok/mcp_preferences.json"));
}

function readToml(vfs: VirtualFS, path: string): Record<string, unknown> | undefined {
  const source = read(vfs, path);
  return source === undefined ? undefined : parseGrokBuildMcpToml(source);
}

function readJson(vfs: VirtualFS, path: string): unknown {
  const source = read(vfs, path);
  if (source === undefined) return undefined;
  try { return JSON.parse(source); } catch { return undefined; }
}

function read(vfs: VirtualFS, path: string): string | undefined {
  try {
    if (!vfs.existsSync(path) || !vfs.statSync(path).isFile()) return undefined;
    return vfs.readFileSync(path, "utf8");
  } catch { return undefined; }
}

function exists(vfs: VirtualFS, path: string): boolean {
  try { return vfs.existsSync(path); } catch { return false; }
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function parent(path: string): string {
  const boundary = path.lastIndexOf("/");
  return boundary <= 0 ? "/" : path.slice(0, boundary);
}

function join(base: string, suffix: string): string {
  return normalizePath(`${base}/${suffix}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
