import { describe, expect, it } from "vitest";
import {
  GrokBuildMemoryMcpCredentialStore,
  parseGrokBuildMcpOAuthCallbackMessage,
} from "../experiments/browser-agent/src/grok-build-mcp-oauth-dialog.js";
import type { McpOAuthCredentials } from "../experiments/browser-agent/src/grok-build-mcp-oauth.js";

const credentials: McpOAuthCredentials = {
  clientId: "client",
  accessToken: "access",
  refreshToken: "refresh",
  grantedScopes: ["read"],
  metadata: {
    authorizationEndpoint: "https://auth.example.com/authorize",
    tokenEndpoint: "https://auth.example.com/token",
  },
  redirectUri: "https://agent.example/mcp-oauth-callback.html",
};

describe("Grok Build browser MCP OAuth UI boundary", () => {
  it("keeps credentials isolated from caller mutation and supports explicit clearing", async () => {
    const store = new GrokBuildMemoryMcpCredentialStore();
    await store.save("server:https://mcp.example.com", credentials);
    const loaded = await store.load("server:https://mcp.example.com");
    expect(loaded).toEqual(credentials);
    loaded!.accessToken = "mutated";
    expect((await store.load("server:https://mcp.example.com"))!.accessToken).toBe("access");
    await store.clear("server:https://mcp.example.com");
    expect(await store.load("server:https://mcp.example.com")).toBeUndefined();
  });

  it("accepts only exact, bounded, string-only callback messages", () => {
    expect(parseGrokBuildMcpOAuthCallbackMessage({
      type: "grok-mcp-oauth-callback", code: "code", state: "state", issuer: "https://auth.example.com",
    })).toEqual({ type: "grok-mcp-oauth-callback", code: "code", state: "state", issuer: "https://auth.example.com" });
    expect(parseGrokBuildMcpOAuthCallbackMessage({ type: "other", code: "code", state: "state" })).toBeUndefined();
    expect(parseGrokBuildMcpOAuthCallbackMessage({ type: "grok-mcp-oauth-callback", code: 1, state: "state" })).toBeUndefined();
    expect(parseGrokBuildMcpOAuthCallbackMessage({ type: "grok-mcp-oauth-callback", code: "code", state: "state", extra: true })).toBeUndefined();
    expect(parseGrokBuildMcpOAuthCallbackMessage({ type: "grok-mcp-oauth-callback", error: "access_denied\n" })).toBeUndefined();
  });
});
