import { VirtualFS } from "almostnode";
import { describe, expect, it, vi } from "vitest";
import type { GrokTool } from "../src/grok-browser-protocol.js";
import type { GrokBuildAgentDefinition } from "../experiments/browser-agent/src/grok-build-agents.js";
import {
  configureGrokBuildAgentTools,
  formatGrokBuildPreloadedSkills,
  grokBuildAgentMemory,
  GrokBuildCompletionTracker,
  GrokBuildHookedRuntime,
  runGrokBuildAgentHooks,
} from "../experiments/browser-agent/src/grok-build-custom-agent.js";
import { discoverGrokBuildSkills } from "../experiments/browser-agent/src/grok-build-skills.js";

function definition(overrides: Partial<GrokBuildAgentDefinition> = {}): GrokBuildAgentDefinition {
  return {
    name: "worker", description: "worker", promptMode: "extend", permissionMode: "default",
    skills: [], discoverSkills: true, inheritSkills: true, agentsMd: true, injectDefaultTools: true,
    tools: [], disallowedTools: [], mcpServers: [], mcpInheritance: "all", source: "project", ...overrides,
  };
}

function write(vfs: VirtualFS, path: string, source: string): void {
  vfs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  vfs.writeFileSync(path, source);
}

describe("Grok Build browser custom-agent runtime", () => {
  it("preloads exact skill bodies and injects scoped memory with native envelopes and bounds", () => {
    const vfs = new VirtualFS();
    write(vfs, "/repo/.grok/skills/review/SKILL.md", "---\nname: review\ndescription: Review code\n---\n# Review\n\nCheck tests.");
    const skills = discoverGrokBuildSkills(vfs, { workingDirectory: "/repo" });
    expect(formatGrokBuildPreloadedSkills(vfs, ["REVIEW", "missing"], skills).injection).toBe(
      '\n\n<skill name="review" description="Review code" path="/repo/.grok/skills/review/SKILL.md">\n# Review\n\nCheck tests.\n</skill>\n\n',
    );
    write(vfs, "/repo/.grok/agent-memory/worker/MEMORY.md", `${Array.from({ length: 205 }, (_, index) => `line-${index}`).join("\n")}\nignored`);
    const memory = grokBuildAgentMemory(vfs, definition({ memory: "project" }), "/repo");
    expect(memory.directory).toBe("/repo/.grok/agent-memory/worker");
    expect(memory.injection).toContain("<agent-memory>\nMemory directory: /repo/.grok/agent-memory/worker");
    expect(memory.injection).toContain("line-199");
    expect(memory.injection).not.toContain("line-200");
  });

  it("applies native tool config names/params/descriptions and hosted search overrides", async () => {
    const tools: GrokTool[] = [
      { type: "function", name: "grep", description: "old", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
      { type: "web_search" }, { type: "x_search" },
    ];
    const execute = vi.fn(async (call) => ({ output: `${call.name}:${call.arguments}` }));
    const configured = configureGrokBuildAgentTools(tools, { execute }, definition({
      toolConfig: { tools: [{ id: "GrokBuild:grep", name_override: "search", params_name_overrides: { pattern: "query" }, description_override: "Find text" }, { id: "web_search" }, { id: "x_search" }] },
      toolOverrides: {
        webSearch: { allowedDomains: ["example.com"] },
        xSearch: { dateBound: { fromDate: "2026-01-01", toDate: "2026-02-01" } },
      },
    }));
    expect(configured.tools).toEqual([
      { type: "function", name: "search", description: "Find text", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
      { type: "web_search", filters: { allowed_domains: ["example.com"] } },
      { type: "x_search", from_date: "2026-01-01", to_date: "2026-02-01" },
    ]);
    await configured.runtime.execute({ callId: "1", name: "search", arguments: '{"query":"needle"}' }, new AbortController().signal);
    expect(execute).toHaveBeenCalledWith({ callId: "1", name: "grep", arguments: '{"pattern":"needle"}' }, expect.any(AbortSignal));
    expect(configured.canonicalToolName("search")).toBe("grep");
  });

  it("retries completion turns with source exponential recovery until the canonical tool is called", async () => {
    const tracker = new GrokBuildCompletionTracker((name) => name === "done_alias" ? "complete_task" : name);
    const prompts: string[] = [];
    const delays: number[] = [];
    let attempts = 0;
    const result = await tracker.run("work", {
      tool: "complete_task", reminder: "call it",
      recovery: { maxRetries: 3, baseDelayMs: 5, maxDelayMs: 8 },
    }, new AbortController().signal, async (prompt) => {
      prompts.push(prompt);
      attempts += 1;
      if (attempts === 3) tracker.event({ type: "tool_start", turn: 1, call: { callId: "x", name: "done_alias", arguments: "{}" } });
      return { status: "complete" as const };
    }, async (delay) => { delays.push(delay); });
    expect(result.status).toBe("complete");
    expect(prompts).toEqual(["work", "call it", "call it"]);
    expect(delays).toEqual([5, 8]);
  });

  it("runs matching inline hooks, fails open on crashes, and blocks pre-tool exit-2/deny", async () => {
    const hooks = {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard" }] }],
      PostToolUse: [{ hooks: [{ type: "command", command: "observe" }] }],
    };
    const runner = { run: vi.fn(async (command: string) => command === "guard"
      ? { stdout: '{"decision":"deny","reason":"not allowed"}', stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "", exitCode: 0 }) };
    await expect(runGrokBuildAgentHooks(hooks, "PreToolUse", "run_terminal_command", "/repo", runner, new AbortController().signal))
      .resolves.toEqual({ denied: "not allowed" });
    const execute = vi.fn(async () => ({ output: "must not execute" }));
    const runtime = new GrokBuildHookedRuntime({ execute }, hooks, "/repo", runner);
    await expect(runtime.execute({ callId: "1", name: "run_terminal_command", arguments: "{}" }, new AbortController().signal))
      .resolves.toEqual({ output: "not allowed", isError: true });
    expect(execute).not.toHaveBeenCalled();
  });
});
