import { VirtualFS } from "almostnode";
import { describe, expect, it } from "vitest";
import {
  discoverGrokBuildAgents,
  renderGrokBuildAgentPrompt,
} from "../experiments/browser-agent/src/grok-build-agents.js";

describe("Grok Build browser agent definitions", () => {
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
    vfs.writeFileSync("/.grok/agents/explore.md", "---\nname: explore\ndescription: Project-specific explorer\nprompt_mode: full\npermission_mode: plan\nagents_md: false\n---\nOnly inspect this project with " + "${{ tools.by_kind.read }}" + ".\n");
    vfs.writeFileSync("/.grok/agents/security.md", "---\nname: security\ndescription: Review application security\nprompt_mode: full\n---\nUse " + "${{ tools.by_kind.search }}" + " to find risks.\n");

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
});
