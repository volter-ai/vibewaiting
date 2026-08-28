import { describe, expect, it, vi } from "vitest";
import {
  GrokBuildMcpRegistry,
  type GrokBuildMcpTraceSink,
} from "../experiments/browser-agent/src/grok-build-mcp.js";
import type { McpOAuthCredentials } from "../experiments/browser-agent/src/grok-build-mcp-oauth.js";
import {
  createGrokBuildMcpOtlpTraceSink,
  GrokBuildBrowserOtlpTracer,
} from "../experiments/browser-agent/src/grok-build-otlp-trace.js";

type Request = { id?: number | string; method?: string };

describe("Grok Build MCP runtime OTLP wiring", () => {
  it("reports connection and reconnect tool-call metadata through an optional sink", async () => {
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
        : { jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "ok" }] } };
    });
    const connectionEvents: Array<Parameters<GrokBuildMcpTraceSink["recordConnection"]>[0]> = [];
    const toolEvents: Array<Record<string, unknown>> = [];
    const sink: GrokBuildMcpTraceSink = {
      recordConnection: (event) => { connectionEvents.push(event); },
      startToolCall: (event) => {
        toolEvents.push({ ...event });
        return { end: (outcome) => { toolEvents.push({ ...outcome }); } };
      },
    };
    const times = [0, 17, 20, 39];
    const registry = new GrokBuildMcpRegistry([{
      name: "data",
      url: "https://mcp.example.test",
      fetchImpl,
      serverScope: "project",
    }], { traceSink: sink, now: () => times.shift() ?? 39 });

    await expect(registry.useTool("data__query", {}, new AbortController().signal)).resolves.toBe("ok");
    expect(connectionEvents).toEqual([
      {
        status: "connected", serverName: "data", transportType: "http",
        serverScope: "project", durationMs: 17, toolCount: 1,
      },
      {
        status: "connected", serverName: "data", transportType: "http",
        serverScope: "project", durationMs: 19, toolCount: 1,
      },
    ]);
    expect(toolEvents).toEqual([
      { serverName: "data", toolName: "query" },
      { reconnectAttempted: true, authRetryAttempted: false },
    ]);
    expect({ initializeCalls, toolCalls }).toEqual({ initializeCalls: 2, toolCalls: 2 });
  });

  it("tracks an OAuth retry handled inside the HTTP client without mislabeling it as reconnect", async () => {
    let stored: McpOAuthCredentials = {
      clientId: "service-client",
      accessToken: "bad-token",
      grantedScopes: [],
      redirectUri: "",
      metadata: {
        authorizationEndpoint: "https://auth.example.test/authorize",
        tokenEndpoint: "https://auth.example.test/token",
      },
    };
    let firstToolAttempt = true;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://auth.example.test/token") {
        return jsonResponse({ access_token: "good-token", expires_in: 3600 });
      }
      const request = JSON.parse(String(init?.body)) as Request;
      if (request.method === "tools/call" && firstToolAttempt) {
        firstToolAttempt = false;
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer bad-token");
        return new Response("expired", { status: 401 });
      }
      if (request.method === "tools/call") {
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer good-token");
        return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "authorized" }] } });
      }
      if (request.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: {} } });
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "secure", inputSchema: {} }] } });
    }) as unknown as typeof fetch;
    const outcomes: Array<{ reconnectAttempted: boolean; authRetryAttempted: boolean }> = [];
    const registry = new GrokBuildMcpRegistry([{
      name: "secure",
      url: "https://mcp.example.test",
      fetchImpl,
      oauth: {
        credentialStore: {
          load: async () => stored,
          save: async (_key, credentials) => { stored = credentials; },
          clear: async () => undefined,
        },
        clientCredentials: { clientId: "service-client", clientSecret: "secret" },
        resolveAuthorizationHostname: async () => ["8.8.8.8"],
      },
    }], { traceSink: {
      recordConnection: () => undefined,
      startToolCall: () => ({ end: (outcome) => { outcomes.push(outcome); } }),
    } });
    await expect(registry.useTool("secure__secure", {}, new AbortController().signal)).resolves.toBe("authorized");
    expect(outcomes).toEqual([{ reconnectAttempted: false, authRetryAttempted: true }]);
  });

  it("classifies failed handshakes and isolates sink failures from MCP behavior", async () => {
    const events: Array<Parameters<GrokBuildMcpTraceSink["recordConnection"]>[0]> = [];
    const failed = new GrokBuildMcpRegistry([{
      name: "offline",
      url: "https://offline.example.test",
      fetchImpl: vi.fn(async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch,
    }], { traceSink: {
      recordConnection: (event) => { events.push(event); },
      startToolCall: () => undefined,
    }, now: (() => { let time = 10; return () => time += 5; })() });
    await failed.connectAll(new AbortController().signal);
    expect(events).toEqual([{
      status: "failed", serverName: "offline", transportType: "http", serverScope: "unknown",
      durationMs: 5, errorType: "handshake_failed",
    }]);

    const healthy = new GrokBuildMcpRegistry([{
      name: "safe",
      url: "https://mcp.example.test",
      fetchImpl: rpcFetch((request) => request.method === "initialize"
        ? { jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: {} } }
        : request.method === "tools/list"
          ? { jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "run", inputSchema: {} }] } }
          : request.method === "tools/call"
            ? { jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "still works" }] } }
            : undefined),
    }], { traceSink: {
      recordConnection: () => { throw new Error("sink failure"); },
      startToolCall: () => { throw new Error("sink failure"); },
    } });
    await expect(healthy.useTool("safe__run", {}, new AbortController().signal)).resolves.toBe("still works");
  });

  it("adapts runtime sink events into drainable OTLP spans only when explicitly injected", () => {
    let now = 1n;
    let seed = 1;
    const tracer = new GrokBuildBrowserOtlpTracer({
      nowUnixNano: () => now++,
      randomBytes: (length) => Uint8Array.from({ length }, () => seed++ & 0xff),
    });
    const sink = createGrokBuildMcpOtlpTraceSink(tracer);
    sink.recordConnection({
      status: "connected", serverName: "linear", transportType: "http", serverScope: "user",
      durationMs: 12, toolCount: 3,
    });
    const call = sink.startToolCall({ serverName: "linear", toolName: "save_issue" });
    call?.end({ reconnectAttempted: false, authRetryAttempted: true });
    expect(tracer.drain().map(({ name, attributes }) => ({ name, attributes }))).toEqual([
      {
        name: "mcp.server_connection",
        attributes: [
          { key: "status", value: "connected" }, { key: "server_name", value: "linear" },
          { key: "transport_type", value: "http" }, { key: "server_scope", value: "user" },
          { key: "duration_ms", value: 12 }, { key: "tool_count", value: 3 },
        ],
      },
      {
        name: "mcp.tool_call",
        attributes: [
          { key: "server_name", value: "linear" }, { key: "tool_name", value: "save_issue" },
          { key: "reconnect", value: false }, { key: "auth_retry", value: true },
        ],
      },
    ]);
  });
});

function rpcFetch(handler: (request: Request) => Record<string, unknown> | undefined): typeof fetch {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as Request;
    const response = handler(request);
    return response === undefined ? new Response(null, { status: 202 }) : jsonResponse(response);
  }) as unknown as typeof fetch;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}
