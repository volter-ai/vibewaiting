import { VirtualFS } from "almostnode";
import { describe, expect, it } from "vitest";
import { discoverGrokBuildAgents } from "../experiments/browser-agent/src/grok-build-agents.js";
import {
  discoverGrokBuildSubagentDefinitions,
  intersectGrokBuildCapabilityModes,
  resolveGrokBuildSubagentRuntime,
  validateGrokBuildSubagentResume,
} from "../experiments/browser-agent/src/grok-build-subagent-config.js";
import { grokBuildModelSubagentInput, subagentToolNames } from "../experiments/browser-agent/src/grok-build-subagent-runner.js";

describe("Grok Build subagent role/persona resolution", () => {
  it("matches the native built-in explore tool surface", () => {
    const definition = discoverGrokBuildAgents(new VirtualFS()).find((item) => item.name === "explore")!;
    expect([...subagentToolNames("explore", undefined, definition)].sort()).toEqual([
      "ask_user_question", "enter_plan_mode", "exit_plan_mode", "grep", "image_edit", "image_gen",
      "image_to_video", "list_dir", "read_file", "reference_to_video", "web_fetch", "web_search", "write", "x_search",
    ]);
  });

  it("ignores the harness-only capability mode in model-facing spawn JSON", () => {
    expect(grokBuildModelSubagentInput({ prompt: "Inspect", capability_mode: "read-only" }))
      .toEqual({ prompt: "Inspect" });
  });

  it("uses inline > project > user > bundled discovery precedence", () => {
    const vfs = new VirtualFS();
    for (const directory of ["/repo/.grok/roles", "/repo/.grok/personas", "/user/roles", "/user/personas", "/user/bundled/roles"]) {
      vfs.mkdirSync(directory, { recursive: true });
    }
    vfs.writeFileSync("/repo/.grok/roles/reviewer.toml", 'description = "project"');
    vfs.writeFileSync("/user/roles/reviewer.toml", 'description = "user"');
    vfs.writeFileSync("/user/roles/user-only.toml", 'description = "user only"');
    vfs.writeFileSync("/user/bundled/roles/user-only.toml", 'description = "bundled loses"');
    vfs.writeFileSync("/repo/.grok/personas/careful.toml", 'instructions = "project persona"');

    const definitions = discoverGrokBuildSubagentDefinitions(vfs, {
      cwd: "/repo", grokHome: "/user", bundledRoot: "/user/bundled",
      inlineRoles: { reviewer: { description: "inline" } },
    });
    expect(definitions.roles.reviewer?.description).toBe("inline");
    expect(definitions.roles["user-only"]?.description).toBe("user only");
    expect(definitions.personas.careful?.instructions).toBe("project persona");
  });

  it("composes explicit, role, persona, and definition defaults in native order", () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync("/repo/prompts", { recursive: true });
    vfs.writeFileSync("/repo/prompts/role.md", "role file");
    vfs.writeFileSync("/repo/prompts/persona.md", "persona file");
    const definition = discoverGrokBuildAgents(vfs).find((item) => item.name === "general-purpose")!;
    definition.capabilityMode = "execute";
    definition.effort = "medium";
    definition.isolation = "worktree";
    const resolved = resolveGrokBuildSubagentRuntime("reviewer", definition, {
      capabilityMode: "read-write", persona: "careful", reasoningEffort: "xhigh",
    }, {
      roles: { reviewer: { description: "review", defaultCapabilityMode: "all", model: "role-model", promptFile: "prompts/role.md", sourceDirectory: "/repo" } },
      personas: { careful: { instructions: "inline persona", instructionsFile: "prompts/persona.md", inputs: [], outputs: [], model: "persona-model", defaultIsolation: "none", sourceDirectory: "/repo" } },
    }, vfs, "/repo", "parent-model");

    expect(resolved).toMatchObject({
      model: "role-model", reasoningEffort: "xhigh", capabilityMode: "read-only",
      isolation: "none", roleName: "reviewer", roleInstructions: "role file",
      persona: "careful", personaInstructions: "inline persona\n\npersona file",
    });
  });

  it("implements capability intersection and resume identity/model invariants", () => {
    expect(intersectGrokBuildCapabilityModes("read-write", "execute")).toBe("read-only");
    expect(intersectGrokBuildCapabilityModes("all", "execute")).toBe("execute");
    expect(() => validateGrokBuildSubagentResume("explore", undefined, { subagentType: "plan", model: "source" })).toThrow("same subagent type");
    expect(() => validateGrokBuildSubagentResume("plan", "new", { subagentType: "plan", persona: "old", model: "source" })).toThrow("same persona");
    expect(() => validateGrokBuildSubagentResume("plan", undefined, { subagentType: "plan", persona: "old", model: "source" })).not.toThrow();
  });

  it("fails closed for an unreadable persona file but soft-degrades a role prompt", () => {
    const vfs = new VirtualFS();
    const definition = discoverGrokBuildAgents(vfs)[0]!;
    const fatal = resolveGrokBuildSubagentRuntime("general-purpose", definition, { persona: "missing-file" }, {
      roles: {}, personas: { "missing-file": { instructionsFile: "missing.md", inputs: [], outputs: [], sourceDirectory: "/repo" } },
    }, vfs, "/repo", "parent");
    expect(fatal).toMatchObject({ isolation: "none", persona: "missing-file" });
    expect(fatal.personaError).toContain("failed to read instructions_file");
    expect(fatal.model).toBeUndefined();

    const warning = resolveGrokBuildSubagentRuntime("reviewer", definition, {}, {
      roles: { reviewer: { description: "review", promptFile: "missing.md", sourceDirectory: "/repo" } }, personas: {},
    }, vfs, "/repo", "parent");
    expect(warning.model).toBe("parent");
    expect(warning.roleWarning).toContain("role prompt_file");
  });
});
