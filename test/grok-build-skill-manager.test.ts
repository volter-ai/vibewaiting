import { VirtualFS } from "almostnode";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GrokBuildSkillManager, grokBuildSkillPathsMatch } from "../experiments/browser-agent/src/grok-build-skill-manager.js";

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

  it("loads cwd skills at startup while the dynamic upward walk remains cwd-exclusive", () => {
    const vfs = new VirtualFS();
    skill(vfs, "/repo/.grok/skills/startup/SKILL.md", "name: startup\ndescription: Startup cwd skill");
    vfs.mkdirSync("/repo/src", { recursive: true });
    vfs.writeFileSync("/repo/src/main.ts", "export {};");
    const manager = new GrokBuildSkillManager(vfs, "/repo");

    expect(manager.startupSkills().map(({ name }) => name)).toEqual(["startup"]);
    expect(manager.afterToolCall(call("read_file", { target_file: "/repo/src/main.ts" }), ok)).toBeUndefined();
  });

  it("does not reconcile failed or unrelated tool calls", () => {
    const vfs = new VirtualFS();
    skill(vfs, "/.grok/skills/js/SKILL.md", "name: js\ndescription: JavaScript\npaths: [src/**]");
    const manager = new GrokBuildSkillManager(vfs);

    expect(manager.afterToolCall(call("read_file", { target_file: "/src/main.js" }), { output: "failed", isError: true })).toBeUndefined();
    expect(manager.afterToolCall(call("grep", { path: "/src" }), ok)).toBeUndefined();
  });

  it("registers a directly touched SKILL.md without requiring an ancestor rescan", () => {
    const vfs = new VirtualFS();
    const manager = new GrokBuildSkillManager(vfs, "/repo");
    skill(vfs, "/repo/tools/.grok/skills/new-one/SKILL.md", "name: new-one\ndescription: Newly written skill");

    expect(manager.afterToolCall(call("read_file", { target_file: "/repo/tools/.grok/skills/new-one/SKILL.md" }), ok))
      .toContain("new-one: Newly written skill");
  });

  it("holds a newly discovered conditional skill until a later matching touch", () => {
    const vfs = new VirtualFS();
    const manager = new GrokBuildSkillManager(vfs, "/repo");
    skill(vfs, "/repo/tools/.grok/skills/gated/SKILL.md", "name: gated\ndescription: Gated skill\npaths: tools/**");

    expect(manager.afterToolCall(call("read_file", { target_file: "/repo/tools/.grok/skills/gated/SKILL.md" }), ok)).toBeUndefined();
    expect(manager.afterToolCall(call("read_file", { target_file: "/repo/tools/source.ts" }), ok)).toContain("gated: Gated skill");
  });

  it("matches conditional paths with gitignore ordering, braces, classes, and escaping", () => {
    const matches = (patterns: string[], path: string) => grokBuildSkillPathsMatch(patterns, `/repo/${path}`, "/repo");

    expect(matches(["src"], "src/deep/file.ts")).toBe(true);
    expect(matches(["*.ts"], "src/deep/file.ts")).toBe(true);
    expect(matches(["src/file?.[tj]s"], "src/file1.ts")).toBe(true);
    expect(matches(["src/[!a-c]*.ts"], "src/zeta.ts")).toBe(true);
    expect(matches(["src/[!a-c]*.ts"], "src/beta.ts")).toBe(false);
    expect(matches(["src/[^a-c]*.ts"], "src/zeta.ts")).toBe(true);
    expect(matches(["src/{main,lib}.ts"], "src/lib.ts")).toBe(true);
    expect(matches(["src/{main}.ts"], "src/main.ts")).toBe(true);
    expect(matches(["*.ts", "!generated.ts"], "src/generated.ts")).toBe(false);
    expect(matches(["!generated.ts", "*.ts"], "src/generated.ts")).toBe(true);
    expect(matches(["\\!literal", "\\#notes"], "!literal/file.txt")).toBe(true);
    expect(matches(["\\#notes"], "#notes/file.txt")).toBe(true);
    expect(matches(["/root-only"], "nested/root-only/file.txt")).toBe(false);
    expect(matches(["src/a**b.ts"], "src/a/deep/b.ts")).toBe(false);
    expect(matches(["src/{main,lib.ts"], "src/{main,lib.ts")).toBe(false);
    expect(grokBuildSkillPathsMatch(["src"], "/outside/src/file.ts", "/repo")).toBe(false);
  });

  it("matches the deterministic corpus emitted by pinned native GitignoreBuilder", () => {
    const corpus = JSON.parse(readFileSync("test/fixtures/grok-conformance/native-skill-path-matcher-v1.json", "utf8")) as {
      sourceRevision: string;
      cases: Array<{ id: string; patterns: string[]; path: string; matched: boolean }>;
    };
    expect(corpus.sourceRevision).toBe("9684fa3c");
    for (const entry of corpus.cases) {
      expect(grokBuildSkillPathsMatch(entry.patterns, `/repo/${entry.path}`, "/repo"), entry.id).toBe(entry.matched);
    }
  });
});
