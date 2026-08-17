import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../src/projection.js";
import {
  activeWorkContext,
  compactToolTarget,
  conversationBlocks,
  toolCategory,
  toolGroupSummary,
  toolLabel,
  toolTarget,
} from "../widget/presentation.js";

function entry(over: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return { id: "e", role: "tool", text: "", ts: null, truncated: false, ...over };
}

describe("VGAI-compatible tool presentation", () => {
  it("classifies tools by what they do, including test commands", () => {
    expect(toolCategory(entry({ label: "read_file" }))).toBe("read");
    expect(toolCategory(entry({ label: "exec", arguments: '{"cmd":"npm test"}' }))).toBe("test");
    expect(toolCategory(entry({ label: "apply_patch" }))).toBe("edit");
    expect(toolCategory(entry({ label: "web__run" }))).toBe("web");
  });

  it("extracts and compacts useful file, command, query, and URL targets", () => {
    expect(toolTarget('{"path":"/repo/src/app.ts"}')).toBe("/repo/src/app.ts");
    expect(toolTarget('{"cmd":"npm test"}')).toBe("npm test");
    expect(compactToolTarget("/repo/src/app.ts", "/repo")).toBe("src/app.ts");
  });

  it("humanizes names while preserving the provider-neutral suffix", () => {
    expect(toolLabel("mcp__filesystem__read_file")).toBe("Read File");
    expect(toolLabel("run_terminal_command")).toBe("Run Terminal Command");
  });

  it("groups only consecutive tools and summarizes the activity", () => {
    const entries = [
      entry({ id: "t1", label: "read_file" }),
      entry({ id: "t2", label: "grep" }),
      entry({ id: "m1", role: "assistant", text: "found it" }),
      entry({ id: "t3", label: "apply_patch" }),
    ];
    const blocks = conversationBlocks(entries);
    expect(blocks.map((block) => block.kind)).toEqual(["tool-group", "entry", "tool-group"]);
    expect(blocks[0]?.kind === "tool-group" && toolGroupSummary(blocks[0].tools)).toBe("Explored 2 items");
    expect(blocks[2]?.kind === "tool-group" && toolGroupSummary(blocks[2].tools)).toBe("Activity · 1 changed");
  });

  it("finds the newest typed work-item context without parsing prose", () => {
    const work = activeWorkContext([
      entry({
        id: "m1",
        role: "user",
        context: [{ kind: "work-item", label: "Older", detail: "one" }],
      }),
      entry({
        id: "m2",
        role: "assistant",
        context: [{ kind: "work-item", label: "Markdown parity", detail: "two" }],
      }),
    ]);
    expect(work?.label).toBe("Markdown parity");
  });
});

