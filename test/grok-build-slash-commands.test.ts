import { describe, expect, it } from "vitest";
import { grokBuildAvailableCommands, grokBuildLoopInstruction, resolveGrokBuildSlash } from "../experiments/browser-agent/src/grok-build-slash-commands.js";
import type { GrokBuildSkillInfo } from "../experiments/browser-agent/src/grok-build-skills.js";

const all = { feedback: true, memory: true, memoryConfigured: true, scheduler: true, hooks: true, plugins: true, goal: true, workflows: true, workflowManagement: true };
const skill = (name: string, scope: "local" | "bundled" = "local"): GrokBuildSkillInfo => ({ name, description: `${name} skill`, path: `/.grok/skills/${name}/SKILL.md`, scope, disableModelInvocation: false, enabled: true });

describe("Grok Build shell slash-command port", () => {
  it("preserves native builtin order, aliases, gates, and mixed-case resolution", () => {
    expect(grokBuildAvailableCommands(all, [skill("commit"), skill("deploy")]).map((entry) => entry.name)).toEqual([
      "compact", "always-approve", "flush", "dream", "memory", "context", "hooks-trust", "hooks-list", "hooks-add", "hooks-remove", "hooks-untrust", "plugins", "reload-plugins", "session-info", "feedback", "deep-research", "workflow", "goal", "loop", "commit", "deploy",
    ]);
    expect(resolveGrokBuildSlash(" /Compact keep auth ", all)).toEqual({ type: "builtin", commandName: "compact", action: { type: "compact", userContext: "keep auth" } });
    expect(resolveGrokBuildSlash("/yolo OFF", all)).toEqual({ type: "builtin", commandName: "always-approve", action: { type: "set-yolo", enabled: false } });
    expect(resolveGrokBuildSlash("/status", all)).toEqual({ type: "builtin", commandName: "session-info", action: { type: "session-info" } });
    expect(resolveGrokBuildSlash("/goal ship it --budget 123", all)).toEqual({ type: "builtin", commandName: "goal", action: { type: "goal-set", objective: "ship it", tokenBudget: 123 } });
    expect(resolveGrokBuildSlash("/goal ship --budget nope", all)).toEqual({ type: "builtin", commandName: "goal", action: { type: "goal-set", objective: "ship --budget nope" } });
    expect(resolveGrokBuildSlash("/feedback hello", { ...all, feedback: false })).toEqual({ type: "passthrough", text: "/feedback hello" });
  });

  it("matches native workflow management grammar and preserves listing case", () => {
    expect(resolveGrokBuildSlash("/workflow pause wf_1", all)).toMatchObject({ action: { type: "workflow-manage", operation: "pause", runId: "wf_1" } });
    expect(resolveGrokBuildSlash("/workflow wf_1 stop", all)).toMatchObject({ action: { type: "workflow-manage", operation: "stop", runId: "wf_1" } });
    expect(resolveGrokBuildSlash("/workflow Audit now", all)).toMatchObject({ action: { type: "workflow-launch", name: "Audit", input: "now" } });
    expect(resolveGrokBuildSlash("/triage-flakes now", all, [], [{ name: "Triage-Flakes", description: "Triage" }])).toEqual({ type: "builtin", commandName: "workflow", action: { type: "workflow-launch", name: "Triage-Flakes", input: "now" } });
  });

  it("uses native case-folded collision and qualified skill reference rules", () => {
    const duplicate = [skill("Commit", "local"), skill("commit", "bundled")];
    const names = grokBuildAvailableCommands(all, duplicate).map((entry) => entry.name);
    expect(names).toContain("local:commit");
    expect(names).toContain("bundled:commit");
    expect(names).not.toContain("commit");
    expect(grokBuildAvailableCommands(all, [skill("login")]).map((entry) => entry.name)).toContain("local:login");
    expect(resolveGrokBuildSlash("/local:commit fix auth /deploy prod", all, [...duplicate, skill("deploy")])).toMatchObject({
      type: "skill",
      references: [
        { name: "local:commit", args: "fix auth", qualifiedName: "local:Commit" },
        { name: "deploy", args: "prod", qualifiedName: "local:deploy" },
      ],
    });
  });

  it("ports the canonical /loop usage and mode-specific scheduler instruction", () => {
    expect(resolveGrokBuildSlash("/loop", all)).toEqual({ type: "loop-prompt", commandName: "loop", displayText: "/loop", text: grokBuildLoopInstruction("", "detached") });
    const detached = grokBuildLoopInstruction("2h run tests", "detached");
    const inSession = grokBuildLoopInstruction("2h run tests", "in-session");
    expect(detached).toContain("detached background subagent");
    expect(inSession).toContain("new turn in this conversation");
    expect(detached).toContain("## Input\n2h run tests");
  });
});
