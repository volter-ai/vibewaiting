import { describe, expect, it } from "vitest";
import { applyGrokBuildSkillSubstitutions, buildGrokBuildSkillInformation, resolveGrokBuildSkillInternalLinks } from "../experiments/browser-agent/src/grok-build-skill-invocation.js";

describe("Grok Build slash skill expansion", () => {
  it("ports argument and metadata substitution without treating dollar prices as arguments", () => {
    expect(applyGrokBuildSkillSubstitutions("Run $ARGUMENTS", "deploy prod")).toBe("Run deploy prod");
    expect(applyGrokBuildSkillSubstitutions("$0/$ARGUMENTS[1] $99", "one two")).toBe("one/two $99");
    expect(applyGrokBuildSkillSubstitutions("Config ${SKILL_DIR}/c.json", "prod", { skillDirectory: "/skills/deploy" })).toBe("Config /skills/deploy/c.json\n\n**ARGUMENTS:** prod");
    expect(applyGrokBuildSkillSubstitutions("Session ${SESSION_ID}", "", { sessionId: "s1" })).toBe("Session s1");
  });

  it("builds the native indexed skill_information envelope and skips unreadable bodies", () => {
    const files = new Map([["/.grok/skills/commit/SKILL.md", "---\nname: commit\ndescription: Commit\n---\n# Commit\n\nDo $ARGUMENTS"]]);
    const vfs = {
      existsSync: (path: string) => files.has(path),
      statSync: (path: string) => ({ isFile: () => files.has(path), isDirectory: () => false }),
      readFileSync: (path: string) => files.get(path)!,
    } as never;
    const skill = { name: "commit", description: "Commit", path: "/.grok/skills/commit/SKILL.md", scope: "local" as const, disableModelInvocation: false, enabled: true };
    const result = buildGrokBuildSkillInformation(vfs, [
      { name: "commit", args: "fix auth", skillPath: skill.path, qualifiedName: "local:commit", skill },
      { name: "missing", args: "", skillPath: "/missing/SKILL.md", qualifiedName: "local:missing", skill: { ...skill, name: "missing", path: "/missing/SKILL.md" } },
    ], "s1");
    expect(result).toBe('<skill_information>\n<skills_referenced>\n<skill name="commit" path="/.grok/skills/commit/SKILL.md"/>\n<skill name="missing" path="/missing/SKILL.md"/>\n</skills_referenced>\n<skill name="commit" args="fix auth">\n# Commit\n\nDo fix auth\n</skill>\n</skill_information>');
  });

  it("resolves existing internal Markdown links and rejects traversal like native", () => {
    const existing = new Set(["/skills/review/guide.md", "/skills/review/assets/example.png", "/secret.md"]);
    const vfs = { existsSync: (path: string) => existing.has(path) } as never;
    const body = "[guide](guide.md) ![example](assets/example.png) [missing](nope.md) [secret](../../secret.md) [web](https://x.ai)\n[ref]: guide.md";
    expect(resolveGrokBuildSkillInternalLinks(body, "/skills/review", vfs)).toBe(
      "[guide](/skills/review/guide.md) ![example](/skills/review/assets/example.png) [missing](nope.md) [secret](../../secret.md) [web](https://x.ai)\n[ref]: /skills/review/guide.md",
    );
  });
});
