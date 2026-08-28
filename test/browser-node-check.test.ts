import { describe, expect, it } from "vitest";
import { createContainer } from "almostnode";
import { tryBrowserNodeCheck } from "../experiments/browser-agent/src/browser-node-check.js";

describe("browser node syntax check", () => {
  it("matches native npm run output while parsing ESM in-browser", () => {
    const { vfs } = createContainer();
    vfs.mkdirSync("/src", { recursive: true });
    vfs.writeFileSync("/package.json", JSON.stringify({ type: "module", scripts: { check: "node --check src/main.js" } }));
    vfs.writeFileSync("/src/main.js", 'import "three";\nexport const ok = true;\n');
    expect(tryBrowserNodeCheck(vfs, "/", "npm run check")).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "\n> check\n> node --check src/main.js\n\n",
    });
  });

  it("returns a nonzero parse result and declines unrelated commands", () => {
    const { vfs } = createContainer();
    vfs.writeFileSync("/broken.js", "export const = ;");
    expect(tryBrowserNodeCheck(vfs, "/", "node --check broken.js")).toMatchObject({ exitCode: 1, stdout: "" });
    expect(tryBrowserNodeCheck(vfs, "/", "npm test")).toBeUndefined();
  });
});
