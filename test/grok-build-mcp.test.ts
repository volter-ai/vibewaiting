import { describe, expect, it, vi } from "vitest";
import {
  GrokBuildMcpRegistry,
  createGrokBuildMcpServices,
} from "../experiments/browser-agent/src/grok-build-mcp.js";
import {
  GrokBuildMcpHttpClient,
  McpProtocolError,
} from "../experiments/browser-agent/src/grok-build-mcp-protocol.js";
import {
  MAX_ELICIT_MESSAGE_CHARS,
  McpSseDecoder,
  validateElicitationRequest,
} from "../experiments/browser-agent/src/grok-build-mcp-events.js";
import type { McpOAuthCredentials } from "../experiments/browser-agent/src/grok-build-mcp-oauth.js";
import { searchMcpDocuments } from "../experiments/browser-agent/src/grok-build-mcp-search.js";

type WireRequest = {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
};

describe("Grok Build browser MCP protocol", () => {
  it("pins the native protocol and supports session IDs, SSE, and tools/list pagination", async () => {
    const requests: Array<{ body: WireRequest; headers: Headers; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") return new Response(null, { status: 405 });
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
      enableEventStream: false,
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

  it("incrementally decodes SSE control fields and resumes a long-lived session with Last-Event-ID", async () => {
    const decoder = new McpSseDecoder();
    expect(decoder.push("id: evt-1\r\nretry: 7\r\ndata: {\"jsonrpc\":\r\n", false)).toEqual([]);
    expect(decoder.push("data: \"2.0\"}\r\n\r\n", false)).toEqual([{
      id: "evt-1",
      retry: 7,
      data: "{\"jsonrpc\":\n\"2.0\"}",
    }]);
    expect(decoder.push("data: split-crlf\r", false)).toEqual([]);
    expect(decoder.push("\n\r\n", false)).toEqual([{ data: "split-crlf" }]);

    const notifications: string[] = [];
    const getHeaders: Headers[] = [];
    let getCalls = 0;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 405 });
      if (init?.method === "GET") {
        getHeaders.push(new Headers(init.headers));
        getCalls += 1;
        if (getCalls === 1) return new Response("id: evt-9\nretry: 1\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\",\"params\":{}}\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        });
        return new Response(null, { status: 405 });
      }
      const request = JSON.parse(String(init?.body)) as WireRequest;
      if (request.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: {} } }, { "Mcp-Session-Id": "resume-me" });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const client = new GrokBuildMcpHttpClient({
      name: "events",
      url: "https://mcp.example.test",
      fetchImpl,
      events: { onNotification: (method) => { notifications.push(method); } },
    });
    await client.initialize(new AbortController().signal);
    await vi.waitFor(() => expect(getCalls).toBe(2));
    expect(notifications).toEqual(["notifications/tools/list_changed"]);
    expect(getHeaders[1]?.get("Last-Event-ID")).toBe("evt-9");
    await client.close(new AbortController().signal);
  });

  it("advertises elicitation and answers server elicitation/create requests carried before an SSE response", async () => {
    const requests: WireRequest[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as WireRequest;
      requests.push(request);
      if (request.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: {} } });
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (request.method === "tools/list") return new Response([
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: "server-1", method: "elicitation/create", params: { message: "Choose a project", requestedSchema: { type: "object", properties: { project: { type: "string" } } } } })}\n\n`,
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [] } })}\n\n`,
      ].join(""), { headers: { "Content-Type": "text/event-stream" } });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const client = new GrokBuildMcpHttpClient({
      name: "forms",
      url: "https://mcp.example.test",
      fetchImpl,
      events: {
        onElicitation: async (request) => ({ action: "accept", content: { project: request.mode === "form" ? "browser" : "unexpected" } }),
      },
    });
    await client.listTools(new AbortController().signal);
    await vi.waitFor(() => expect(requests.some((request) => request.id === "server-1" && request.method === undefined)).toBe(true));
    expect(requests[0]?.params?.capabilities).toMatchObject({
      elicitation: { form: { schemaValidation: true }, url: {} },
    });
    expect(requests.find((request) => request.id === "server-1")).toEqual({
      jsonrpc: "2.0",
      id: "server-1",
      result: { action: "accept", content: { project: "browser" } },
    });
  });

  it("declines out-of-bounds elicitation and maps server cancellation to a cancel result", async () => {
    expect(validateElicitationRequest("forms", { message: "x".repeat(MAX_ELICIT_MESSAGE_CHARS + 1), requestedSchema: {} })).toBeUndefined();
    expect(validateElicitationRequest("forms", {
      message: "Continue in browser",
      url: "https://auth.example.test/continue",
      elicitationId: "elicit-1",
    })).toMatchObject({ mode: "url", elicitationId: "elicit-1" });

    const responses: WireRequest[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as WireRequest;
      if (request.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: {} } });
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (request.method === "tools/list") return new Response([
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: "server-cancel", method: "elicitation/create", params: { message: "Wait", requestedSchema: {} } })}\n\n`,
        `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "server-cancel", reason: "superseded" } })}\n\n`,
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [] } })}\n\n`,
      ].join(""), { headers: { "Content-Type": "text/event-stream" } });
      responses.push(request);
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const client = new GrokBuildMcpHttpClient({
      name: "cancel",
      url: "https://mcp.example.test",
      fetchImpl,
      events: {
        onElicitation: async (_request, signal) => await new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ action: "accept", content: { ignored: true } }), { once: true });
        }),
      },
    });
    await client.listTools(new AbortController().signal);
    await vi.waitFor(() => expect(responses.find((response) => response.id === "server-cancel")).toBeDefined());
    expect(responses.find((response) => response.id === "server-cancel")).toEqual({
      jsonrpc: "2.0",
      id: "server-cancel",
      result: { action: "cancel" },
    });
  });

  it("refreshes expiring OAuth credentials and preserves a refresh token omitted by the token response", async () => {
    let saved: McpOAuthCredentials | undefined;
    const expired: McpOAuthCredentials = {
      clientId: "browser-client",
      accessToken: "expired",
      refreshToken: "keep-me",
      expiresIn: 60,
      tokenReceivedAt: Math.floor(Date.now() / 1_000) - 45,
      grantedScopes: ["mcp"],
      metadata: { authorizationEndpoint: "https://auth.example.test/authorize", tokenEndpoint: "https://auth.example.test/token" },
      redirectUri: "https://app.example.test/oauth/callback",
    };
    const authorizations: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === "https://auth.example.test/token") {
        expect(String(init?.body)).toContain("grant_type=refresh_token");
        return jsonResponse({ access_token: "fresh", expires_in: 3600, scope: "mcp" });
      }
      authorizations.push(new Headers(init?.headers).get("Authorization") ?? "");
      const request = JSON.parse(String(init?.body)) as WireRequest;
      return request.method === "initialize"
        ? jsonResponse({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: {} } })
        : new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const client = new GrokBuildMcpHttpClient({
      name: "oauth",
      url: "https://mcp.example.test",
      fetchImpl,
      oauth: {
        credentialStore: {
          load: async () => expired,
          save: async (_key, value) => { saved = value; },
          clear: async () => undefined,
        },
      },
    });
    await client.initialize(new AbortController().signal);
    expect(authorizations).toEqual(["Bearer fresh", "Bearer fresh"]);
    expect(saved).toMatchObject({ accessToken: "fresh", refreshToken: "keep-me" });
  });

  it("performs protected-resource discovery, DCR, PKCE, issuer validation, and resource-bound token exchange", async () => {
    let authorizationUrl = "";
    let saved: McpOAuthCredentials | undefined;
    const discoveryHeaders: Headers[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method !== "POST") discoveryHeaders.push(new Headers(init?.headers));
      if (url === "https://mcp.example.test/") {
        if (init?.method === "POST") {
          const request = JSON.parse(String(init.body)) as WireRequest;
          return request.method === "initialize"
            ? jsonResponse({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: {} } })
            : new Response(null, { status: 202 });
        }
        return new Response(null, { status: 404 });
      }
      if (url === "https://mcp.example.test/.well-known/oauth-protected-resource") return jsonResponse({
        resource: "https://mcp.example.test/",
        authorization_servers: ["https://auth.example.test"],
        scopes_supported: ["mcp", "offline_access"],
      });
      if (url === "https://auth.example.test/.well-known/oauth-authorization-server") return jsonResponse({
        issuer: "https://auth.example.test",
        authorization_endpoint: "https://auth.example.test/authorize",
        token_endpoint: "https://auth.example.test/token",
        registration_endpoint: "https://auth.example.test/register",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true,
      });
      if (url === "https://auth.example.test/register") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
          client_name: "Grok",
          application_type: "native",
          grant_types: ["authorization_code", "refresh_token"],
          token_endpoint_auth_method: "none",
        });
        return jsonResponse({ client_id: "dynamic-browser-client" });
      }
      if (url === "https://auth.example.test/token") {
        const body = new URLSearchParams(String(init?.body));
        expect(Object.fromEntries(body)).toMatchObject({
          grant_type: "authorization_code",
          code: "issued-code",
          client_id: "dynamic-browser-client",
          resource: "https://mcp.example.test/",
        });
        expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
        return jsonResponse({ access_token: "issued-access", refresh_token: "issued-refresh", expires_in: 3600, scope: "mcp offline_access" });
      }
      throw new Error(`Unexpected OAuth URL ${url}`);
    }) as unknown as typeof fetch;
    const client = new GrokBuildMcpHttpClient({
      name: "discovery",
      url: "https://mcp.example.test/",
      fetchImpl,
      oauth: {
        credentialStore: {
          load: async () => undefined,
          save: async (_key, credentials) => { saved = credentials; },
          clear: async () => undefined,
        },
        redirectUri: "https://app.example.test/oauth/callback",
        authorize: async (url) => {
          authorizationUrl = url;
          const parsed = new URL(url);
          return { code: "issued-code", state: parsed.searchParams.get("state")!, issuer: "https://auth.example.test" };
        },
      },
    });
    await client.initialize(new AbortController().signal);
    const authorization = new URL(authorizationUrl);
    expect(authorization.searchParams.get("resource")).toBe("https://mcp.example.test/");
    expect(authorization.searchParams.get("scope")).toBe("mcp offline_access");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(discoveryHeaders.every((headers) => headers.get("MCP-Protocol-Version") === "2024-11-05")).toBe(true);
    expect(saved).toMatchObject({ clientId: "dynamic-browser-client", accessToken: "issued-access", refreshToken: "issued-refresh" });
  });
});

