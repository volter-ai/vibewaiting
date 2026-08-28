import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { GrokBuildMcpRegistry } from "../experiments/browser-agent/src/grok-build-mcp.js";
import { loadGrokBuildRhaiWasmSync } from "../experiments/browser-agent/src/grok-build-rhai-wasm.js";

interface NativeCorpus {
  provenance: { sourceRevision: string; nativeBinary: string };
  nativeObserved: {
    oauthDiscovery: string[];
    requests: Array<Record<string, unknown>>;
    searchTool: Record<string, unknown>;
    useTool: string;
  };
  sourceExpected: {
    accept: string;
    discoveryProtocolVersion: string;
    sessionProtocolVersion: string;
    isolatedSearchTool: Record<string, unknown>;
  };
  versionDrift: { installedAccept: string; pinnedSourceAccept: string };
}

const corpus = JSON.parse(readFileSync(new URL("fixtures/mcp/native-http-corpus.json", import.meta.url), "utf8")) as NativeCorpus;

beforeAll(() => {
  const wasm = readFileSync(new URL("../experiments/browser-agent/src/generated-rhai-wasm/grok_workflow_rhai_wasm_bg.wasm", import.meta.url));
  loadGrokBuildRhaiWasmSync(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
});

describe("recorded native MCP transport corpus", () => {
  it("replays native request IDs, progress tokens, result formatting, and use_tool output without normalization", async () => {
    expect(corpus.provenance.sourceRevision).toBe("9684fa3cdbf2995e30ea8b9b637f1db008f144fc");
    expect(corpus.provenance.nativeBinary).toContain("5115b46bc909");
    const requests: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") return new Response(null, { status: 405 });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ body, headers: new Headers(init?.headers) });
      if (body.method === "initialize") return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "grok-parity-fixture", version: "1.0.0" },
          instructions: "Deterministic native MCP parity fixture",
        },
      });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { tools: fixtureTools() } });
      if (body.method === "tools/call") return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: "fixture:isolated-native-corpus" }] },
      });
      throw new Error(`Unexpected MCP method ${String(body.method)}`);
    }) as unknown as typeof fetch;

    const registry = new GrokBuildMcpRegistry([{
      name: "parity_fixture",
      url: "https://fixture.example.test/",
      clientVersion: "1.0.5",
      fetchImpl,
      enableEventStream: false,
    }]);
    const signal = new AbortController().signal;
    const search = await registry.searchTools("fixture echo", 5, signal);
    const output = await registry.useTool("parity_fixture__fixture_echo", { message: "isolated-native-corpus" }, signal);

    expect(requests.map(({ body }) => body)).toEqual(corpus.nativeObserved.requests);
    expect(requests.map(({ headers }) => headers.get("Accept"))).toEqual(Array(4).fill(corpus.sourceExpected.accept));
    expect(requests.map(({ headers }) => headers.get("MCP-Protocol-Version"))).toEqual([
      null,
      corpus.sourceExpected.sessionProtocolVersion,
      corpus.sourceExpected.sessionProtocolVersion,
      corpus.sourceExpected.sessionProtocolVersion,
    ]);
    expect(requests.every(({ headers }) => headers.get("Content-Type") === "application/json")).toBe(true);
    expect(search).toBe(JSON.stringify(corpus.sourceExpected.isolatedSearchTool, null, 2));
    expect(output).toBe(corpus.nativeObserved.useTool);

    // The live binary capture proves the same field/group ordering. Its score
    // corpus also contained 24 built-in Playwright tools, so those stable BM25
    // values are retained verbatim instead of being compared to an isolated corpus.
    expect(Object.keys(corpus.nativeObserved.searchTool)).toEqual(["results", "total_hidden_tools", "status", "note"]);
    expect(corpus.versionDrift.pinnedSourceAccept).toBe(corpus.sourceExpected.accept);
    expect(corpus.versionDrift.installedAccept).not.toBe(corpus.sourceExpected.accept);
  });

  it("matches the native no-OAuth discovery sequence once and does not use the inconclusive anonymous probe", async () => {
    const gets: string[] = [];
    let anonymousProbe = false;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method !== "POST") {
        gets.push(url.pathname);
        expect(new Headers(init?.headers).get("MCP-Protocol-Version")).toBe(corpus.sourceExpected.discoveryProtocolVersion);
        return new Response(null, { status: 405 });
      }
      if (String(init.body) === "{}") {
        anonymousProbe = true;
        return new Response(null, { status: 400 });
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (body.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", capabilities: {} } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
      throw new Error(`Unexpected request ${JSON.stringify(body)}`);
    }) as unknown as typeof fetch;
    const registry = new GrokBuildMcpRegistry([{
      name: "no_oauth",
      url: "https://fixture.example.test/",
      fetchImpl,
      enableEventStream: false,
      oauth: {
        interactive: false,
        credentialStore: { load: async () => undefined, save: async () => undefined, clear: async () => undefined },
      },
    }]);

    await registry.connectAll(new AbortController().signal);
    expect(gets).toEqual(corpus.nativeObserved.oauthDiscovery);
    expect(anonymousProbe).toBe(false);
  });
});

function fixtureTools(): Array<Record<string, unknown>> {
  return [
    {
      name: "fixture_echo",
      description: "Echo a deterministic message for browser parity verification",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string", description: "Message to echo" } },
        required: ["message"],
      },
    },
    {
      name: "fixture_sum",
      description: "Add two integers for deterministic verification",
      inputSchema: {
        type: "object",
        properties: { a: { type: "integer" }, b: { type: "integer" } },
        required: ["a", "b"],
      },
    },
  ];
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}
