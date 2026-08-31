import { parse as parseToml } from "smol-toml";
import type { VirtualFS } from "almostnode";
import type { GrokBuildPermissionRequest } from "./grok-build-permissions.js";
import { analyzeGrokBuildBash } from "./grok-build-permission-policy.js";

export type GrokBuildPermissionRuleAction = "allow" | "deny" | "ask";
export type GrokBuildPermissionToolFilter = "any" | "bash" | "edit" | "read" | "grep" | "mcp" | "web_fetch" | "web_search" | "agent_message";

export interface GrokBuildPermissionRule {
  action: GrokBuildPermissionRuleAction;
  tool: GrokBuildPermissionToolFilter;
  pattern?: string;
  patternMode: "glob" | "domain";
}

export interface GrokBuildPermissionPolicyDecision {
  action: GrokBuildPermissionRuleAction;
  reason: string;
}

export interface GrokBuildPermissionPolicyConfig {
  rules: readonly GrokBuildPermissionRule[];
  promptPolicy?: "ask" | "deny" | "allow";
  acceptEdits?: boolean;
  bypassPermissions?: boolean;
  cwd?: string;
}

/** Browser translation of native PermissionConfig deny > ask > allow evaluation. */
export class GrokBuildPermissionPolicy {
  readonly rules: readonly GrokBuildPermissionRule[];
  readonly promptPolicy: "ask" | "deny" | "allow";
  readonly bypassPermissions: boolean;
  private readonly cwd: string;

  constructor(config: GrokBuildPermissionPolicyConfig = { rules: [] }) {
    this.rules = config.acceptEdits
      ? [...config.rules, { action: "allow", tool: "edit", patternMode: "glob" } satisfies GrokBuildPermissionRule]
      : [...config.rules];
    this.promptPolicy = config.promptPolicy ?? "ask";
    this.bypassPermissions = config.bypassPermissions ?? false;
    this.cwd = normalizePath(config.cwd ?? "/");
  }

  evaluate(request: GrokBuildPermissionRequest): GrokBuildPermissionPolicyDecision | undefined {
    let ask = false;
    let allow = false;
    const bash = request.kind === "bash" ? analyzeGrokBuildBash(request.detail ?? "") : undefined;
    let hasBashRestriction = false;
    for (const rule of this.rules) {
      if (request.kind === "bash" && (rule.tool === "bash" || rule.tool === "any") && rule.action !== "allow") hasBashRestriction = true;
      if (!toolMatches(request, rule.tool) || !requestMatches(request, rule, this.cwd)) continue;
      if (rule.action === "deny") return { action: "deny", reason: policyReason("denied", request) };
      if (rule.action === "ask") ask = true;
      else allow = true;
    }
    if (bash && !bash.parseable && hasBashRestriction) ask = true;
    if (ask) return { action: "ask", reason: policyReason("requires approval for", request) };
    if (allow) return { action: "allow", reason: "Allowed by permission policy" };
    return;
  }
}

/** Parse one native compact rule string (`Bash(...)`, `mcp__...`, bare patterns). */
export function parseGrokBuildPermissionRule(raw: string, action: GrokBuildPermissionRuleAction): GrokBuildPermissionRule | undefined {
  const value = raw.trim();
  const open = findUnescaped(value, "(");
  if (open >= 0) {
    const close = findLastUnescaped(value, ")");
    if (close < open) return;
    const filter = toolFilter(value.slice(0, open).trim());
    if (!filter) return;
    let pattern = unescapeRule(value.slice(open + 1, close).trim());
    if (!pattern || pattern === "*") pattern = "";
    if (filter === "bash" && pattern.endsWith(":*")) pattern = pattern.slice(0, -2);
    const domain = pattern.startsWith("domain:");
    if (domain) pattern = pattern.slice(7);
    return { action, tool: filter, ...(pattern ? { pattern } : {}), patternMode: domain ? "domain" : "glob" };
  }
  const bare = toolFilter(value);
  if (bare) return { action, tool: bare, patternMode: "glob" };
  if (value.startsWith("mcp__") && value.length > 5) {
    const rest = value.slice(5);
    const pattern = rest === "*" ? undefined : rest.includes("__") ? rest : `${rest}__*`;
    return { action, tool: "mcp", ...(pattern ? { pattern } : {}), patternMode: "glob" };
  }
  if (["EnterWorktree", "NotebookEdit", "NotebookRead"].includes(value)) return;
  return { action, tool: "any", ...(value ? { pattern: value } : {}), patternMode: "glob" };
}

/** Discover trusted project Grok/Claude permission layers in the browser VFS. */
export function discoverGrokBuildPermissionPolicy(vfs: VirtualFS, cwd = "/", projectTrusted = true): GrokBuildPermissionPolicy {
  const rules: GrokBuildPermissionRule[] = [];
  let promptPolicy: "ask" | "deny" | "allow" = "ask";
  let acceptEdits = false;
  let bypassPermissions = false;
  if (projectTrusted) {
    for (const directory of ancestorDirectories(cwd)) {
      const grok = `${directory === "/" ? "" : directory}/.grok/config.toml`;
      if (regularFile(vfs, grok)) {
        try {
          const parsed = parseToml(vfs.readFileSync(grok, "utf8")) as Record<string, unknown>;
          rules.push(...rulesFromSection(parsed.permission));
        } catch { /* Native warns and skips malformed config layers. */ }
      }
      for (const suffix of ["settings.json", "settings.local.json"]) {
        const claude = `${directory === "/" ? "" : directory}/.claude/${suffix}`;
        if (!regularFile(vfs, claude)) continue;
        try {
          const parsed = JSON.parse(vfs.readFileSync(claude, "utf8")) as Record<string, unknown>;
          const permissions = object(parsed.permissions);
          rules.push(...rulesFromSection(permissions));
          const mode = typeof permissions?.defaultMode === "string" ? permissions.defaultMode
            : typeof parsed.defaultMode === "string" ? parsed.defaultMode : undefined;
          if (mode !== undefined) {
            promptPolicy = mode === "dontAsk" ? "deny" : "ask";
            acceptEdits = mode === "acceptEdits";
            bypassPermissions = mode === "bypassPermissions";
          }
        } catch { /* Native warns and skips malformed settings files. */ }
      }
    }
  }
  return new GrokBuildPermissionPolicy({ rules, promptPolicy, acceptEdits, bypassPermissions, cwd });
}

