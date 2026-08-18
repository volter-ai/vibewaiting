import { describe, expect, it } from "vitest";
import { readPersistedMessengerState } from "../src/persistence.js";

describe("readPersistedMessengerState", () => {
  it("sanitizes local state and bounds draft and preview text", () => {
    const state = readPersistedMessengerState({
      attention: [
        { key: "one", kind: "finished", preview: "x".repeat(500) },
        { key: 2, kind: "failed" },
        { key: "three", kind: "invented" },
      ],
      drafts: { one: "y".repeat(60_000), bad: 42, empty: "" },
    });
    expect(state.attention).toEqual([{ key: "one", kind: "finished", preview: "x".repeat(240) }]);
    expect(state.drafts["one"]).toHaveLength(50_000);
    expect(state.drafts).not.toHaveProperty("bad");
    expect(state.drafts).not.toHaveProperty("empty");
  });

  it("falls back to empty state for malformed input", () => {
    expect(readPersistedMessengerState(null)).toEqual({ attention: [], drafts: {} });
    expect(readPersistedMessengerState([])).toEqual({ attention: [], drafts: {} });
  });
});