describe("Grok Build browser MCP registry", () => {
  it("uses source-derived English stop words, stemming, identifier expansion, and duplicate-query BM25 weighting", () => {
    const documents = [
      { qualifiedName: "linear__create_issue", serverName: "linear", toolName: "create_issue", description: "Create a work item", parameters: ["teamId"] },
      { qualifiedName: "slack__read_thread", serverName: "slack", toolName: "read_thread", description: "Read thread replies", parameters: ["channelId"] },
      { qualifiedName: "linear__list_issues", serverName: "linear", toolName: "list_issues", description: "List work items", parameters: [] },
    ];
    expect(searchMcpDocuments(documents, "create linear issue", 3)[0]?.qualifiedName).toBe("linear__create_issue");
    expect(searchMcpDocuments(documents, "read slack thread", 3)[0]?.qualifiedName).toBe("slack__read_thread");
    expect(searchMcpDocuments(documents, "creating issues", 3)[0]?.qualifiedName).toBe("linear__create_issue");
    const once = searchMcpDocuments(documents, "create issue", 3)[0]?.score ?? 0;
    const withStopWords = searchMcpDocuments(documents, "the create issue", 3)[0]?.score ?? 0;
    const duplicate = searchMcpDocuments(documents, "create issue create issue", 3)[0]?.score ?? 0;
    expect(withStopWords).toBe(once);
    expect(duplicate).toBeCloseTo(once * 2, 5);
  });

  it("preserves native no-config output", async () => {
    const { services } = createGrokBuildMcpServices([]);
    await expect(services.searchTools("linear", 5, new AbortController().signal)).resolves.toBe(JSON.stringify({
      results: [],
      total_hidden_tools: 0,
      note: "No integration tools are configured. MCP servers are not connected.",
    }, null, 2));
  });

  it("refreshes the live tool catalog after notifications/tools/list_changed", async () => {
    let releaseEvent!: () => void;
    const eventGate = new Promise<void>((resolve) => { releaseEvent = resolve; });
    let catalogVersion = 1;
    let getCalls = 0;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") {
        getCalls += 1;
        if (getCalls > 1) return new Response(null, { status: 405 });
        await eventGate;
        return new Response("retry: 1\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\",\"params\":{}}\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      const request = JSON.parse(String(init?.body)) as WireRequest;
      if (request.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: {} } }, { "Mcp-Session-Id": "catalog-session" });
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (request.method === "tools/list") return jsonResponse({
        jsonrpc: "2.0",
        id: request.id,
        result: { tools: [{ name: catalogVersion === 1 ? "first" : "second", inputSchema: {} }] },
      });
      throw new Error(`Unexpected method ${request.method}`);
    }) as unknown as typeof fetch;
    const registry = new GrokBuildMcpRegistry([{ name: "dynamic", url: "https://mcp.example.test", fetchImpl }]);
    await registry.searchTools("first", 5, new AbortController().signal);
    expect(registry.serverSummaries()[0]?.toolNames).toEqual(["first"]);
    catalogVersion = 2;
    releaseEvent();
    await vi.waitFor(() => expect(registry.serverSummaries()[0]?.toolNames).toEqual(["second"]));
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
