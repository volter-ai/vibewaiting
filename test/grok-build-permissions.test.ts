import { describe, expect, it, vi } from "vitest";
import {
  GrokBuildPermissionManager,
  type GrokBuildPermissionPromptOutcome,
  type GrokBuildPermissionRequest,
} from "../experiments/browser-agent/src/grok-build-permissions.js";

const request = (kind: GrokBuildPermissionRequest["kind"], detail = "value"): GrokBuildPermissionRequest => ({
  toolCallId: crypto.randomUUID(),
  toolName: kind === "bash" ? "run_terminal_command" : kind === "mcp" ? "use_tool" : kind === "edit" ? "write" : kind,
  kind,
  detail,
  input: {},
});

describe("Grok Build browser permission manager", () => {
  it("auto-allows native safe access kinds without opening a prompt", async () => {
    const prompt = vi.fn<() => Promise<GrokBuildPermissionPromptOutcome>>();
    const manager = new GrokBuildPermissionManager(prompt);
    for (const kind of ["read", "grep", "web_search"] as const) {
      await expect(manager.authorize(request(kind), new AbortController().signal)).resolves.toEqual({ allowed: true, source: "safe" });
    }
    expect(prompt).not.toHaveBeenCalled();
  });

  it("ports edit-session, exact command, MCP, and domain grants", async () => {
    const outcomes: GrokBuildPermissionPromptOutcome[] = ["allow-edits-session", "allow-always", "allow-always", "allow-always"];
    const prompt = vi.fn(async () => outcomes.shift()!);
    const manager = new GrokBuildPermissionManager(prompt);
    const signal = new AbortController().signal;
    await manager.authorize(request("edit", "/src/a.ts"), signal);
    await expect(manager.authorize(request("edit", "/src/b.ts"), signal)).resolves.toMatchObject({ allowed: true, source: "session-grant" });
    for (const access of [request("bash", "npm test"), request("mcp", "github__search"), request("web_fetch", "https://Docs.Example.com/a")]) {
      await manager.authorize(access, signal);
      await expect(manager.authorize({ ...access, toolCallId: crypto.randomUUID(), ...(access.kind === "web_fetch" ? { detail: "https://docs.example.com/b" } : {}) }, signal))
        .resolves.toMatchObject({ allowed: true, source: "session-grant" });
    }
    expect(prompt).toHaveBeenCalledTimes(4);
  });

  it("remembers exact denials and makes the slash always-approve switch authoritative", async () => {
    const prompt = vi.fn(async () => "reject-always" as const);
    const manager = new GrokBuildPermissionManager(prompt);
    const denied = request("mcp", "ops__deploy");
    await expect(manager.authorize(denied, new AbortController().signal)).resolves.toMatchObject({ allowed: false, source: "session-deny" });
    await expect(manager.authorize({ ...denied, toolCallId: "again" }, new AbortController().signal)).resolves.toMatchObject({ allowed: false, source: "session-deny" });
    expect(prompt).toHaveBeenCalledOnce();
    expect(manager.setAlwaysApprove(true)).toBe(true);
    await expect(manager.authorize(request("bash", "rm build.tmp"), new AbortController().signal)).resolves.toEqual({ allowed: true, source: "always-approve" });
    expect(manager.setAlwaysApprove(false)).toBe(false);
    await expect(manager.authorize({ ...denied, toolCallId: "after-off" }, new AbortController().signal)).resolves.toMatchObject({ allowed: false, source: "session-deny" });
  });

  it("persists project grants and gives domain denials precedence over parent/subdomain allows", async () => {
    let state: { allowed?: string[]; denied?: string[] } | undefined;
    const store = { load: () => state, save: (next: { allowed: string[]; denied: string[] }) => { state = structuredClone(next); } };
    const outcomes: GrokBuildPermissionPromptOutcome[] = ["allow-always", "reject-always"];
    const first = new GrokBuildPermissionManager(async () => outcomes.shift()!, store);
    const signal = new AbortController().signal;
    await first.authorize(request("bash", "npm test"), signal);
    await first.authorize(request("web_fetch", "https://example.com/private"), signal);
    const prompt = vi.fn(async () => "allow-once" as const);
    const restored = new GrokBuildPermissionManager(prompt, store);
    await expect(restored.authorize(request("bash", "npm test"), signal)).resolves.toMatchObject({ allowed: true, source: "session-grant" });
    await expect(restored.authorize(request("web_fetch", "https://api.example.com/private"), signal)).resolves.toMatchObject({ allowed: false, source: "session-deny" });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("serializes concurrent reverse prompts like the native manager", async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const order: string[] = [];
    const manager = new GrokBuildPermissionManager(async (entry) => {
      order.push(`start:${entry.detail}`);
      if (entry.detail === "first") { markFirstStarted(); await first; }
      order.push(`end:${entry.detail}`);
      return "allow-once";
    });
    const signal = new AbortController().signal;
    const one = manager.authorize(request("bash", "first"), signal);
    const two = manager.authorize(request("bash", "second"), signal);
    await firstStarted;
    expect(order).toEqual(["start:first"]);
    releaseFirst();
    await Promise.all([one, two]);
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });
});
