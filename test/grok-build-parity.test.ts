import { describe, expect, it } from "vitest";
import { GROK_BUILD_TOOLS } from "../experiments/browser-agent/src/grok-build-agent.js";
import {
  GROK_BUILD_SYSTEM_PARITY,
  GROK_BUILD_TOOL_PARITY,
  incompleteGrokParity,
  incompleteGrokSystemParity,
} from "../experiments/browser-agent/src/grok-build-parity.js";

describe("Grok Build parity ledger", () => {
  it("accounts for every native registry entry with no invented tools", () => {
    const native = GROK_BUILD_TOOLS.map((tool) => tool.type === "function" ? tool.name : tool.type).sort();
    expect(Object.keys(GROK_BUILD_TOOL_PARITY).sort()).toEqual(native);
    expect(native).toHaveLength(27);
  });

  it("keeps unfinished parity visible to the release gate", () => {
    const gaps = incompleteGrokParity();
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.every(({ tool, gap }) => tool.length > 0 && gap.length > 0)).toBe(true);
  });

  it("keeps agent-wide startup and service gaps public", () => {
    expect(GROK_BUILD_SYSTEM_PARITY.startup_models.level).toBe("source-ported");
    expect(GROK_BUILD_SYSTEM_PARITY.published_bundle_cache.level).toBe("source-ported");
    expect(incompleteGrokSystemParity()).toEqual(expect.arrayContaining([
      expect.objectContaining({ subsystem: "bundled_workflows" }),
      expect.objectContaining({ subsystem: "telemetry_and_feedback" }),
    ]));
  });
});
