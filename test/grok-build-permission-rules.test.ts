import { describe, expect, it, vi } from "vitest";
import { VirtualFS } from "almostnode";
import {
  discoverGrokBuildPermissionPolicy,
  GrokBuildPermissionPolicy,
  parseGrokBuildPermissionRule,
} from "../experiments/browser-agent/src/grok-build-permission-rules.js";
import type { GrokBuildPermissionRequest } from "../experiments/browser-agent/src/grok-build-permissions.js";

const access = (kind: GrokBuildPermissionRequest["kind"], detail: string): GrokBuildPermissionRequest => ({
  toolCallId: "call", toolName: kind, kind, detail, input: {},
});

describe("Grok Build native permission rule policy", () => {
  it("parses native compact aliases, domain rules, bash prefix idioms, and Claude MCP spelling", () => {
    expect(parseGrokBuildPermissionRule("Bash(npm run build:*)", "allow")).toEqual({ action: "allow", tool: "bash", pattern: "npm run build", patternMode: "glob" });
    expect(parseGrokBuildPermissionRule("Write(src/**/*.ts)", "ask")).toEqual({ action: "ask", tool: "edit", pattern: "src/**/*.ts", patternMode: "glob" });
    expect(parseGrokBuildPermissionRule("WebFetch(domain:example.com)", "deny")).toEqual({ action: "deny", tool: "web_fetch", pattern: "example.com", patternMode: "domain" });
    expect(parseGrokBuildPermissionRule("mcp__github", "allow")).toEqual({ action: "allow", tool: "mcp", pattern: "github__*", patternMode: "glob" });
    expect(parseGrokBuildPermissionRule("NotebookEdit", "allow")).toBeUndefined();
  });

  it("applies order-independent deny > ask > allow and Read rules to grep", () => {
    const policy = new GrokBuildPermissionPolicy({ rules: [
      parseGrokBuildPermissionRule("Read(**)", "allow")!,
      parseGrokBuildPermissionRule("Read(**/.env)", "ask")!,
      parseGrokBuildPermissionRule("Read(**/secret/**)", "deny")!,
    ] });
    expect(policy.evaluate(access("read", "/repo/src/a.ts"))?.action).toBe("allow");
    expect(policy.evaluate(access("grep", "/repo/.env"))?.action).toBe("ask");
    expect(policy.evaluate(access("read", "/repo/secret/key"))?.action).toBe("deny");
  });

  it("matches every Bash segment and web domains with subdomain semantics", () => {
    const policy = new GrokBuildPermissionPolicy({ rules: [
      parseGrokBuildPermissionRule("Bash(rm *)", "deny")!,
      parseGrokBuildPermissionRule("WebFetch(domain:example.com)", "ask")!,
    ] });
    expect(policy.evaluate(access("bash", "git status && rm -rf /tmp/x"))?.action).toBe("deny");
    expect(policy.evaluate(access("web_fetch", "https://api.example.com/a"))?.action).toBe("ask");
    expect(policy.evaluate(access("web_fetch", "https://notexample.com/a"))).toBeUndefined();
  });

  it("discovers trusted Grok TOML and Claude JSON layers with defaultMode effects", () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync("/.grok", { recursive: true });
    vfs.mkdirSync("/repo/.claude", { recursive: true });
    vfs.writeFileSync("/.grok/config.toml", '[permission]\nallow = ["Bash(git status)"]\n');
    vfs.writeFileSync("/repo/.claude/settings.json", JSON.stringify({ permissions: { deny: ["Bash(git push *)"], defaultMode: "dontAsk" } }));
    const policy = discoverGrokBuildPermissionPolicy(vfs, "/repo");
    expect(policy.evaluate(access("bash", "git status"))?.action).toBe("allow");
    expect(policy.evaluate(access("bash", "git push origin main"))?.action).toBe("deny");
    expect(policy.promptPolicy).toBe("deny");
    const untrusted = discoverGrokBuildPermissionPolicy(vfs, "/repo", false);
    expect(untrusted.rules).toEqual([]);
  });
});
