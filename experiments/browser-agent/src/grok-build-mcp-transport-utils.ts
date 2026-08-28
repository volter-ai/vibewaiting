import type { GrokBuildMcpHttpConfig } from "./grok-build-mcp-protocol.js";

export function parseMcpChallengeScopes(challenge: string | undefined): string[] {
  if (!challenge || !/error\s*=\s*"?insufficient_scope"?/iu.test(challenge)) return [];
  const match = /scope\s*=\s*(?:"([^"]*)"|([^,\s]+))/iu.exec(challenge);
  return (match?.[1] ?? match?.[2] ?? "").split(/\s+/u).filter(Boolean);
}

export function validateGrokBuildMcpHttpConfig(config: GrokBuildMcpHttpConfig): void {
  if (!config.name || config.name.includes("__")) throw new Error("MCP server name must be non-empty and cannot contain '__'.");
  let url: URL;
  try {
    url = new URL(config.url, globalThis.location?.href);
  } catch {
    throw new Error(`Invalid MCP server URL: ${config.url}`);
  }
  const localHttp = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (url.protocol !== "https:" && !localHttp) throw new Error("MCP server URL must use HTTPS (HTTP is allowed only for localhost). ");
  for (const [name, value] of Object.entries(config.headers ?? {})) {
    if (!name.trim() || /[\r\n]/u.test(name) || /[\r\n]/u.test(value)) throw new Error(`Invalid MCP header '${name}'.`);
  }
  for (const timeout of [config.startupTimeoutMs, config.toolTimeoutMs]) {
    if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout <= 0)) throw new Error("MCP timeouts must be positive integers.");
  }
}

export async function waitForMcpReconnect(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      globalThis.clearTimeout(timer);
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    }, { once: true });
  });
}
