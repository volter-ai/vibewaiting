import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import sourceMap from "./fixtures/grok-conformance/native-source-map-v1.json" with { type: "json" };
import { GROK_BUILD_SYSTEM_PARITY, GROK_BUILD_TOOL_PARITY } from "../experiments/browser-agent/src/grok-build-parity.js";

const repositoryRoot = resolve(import.meta.dirname, "..");

describe("Grok Build native source map", () => {
  it("maps every exposed system and tool parity row exactly once", () => {
    expect(Object.keys(sourceMap.systems).sort()).toEqual(Object.keys(GROK_BUILD_SYSTEM_PARITY).sort());
    expect(Object.keys(sourceMap.tools).sort()).toEqual(Object.keys(GROK_BUILD_TOOL_PARITY).sort());
  });

  it("points every row at browser implementation and executable test evidence", () => {
    for (const [key, row] of [...Object.entries(sourceMap.systems), ...Object.entries(sourceMap.tools)]) {
      expect(row.native.length, `${key} native evidence`).toBeGreaterThan(0);
      expect(row.browser.length, `${key} browser evidence`).toBeGreaterThan(0);
      expect(row.tests.length, `${key} test evidence`).toBeGreaterThan(0);
      for (const path of [...row.browser, ...row.tests]) {
        expect(existsSync(resolve(repositoryRoot, path)), `${key}: ${path}`).toBe(true);
      }
    }
  });

  it("pins a non-placeholder aggregate of the mapped native files", () => {
    expect(sourceMap.sourceFileCount).toBeGreaterThan(100);
    expect(sourceMap.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});
