import { describe, expect, it } from "vitest";
import {
  composeGrokBuildMcpCatalog,
  filterGrokBuildInheritedMcpPool,
  parseGrokBuildAcpMcpServer,
  parseGrokBuildAgentMcpServerRef,
  parseGrokBuildMcpInheritance,
  resolveGrokBuildAgentMcp,
  type GrokBuildAcpMcpServer,
} from "../experiments/browser-agent/src/grok-build-agent-mcp.js";

const http = (name: string, url = `https://${name}.example/mcp`): GrokBuildAcpMcpServer => ({
  type: "http",
  name,
  url,
  headers: [],
});

describe("Grok Build custom-agent MCP source port", () => {
  it("parses native refs, including the one-key ambiguity, and rejects malformed refs", () => {
    expect(parseGrokBuildAgentMcpServerRef("slack")).toEqual({ kind: "named", name: "slack" });
    expect(parseGrokBuildAgentMcpServerRef({ slack: { type: "http", url: "https://x", headers: [] } })).toEqual({
      kind: "inline",
      name: "slack",
      config: { type: "http", url: "https://x", headers: [] },
    });
    expect(parseGrokBuildAgentMcpServerRef({ name: "flat", type: "http", url: "https://x", headers: [] })).toEqual({
      kind: "inline",
      name: "flat",
      config: { name: "flat", type: "http", url: "https://x", headers: [] },
    });
    // Native checks the one-key map arm first, so this is not a flat named ref.
    expect(() => parseGrokBuildAgentMcpServerRef({ name: "only" })).toThrow(
      "inline config for 'name' must be an object",
    );
    expect(() => parseGrokBuildAgentMcpServerRef({ type: "stdio" })).toThrow(
      "inline config for 'type' must be an object",
    );
    expect(() => parseGrokBuildAgentMcpServerRef(42)).toThrow("string or object");
  });

  it("parses inheritance exactly: case-insensitive scalar and strict single-key maps", () => {
    expect(parseGrokBuildMcpInheritance(undefined)).toBe("all");
    expect(parseGrokBuildMcpInheritance("ALL")).toBe("all");
    expect(parseGrokBuildMcpInheritance("NoNe")).toBe("none");
    expect(parseGrokBuildMcpInheritance({ named: ["slack", "github"] })).toEqual({ named: ["slack", "github"] });
    expect(parseGrokBuildMcpInheritance({ except: [] })).toEqual({ except: [] });
    expect(() => parseGrokBuildMcpInheritance({})).toThrow("exactly one key");
    expect(() => parseGrokBuildMcpInheritance({ named: [], except: [] })).toThrow("exactly one key");
    expect(() => parseGrokBuildMcpInheritance({ Named: [] })).toThrow("unknown mcpInheritance variant");
    expect(() => parseGrokBuildMcpInheritance({ named: [1] })).toThrow("array of strings");
  });

  it("parses ACP 0.10.4 HTTP/SSE and untagged stdio wire shapes strictly", () => {
    expect(parseGrokBuildAcpMcpServer({
      type: "http",
      name: "remote",
      url: "https://mcp.example",
      headers: [{ name: "Authorization", value: "Bearer x" }],
      _meta: { vendor: true },
    })).toEqual({
      type: "http",
      name: "remote",
      url: "https://mcp.example",
      headers: [{ name: "Authorization", value: "Bearer x" }],
      _meta: { vendor: true },
    });
    expect(parseGrokBuildAcpMcpServer({
      name: "local",
      command: "/usr/bin/server",
      args: ["--port", "3000"],
      env: [{ name: "MODE", value: "test" }],
    })).toEqual({
      type: "stdio",
      name: "local",
      command: "/usr/bin/server",
      args: ["--port", "3000"],
      env: [{ name: "MODE", value: "test" }],
    });
    expect(parseGrokBuildAcpMcpServer({ type: "http", name: "x", url: "https://x" })).toBeUndefined();
    expect(parseGrokBuildAcpMcpServer({ name: "x", command: "run", args: [], env: {} })).toBeUndefined();
  });

  it("resolves named snapshots and inline configs in declaration order, forcing the ref name", () => {
    const parentConfigs = [
      { ...http("shared"), _meta: { nested: { preserved: true } } },
      http("later"),
    ];
    const result = resolveGrokBuildAgentMcp({
      definition: {
        mcpServers: [
          "shared",
          { inline: { type: "http", name: "ignored", url: "https://inline.example", headers: [] } },
          "missing",
          { bad: { type: "http", url: "https://bad.example" } },
        ],
      },
      parentConfigs,
    });
    expect(result.owned).toEqual([
      { ...http("shared"), _meta: { nested: { preserved: true } } },
      { type: "http", name: "inline", url: "https://inline.example", headers: [] },
    ]);
    expect(result.skipped).toEqual([
      { name: "missing", reason: "named-not-found" },
      { name: "bad", reason: "invalid-inline" },
    ]);
    const firstParent = parentConfigs[0];
    if (firstParent?.type !== "http") throw new Error("test fixture must be HTTP");
    firstParent.url = "https://mutated.example";
    const parentNested = (firstParent._meta?.nested as { preserved: boolean });
    parentNested.preserved = false;
    expect(result.owned[0]).toEqual({ ...http("shared"), _meta: { nested: { preserved: true } } });
  });

  it("blocks owned plugin and untrusted-project declarations without blocking inheritance", () => {
    const parentPool = [http("parent")];
    expect(resolveGrokBuildAgentMcp({
      definition: { pluginName: "vendor", mcpServers: ["parent"] },
      parentConfigs: parentPool,
      parentPool,
    })).toEqual({
      owned: [],
      inherited: parentPool,
      skipped: [{ name: "parent", reason: "plugin-owned" }],
    });
    expect(resolveGrokBuildAgentMcp({
      definition: { scope: "project", mcpServers: ["parent"], mcpInheritance: "none" },
      parentConfigs: parentPool,
      parentPool,
      projectTrusted: false,
    })).toEqual({
      owned: [],
      inherited: undefined,
      skipped: [{ name: "parent", reason: "untrusted-project" }],
    });
  });

  it("preserves native None versus present-empty inheritance semantics", () => {
    const pool = [http("a"), http("b"), http("c")];
    expect(filterGrokBuildInheritedMcpPool(pool, "all")?.map(({ name }) => name)).toEqual(["a", "b", "c"]);
    expect(filterGrokBuildInheritedMcpPool(pool, "none")).toBeUndefined();
    expect(filterGrokBuildInheritedMcpPool(pool, { named: [] })).toEqual([]);
    expect(filterGrokBuildInheritedMcpPool(pool, { named: ["b", "absent"] })?.map(({ name }) => name)).toEqual(["b"]);
    expect(filterGrokBuildInheritedMcpPool(pool, { except: [] })?.map(({ name }) => name)).toEqual(["a", "b", "c"]);
    expect(filterGrokBuildInheritedMcpPool(pool, { except: ["b", "absent"] })?.map(({ name }) => name)).toEqual(["a", "c"]);
    expect(filterGrokBuildInheritedMcpPool(undefined, "all")).toBeUndefined();
  });

  it("composes owned-first catalogs and suppresses inherited collisions", () => {
    const catalog = composeGrokBuildMcpCatalog(
      [{ name: "owned", tools: ["one"] }, { name: "same", tools: ["owned"] }],
      [{ name: "same", tools: ["parent"] }, { name: "shared", tools: ["two"] }],
    );
    expect(catalog).toEqual([
      { name: "owned", tools: ["one"] },
      { name: "same", tools: ["owned"] },
      { name: "shared", tools: ["two"] },
    ]);
    expect(composeGrokBuildMcpCatalog(
      [],
      [{ name: "failed-owned", tools: ["parent-must-not-leak"] }, { name: "shared", tools: ["ok"] }],
      ["failed-owned"],
    )).toEqual([{ name: "shared", tools: ["ok"] }]);
  });
});
