import type { VirtualFS } from "almostnode";
import type { GrokBuildAcpMcpServer } from "./grok-build-agent-mcp.js";
import { policyFromGrokBuildAcpServer, type GrokBuildMcpConfigPolicy } from "./grok-build-mcp-config-parse.js";
import type { GrokBuildMcpServerConfig } from "./grok-build-mcp.js";
import type { GrokBuildMcpOAuthOptions } from "./grok-build-mcp-oauth.js";
import { createGrokBuildAlmostNodeStdioConfig } from "./grok-build-mcp-stdio.js";
import { shouldRelayGrokBuildMcpUrl } from "./grok-build-mcp-relay.js";

export interface GrokBuildMcpRuntimeProjectionOptions {
  cwd: string;
  sessionId?: string;
  defaultStartupTimeoutMs?: number;
  relayFetch?: typeof fetch;
  oauth?(server: GrokBuildAcpMcpServer, policy: GrokBuildMcpConfigPolicy): GrokBuildMcpOAuthOptions | undefined;
}

/** Project ACP transport plus the out-of-band policy native resolves by server name. */
export function projectGrokBuildMcpRuntimeConfig(
  vfs: VirtualFS,
  server: GrokBuildAcpMcpServer,
  options: GrokBuildMcpRuntimeProjectionOptions,
): GrokBuildMcpServerConfig {
  const policy = policyFromGrokBuildAcpServer(server);
  const startupTimeoutMs = policy.startupTimeoutMs ?? options.defaultStartupTimeoutMs;
  const common = {
    ...(startupTimeoutMs !== undefined ? { startupTimeoutMs } : {}),
    ...(policy.toolTimeoutMs !== undefined ? { toolTimeoutMs: policy.toolTimeoutMs } : {}),
    ...(policy.toolTimeoutsMs ? { toolTimeoutsMs: policy.toolTimeoutsMs } : {}),
    ...(policy.exposeImageBase64 !== undefined ? { exposeImageBase64: policy.exposeImageBase64 } : {}),
    ...(policy.disabledTools ? { disabledTools: policy.disabledTools } : {}),
    serverScope: typeof server._meta?.grokBrowserScope === "string" ? server._meta.grokBrowserScope : "unknown",
  } satisfies Partial<GrokBuildMcpServerConfig>;
  if (server.type === "stdio") {
    return {
      ...createGrokBuildAlmostNodeStdioConfig(vfs, server, {
        cwd: options.cwd,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      }),
      ...common,
    };
  }
  const oauth = options.oauth?.(server, policy);
  return {
    name: server.name,
    url: server.url,
    headers: Object.fromEntries(server.headers.map((header) => [header.name, header.value])),
    enableEventStream: server.type === "sse",
    ...(options.relayFetch && shouldRelayGrokBuildMcpUrl(server.url) ? { fetchImpl: options.relayFetch } : {}),
    ...common,
    ...(oauth ? { oauth } : {}),
  };
}

export function withGrokBuildMcpScope(server: GrokBuildAcpMcpServer, scope: "user" | "project"): GrokBuildAcpMcpServer {
  return { ...server, _meta: { ...server._meta, grokBrowserScope: scope } };
}
