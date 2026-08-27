import { VirtualFS } from "almostnode";
import { describe, expect, it } from "vitest";
import {
  createGrokBuildSkillReminder,
  discoverGrokBuildSkills,
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
