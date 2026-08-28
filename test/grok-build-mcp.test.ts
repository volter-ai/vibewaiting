import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
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
import { isPublicIpAddress, type McpOAuthCredentials } from "../experiments/browser-agent/src/grok-build-mcp-oauth.js";
import { searchMcpDocuments } from "../experiments/browser-agent/src/grok-build-mcp-search.js";
import {
  ELICITATION_LIMITS,
  parseElicitationFormSchema,
  validateElicitationForm,
} from "../experiments/browser-agent/src/grok-build-mcp-elicitation.js";
import { loadGrokBuildRhaiWasmSync } from "../experiments/browser-agent/src/grok-build-rhai-wasm.js";

beforeAll(() => {
  const wasm = readFileSync(new URL("../experiments/browser-agent/src/generated-rhai-wasm/grok_workflow_rhai_wasm_bg.wasm", import.meta.url));
  const bytes = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer;
  loadGrokBuildRhaiWasmSync(bytes);
});

type WireRequest = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
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
      id: 0,
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
    expect(requests[2]?.body).toMatchObject({
      id: 1,
      method: "tools/list",
      params: { _meta: { progressToken: 0 } },
    });
    expect(requests.at(-1)?.body).toMatchObject({
      id: 2,
      params: { _meta: { progressToken: 1 }, cursor: "page-2" },
    });
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

  it("cancels an older pending elicitation when a newer request replaces it", async () => {
    const responses: WireRequest[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as WireRequest;
      if (request.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: {} } });
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (request.method === "tools/list") return new Response([
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: "old", method: "elicitation/create", params: { message: "Old", requestedSchema: { properties: { value: { type: "string" } } } } })}\n\n`,
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: "new", method: "elicitation/create", params: { message: "New", requestedSchema: { properties: { value: { type: "string" } } } } })}\n\n`,
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [] } })}\n\n`,
      ].join(""), { headers: { "Content-Type": "text/event-stream" } });
      responses.push(request); return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const client = new GrokBuildMcpHttpClient({ name: "replace", url: "https://mcp.example.test", fetchImpl, events: {
      onElicitation: async (request, signal) => request.message === "New" ? { action: "accept", content: { value: "new" } } : await new Promise((resolve) => signal.addEventListener("abort", () => resolve({ action: "accept", content: { value: "old" } }), { once: true })),
    } });
    await client.listTools(new AbortController().signal);
    await vi.waitFor(() => expect(responses.filter((response) => response.id === "old" || response.id === "new")).toHaveLength(2));
    expect(responses.find((response) => response.id === "old")?.result).toEqual({ action: "cancel" });
    expect(responses.find((response) => response.id === "new")?.result).toEqual({ action: "accept", content: { value: "new" } });
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
        resolveAuthorizationHostname: async () => ["8.8.8.8"],
      },
    });
    await client.initialize(new AbortController().signal);
    expect(authorizations).toEqual(["Bearer fresh", "Bearer fresh"]);
    expect(saved).toMatchObject({ accessToken: "fresh", refreshToken: "keep-me" });
  });

  it("refreshes a server-rejected usable token before considering interactive authorization", async () => {
    let stored: McpOAuthCredentials = {
      clientId: "browser-client", accessToken: "rejected", refreshToken: "refresh",
      grantedScopes: ["mcp"], redirectUri: "https://app.example.test/callback",
      metadata: { authorizationEndpoint: "https://auth.example.test/authorize", tokenEndpoint: "https://auth.example.test/token" },
    };
    let initializeCalls = 0;
    let authorizeCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === stored.metadata.tokenEndpoint) {
        expect(String(init?.body)).toContain("grant_type=refresh_token");
        return jsonResponse({ access_token: "refreshed", expires_in: 3600, scope: "mcp" });
      }
      const request = JSON.parse(String(init?.body)) as WireRequest;
      if (request.method === "initialize") {
        initializeCalls += 1;
        if (initializeCalls === 1) return new Response("expired", { status: 401 });
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer refreshed");
        return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: {} } });
      }
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const client = new GrokBuildMcpHttpClient({ name: "refresh-retry", url: "https://mcp.example.test", fetchImpl, oauth: {
      credentialStore: {
        load: async () => stored,
        save: async (_key, value) => { stored = value; },
        clear: async () => undefined,
      },
      authorize: async () => { authorizeCalls += 1; throw new Error("must not authorize"); },
      redirectUri: stored.redirectUri,
      resolveAuthorizationHostname: async () => ["8.8.8.8"],
    } });
    await client.initialize(new AbortController().signal);
    expect({ initializeCalls, authorizeCalls, token: stored.accessToken }).toEqual({ initializeCalls: 2, authorizeCalls: 0, token: "refreshed" });
  });

  it("does not open an authorization popup when automatic refresh fails transiently", async () => {
    const stored: McpOAuthCredentials = {
      clientId: "browser-client", accessToken: "rejected", refreshToken: "refresh",
      grantedScopes: ["mcp"], redirectUri: "https://app.example.test/callback",
      metadata: { authorizationEndpoint: "https://auth.example.test/authorize", tokenEndpoint: "https://auth.example.test/token" },
    };
    let authorizeCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === stored.metadata.tokenEndpoint) throw new TypeError("network unavailable");
      const request = JSON.parse(String(init?.body)) as WireRequest;
      if (request.method === "initialize") return new Response("expired", { status: 401 });
      throw new Error(`Unexpected ${request.method}`);
    }) as unknown as typeof fetch;
    const client = new GrokBuildMcpHttpClient({ name: "transient-refresh", url: "https://mcp.example.test", fetchImpl, oauth: {
      credentialStore: { load: async () => stored, save: async () => undefined, clear: async () => undefined },
      authorize: async () => { authorizeCalls += 1; throw new Error("must not authorize"); },
      redirectUri: stored.redirectUri,
      resolveAuthorizationHostname: async () => ["8.8.8.8"],
    } });
    await expect(client.initialize(new AbortController().signal)).rejects.toThrow("OAuth token request failed");
    expect(authorizeCalls).toBe(0);
  });

  it("does open a fresh authorization flow when explicit user auth follows a transient refresh failure", async () => {
    let stored: McpOAuthCredentials = {
      clientId: "browser-client", accessToken: "rejected", refreshToken: "refresh",
      grantedScopes: ["mcp"], redirectUri: "https://app.example.test/callback",
      metadata: { authorizationEndpoint: "https://auth.example.test/authorize", tokenEndpoint: "https://auth.example.test/token" },
    };
    let tokenCalls = 0;
    let authorizeCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === stored.metadata.tokenEndpoint) {
        tokenCalls += 1;
        if (tokenCalls === 1) throw new TypeError("network unavailable");
        expect(String(init?.body)).toContain("grant_type=authorization_code");
        return jsonResponse({ access_token: "fresh-user-token", refresh_token: "fresh-refresh", scope: "mcp" });
      }
      throw new Error(`Unexpected URL ${String(input)}`);
    }) as unknown as typeof fetch;
    const client = new GrokBuildMcpHttpClient({ name: "explicit-auth", url: "https://mcp.example.test", fetchImpl, oauth: {
      credentialStore: {
        load: async () => stored,
        save: async (_key, value) => { stored = value; },
        clear: async () => undefined,
      },
      authorize: async (url) => {
        authorizeCalls += 1;
        const parsed = new URL(url);
        return { code: "user-code", state: parsed.searchParams.get("state")! };
      },
      redirectUri: stored.redirectUri,
      resolveAuthorizationHostname: async () => ["8.8.8.8"],
    } });
    await client.forceReauth(new AbortController().signal);
    expect({ authorizeCalls, tokenCalls, token: stored.accessToken }).toEqual({ authorizeCalls: 1, tokenCalls: 2, token: "fresh-user-token" });
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
        resolveAuthorizationHostname: async () => ["8.8.8.8"],
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

  it("rejects private/reserved authorization addresses and supports client_credentials through a DNS-validating relay", async () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "100.64.1.1", "169.254.1.1", "172.16.0.1", "192.168.1.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "::1", "fd00::1", "fe80::1", "2001:db8::1"]) expect(isPublicIpAddress(address)).toBe(false);
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPublicIpAddress(address)).toBe(true);

    let stored: McpOAuthCredentials | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://mcp.example.test/") {
        if (init?.method === "POST") { const request = JSON.parse(String(init.body)) as WireRequest; return request.method === "initialize" ? jsonResponse({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: {} } }) : new Response(null, { status: 202 }); }
        return new Response(null, { status: 404 });
      }
      if (url.endsWith("/.well-known/oauth-protected-resource")) return jsonResponse({ resource: "https://mcp.example.test/", authorization_servers: ["https://auth.example.test"] });
      if (url === "https://auth.example.test/.well-known/oauth-authorization-server") return jsonResponse({ authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token", token_endpoint_auth_methods_supported: ["client_secret_post"] });
      if (url === "https://auth.example.test/token") {
        const body = new URLSearchParams(String(init?.body));
        expect(Object.fromEntries(body)).toMatchObject({ grant_type: "client_credentials", scope: "mcp", resource: "https://mcp.example.test/" });
        if (body.has("client_assertion")) {
          expect(body.get("client_id")).toBe("jwt-client");
          expect(body.get("client_assertion_type")).toBe("urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
          const [header, payload, signature] = body.get("client_assertion")!.split(".");
          expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toMatchObject({ alg: "RS256", typ: "JWT" });
          expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({ iss: "jwt-client", sub: "jwt-client", aud: "https://auth.example.test/token" });
          expect(signature).toMatch(/^[A-Za-z0-9_-]+$/u);
          expect(body.has("client_secret")).toBe(false);
        } else expect(Object.fromEntries(body)).toMatchObject({ client_id: "service-client", client_secret: "secret" });
        return jsonResponse({ access_token: "service-token", expires_in: 3600, scope: "mcp" });
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const client = new GrokBuildMcpHttpClient({ name: "service", url: "https://mcp.example.test/", fetchImpl, oauth: {
      credentialStore: { load: async () => undefined, save: async (_key, value) => { stored = value; }, clear: async () => undefined },
      clientCredentials: { clientId: "service-client", clientSecret: "secret", scopes: ["mcp"] },
      resolveAuthorizationHostname: async () => ["8.8.8.8"],
    } });
    await client.initialize(new AbortController().signal);
    expect(stored).toMatchObject({ clientId: "service-client", accessToken: "service-token" });

    const signingKey = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, false, ["sign", "verify"]);
    const jwtClient = new GrokBuildMcpHttpClient({ name: "jwt-service", url: "https://mcp.example.test/", fetchImpl, oauth: {
      credentialStore: { load: async () => undefined, save: async () => undefined, clear: async () => undefined },
      clientCredentials: { method: "private_key_jwt", clientId: "jwt-client", signingKey: signingKey.privateKey, algorithm: "RS256", scopes: ["mcp"] },
      resolveAuthorizationHostname: async () => ["8.8.8.8"],
    } });
    await jwtClient.initialize(new AbortController().signal);
  });

  it("coordinates authorization and upgrades scopes after an insufficient_scope challenge", async () => {
    const stored: McpOAuthCredentials = {
      clientId: "interactive-client", accessToken: "read-token", grantedScopes: ["read"], redirectUri: "https://app.example.test/callback",
      metadata: {
        issuer: "https://auth.example.test", authorizationEndpoint: "https://auth.example.test/authorize", tokenEndpoint: "https://auth.example.test/token",
        scopesSupported: ["read", "write"], authorizationResponseIssParameterSupported: true,
      },
    };
    let initializeCalls = 0;
    let coordinated = 0;
    let authorizedScopes = "";
    let saved: McpOAuthCredentials | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://auth.example.test/token") return jsonResponse({ access_token: "write-token", expires_in: 3600, scope: "read write" });
      const request = JSON.parse(String(init?.body)) as WireRequest;
      if (request.method === "initialize") {
        initializeCalls += 1;
        if (initializeCalls === 1) return new Response(null, { status: 403, headers: { "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="write"' } });
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer write-token");
        return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: {} } });
      }
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const client = new GrokBuildMcpHttpClient({ name: "scopes", url: "https://mcp.example.test/", fetchImpl, oauth: {
      credentialStore: { load: async () => stored, save: async (_key, value) => { saved = value; }, clear: async () => undefined },
      redirectUri: stored.redirectUri,
      resolveAuthorizationHostname: async () => ["8.8.8.8"],
      coordinateAuthorization: async (_key, _signal, operation) => { coordinated += 1; return operation(); },
      authorize: async (url) => {
        const parsed = new URL(url);
        authorizedScopes = parsed.searchParams.get("scope") ?? "";
        return { code: "scope-code", state: parsed.searchParams.get("state")!, issuer: "https://auth.example.test" };
      },
    } });
    await client.initialize(new AbortController().signal);
    expect(authorizedScopes.split(" ")).toEqual(["read", "write"]);
    expect(saved).toMatchObject({ accessToken: "write-token", grantedScopes: ["read", "write"] });
    expect(coordinated).toBeGreaterThanOrEqual(2);
  });
});

describe("Grok Build elicitation schema and value port", () => {
  it("parses ordered scalar/select/multi-select fields and native defaults", () => {
    const specs = parseElicitationFormSchema({
      type: "object",
      properties: {
        email: { type: "string", title: "Email", format: "email", minLength: 3, default: "a@b.co" },
        color: { type: "string", enum: ["red", "blue"], enumNames: ["Red label", "Blue label"], default: "blue" },
        countries: { type: "array", items: { anyOf: [{ const: "US", title: "United States" }, { const: "DE" }] }, minItems: 1, maxItems: 2, default: ["DE"] },
        enabled: { type: "boolean", default: true },
      },
      required: ["email", "color", "countries"],
    });
    expect(specs.map((spec) => spec.name)).toEqual(["email", "color", "countries", "enabled"]);
    expect(specs[1]?.kind).toMatchObject({ type: "single-select", defaultIndex: 1, options: [{ value: "red", label: "Red label" }, { value: "blue", label: "Blue label" }] });
    expect(specs[2]?.kind).toMatchObject({ type: "multi-select", minItems: 1, maxItems: 2, defaultIndexes: [1] });
    expect(specs[3]?.kind).toEqual({ type: "boolean", default: true });
  });

  it("enforces native form caps and schema shape", () => {
    expect(() => parseElicitationFormSchema([])).toThrow("must be a JSON object");
    expect(() => parseElicitationFormSchema({ type: "string", properties: {} })).toThrow('type must be "object"');
    expect(() => parseElicitationFormSchema({ type: "object" })).toThrow("properties is required");
    expect(() => parseElicitationFormSchema({ properties: Object.fromEntries(Array.from({ length: ELICITATION_LIMITS.fields + 1 }, (_, index) => [`p${index}`, {}])) })).toThrow("exceeds 32 fields");
    expect(() => parseElicitationFormSchema({ properties: { x: { title: "x".repeat(ELICITATION_LIMITS.titleChars + 1) } } })).toThrow("title exceeds 128");
    expect(() => parseElicitationFormSchema({ properties: { x: { enum: Array.from({ length: ELICITATION_LIMITS.enumValues + 1 }, (_, index) => index) } } })).toThrow("enum exceeds 32 values");
  });

  it("validates native string, format, numeric, selection, unsupported, and omission semantics", () => {
    const specs = parseElicitationFormSchema({ properties: {
      note: { type: "string", minLength: 6 },
      email: { type: "string", format: "email" },
      uri: { type: "string", format: "uri" },
      date: { type: "string", format: "date" },
      time: { type: "string", format: "date-time" },
      ratio: { type: "number", minimum: 0.5, maximum: 2.5 },
      age: { type: "integer", minimum: 0.5, maximum: 120.9 },
      color: { enum: ["red", "blue"] },
      countries: { type: "array", items: { enum: ["US", "UK", "DE"] }, minItems: 1, maxItems: 2 },
      optionalTags: { type: "array", items: { enum: ["a"] } },
      unsupported: { type: "object" },
    }, required: ["note", "email", "uri", "date", "time", "ratio", "age", "color", "countries", "unsupported"] });
    const valid = validateElicitationForm(specs, [
      { type: "draft", value: "  ab  " }, { type: "draft", value: "a.b+c@sub.example.co" },
      { type: "draft", value: "urn:isbn:0451450523" }, { type: "draft", value: "2024-02-29" },
      { type: "draft", value: "2026-08-19T10:00:00.123+02:00" }, { type: "draft", value: "1.25" },
      { type: "draft", value: "30" }, { type: "choice", index: 1 }, { type: "multi-choice", indexes: [0, 2] },
      { type: "multi-choice", indexes: [] }, { type: "draft", value: "" },
    ]);
    expect(valid).toEqual({ errors: [{ field: "unsupported", message: "unsupported field type" }] });
    const optional = parseElicitationFormSchema({ properties: { tags: { type: "array", items: { enum: ["x"] } }, blob: { type: "object" } } });
    expect(validateElicitationForm(optional, [{ type: "multi-choice", indexes: [] }, { type: "draft", value: "" }])).toEqual({ content: {} });
  });

  it.each([
    ["bad email", { type: "string", format: "email" }, "user@nodot", "invalid email"],
    ["relative URI", { type: "string", format: "uri" }, "/relative", "invalid URI"],
    ["invalid leap day", { type: "string", format: "date" }, "2023-02-29", "use YYYY-MM-DD"],
    ["invalid date-time", { type: "string", format: "date-time" }, "2026-08-19T25:00:00Z", "use RFC 3339 date-time"],
    ["number below min", { type: "number", minimum: 0.5 }, "0.1", "min 0.5"],
    ["fractional integer", { type: "integer" }, "30.5", "must be an integer"],
    ["i64 overflow", { type: "integer" }, "9223372036854775808", "must be an integer"],
  ])("rejects %s", (_label, property, draft, message) => {
    const specs = parseElicitationFormSchema({ properties: { value: property as never }, required: ["value"] });
    expect(validateElicitationForm(specs, [{ type: "draft", value: draft }])).toEqual({ errors: [{ field: "value", message }] });
  });

  it("serializes native lossless i64 elicitation values with JSON raw numbers", () => {
    const specs = parseElicitationFormSchema({ properties: { id: { type: "integer" } }, required: ["id"] });
    const result = validateElicitationForm(specs, [{ type: "draft", value: "9007199254740993" }]);
    expect(JSON.stringify(result)).toBe('{"content":{"id":9007199254740993}}');
  });
});

describe("Grok Build browser MCP registry", () => {
  it("uses native bm25 English stop words, stemming, identifier expansion, and duplicate-query weighting", async () => {
    const documents = [
      { qualifiedName: "linear__create_issue", serverName: "linear", toolName: "create_issue", description: "Create a work item", parameters: ["teamId"] },
      { qualifiedName: "slack__read_thread", serverName: "slack", toolName: "read_thread", description: "Read thread replies", parameters: ["channelId"] },
      { qualifiedName: "linear__list_issues", serverName: "linear", toolName: "list_issues", description: "List work items", parameters: [] },
    ];
    expect((await searchMcpDocuments(documents, "create linear issue", 3))[0]?.qualifiedName).toBe("linear__create_issue");
    expect((await searchMcpDocuments(documents, "read slack thread", 3))[0]?.qualifiedName).toBe("slack__read_thread");
    expect((await searchMcpDocuments(documents, "creating issues", 3))[0]?.qualifiedName).toBe("linear__create_issue");
    const once = (await searchMcpDocuments(documents, "create issue", 3))[0]?.score ?? 0;
    const withStopWords = (await searchMcpDocuments(documents, "the create issue", 3))[0]?.score ?? 0;
    const duplicate = (await searchMcpDocuments(documents, "create issue create issue", 3))[0]?.score ?? 0;
    expect(withStopWords).toBe(once);
    expect(duplicate).toBeCloseTo(once * 2, 5);
  });

  it("passes the native 55+ production haystack exact-match and fuzzy-ranking corpus", async () => {
    const corpus = NATIVE_PRODUCTION_HAYSTACK.map((tool) => ({ ...tool, parameters: [...tool.parameters] }));
    expect(corpus.length).toBeGreaterThanOrEqual(55);
    const exactCases = [
      ["grok_com_slack__slack_search_public", "grok_com_slack__slack_search_public"],
      ["slack_search_public", "grok_com_slack__slack_search_public"],
      ["notion-search", "notion__notion-search"],
      ["SearchDashboards", "grafana-ai__SearchDashboards"],
    ] as const;
    for (const [query, expected] of exactCases) {
      const results = await searchMcpDocuments(corpus, query, 5);
      expect(results).toHaveLength(1);
      expect(results[0]?.qualifiedName).toBe(expected);
    }
    const fuzzyCases = [
      ["search public slack messages", "grok_com_slack__slack_search_public", 3],
      ["send a message in slack", "grok_com_slack__slack_send_message", 3],
      ["read thread replies slack", "grok_com_slack__slack_read_thread", 3],
      ["search notion pages", "notion__notion-search", 3],
      ["create a new notion page", "notion__notion-create-pages", 3],
      ["search grafana dashboards", "grafana-ai__SearchDashboards", 3],
      ["delete alert rule grafana", "grafana-ai__DeleteAlertRule", 3],
      ["create a linear issue", "linear__save_issue", 3],
      ["create pull request github", "github__create_pull_request", 3],
      ["search code in github repos", "github__search_code", 3],
      ["wrong_server__SearchDashboards", "grafana-ai__SearchDashboards", 3],
      ["search_public", "grok_com_slack__slack_search_public", 3],
      ["getDashboardByUID", "grafana-ai__GetDashboardByUID", 2],
      ["slack__slack_read_thread", "grok_com_slack__slack_read_thread", 3],
      ["add comment notion page", "notion__notion-create-comment", 3],
    ] as const;
    for (const [query, expected, top] of fuzzyCases) {
      const names = (await searchMcpDocuments(corpus, query, 5)).slice(0, top).map((tool) => tool.qualifiedName);
      expect(names, query).toContain(expected);
    }
    const publicNames = (await searchMcpDocuments(corpus, "search public channels only", 5)).map((tool) => tool.qualifiedName);
    expect(publicNames.indexOf("grok_com_slack__slack_search_public")).toBeGreaterThanOrEqual(0);
    const privatePosition = publicNames.indexOf("grok_com_slack__slack_search_public_and_private");
    if (privatePosition >= 0) expect(publicNames.indexOf("grok_com_slack__slack_search_public")).toBeLessThan(privatePosition);
    const notionCreates = (await searchMcpDocuments(corpus, "notion-create", 5)).filter((tool) => tool.qualifiedName.includes("notion-create"));
    expect(notionCreates.length).toBeGreaterThanOrEqual(2);
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

  it("forks child catalogs over the parent's live client pool and closes only owned clients", async () => {
    let parentInitializes = 0;
    let parentDeletes = 0;
    const parentFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") { parentDeletes += 1; return new Response(null, { status: 204 }); }
      const request = JSON.parse(String(init?.body)) as WireRequest;
      if (request.method === "initialize") { parentInitializes += 1; return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: {} } }, { "Mcp-Session-Id": "shared" }); }
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (request.method === "tools/list") return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "read", inputSchema: {} }] } });
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "parent" }] } });
    }) as unknown as typeof fetch;
    const parent = new GrokBuildMcpRegistry([{ name: "shared", url: "https://parent.example/mcp", fetchImpl: parentFetch, enableEventStream: false }]);
    await parent.connectAll(new AbortController().signal);

    const ownedFetch = catalogFetch([{ name: "write", inputSchema: {} }], () => ({ content: [{ type: "text", text: "owned" }] }));
    const child = parent.fork(
      [{ name: "owned", url: "https://owned.example/mcp", fetchImpl: ownedFetch }],
      new Set(["shared"]),
    );
    await expect(child.useTool("shared__read", {}, new AbortController().signal)).resolves.toBe("parent");
    await expect(child.useTool("owned__write", {}, new AbortController().signal)).resolves.toBe("owned");
    expect(parentInitializes).toBe(1);
    await child.closeAll(new AbortController().signal);
    expect(parentDeletes).toBe(0);
    await parent.closeAll(new AbortController().signal);
    expect(parentDeletes).toBe(1);

    const shadow = parent.fork([{ name: "shared", url: "https://owned.example/mcp", fetchImpl: ownedFetch }], new Set(["shared"]), new Set(["shared"]));
    expect(shadow.serverSummaries().map((server) => server.name)).toEqual(["shared"]);
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
      supportsAuthentication: false,
    }]);
  });

  it("exposes explicit OAuth authentication and rebuilds the failed server catalog", async () => {
    let stored: McpOAuthCredentials = {
      clientId: "browser-client", accessToken: "rejected", refreshToken: "refresh",
      grantedScopes: ["mcp"], redirectUri: "https://app.example.test/callback",
      metadata: { authorizationEndpoint: "https://auth.example.test/authorize", tokenEndpoint: "https://auth.example.test/token" },
    };
    let authorizeCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === stored.metadata.tokenEndpoint) {
        const body = new URLSearchParams(String(init?.body));
        if (body.get("grant_type") === "refresh_token") throw new TypeError("refresh network unavailable");
        return jsonResponse({ access_token: "accepted", scope: "mcp" });
      }
      const request = JSON.parse(String(init?.body)) as WireRequest;
      if (request.method === "initialize") {
        if (new Headers(init?.headers).get("Authorization") !== "Bearer accepted") return new Response("expired", { status: 401 });
        return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: {} } });
      }
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "recovered", inputSchema: {} }] } });
    }) as unknown as typeof fetch;
    const registry = new GrokBuildMcpRegistry([{ name: "recoverable", url: "https://mcp.example.test", fetchImpl, oauth: {
      credentialStore: {
        load: async () => stored,
        save: async (_key, value) => { stored = value; },
        clear: async () => undefined,
      },
      authorize: async (url) => {
        authorizeCalls += 1;
        return { code: "user-code", state: new URL(url).searchParams.get("state")! };
      },
      redirectUri: stored.redirectUri,
      resolveAuthorizationHostname: async () => ["8.8.8.8"],
    } }]);
    await registry.connectAll(new AbortController().signal);
    expect(registry.serverSummaries()[0]).toMatchObject({ status: "failed", supportsAuthentication: true });
    await registry.authenticate("recoverable", new AbortController().signal);
    expect(authorizeCalls).toBe(1);
    expect(registry.serverSummaries()[0]).toMatchObject({ status: "ready", supportsAuthentication: true, toolNames: ["recovered"] });
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
    expect(calls.at(-1)?.params).toEqual({ _meta: { progressToken: 1 }, name: "save_issue", arguments: { title: "Broken build" } });
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

const NATIVE_PRODUCTION_HAYSTACK = [
  {
    "qualifiedName": "grok_com_slack__slack_create_canvas",
    "serverName": "grok_com_slack",
    "toolName": "slack_create_canvas",
    "description": "Create a new Slack canvas in a channel",
    "parameters": [
      "channel_id",
      "content"
    ]
  },
  {
    "qualifiedName": "grok_com_slack__slack_get_reactions",
    "serverName": "grok_com_slack",
    "toolName": "slack_get_reactions",
    "description": "Retrieves all reactions (emoji) on a specific Slack message",
    "parameters": [
      "channel_id",
      "message_ts"
    ]
  },
  {
    "qualifiedName": "grok_com_slack__slack_list_channel_members",
    "serverName": "grok_com_slack",
    "toolName": "slack_list_channel_members",
    "description": "List members of a Slack channel",
    "parameters": [
      "channel_id"
    ]
  },
  {
    "qualifiedName": "grok_com_slack__slack_read_canvas",
    "serverName": "grok_com_slack",
    "toolName": "slack_read_canvas",
    "description": "Read a Slack canvas by ID",
    "parameters": [
      "canvas_id"
    ]
  },
  {
    "qualifiedName": "grok_com_slack__slack_read_channel",
    "serverName": "grok_com_slack",
    "toolName": "slack_read_channel",
    "description": "Reads messages from a Slack channel in reverse chronological order",
    "parameters": [
      "channel_id",
      "limit"
    ]
  },
  {
    "qualifiedName": "grok_com_slack__slack_read_file",
    "serverName": "grok_com_slack",
    "toolName": "slack_read_file",
    "description": "Reads a Slack file's content by file ID",
    "parameters": [
      "file_id"
    ]
  },
  {
    "qualifiedName": "grok_com_slack__slack_read_thread",
    "serverName": "grok_com_slack",
    "toolName": "slack_read_thread",
    "description": "Reads messages from a specific Slack thread (parent message + all replies)",
    "parameters": [
      "channel_id",
      "message_ts"
    ]
  },
  {
    "qualifiedName": "grok_com_slack__slack_read_user_profile",
    "serverName": "grok_com_slack",
    "toolName": "slack_read_user_profile",
    "description": "Read a Slack user's profile information",
    "parameters": [
      "user_id"
    ]
  },
  {
    "qualifiedName": "grok_com_slack__slack_schedule_message",
    "serverName": "grok_com_slack",
    "toolName": "slack_schedule_message",
    "description": "Schedule a message to be sent at a specific time",
    "parameters": [
      "channel_id",
      "text",
      "post_at"
    ]
  },
  {
    "qualifiedName": "grok_com_slack__slack_search_channels",
    "serverName": "grok_com_slack",
    "toolName": "slack_search_channels",
    "description": "Search for Slack channels by name or topic",
    "parameters": [
      "query"
    ]
  },
  {
    "qualifiedName": "grok_com_slack__slack_search_emojis",
    "serverName": "grok_com_slack",
    "toolName": "slack_search_emojis",
    "description": "Search for custom emoji in the Slack workspace",
    "parameters": [
      "query"
    ]
  },
  {
    "qualifiedName": "grok_com_slack__slack_search_public",
    "serverName": "grok_com_slack",
    "toolName": "slack_search_public",
    "description": "Searches for messages and files in public Slack channels only",
    "parameters": [
      "query",
      "sort",
      "sort_dir"
    ]
  },
  {
    "qualifiedName": "grok_com_slack__slack_search_public_and_private",
    "serverName": "grok_com_slack",
    "toolName": "slack_search_public_and_private",
    "description": "Searches for messages and files in both public and private Slack channels",
    "parameters": [
      "query",
      "sort",
      "sort_dir"
    ]
  },
  {
    "qualifiedName": "grok_com_slack__slack_search_users",
    "serverName": "grok_com_slack",
    "toolName": "slack_search_users",
    "description": "Search for users in the Slack workspace by name or email",
    "parameters": [
      "query"
    ]
  },
  {
    "qualifiedName": "grok_com_slack__slack_send_message",
    "serverName": "grok_com_slack",
    "toolName": "slack_send_message",
    "description": "Send a message in a Slack channel or thread",
    "parameters": [
      "channel_id",
      "text",
      "thread_ts"
    ]
  },
  {
    "qualifiedName": "grok_com_slack__slack_send_message_draft",
    "serverName": "grok_com_slack",
    "toolName": "slack_send_message_draft",
    "description": "Create a draft message for user review before sending",
    "parameters": [
      "channel_id",
      "text"
    ]
  },
  {
    "qualifiedName": "grok_com_slack__slack_update_canvas",
    "serverName": "grok_com_slack",
    "toolName": "slack_update_canvas",
    "description": "Update the content of an existing Slack canvas",
    "parameters": [
      "canvas_id",
      "content"
    ]
  },
  {
    "qualifiedName": "notion__notion-create-comment",
    "serverName": "notion",
    "toolName": "notion-create-comment",
    "description": "Create a comment on a Notion page or discussion",
    "parameters": [
      "page_id",
      "text"
    ]
  },
  {
    "qualifiedName": "notion__notion-create-database",
    "serverName": "notion",
    "toolName": "notion-create-database",
    "description": "Create a new Notion database with specified properties",
    "parameters": [
      "parent_id",
      "title",
      "properties"
    ]
  },
  {
    "qualifiedName": "notion__notion-create-pages",
    "serverName": "notion",
    "toolName": "notion-create-pages",
    "description": "Create one or more new Notion pages",
    "parameters": [
      "parent_id",
      "title",
      "content"
    ]
  },
  {
    "qualifiedName": "notion__notion-create-view",
    "serverName": "notion",
    "toolName": "notion-create-view",
    "description": "Create a new view for a Notion database",
    "parameters": [
      "database_id",
      "type"
    ]
  },
  {
    "qualifiedName": "notion__notion-duplicate-page",
    "serverName": "notion",
    "toolName": "notion-duplicate-page",
    "description": "Duplicate an existing Notion page",
    "parameters": [
      "page_id"
    ]
  },
  {
    "qualifiedName": "notion__notion-fetch",
    "serverName": "notion",
    "toolName": "notion-fetch",
    "description": "Fetch the content of a Notion page or block by URL or ID",
    "parameters": [
      "url"
    ]
  },
  {
    "qualifiedName": "notion__notion-get-comments",
    "serverName": "notion",
    "toolName": "notion-get-comments",
    "description": "Get comments on a Notion page or discussion",
    "parameters": [
      "page_id"
    ]
  },
  {
    "qualifiedName": "notion__notion-get-teams",
    "serverName": "notion",
    "toolName": "notion-get-teams",
    "description": "Get the list of teams in the Notion workspace",
    "parameters": []
  },
  {
    "qualifiedName": "notion__notion-get-users",
    "serverName": "notion",
    "toolName": "notion-get-users",
    "description": "Get the list of users in the Notion workspace",
    "parameters": []
  },
  {
    "qualifiedName": "notion__notion-move-pages",
    "serverName": "notion",
    "toolName": "notion-move-pages",
    "description": "Move Notion pages to a different parent",
    "parameters": [
      "page_ids",
      "target_parent_id"
    ]
  },
  {
    "qualifiedName": "notion__notion-search",
    "serverName": "notion",
    "toolName": "notion-search",
    "description": "Search Notion pages and databases by title or content",
    "parameters": [
      "query"
    ]
  },
  {
    "qualifiedName": "notion__notion-update-data-source",
    "serverName": "notion",
    "toolName": "notion-update-data-source",
    "description": "Update the data source configuration for a Notion database",
    "parameters": [
      "database_id"
    ]
  },
  {
    "qualifiedName": "notion__notion-update-page",
    "serverName": "notion",
    "toolName": "notion-update-page",
    "description": "Update properties or content of an existing Notion page",
    "parameters": [
      "page_id",
      "properties"
    ]
  },
  {
    "qualifiedName": "notion__notion-update-view",
    "serverName": "notion",
    "toolName": "notion-update-view",
    "description": "Update a view configuration for a Notion database",
    "parameters": [
      "view_id"
    ]
  },
  {
    "qualifiedName": "grafana-ai__SearchDashboards",
    "serverName": "grafana-ai",
    "toolName": "SearchDashboards",
    "description": "Search for Grafana dashboards by query string. Returns matching dashboards with title, UID, folder, tags, and full URL.",
    "parameters": [
      "query",
      "limit",
      "page"
    ]
  },
  {
    "qualifiedName": "grafana-ai__GetDashboardByUID",
    "serverName": "grafana-ai",
    "toolName": "GetDashboardByUID",
    "description": "Get a complete Grafana dashboard by its UID. Returns full dashboard JSON including panels, variables, and settings.",
    "parameters": [
      "uid"
    ]
  },
  {
    "qualifiedName": "grafana-ai__GenerateDeeplink",
    "serverName": "grafana-ai",
    "toolName": "GenerateDeeplink",
    "description": "Generate a direct URL to a Grafana resource (dashboard, panel, explore page, or alert rule).",
    "parameters": [
      "resource_type",
      "uid"
    ]
  },
  {
    "qualifiedName": "grafana-ai__GetDashboardProperty",
    "serverName": "grafana-ai",
    "toolName": "GetDashboardProperty",
    "description": "Get a specific property value from a Grafana dashboard by JSONPath.",
    "parameters": [
      "uid",
      "property"
    ]
  },
  {
    "qualifiedName": "grafana-ai__DeleteAlertRule",
    "serverName": "grafana-ai",
    "toolName": "DeleteAlertRule",
    "description": "Delete a Grafana alert rule by UID. This action cannot be undone.",
    "parameters": [
      "uid"
    ]
  },
  {
    "qualifiedName": "grafana-ai__SearchFolders",
    "serverName": "grafana-ai",
    "toolName": "SearchFolders",
    "description": "Search for Grafana folders by query string. Returns matching folders with title, UID, and URL.",
    "parameters": [
      "query"
    ]
  },
  {
    "qualifiedName": "grafana-ai__ListDatasources",
    "serverName": "grafana-ai",
    "toolName": "ListDatasources",
    "description": "List all configured datasources in Grafana. Returns datasource summaries with UID, name, type.",
    "parameters": [
      "type"
    ]
  },
  {
    "qualifiedName": "grafana-ai__ListContactPoints",
    "serverName": "grafana-ai",
    "toolName": "ListContactPoints",
    "description": "List Grafana notification contact points. Returns summaries including UID, name, and type.",
    "parameters": [
      "name",
      "limit"
    ]
  },
  {
    "qualifiedName": "grafana-ai__GetDashboardPanelQueries",
    "serverName": "grafana-ai",
    "toolName": "GetDashboardPanelQueries",
    "description": "Get panel queries from a Grafana dashboard. Returns an array of panel queries with title, query expression, and datasource info.",
    "parameters": [
      "uid"
    ]
  },
  {
    "qualifiedName": "linear__save_issue",
    "serverName": "linear",
    "toolName": "save_issue",
    "description": "Create or update a Linear issue",
    "parameters": [
      "title",
      "team",
      "description",
      "assignee",
      "priority"
    ]
  },
  {
    "qualifiedName": "linear__list_issues",
    "serverName": "linear",
    "toolName": "list_issues",
    "description": "List issues in the user's Linear workspace",
    "parameters": [
      "assignee",
      "project",
      "state",
      "team",
      "query"
    ]
  },
  {
    "qualifiedName": "linear__get_issue",
    "serverName": "linear",
    "toolName": "get_issue",
    "description": "Retrieve detailed information about a Linear issue by ID",
    "parameters": [
      "id"
    ]
  },
  {
    "qualifiedName": "linear__list_projects",
    "serverName": "linear",
    "toolName": "list_projects",
    "description": "List projects in the user's Linear workspace",
    "parameters": [
      "query",
      "team"
    ]
  },
  {
    "qualifiedName": "linear__create_comment",
    "serverName": "linear",
    "toolName": "create_comment",
    "description": "Add a comment to a Linear issue",
    "parameters": [
      "issue_id",
      "body"
    ]
  },
  {
    "qualifiedName": "linear__list_teams",
    "serverName": "linear",
    "toolName": "list_teams",
    "description": "List teams in the user's Linear workspace",
    "parameters": []
  },
  {
    "qualifiedName": "linear__search_issues",
    "serverName": "linear",
    "toolName": "search_issues",
    "description": "Search for Linear issues by keyword",
    "parameters": [
      "query"
    ]
  },
  {
    "qualifiedName": "linear__get_user",
    "serverName": "linear",
    "toolName": "get_user",
    "description": "Get information about a Linear user",
    "parameters": [
      "id"
    ]
  },
  {
    "qualifiedName": "github__create_pull_request",
    "serverName": "github",
    "toolName": "create_pull_request",
    "description": "Create a new GitHub pull request",
    "parameters": [
      "repo",
      "title",
      "head",
      "base",
      "body"
    ]
  },
  {
    "qualifiedName": "github__list_pull_requests",
    "serverName": "github",
    "toolName": "list_pull_requests",
    "description": "List pull requests in a GitHub repository",
    "parameters": [
      "repo",
      "state"
    ]
  },
  {
    "qualifiedName": "github__get_file_contents",
    "serverName": "github",
    "toolName": "get_file_contents",
    "description": "Get the contents of a file from a GitHub repository",
    "parameters": [
      "repo",
      "path",
      "ref"
    ]
  },
  {
    "qualifiedName": "github__search_code",
    "serverName": "github",
    "toolName": "search_code",
    "description": "Search for code across GitHub repositories",
    "parameters": [
      "query"
    ]
  },
  {
    "qualifiedName": "github__create_issue",
    "serverName": "github",
    "toolName": "create_issue",
    "description": "Create a new GitHub issue",
    "parameters": [
      "repo",
      "title",
      "body"
    ]
  },
  {
    "qualifiedName": "github__list_commits",
    "serverName": "github",
    "toolName": "list_commits",
    "description": "List commits in a GitHub repository",
    "parameters": [
      "repo",
      "sha"
    ]
  },
  {
    "qualifiedName": "github__get_pull_request",
    "serverName": "github",
    "toolName": "get_pull_request",
    "description": "Get details about a specific GitHub pull request",
    "parameters": [
      "repo",
      "pull_number"
    ]
  }
] as const;

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
