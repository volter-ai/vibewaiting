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

  it("honors Node module mode, quoted paths, compound checks, and shell redirection", () => {
    const { vfs } = createContainer();
    vfs.mkdirSync("/src", { recursive: true });
    vfs.writeFileSync("/src/one file.js", "const one = 1;\n");
    vfs.writeFileSync("/src/two.js", "export const two = 2;\n");
    expect(tryBrowserNodeCheck(vfs, "/", "node --check 'src/one file.js' && node -c src/two.js")).toMatchObject({ exitCode: 1 });
    vfs.writeFileSync("/package.json", JSON.stringify({ type: "module" }));
    expect(tryBrowserNodeCheck(vfs, "/", "node --check 'src/one file.js' && node -c src/two.js > /check.log")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(vfs.readFileSync("/check.log", "utf8")).toBe("");
  });
});
