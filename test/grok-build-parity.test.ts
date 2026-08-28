import { describe, expect, it } from "vitest";
import { GROK_BUILD_TOOLS } from "../experiments/browser-agent/src/grok-build-agent.js";
import {
  GROK_BUILD_SYSTEM_PARITY,
  GROK_BUILD_TOOL_PARITY,
  incompleteGrokParity,
  incompleteGrokSystemParity,
  unprovenExactGrokParity,
  unprovenExactGrokSystemParity,
} from "../experiments/browser-agent/src/grok-build-parity.js";

describe("Grok Build parity ledger", () => {
  it("accounts for every native registry entry with no invented tools", () => {
    const native = GROK_BUILD_TOOLS.map((tool) => tool.type === "function" ? tool.name : tool.type).sort();
    expect(Object.keys(GROK_BUILD_TOOL_PARITY).sort()).toEqual(native);
    expect(native).toHaveLength(27);
  });

  it("has no unfinished browser-representable tool implementation", () => {
    expect(incompleteGrokParity()).toEqual([]);
  });

  it("has no unfinished browser-representable system implementation", () => {
    expect(incompleteGrokSystemParity()).toEqual([]);
  });

  it("keeps traffic-exact proof boundaries public without calling them missing code", () => {
    expect(GROK_BUILD_SYSTEM_PARITY.startup_models.level).toBe("source-ported");
    expect(GROK_BUILD_SYSTEM_PARITY.published_bundle_cache.level).toBe("source-ported");
    expect(unprovenExactGrokParity().length).toBeGreaterThan(0);
    expect(unprovenExactGrokSystemParity()).toEqual(expect.arrayContaining([
      expect.objectContaining({ subsystem: "bundled_workflows" }),
      expect.objectContaining({ subsystem: "telemetry_and_feedback" }),
    ]));
  });
});
