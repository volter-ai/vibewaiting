import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createGrokBuildManagedMcpConfigs, gatewayResultToText, grokBuildManagedGatewayEnabled, parseGrokBuildGatewayToolCatalog } from "../experiments/browser-agent/src/grok-build-managed-mcp.js";
import { createGrokBuildMcpServices } from "../experiments/browser-agent/src/grok-build-mcp.js";
import { loadGrokBuildRhaiWasmSync } from "../experiments/browser-agent/src/grok-build-rhai-wasm.js";

beforeAll(() => {
  const wasm = readFileSync(new URL("../experiments/browser-agent/src/generated-rhai-wasm/grok_workflow_rhai_wasm_bg.wasm", import.meta.url));
  loadGrokBuildRhaiWasmSync(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
});

const wireCatalog = {
  tools: [{
    connector_id: "gmail",
    connector_name: "Gmail",
    tool_id: "search",
    tool_name: "Search Gmail",
    call_id: "gmail.search",
    description: "Search email by query",
    json_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  }],
  total_tools: 1,
  connectors_needing_reauth: ["Slack"],
};

describe("Grok Build managed MCP gateway source port", () => {
  it("strictly parses the native catalog and remote feature gates", () => {
    expect(parseGrokBuildGatewayToolCatalog(wireCatalog)).toMatchObject({
      totalTools: 1,
      connectorsNeedingReauth: ["Slack"],
      tools: [{ connectorId: "gmail", toolId: "search", callId: "gmail.search" }],
    });
    expect(parseGrokBuildGatewayToolCatalog({})).toEqual({ tools: [], totalTools: 0, connectorsNeedingReauth: [] });
    expect(() => parseGrokBuildGatewayToolCatalog({ tools: [{ connector_id: "bad" }] })).toThrow("connector_name");
    expect(grokBuildManagedGatewayEnabled({ managed_mcp_gateway_tools_enabled: true })).toBe(true);
    expect(grokBuildManagedGatewayEnabled({ managed_mcps_enabled: false, managed_mcp_gateway_tools_enabled: true })).toBe(false);
    expect(grokBuildManagedGatewayEnabled({})).toBe(false);
  });

  it("indexes stable connector/tool IDs and dispatches the opaque xAI call ID", async () => {
    const calls: Array<{ url: string; init?: RequestInit; body: unknown }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), ...(init ? { init } : {}), body: JSON.parse(String(init?.body)) as unknown });
      return Response.json({
        result: { content: [
          { type: "text", text: "mail found" },
          { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
          { type: "resource", resource: { uri: "file:///mail" } },
        ] },
        connectors_needing_reauth: [],
      });
    }) as unknown as typeof fetch;
    const configs = createGrokBuildManagedMcpConfigs(parseGrokBuildGatewayToolCatalog(wireCatalog), { fetch: fetchImpl });
    const { registry, services } = createGrokBuildMcpServices(configs);
    const signal = new AbortController().signal;

    await expect(services.searchTools("email", 5, signal)).resolves.toContain("gmail__search");
    await expect(services.useTool("gmail__search", { query: "from:xai" }, signal)).resolves.toBe(
      'mail found\ndata:image/png;base64,aGVsbG8=\n{"type":"resource","resource":{"uri":"file:///mail"}}',
    );
    expect(calls).toEqual([expect.objectContaining({
      url: "/api/grok/mcp/tools/call",
      body: { call_id: "gmail.search", arguments: { query: "from:xai" } },
    })]);
    expect(new Headers(calls[0]?.init?.headers).get("x-browser-agent-client-mode")).toBe("interactive");
    expect(registry.serverSummaries()).toEqual([expect.objectContaining({ name: "gmail", description: "Gmail", toolNames: ["search"] })]);
  });

  it("preserves gateway logical failures and arbitrary JSON fallback text", async () => {
    expect(gatewayResultToText({ answer: 42 })).toBe('{\n  "answer": 42\n}');
    const configs = createGrokBuildManagedMcpConfigs(parseGrokBuildGatewayToolCatalog(wireCatalog), {
      fetch: vi.fn(async () => Response.json({
        result: { isError: true, content: [{ type: "text", text: "reauthorize Gmail" }] },
        connectors_needing_reauth: ["gmail"],
      })) as unknown as typeof fetch,
    });
    const { services } = createGrokBuildMcpServices(configs);
    await expect(services.useTool("gmail__search", {}, new AbortController().signal))
      .rejects.toThrow("Failed to call search: reauthorize Gmail");
  });
});
