import { describe, expect, it } from "vitest";
import { safeArtifactPath } from "../src/artifacts.js";

describe("safeArtifactPath", () => {
  it("keeps a relative artifact hierarchy", () => {
    expect(safeArtifactPath("subagents/worker.jsonl")).toBe("subagents/worker.jsonl");
    expect(safeArtifactPath("./session.jsonl")).toBe("session.jsonl");
  });

  it("rejects traversal and empty targets", () => {
    expect(() => safeArtifactPath("../outside.jsonl")).toThrow("unsafe artifact path");
    expect(() => safeArtifactPath("sub/../../outside.jsonl")).toThrow("unsafe artifact path");
    expect(() => safeArtifactPath("/")).toThrow("unsafe artifact path");
  });
});
