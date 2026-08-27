import { describe, expect, it } from "vitest";
import {
  extractGrokCompactionKeywords,
  renderGrokCompactionIndexRow,
  renderGrokCompactionSegment,
} from "../experiments/browser-agent/src/grok-build-compaction-store.js";

const SUMMARY = `Summary:
8. Current Work: Implementing Pong gameplay and browser controls.
9. Next Step: Test gameplay.`;

describe("native Grok Build compaction segment persistence", () => {
  it("renders the native verbose segment and index formats exactly", () => {
    const markdown = renderGrokCompactionSegment({
      index: 0,
      timestamp: "2026-08-27T19:16:29Z",
      summary: SUMMARY,
      items: [
        { type: "message", role: "system", content: "System" },
        { type: "message", role: "user", content: "Build Pong" },
        {
          type: "function_call",
          call_id: "a",
          name: "read_file",
          arguments: JSON.stringify({ target_file: "src/game.ts", offset: 1 }),
        },
        { type: "function_call_output", call_id: "a", output: "const game = true;" },
      ],
    });

    expect(markdown).toBe(`# HISTORICAL -- DO NOT EDIT
# Record of compaction segment 000 (detail=verbose) from this same task.
# Use read_file or grep to look up details, but do not modify.

## Segment metadata
- Index: 000
- Turn count: 4
- Timestamp: 2026-08-27T19:16:29Z

## Turn statistics

- Turns: 4 (Assistant=1, Function=1, Human=1, System=1)
- Tools used: read_file (1)
- Unique target files (1): src/game.ts
- Tool errors: 0
- Verbose-render size estimate: 383 B


## Summary (curated by compaction step)

Summary:
8. Current Work: Implementing Pong gameplay and browser controls.
9. Next Step: Test gameplay.

## Verbatim turns

### Turn 0 (System)
System

### Turn 1 (Human)
Build Pong

### Turn 2 (Assistant)
[tool_request: read_file]
- target_file: src/game.ts
- offset: 1

### Turn 3 (Function)
[tool_response]
const game = true;
`);
    expect(new TextEncoder().encode(markdown)).toHaveLength(819);
    const keywords = extractGrokCompactionKeywords(SUMMARY);
    expect(keywords).toEqual(["Implementing", "Pong", "gameplay", "browser", "controls"]);
    expect(renderGrokCompactionIndexRow(0, 4, 819, keywords)).toBe(
      '| 000 | segment_000.md | 4 | 819 | "Implementing", "Pong", "gameplay", "browser", "controls" |\n',
    );
  });
});
