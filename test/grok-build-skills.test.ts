import { VirtualFS } from "almostnode";
import { describe, expect, it } from "vitest";
import {
  createGrokBuildSkillReminder,
  discoverGrokBuildSkills,
  discoverGrokBuildSkillsNearPath,
  formatGrokBuildSkillListing,
} from "../experiments/browser-agent/src/grok-build-skills.js";

function skill(vfs: VirtualFS, path: string, content: string): void {
  vfs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  vfs.writeFileSync(path, content);
}

describe("Grok Build browser skill discovery", () => {
  it("discovers local and bundled skill layouts with local name shadowing", () => {
    const vfs = new VirtualFS();
    skill(vfs, "/.grok/skills/review/SKILL.md", "---\nname: review\ndescription: Local review\n---\n");
    skill(vfs, "/.grok/bundled/skills/review/SKILL.md", "---\nname: review\ndescription: Bundled review\n---\n");
    skill(vfs, "/.grok/bundled/skills/game/SKILL.md", "---\nname: game\ndescription: Build games\n---\n");

    const skills = discoverGrokBuildSkills(vfs);

    expect(skills.map(({ name, scope }) => [name, scope])).toEqual([["review", "local"], ["game", "bundled"]]);
    expect(skills[0]?.description).toBe("Local review");
  });

  it("parses folded YAML descriptions and renders native trigger/path lines", () => {
    const vfs = new VirtualFS();
    skill(vfs, "/.grok/bundled/skills/build-with-ai/SKILL.md", `---
name: build-with-ai
description: >
  Build AI features into an app. Use when adding a chatbot,
  calling an LLM, or selecting a model.
---
`);

    const listing = formatGrokBuildSkillListing(discoverGrokBuildSkills(vfs));

    expect(listing).toBe(`The following skills are available for use:

- build-with-ai: Build AI features into an app
  Use when: adding a chatbot, calling an LLM, or selecting a model.
  Absolute path: /.grok/bundled/skills/build-with-ai/SKILL.md`);
  });

  it("derives a body description but omits model-disabled skills", () => {
    const vfs = new VirtualFS();
    skill(vfs, "/.agents/skills/browser/SKILL.md", "---\nname: browser\n---\n# Browser\n\nLaunch a browser for testing.\n");
    skill(vfs, "/.agents/skills/manual/SKILL.md", "---\nname: manual\ndescription: Manual only\ndisable-model-invocation: true\n---\n");

    const skills = discoverGrokBuildSkills(vfs);
    expect(skills.find((entry) => entry.name === "browser")?.description).toBe("Launch a browser for testing.");
    expect(formatGrokBuildSkillListing(skills)).not.toContain("manual");
  });

  it("filters vendor-shipped defaults but keeps similarly named Grok skills", () => {
    const vfs = new VirtualFS();
    skill(vfs, "/.claude/skills/pdf/SKILL.md", "---\nname: pdf\ndescription: Vendor PDF\n---\n");
    skill(vfs, "/.grok/skills/pdf/SKILL.md", "---\nname: pdf\ndescription: User PDF\n---\n");
    expect(discoverGrokBuildSkills(vfs).map((entry) => entry.description)).toEqual(["User PDF"]);
  });

  it("honors native vendor gates at startup", () => {
    const vfs = new VirtualFS();
    skill(vfs, "/.claude/skills/custom-claude/SKILL.md", "---\nname: custom-claude\ndescription: Claude custom\n---\n");
    skill(vfs, "/.cursor/skills/custom-cursor/SKILL.md", "---\nname: custom-cursor\ndescription: Cursor custom\n---\n");
    skill(vfs, "/.grok/skills/custom-grok/SKILL.md", "---\nname: custom-grok\ndescription: Grok custom\n---\n");

    expect(discoverGrokBuildSkills(vfs, { claudeSkills: false, cursorSkills: false }).map(({ name }) => name))
      .toEqual(["custom-grok"]);
  });

  it("loads a configured directory's own SKILL.md before its recursive children", () => {
    const vfs = new VirtualFS();
    skill(vfs, "/custom/direct/SKILL.md", "---\nname: direct\ndescription: Direct root\n---\n");
    skill(vfs, "/custom/direct/nested/SKILL.md", "---\nname: nested\ndescription: Nested child\n---\n");

    expect(discoverGrokBuildSkills(vfs, { paths: ["/custom/direct"] }).map(({ name }) => name))
      .toEqual(["direct", "nested"]);
    expect(discoverGrokBuildSkills(vfs, { paths: ["/custom/direct/SKILL.md"] }).map(({ name }) => name))
      .toEqual(["direct"]);
    expect(discoverGrokBuildSkills(vfs, { workingDirectory: "/custom", paths: ["direct/SKILL.md"] }).map(({ name }) => name))
      .toEqual(["direct"]);
  });

  it("uses an optional realpath abstraction for native canonical deduplication", () => {
    const vfs = new VirtualFS();
    skill(vfs, "/real/skill/SKILL.md", "---\nname: canonical\ndescription: Canonical\n---\n");
    skill(vfs, "/alias/skill/SKILL.md", "---\nname: alias-copy\ndescription: Alias\n---\n");
    const nativeRealpath = vfs.realpathSync.bind(vfs);
    vfs.realpathSync = (path: string) => path === "/alias/skill/SKILL.md" ? "/real/skill/SKILL.md" : nativeRealpath(path);

    expect(discoverGrokBuildSkills(vfs, { paths: ["/real/skill/SKILL.md", "/alias/skill/SKILL.md"] }).map(({ name }) => name))
      .toEqual(["canonical"]);
  });

  it("normalizes paths like native without splitting commas inside braces", () => {
    const vfs = new VirtualFS();
    skill(vfs, "/.grok/skills/scoped/SKILL.md", "---\nname: scoped\ndescription: Scoped\npaths: src/**, a/{b,c}/**, docs\n---\n");
    skill(vfs, "/.grok/skills/all/SKILL.md", "---\nname: all\ndescription: All\npaths: '**'\n---\n");

    const skills = discoverGrokBuildSkills(vfs);
    expect(skills.find(({ name }) => name === "scoped")?.paths).toEqual(["src", "a/{b,c}", "docs"]);
    expect(skills.find(({ name }) => name === "all")?.paths).toBeUndefined();
  });

  it("walks upward deepest-first, excludes cwd, never scans cursor dynamically, and gates claude", () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync("/repo/packages/game/src", { recursive: true });
    vfs.writeFileSync("/repo/packages/game/src/main.ts", "export {};");
    skill(vfs, "/repo/.grok/skills/cwd/SKILL.md", "---\nname: cwd\ndescription: Cwd\n---\n");
    skill(vfs, "/repo/packages/.grok/skills/parent/SKILL.md", "---\nname: parent\ndescription: Parent\n---\n");
    skill(vfs, "/repo/packages/game/.grok/skills/deep/SKILL.md", "---\nname: deep\ndescription: Deep\n---\n");
    skill(vfs, "/repo/packages/game/.claude/skills/claude-dyn/SKILL.md", "---\nname: claude-dyn\ndescription: Claude\n---\n");
    skill(vfs, "/repo/packages/game/.cursor/skills/cursor-dyn/SKILL.md", "---\nname: cursor-dyn\ndescription: Cursor\n---\n");

    expect(discoverGrokBuildSkillsNearPath(vfs, "/repo/packages/game/src/main.ts", "/repo").map(({ name }) => name))
      .toEqual(["deep", "claude-dyn", "parent"]);
    expect(discoverGrokBuildSkillsNearPath(vfs, "/repo/packages/game/src/main.ts", "/repo", { claudeSkills: false }).map(({ name }) => name))
      .toEqual(["deep", "parent"]);
  });

  it("wraps the baseline listing in the native reminder carrier", () => {
    expect(createGrokBuildSkillReminder([{
      name: "review",
      description: "Review code",
      path: "/.grok/bundled/skills/review/SKILL.md",
      scope: "bundled",
      disableModelInvocation: false,
      enabled: true,
    }])).toBe(`<system-reminder>
The following skills are available for use:

- review: Review code
  Absolute path: /.grok/bundled/skills/review/SKILL.md
</system-reminder>`);
  });
});
