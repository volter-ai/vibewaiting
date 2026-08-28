import { VirtualFS } from "almostnode";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autosaveBrowserProject,
  clearVirtualFileSystem,
  restoreBrowserProject,
  validateBrowserProject,
} from "../experiments/browser-agent/src/browser-project-store.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

  it("validates the complete snapshot before replacing the live filesystem", () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync("/keep.txt", "still here");
    const invalid = {
      files: [
        { path: "/", type: "directory" },
        { path: "/../escape.txt", type: "file", content: btoa("bad") },
      ],
    };

    expect(() => restoreBrowserProject(vfs, invalid as never)).toThrow(/invalid or duplicate/u);
    expect(vfs.readFileSync("/keep.txt", "utf8")).toBe("still here");
    expect(() => validateBrowserProject({
      files: [
        { path: "/same", type: "file", content: "" },
        { path: "/same", type: "file", content: "" },
      ],
    })).toThrow(/invalid or duplicate/u);
    expect(() => validateBrowserProject({ files: [{ path: "/bad", type: "file", content: "%%%" }] }))
      .toThrow(/invalid file data/u);
  });

  it("flushes pending changes and drains a newer edit made during an in-flight save", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    const vfs = new VirtualFS();
    let calls = 0;
    let releaseFirst!: () => void;
    const firstSave = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const autosave = autosaveBrowserProject(vfs, vi.fn(), async () => {
      calls += 1;
      if (calls === 1) await firstSave;
    });

    vfs.writeFileSync("/first.txt", "first");
    const flushing = autosave.flush();
    expect(calls).toBe(1);
    vfs.writeFileSync("/second.txt", "second");
    releaseFirst();
    await flushing;
    expect(calls).toBe(2);
    expect(vi.getTimerCount()).toBe(0);

    await autosave.dispose();
    vfs.writeFileSync("/after-dispose.txt", "ignored");
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(2);
  });
});
