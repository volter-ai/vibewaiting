import { VirtualFS } from "almostnode";
import { describe, expect, it } from "vitest";
import { GrokBuildSkillManager } from "../experiments/browser-agent/src/grok-build-skill-manager.js";

function skill(vfs: VirtualFS, path: string, frontmatter: string): void {
  vfs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  vfs.writeFileSync(path, `---\n${frontmatter}\n---\n# Skill\n`);
}

const ok = { output: "ok" };
const call = (name: string, input: object) => ({ callId: name, name, arguments: JSON.stringify(input) });

describe("Grok Build session skill lifecycle", () => {
  it("withholds paths-gated skills until a successful matching file tool call", () => {
    const vfs = new VirtualFS();
    skill(vfs, "/.grok/skills/react/SKILL.md", "name: react\ndescription: React specialist\npaths:\n  - src/**/*.tsx");
    const manager = new GrokBuildSkillManager(vfs);

    expect(manager.startupSkills()).toEqual([]);
    expect(manager.afterToolCall(call("read_file", { target_file: "/README.md" }), ok)).toBeUndefined();
    expect(manager.afterToolCall(call("read_file", { target_file: "/src/ui/App.tsx" }), ok)).toContain("react: React specialist");
    expect(manager.afterToolCall(call("read_file", { target_file: "/src/ui/App.tsx" }), ok)).toBeUndefined();
  });

  it("discovers a nested config directory only after a nearby path is accessed", () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync("/packages/game/src", { recursive: true });
    vfs.writeFileSync("/packages/game/src/main.ts", "export {};");
    skill(vfs, "/packages/game/.grok/skills/three/SKILL.md", "name: three\ndescription: Build Three.js games");
    const manager = new GrokBuildSkillManager(vfs);

    expect(manager.startupSkills()).toEqual([]);
    const reminder = manager.afterToolCall(call("read_file", { target_file: "/packages/game/src/main.ts" }), ok);
    expect(reminder).toContain("three: Build Three.js games");
    expect(reminder).toContain("/packages/game/.grok/skills/three/SKILL.md");
  });

  it("does not reconcile failed or unrelated tool calls", () => {
    const vfs = new VirtualFS();
    skill(vfs, "/.grok/skills/js/SKILL.md", "name: js\ndescription: JavaScript\npaths: [src/**]");
    const manager = new GrokBuildSkillManager(vfs);

    expect(manager.afterToolCall(call("read_file", { target_file: "/src/main.js" }), { output: "failed", isError: true })).toBeUndefined();
    expect(manager.afterToolCall(call("grep", { path: "/src" }), ok)).toBeUndefined();
  });
});
