import { analyzeGrokBuildBash, isGrokBuildStaticWebFetchAllowed, protectedGrokBuildEdit } from "./grok-build-permission-policy.js";
import { GrokBuildPermissionPolicy } from "./grok-build-permission-rules.js";

export type GrokBuildPermissionAccessKind = "read" | "grep" | "edit" | "bash" | "mcp" | "web_fetch" | "web_search" | "agent_message";

export interface GrokBuildPermissionRequest {
  toolCallId: string;
  toolName: string;
  kind: GrokBuildPermissionAccessKind;
  detail?: string;
  input: Record<string, unknown>;
}

export type GrokBuildPermissionPromptOutcome =
  | "allow-once"
  | "allow-always"
  | "allow-mcp-server"
  | "allow-edits-session"
  | "reject-once"
  | "reject-always"
  | "enable-always-approve"
  | "cancelled";

export interface GrokBuildPermissionDecision {
  allowed: boolean;
  source: "safe" | "always-approve" | "policy" | "session-grant" | "session-deny" | "prompt";
  reason?: string;
}

export type GrokBuildPermissionPrompter = (
  request: GrokBuildPermissionRequest,
  signal: AbortSignal,
) => Promise<GrokBuildPermissionPromptOutcome>;

export interface GrokBuildPermissionStore {
  load(): { allowed?: string[]; denied?: string[] } | undefined;
  save(state: { allowed: string[]; denied: string[] }): void;
}

/** Browser port of native Ask/AlwaysApprove permission state and grants. */
export class GrokBuildPermissionManager {
  private alwaysApprove = false;
  private allowEditsForSession = false;
  private readonly allowed = new Set<string>();
  private readonly denied = new Set<string>();
  private promptTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly prompt?: GrokBuildPermissionPrompter,
    private readonly store?: GrokBuildPermissionStore,
    private readonly policy = new GrokBuildPermissionPolicy(),
  ) {
    const restored = store?.load();
    for (const key of restored?.allowed ?? []) if (typeof key === "string") this.allowed.add(key);
    for (const key of restored?.denied ?? []) if (typeof key === "string") this.denied.add(key);
  }

  isAlwaysApprove(): boolean { return this.alwaysApprove; }

  setAlwaysApprove(enabled: boolean): boolean {
    this.alwaysApprove = enabled;
    return this.alwaysApprove;
  }

  resetSessionGrants(): void {
    this.allowEditsForSession = false;
    this.allowed.clear();
    this.denied.clear();
    this.persist();
  }

  async authorize(request: GrokBuildPermissionRequest, signal: AbortSignal): Promise<GrokBuildPermissionDecision> {
    signal.throwIfAborted();
    const policyDecision = this.policy.evaluate(request);
    if (policyDecision?.action === "deny") return { allowed: false, source: "policy", reason: policyDecision.reason };
    const policyForcesPrompt = policyDecision?.action === "ask";
    if ((this.alwaysApprove || this.policy.bypassPermissions) && !policyForcesPrompt) return { allowed: true, source: "always-approve" };
    if (!policyForcesPrompt && (request.kind === "read" || request.kind === "grep" || request.kind === "web_search")) {
      return { allowed: true, source: "safe" };
    }
    const protectedEdit = request.kind === "edit" && request.detail ? protectedGrokBuildEdit(request.detail) : undefined;
    if (!policyForcesPrompt && request.kind === "edit" && this.allowEditsForSession && !protectedEdit) return { allowed: true, source: "session-grant" };
    const bash = request.kind === "bash" ? analyzeGrokBuildBash(request.detail ?? "") : undefined;
    const key = permissionKey(request);
    if (isDenied(request, this.denied)) return { allowed: false, source: "session-deny", reason: rememberedDenial(request) };
    if (!policyForcesPrompt && request.kind === "web_fetch" && isGrokBuildStaticWebFetchAllowed(request.detail ?? "")) return { allowed: true, source: "safe" };
    if (!policyForcesPrompt && bash && bash.needsPrompt.length === 0) return { allowed: true, source: "safe" };
    const bashFloor = Boolean(bash && (bash.dangerous.length || !bash.parseable));
    if (policyDecision?.action === "allow" && !protectedEdit && !bashFloor) return { allowed: true, source: "policy" };
    if (!policyForcesPrompt && !protectedEdit && (!bash ? this.allowed.has(key) || mcpServerGranted(request, this.allowed) : bashSegmentsGranted(bash, this.allowed))) {
      return { allowed: true, source: "session-grant" };
    }
    if (this.policy.promptPolicy === "deny") return { allowed: false, source: "policy", reason: "Permission policy denied an unapproved tool call" };
    if (this.policy.promptPolicy === "allow") return { allowed: true, source: "policy" };
    if (!this.prompt) return { allowed: false, source: "prompt", reason: "Failed to request permission from user: no permission client is available" };

    const outcome = await this.serialPrompt(request, signal);
    switch (outcome) {
      case "enable-always-approve":
        this.alwaysApprove = true;
        return { allowed: true, source: "always-approve" };
      case "allow-edits-session":
        if (request.kind === "edit") this.allowEditsForSession = true;
        else this.allowed.add(key);
        return { allowed: true, source: "session-grant" };
      case "allow-always":
        if (bash?.parseable) for (const segment of bash.needsPrompt) this.allowed.add(`bash:${segment}`);
        else this.allowed.add(key);
        this.persist();
        return { allowed: true, source: "session-grant" };
      case "allow-mcp-server": {
        const server = request.kind === "mcp" ? parseMcpServer(request.detail ?? "") : undefined;
        if (server) this.allowed.add(`mcp_server:${server}`);
        else this.allowed.add(key);
        this.persist();
        return { allowed: true, source: "session-grant" };
      }
      case "allow-once": return { allowed: true, source: "prompt" };
      case "reject-always":
        if (bash?.parseable) for (const segment of bash.needsPrompt) this.denied.add(`bash:${segment}`);
        else this.denied.add(denialKey(request));
        this.persist();
        return { allowed: false, source: "session-deny", reason: rememberedDenial(request) };
      case "cancelled": return { allowed: false, source: "prompt", reason: "User cancelled the execution" };
      case "reject-once": return { allowed: false, source: "prompt", reason: "User rejected the execution" };
    }
  }

  private persist(): void {
    this.store?.save({ allowed: [...this.allowed].sort(), denied: [...this.denied].sort() });
  }

  private async serialPrompt(request: GrokBuildPermissionRequest, signal: AbortSignal): Promise<GrokBuildPermissionPromptOutcome> {
    let release!: () => void;
    const slot = new Promise<void>((resolve) => { release = resolve; });
    const prior = this.promptTail;
    this.promptTail = prior.catch(() => undefined).then(() => slot);
    await waitForTurn(prior, signal);
    try {
      signal.throwIfAborted();
      return await this.prompt!(request, signal);
    } finally {
      release();
    }
  }
}

