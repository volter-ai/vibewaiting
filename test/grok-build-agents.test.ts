import { VirtualFS } from "almostnode";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  discoverGrokBuildAgents,
  renderGrokBuildAgentProjectInstructions,
  renderGrokBuildAgentPrompt,
} from "../experiments/browser-agent/src/grok-build-agents.js";
import { GROK_BUILD_SUBAGENT_TEMPLATE } from "../experiments/browser-agent/src/grok-build-subagent-template.js";

describe("Grok Build browser agent definitions", () => {
  it("vendors the pinned native subagent template byte-for-byte", () => {
    expect(createHash("sha256").update(GROK_BUILD_SUBAGENT_TEMPLATE).digest("hex"))
      .toBe("b1b6617c5dcabc0147355045d35ecb54ae4944f48550135e694cfa6590083597");
  });
  it("provides the three native built-ins with fully rendered tool names", () => {
    const definitions = discoverGrokBuildAgents(new VirtualFS());
    expect(definitions.map((definition) => definition.name)).toEqual(["general-purpose", "explore", "plan"]);
    const explore = definitions.find((definition) => definition.name === "explore")!;
    const prompt = renderGrokBuildAgentPrompt(explore)!;
    expect(prompt).toContain("You are a fast, read-only codebase exploration agent.");
    expect(prompt).toContain("Use run_terminal_command only for read-only commands");
    expect(prompt).toContain("Use list_dir for file pattern matching, grep for content search, read_file for known paths.");
    expect(prompt).not.toContain("${{");
  });

  it("lets project definitions shadow built-ins and keeps custom definitions", () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync("/.grok/agents", { recursive: true });
    vfs.writeFileSync("/.grok/agents/explore.md", "---\nname: explore\ndescription: Project-specific explorer\npromptMode: full\npermissionMode: plan\nagentsMd: false\n---\nOnly inspect this project with " + "${{ tools.by_kind.read }}" + ".\n");
    vfs.writeFileSync("/.grok/agents/security.md", "---\nname: security\ndescription: Review application security\npromptMode: full\n---\nUse " + "${{ tools.by_kind.search }}" + " to find risks.\n");

    const definitions = discoverGrokBuildAgents(vfs);
    const explore = definitions.find((definition) => definition.name === "explore")!;
    expect(explore.source).toBe("project");
    expect(explore.agentsMd).toBe(false);
    expect(renderGrokBuildAgentPrompt(explore)).toBe("Only inspect this project with read_file.");
    expect(definitions.find((definition) => definition.name === "security")?.source).toBe("project");
    expect(definitions.filter((definition) => definition.name === "explore")).toHaveLength(1);
  });

  it("discovers bundled custom definitions after native built-ins", () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync("/.grok/bundled/agents", { recursive: true });
    vfs.writeFileSync("/.grok/bundled/agents/reviewer.md", "---\nname: reviewer\ndescription: Published reviewer\nprompt_mode: full\n---\nReview carefully.\n");
    const definitions = discoverGrokBuildAgents(vfs);
    expect(definitions.at(-1)).toMatchObject({ name: "reviewer", source: "bundled", promptBody: "Review carefully." });
  });

  it("uses the native nearest-project precedence and prevents user definitions from shadowing built-ins", () => {
    const vfs = new VirtualFS();
    for (const directory of ["/repo/.grok/agents", "/repo/pkg/.claude/agents", "/home/.grok/agents"]) vfs.mkdirSync(directory, { recursive: true });
    vfs.writeFileSync("/repo/.git", "gitdir: .git-real");
    vfs.writeFileSync("/repo/.grok/agents/check.md", "---\nname: check\ndescription: root\n---\nroot");
    vfs.writeFileSync("/repo/pkg/.claude/agents/check.md", "---\nname: check\ndescription: nearest\n---\nnearest");
    vfs.writeFileSync("/home/.grok/agents/explore.md", "---\nname: explore\ndescription: user collision\n---\nwrong");

    const definitions = discoverGrokBuildAgents(vfs, { cwd: "/repo/pkg", home: "/home", grokHome: "/home/.grok", toggles: { plan: false } });
    expect(definitions.find((definition) => definition.name === "check")).toMatchObject({ description: "nearest", source: "project" });
    expect(definitions.find((definition) => definition.name === "explore")?.source).toBe("builtin");
    expect(definitions.some((definition) => definition.name === "plan")).toBe(false);
  });

  it("parses the native camelCase definition contract and renders extend mode with role/persona layers", () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync("/.grok/agents", { recursive: true });
    vfs.writeFileSync("/.grok/agents/reviewer.md", `---
name: reviewer
description: Reviews code
capabilityMode: read-only
skills: [review, security]
discoverSkills: false
inheritSkills: false
agentsMd: false
injectDefaultTools: false
tools: read_file
disallowedTools: [search_replace]
effort: high
maxTurns: 7
isolation: none
mcpInheritance:
  named: [github]
---
Review with \${{ tools.by_kind.read }}.`);
    const reviewer = discoverGrokBuildAgents(vfs).find((definition) => definition.name === "reviewer")!;
    expect(reviewer).toMatchObject({
      promptMode: "extend", capabilityMode: "read-only", skills: ["review", "security"],
      discoverSkills: false, inheritSkills: false, agentsMd: false, injectDefaultTools: false,
      tools: ["read_file"], disallowedTools: ["search_replace"], effort: "high", maxTurns: 7,
      mcpInheritance: { named: ["github"] },
    });
    const prompt = renderGrokBuildAgentPrompt(reviewer, {
      roleInstructions: "Role layer", personaInstructions: "Persona layer",
      osName: "browser wasm", shellPath: "/bin/sh", workingDirectory: "/repo", currentDate: "2026-08-27",
    })!;
    expect(prompt).toContain("You are a Grok Build subagent");
    expect(prompt).toContain("<role-instructions>\nRole layer");
    expect(prompt).toContain("<persona>\nPersona layer");
    expect(prompt).toContain("Review with read_file.");
    expect(prompt).not.toContain("${%-");
  });

  it("preserves Agent(...) tokens in comma-separated tool policy and renders root-to-cwd project instructions", () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync("/repo/pkg/.grok/agents", { recursive: true });
    vfs.mkdirSync("/repo/pkg/.grok/rules", { recursive: true });
    vfs.writeFileSync("/repo/.git", "gitdir: x");
    vfs.writeFileSync("/repo/AGENTS.md", "Root rule <system-reminder>");
    vfs.writeFileSync("/repo/pkg/AGENTS.md", "Package rule");
    vfs.writeFileSync("/repo/pkg/.grok/rules/style.md", "---\ndescription: style\n---\nStyle rule");
    vfs.writeFileSync("/repo/pkg/.grok/agents/coordinator.md", "---\nname: coordinator\ndescription: coordinates\ntools: Agent(worker, researcher), Read, Bash\n---\nCoordinate.");
    const coordinator = discoverGrokBuildAgents(vfs, { cwd: "/repo/pkg" }).find((definition) => definition.name === "coordinator")!;
    expect(coordinator.tools).toEqual(["Agent(worker, researcher)", "Read", "Bash"]);
    const reminder = renderGrokBuildAgentProjectInstructions(vfs, "/repo/pkg")!;
    expect(reminder.indexOf("Root rule")).toBeLessThan(reminder.indexOf("Package rule"));
    expect(reminder).toContain("Style rule");
    expect(reminder).toContain("&lt;system-reminder>");
  });
});