function rulesFromSection(value: unknown): GrokBuildPermissionRule[] {
  const section = object(value);
  if (!section) return [];
  const output: GrokBuildPermissionRule[] = [];
  for (const action of ["deny", "allow", "ask"] as const) {
    const entries = section[action];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) if (typeof entry === "string") {
      const rule = parseGrokBuildPermissionRule(entry, action);
      if (rule) output.push(rule);
    }
  }
  return output;
}

function toolFilter(name: string): GrokBuildPermissionToolFilter | undefined {
  return ({
    Bash: "bash", Read: "read", Edit: "edit", Write: "edit", MCPTool: "mcp", Grep: "grep", Glob: "grep",
    WebFetch: "web_fetch", WebSearch: "web_search", AgentMessage: "agent_message", SendSubagentMessage: "agent_message",
    SendAgentMessage: "agent_message",
  } as Record<string, GrokBuildPermissionToolFilter>)[name];
}

function toolMatches(request: GrokBuildPermissionRequest, filter: GrokBuildPermissionToolFilter): boolean {
  if (filter === "any") return true;
  if (filter === "read") return request.kind === "read" || request.kind === "grep";
  return request.kind === filter;
}

function requestMatches(request: GrokBuildPermissionRequest, rule: GrokBuildPermissionRule, cwd: string): boolean {
  if (!rule.pattern || rule.pattern === "*") return true;
  if (request.kind === "bash") {
    const analysis = analyzeGrokBuildBash(request.detail ?? "");
    return analysis.segments.some((segment) => segment.trimStart().startsWith(rule.pattern!) || globMatch(segment.trimStart(), rule.pattern!, false));
  }
  const detail = request.detail;
  if (!detail) return false;
  if (request.kind === "web_fetch" && rule.patternMode === "domain") {
    try {
      const host = normalizeDomain(new URL(detail).hostname);
      const pattern = normalizeDomain(rule.pattern);
      return host === pattern || host.endsWith(`.${pattern}`);
    } catch { return false; }
  }
  const pathMode = request.kind === "read" || request.kind === "edit" || request.kind === "grep";
  return (pathMode ? pathMatchForms(detail, cwd).some((form) => globMatch(form, rule.pattern!, true)) : globMatch(detail, rule.pattern, false))
    || ((request.kind === "web_search" || request.kind === "agent_message") && detail.startsWith(rule.pattern));
}

function globMatch(value: string, pattern: string, pathMode: boolean): boolean {
  let regex = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") { regex += "(?:.*/)?"; index += 2; }
        else { regex += ".*"; index += 1; }
      }
      else regex += pathMode ? "[^/]*" : ".*";
    } else if (char === "?") regex += pathMode ? "[^/]" : ".";
    else regex += char.replace(/[\\^$+?.()|{}[\]]/gu, "\\$&");
  }
  try { return new RegExp(`${regex}$`, "u").test(value.replace(/\\/gu, "/")); } catch { return false; }
}

function pathMatchForms(value: string, cwd: string): string[] {
  const absolute = normalizePath(value.startsWith("/") ? value : `${cwd}/${value}`);
  const forms = [absolute];
  const root = cwd === "/" ? "/" : `${cwd}/`;
  if (absolute === cwd) forms.push(".", "./");
  else if (absolute.startsWith(root)) {
    const relative = absolute.slice(root.length);
    forms.push(relative, `./${relative}`);
  }
  return forms;
}

function policyReason(verb: string, request: GrokBuildPermissionRequest): string {
  return `Permission policy ${verb} ${request.kind}${request.detail ? ` \`${request.detail}\`` : ""}`;
}

function unescapeRule(value: string): string { return value.replace(/\\([()\\])/gu, "$1"); }

function findUnescaped(value: string, character: string): number {
  for (let index = 0; index < value.length; index += 1) if (value[index] === character && (index === 0 || value[index - 1] !== "\\")) return index;
  return -1;
}

function findLastUnescaped(value: string, character: string): number {
  for (let index = value.length - 1; index >= 0; index -= 1) if (value[index] === character && (index === 0 || value[index - 1] !== "\\")) return index;
  return -1;
}

function ancestorDirectories(cwd: string): string[] {
  const parts = cwd.replace(/\\/gu, "/").split("/").filter(Boolean);
  const output = ["/"];
  for (let index = 1; index <= parts.length; index += 1) output.push(`/${parts.slice(0, index).join("/")}`);
  return [...new Set(output)];
}

function regularFile(vfs: VirtualFS, path: string): boolean {
  try { return vfs.existsSync(path) && vfs.statSync(path).isFile(); } catch { return false; }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function normalizeDomain(value: string): string {
  const normalized = value.trim().replace(/[/.]+$/u, "").toLowerCase();
  return normalized.startsWith("www.") ? normalized.slice(4) : normalized;
}

function normalizePath(value: string): string {
  const output: string[] = [];
  for (const part of value.replace(/\\/gu, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") output.pop(); else output.push(part);
  }
  return `/${output.join("/")}`;
}
