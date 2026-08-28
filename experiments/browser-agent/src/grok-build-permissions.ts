export type GrokBuildPermissionAccessKind = "read" | "grep" | "edit" | "bash" | "mcp" | "web_fetch" | "web_search";

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
  | "allow-edits-session"
  | "reject-once"
  | "reject-always"
  | "enable-always-approve"
  | "cancelled";

export interface GrokBuildPermissionDecision {
  allowed: boolean;
  source: "safe" | "always-approve" | "session-grant" | "session-deny" | "prompt";
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

  constructor(private readonly prompt?: GrokBuildPermissionPrompter, private readonly store?: GrokBuildPermissionStore) {
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
    if (this.alwaysApprove) return { allowed: true, source: "always-approve" };
    if (request.kind === "read" || request.kind === "grep" || request.kind === "web_search") {
      return { allowed: true, source: "safe" };
    }
    if (request.kind === "edit" && this.allowEditsForSession) return { allowed: true, source: "session-grant" };
    const key = permissionKey(request);
    if (isDenied(request, this.denied)) return { allowed: false, source: "session-deny", reason: rememberedDenial(request) };
    if (this.allowed.has(key)) return { allowed: true, source: "session-grant" };
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
        this.allowed.add(key);
        this.persist();
        return { allowed: true, source: "session-grant" };
      case "allow-once": return { allowed: true, source: "prompt" };
      case "reject-always":
        this.denied.add(denialKey(request));
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
