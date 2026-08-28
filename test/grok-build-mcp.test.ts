import { describe, expect, it, vi } from "vitest";
import {
  GrokBuildMcpRegistry,
  createGrokBuildMcpServices,
} from "../experiments/browser-agent/src/grok-build-mcp.js";
import {
  GrokBuildMcpHttpClient,
  McpProtocolError,
} from "../experiments/browser-agent/src/grok-build-mcp-protocol.js";

type WireRequest = {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: Record<string, unknown>;
};

describe("Grok Build browser MCP protocol", () => {
  it("pins the native protocol and supports session IDs, SSE, and tools/list pagination", async () => {
    const requests: Array<{ body: WireRequest; headers: Headers; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as WireRequest;
      const headers = new Headers(init?.headers);
      requests.push({ body, headers, init: init ?? {} });
      if (body.method === "initialize") {
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", capabilities: {}, instructions: "Issue tracking" } }, {
          "Mcp-Session-Id": "session-123",
        });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list" && body.params?.cursor === undefined) {
        return new Response(`event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [{ name: "create_issue", description: "Create an issue", inputSchema: { properties: { title: { type: "string" } }, required: ["title"] } }],
            nextCursor: "page-2",
          },
        })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: [{ name: "get_issue", inputSchema: {} }] },
      });
    }) as unknown as typeof fetch;

    const client = new GrokBuildMcpHttpClient({
      name: "linear",
      url: "https://mcp.example.test/rpc",
      headers: { Authorization: "Bearer user-token", Accept: "text/plain" },
      fetchImpl,
      clientVersion: "1.2.3",
    });
    const initialized = await client.initialize(new AbortController().signal);
    expect(initialized).toEqual({ instructions: "Issue tracking" });
    await expect(client.listTools(new AbortController().signal)).resolves.toHaveLength(2);

    expect(requests[0]?.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {
          extensions: {
            "io.modelcontextprotocol/ui": {
              mimeTypes: ["text/html;profile=mcp-app"],
            },
          },
        },
        clientInfo: { name: "grok-shell-linear", version: "1.2.3" },
      },
    });
    expect(requests[0]?.headers.get("Accept")).toBe("application/json, text/event-stream");
    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer user-token");
    expect(requests[1]?.headers.get("Mcp-Session-Id")).toBe("session-123");
    expect(requests[1]?.headers.get("MCP-Protocol-Version")).toBe("2025-11-25");
    expect(requests[0]?.init).toMatchObject({ credentials: "omit", redirect: "error" });
    expect(requests.at(-1)?.body.params).toEqual({ cursor: "page-2" });
  });

  it("surfaces JSON-RPC errors with their native code", async () => {
    const fetchImpl = rpcFetch(({ id, method }) => method === "initialize"
      ? { jsonrpc: "2.0", id, result: { protocolVersion: "2025-11-25", capabilities: {} } }
      : method === "notifications/initialized"
        ? undefined
        : { jsonrpc: "2.0", id, error: { code: -32602, message: "bad arguments" } });
    const client = new GrokBuildMcpHttpClient({ name: "bad", url: "https://mcp.example.test", fetchImpl });
    await expect(client.listTools(new AbortController().signal)).rejects.toEqual(expect.objectContaining<McpProtocolError>({
      name: "McpProtocolError",
      code: -32602,
      message: "bad arguments",
    }));
  });
});

describe("Grok Build browser MCP registry", () => {
  it("preserves native no-config output", async () => {
    const { services } = createGrokBuildMcpServices([]);
    await expect(services.searchTools("linear", 5, new AbortController().signal)).resolves.toBe(JSON.stringify({
      results: [],
      total_hidden_tools: 0,
      note: "No integration tools are configured. MCP servers are not connected.",
    }, null, 2));
  });

  it("indexes model-visible valid tools, patches object schemas, and formats grouped search results", async () => {
    const fetchImpl = catalogFetch([
      { name: "create_issue", description: "Create a Linear issue", inputSchema: { properties: { title: { type: "string" } }, required: ["title"] } },
      { name: "refresh", description: "Refresh UI", inputSchema: {}, _meta: { ui: { visibility: ["app"] } } },
      { name: "bad__ambiguous", description: "Invalid", inputSchema: {} },
    ]);
    const registry = new GrokBuildMcpRegistry([{ name: "linear", url: "https://mcp.example.test", fetchImpl }]);
    const output = JSON.parse(await registry.searchTools("create_issue", 5, new AbortController().signal)) as Record<string, unknown>;
    expect(output).toMatchObject({ total_hidden_tools: 1, status: "ready", note: null });
    expect(output.results).toEqual([{
      server: "linear",
      tools: [{
        tool_name: "linear__create_issue",
        description: "Create a Linear issue",
        score: 1,
        input_schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      }],
    }]);
    expect(registry.serverSummaries()).toEqual([{
      name: "linear",
      description: "Linear integration server",
      toolCount: 1,
      toolNames: ["create_issue"],
      status: "ready",
    }]);
  });

  it("finds natural-language BM25 matches and does not let one failed server hide healthy tools", async () => {
    const healthy = catalogFetch([
      { name: "create_issue", description: "Create a work item in Linear", inputSchema: { type: "object" } },
      { name: "read_thread", description: "Read replies in a Slack thread", inputSchema: { type: "object" } },
    ]);
    const failed = vi.fn(async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
    const registry = new GrokBuildMcpRegistry([
      { name: "integrations", url: "https://mcp.example.test", fetchImpl: healthy },
      { name: "offline", url: "https://offline.example.test", fetchImpl: failed },
    ]);
    const result = JSON.parse(await registry.searchTools("linear create issue", 1, new AbortController().signal)) as {
      status: string;
      results: Array<{ tools: Array<{ tool_name: string }> }>;
    };
    expect(result.status).toBe("ready");
    expect(result.results[0]?.tools[0]?.tool_name).toBe("integrations__create_issue");
    expect(registry.serverSummaries()[1]).toMatchObject({ name: "offline", status: "failed", error: expect.stringContaining("503") });
  });

  it("dispatches use_tool, preserves MCP content, and emits native corrective errors", async () => {
    const calls: WireRequest[] = [];
    const fetchImpl = catalogFetch([
      { name: "save_issue", description: "Save an issue", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
    ], (request) => {
      calls.push(request);
      return { content: [
        { type: "text", text: "Saved ISSUE-7" },
        { type: "resource", resource: { uri: "linear://ISSUE-7", text: "details" } },
      ] };
    });
    const registry = new GrokBuildMcpRegistry(
      [{ name: "linear", url: "https://mcp.example.test", fetchImpl }],
      { enabledNativeToolNames: new Set(["read_file"]) },
    );
    await expect(registry.useTool("read_file", {}, new AbortController().signal)).rejects.toThrow("native tool, not an MCP integration tool");
    await expect(registry.useTool("jira", {}, new AbortController().signal)).rejects.toThrow("server__tool");
    await expect(registry.useTool("linear__save_issue", { title: "Broken build" }, new AbortController().signal))
      .resolves.toBe('Saved ISSUE-7\n{"type":"resource","resource":{"uri":"linear://ISSUE-7","text":"details"}}');
    expect(calls.at(-1)?.params).toEqual({ name: "save_issue", arguments: { title: "Broken build" } });
  });

  it("turns MCP logical errors into native Failed to call output and bounds large payloads", async () => {
    let logicalError = true;
    const fetchImpl = catalogFetch([{ name: "run", inputSchema: {} }], () => logicalError
      ? { isError: true, content: [{ type: "text", text: "permission denied" }] }
      : { content: [{ type: "text", text: "x".repeat(30) }] });
    const registry = new GrokBuildMcpRegistry([{ name: "ops", url: "https://mcp.example.test", fetchImpl }], { maxOutputBytes: 10 });
    await expect(registry.useTool("ops__run", {}, new AbortController().signal)).rejects.toThrow("Failed to call run: permission denied");
    logicalError = false;
    await expect(registry.useTool("ops__run", {}, new AbortController().signal)).resolves.toBe("xxxxxxxxxx\n\n[MCP output truncated: showing first 10 B of 30 B.]");
  });

  it("rebuilds the HTTP session once for native-retriable MCP errors", async () => {
    let initializeCalls = 0;
    let toolCalls = 0;
    const fetchImpl = rpcFetch((request) => {
      if (request.method === "initialize") {
        initializeCalls += 1;
        return { jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: {} } };
      }
      if (request.method === "notifications/initialized") return undefined;
      if (request.method === "tools/list") return { jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "query", inputSchema: {} }] } };
      toolCalls += 1;
      return toolCalls === 1
        ? { jsonrpc: "2.0", id: request.id, error: { code: -32001, message: "session expired" } }
        : { jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "reconnected" }] } };
    });
    const registry = new GrokBuildMcpRegistry([{ name: "data", url: "https://mcp.example.test", fetchImpl }]);
    await expect(registry.useTool("data__query", {}, new AbortController().signal)).resolves.toBe("reconnected");
    expect({ initializeCalls, toolCalls }).toEqual({ initializeCalls: 2, toolCalls: 2 });
  });
});

function catalogFetch(
  tools: Array<Record<string, unknown>>,
  call?: (request: WireRequest) => Record<string, unknown>,
): typeof fetch {
  return rpcFetch((request) => {
    if (request.method === "initialize") return {
      jsonrpc: "2.0",
      id: request.id,
      result: { protocolVersion: "2025-11-25", capabilities: {}, instructions: "Linear\n integration   server" },
    };
    if (request.method === "notifications/initialized") return undefined;
    if (request.method === "tools/list") return { jsonrpc: "2.0", id: request.id, result: { tools } };
    if (request.method === "tools/call") return { jsonrpc: "2.0", id: request.id, result: call?.(request) ?? { content: [] } };
    throw new Error(`Unexpected method ${request.method}`);
  });
}

function rpcFetch(handler: (request: WireRequest) => Record<string, unknown> | undefined): typeof fetch {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as WireRequest;
    const response = handler(request);
    return response === undefined ? new Response(null, { status: 202 }) : jsonResponse(response);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", ...headers } });
}
