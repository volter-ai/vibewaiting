import { describe, expect, it, vi } from "vitest";
import {
  createGrokBuildMcpHostnameResolver,
  createGrokBuildMcpRelayFetch,
  shouldRelayGrokBuildMcpUrl,
} from "../experiments/browser-agent/src/grok-build-mcp-relay.js";

describe("Grok Build local MCP relay adapter", () => {
  it("projects remote fetches through the same-origin envelope and restores protocol headers", async () => {
    const relay = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        url: "https://mcp.example.com/rpc", method: "POST",
        headers: { accept: "application/json", authorization: "Bearer token" }, body: "{\"jsonrpc\":\"2.0\"}",
      });
      expect(init).toMatchObject({ method: "POST", credentials: "include", redirect: "error" });
      return new Response("result", { status: 200, headers: { "Mcp-Session-Id": "session", "Content-Type": "application/json", "X-Ignored": "no" } });
    }) as unknown as typeof fetch;
    const fetchImpl = createGrokBuildMcpRelayFetch({ fetch: relay });
    const response = await fetchImpl("https://mcp.example.com/rpc", {
      method: "POST",
      headers: { Accept: "application/json", Authorization: "Bearer token" },
      body: '{"jsonrpc":"2.0"}',
    });
    expect(await response.text()).toBe("result");
    expect(response.headers.get("Mcp-Session-Id")).toBe("session");
    expect(response.headers.get("X-Ignored")).toBeNull();
  });

  it("restores upstream redirects without allowing the browser to follow them from the relay origin", async () => {
    const relayMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("", {
      status: 200,
      headers: {
        "X-Vibewaiting-Mcp-Upstream-Status": "302",
        Location: "https://mcp.example.com/next",
      },
    }));
    const response = await createGrokBuildMcpRelayFetch({ fetch: relayMock as unknown as typeof fetch })("https://mcp.example.com/start", { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://mcp.example.com/next");
    expect(relayMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  it("implements caller redirect policy and strips authorization across origins", async () => {
    const envelopes: Array<Record<string, unknown>> = [];
    const relayMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      envelopes.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return envelopes.length === 1
        ? new Response("", { status: 200, headers: {
            "X-Vibewaiting-Mcp-Upstream-Status": "307",
            Location: "https://auth.example.com/token",
          } })
        : new Response("issued", { status: 200, headers: { "X-Vibewaiting-Mcp-Upstream-Status": "200" } });
    });
    const fetchImpl = createGrokBuildMcpRelayFetch({ fetch: relayMock as unknown as typeof fetch });
    const response = await fetchImpl("https://mcp.example.com/token", {
      method: "POST", redirect: "follow", headers: { Authorization: "Bearer private", "Content-Type": "application/json" }, body: "{}",
    });
    expect(await response.text()).toBe("issued");
    expect(envelopes).toEqual([
      { url: "https://mcp.example.com/token", method: "POST", headers: { authorization: "Bearer private", "content-type": "application/json" }, body: "{}" },
      { url: "https://auth.example.com/token", method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    ]);
  });

  it("resolves OAuth hosts through the authenticated edge and selects only cross-origin HTTPS", async () => {
    const relay = vi.fn(async () => Response.json({ addresses: ["8.8.8.8", "2606:4700:4700::1111"] })) as unknown as typeof fetch;
    const resolve = createGrokBuildMcpHostnameResolver({ fetch: relay });
    await expect(resolve("auth.example.com", new AbortController().signal)).resolves.toEqual(["8.8.8.8", "2606:4700:4700::1111"]);
    expect(shouldRelayGrokBuildMcpUrl("https://mcp.example.com", "https://agent.example")).toBe(true);
    expect(shouldRelayGrokBuildMcpUrl("https://agent.example/mcp", "https://agent.example")).toBe(false);
    expect(shouldRelayGrokBuildMcpUrl("http://localhost:3000/mcp", "https://agent.example")).toBe(false);
  });
});