function permissionKey(request: GrokBuildPermissionRequest): string {
  if (request.kind === "edit") return "edit:*";
  if (request.kind === "web_fetch") {
    try { return `web_fetch:${normalizeAllowDomain(new URL(request.detail ?? "").hostname)}`; }
    catch { return `web_fetch:${request.detail ?? ""}`; }
  }
  return `${request.kind}:${request.detail ?? request.toolName}`;
}

function denialKey(request: GrokBuildPermissionRequest): string {
  if (request.kind !== "web_fetch") return permissionKey(request);
  try { return `web_fetch:${normalizeDenyDomain(new URL(request.detail ?? "").hostname)}`; }
  catch { return `web_fetch:${request.detail ?? ""}`; }
}

function isDenied(request: GrokBuildPermissionRequest, denied: ReadonlySet<string>): boolean {
  if (request.kind === "bash") {
    const analysis = analyzeGrokBuildBash(request.detail ?? "");
    return analysis.segments.some((segment) => [...denied].some((key) => key.startsWith("bash:") && matchesCommandPrefix(segment, key.slice(5))))
      || (!analysis.parseable && denied.has(denialKey(request)));
  }
  if (request.kind !== "web_fetch") return denied.has(denialKey(request));
  let host: string;
  try { host = normalizeDenyDomain(new URL(request.detail ?? "").hostname); }
  catch { return denied.has(denialKey(request)); }
  for (const key of denied) {
    if (!key.startsWith("web_fetch:")) continue;
    const domain = key.slice("web_fetch:".length);
    if (domain && (host === domain || host.endsWith(`.${domain}`))) return true;
  }
  return false;
}

function bashSegmentsGranted(
  analysis: ReturnType<typeof analyzeGrokBuildBash>,
  allowed: ReadonlySet<string>,
): boolean {
  if (!analysis.parseable || analysis.dangerous.length) return false;
  return analysis.needsPrompt.every((segment) => [...allowed].some((key) => key.startsWith("bash:") && matchesCommandPrefix(segment, key.slice(5))));
}

function matchesCommandPrefix(command: string, prefix: string): boolean {
  return command === prefix || (command.startsWith(prefix) && command.charAt(prefix.length) === " ");
}

function mcpServerGranted(request: GrokBuildPermissionRequest, allowed: ReadonlySet<string>): boolean {
  if (request.kind !== "mcp") return false;
  const server = parseMcpServer(request.detail ?? "");
  return Boolean(server && allowed.has(`mcp_server:${server}`));
}

export function parseGrokBuildMcpServer(name: string): string | undefined { return parseMcpServer(name); }

function parseMcpServer(name: string): string | undefined {
  let boundary = -1;
  let count = 0;
  for (let index = 0; index < name.length - 1; index += 1) {
    if (name[index] === "_" && name[index + 1] === "_") { boundary = index; count += 1; }
  }
  if (count !== 1) return;
  const server = name.slice(0, boundary);
  const tool = name.slice(boundary + 2);
  if (!server || !tool || !/^[A-Za-z0-9_:-]+$/u.test(name)) return;
  return server;
}

function normalizeAllowDomain(host: string): string {
  const normalized = normalizeDenyDomain(host);
  return normalized.startsWith("www.") ? normalized.slice(4) : normalized;
}

function normalizeDenyDomain(host: string): string { return host.trim().replace(/[./]+$/u, "").toLowerCase(); }

function rememberedDenial(request: GrokBuildPermissionRequest): string {
  if (request.kind === "bash") return `User rejected the execution and excluded \`${request.detail ?? ""}\` from future runs in this project`;
  if (request.kind === "mcp") return `User rejected the execution and excluded MCP tool \`${request.detail ?? request.toolName}\` from future runs in this project`;
  if (request.kind === "web_fetch") return `User rejected the execution and excluded this domain from future requests in this project`;
  return "User rejected the execution";
}

async function waitForTurn(prior: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) signal.throwIfAborted();
  let aborted!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    aborted = () => reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    signal.addEventListener("abort", aborted, { once: true });
  });
  try { await Promise.race([prior.catch(() => undefined), cancelled]); }
  finally { signal.removeEventListener("abort", aborted); }
}
