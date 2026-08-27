import { VirtualFS } from "almostnode";
import { describe, expect, it } from "vitest";
import { clearVirtualFileSystem } from "../experiments/browser-agent/src/browser-project-store.js";

describe("browser project reset", () => {
  it("can reset the project without deleting the global published bundle cache", () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync("/src/game.js", "game");
    vfs.writeFileSync("/.grok/skills/local/SKILL.md", "local");
    vfs.writeFileSync("/.grok/bundled/skills/review/SKILL.md", "published");

    clearVirtualFileSystem(vfs, "/", ["/.grok/bundled"]);

    expect(vfs.existsSync("/src/game.js")).toBe(false);
    expect(vfs.existsSync("/.grok/skills/local/SKILL.md")).toBe(false);
    expect(vfs.readFileSync("/.grok/bundled/skills/review/SKILL.md", "utf8")).toBe("published");
  });
});
