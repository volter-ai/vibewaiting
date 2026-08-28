import type { GrokBuildMcpServerConfig } from "./grok-build-mcp.js";

type JsonObject = Record<string, unknown>;

export interface GrokBuildGatewayTool {
  connectorId: string;
  connectorName: string;
  toolId: string;
  toolName: string;
  callId: string;
  description: string;
  jsonSchema: JsonObject;
}

export interface GrokBuildGatewayToolCatalog {
  tools: GrokBuildGatewayTool[];
  totalTools: number;
  connectorsNeedingReauth: string[];
}

export interface GrokBuildManagedMcpOptions {
  fetch?: typeof globalThis.fetch;
  callEndpoint?: string;
  clientMode?: "interactive" | "headless";
}

/** Strict translation of xAI's `GatewayToolCatalog` serde contract. */
export function parseGrokBuildGatewayToolCatalog(value: unknown): GrokBuildGatewayToolCatalog {
  if (!isObject(value)) throw new Error("Managed MCP catalog must be an object.");
  const rawTools = value.tools === undefined ? [] : value.tools;
  const rawReauth = value.connectors_needing_reauth === undefined ? [] : value.connectors_needing_reauth;
  const totalTools = value.total_tools === undefined ? 0 : value.total_tools;
  if (!Array.isArray(rawTools) || !Array.isArray(rawReauth)
    || !rawReauth.every((entry) => typeof entry === "string")
    || !Number.isSafeInteger(totalTools) || (totalTools as number) < 0) {
    throw new Error("Managed MCP catalog has invalid tools, totals, or reauthentication connectors.");
  }
  return {
    tools: rawTools.map(parseGatewayTool),
    totalTools: totalTools as number,
    connectorsNeedingReauth: [...rawReauth] as string[],
  };
}

/** Native master flag plus the remote gateway-tools opt-in. */
export function grokBuildManagedGatewayEnabled(settings: Readonly<JsonObject>): boolean {
  return settings.managed_mcps_enabled !== false
    && settings.managed_mcp_gateway_tools_enabled === true;
}

/** One projected MCP server per connector; registry semantics stay unchanged. */
export function createGrokBuildManagedMcpConfigs(
  catalog: GrokBuildGatewayToolCatalog,
  options: GrokBuildManagedMcpOptions = {},
): GrokBuildMcpServerConfig[] {
  const byConnector = new Map<string, GrokBuildGatewayTool[]>();
  for (const tool of catalog.tools) {
    const tools = byConnector.get(tool.connectorId) ?? [];
    tools.push(tool);
    byConnector.set(tool.connectorId, tools);
  }
  return [...byConnector.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([connectorId, tools]) => {
    const adapter = new GrokBuildManagedMcpFetchAdapter(connectorId, tools, options);
    return {
      name: connectorId,
      url: `https://managed-mcp.invalid/${encodeURIComponent(connectorId)}`,
      fetchImpl: adapter.fetch,
      enableEventStream: false,
      serverScope: "managed",
    };
  });
}

class GrokBuildManagedMcpFetchAdapter {
  readonly fetch: typeof fetch;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;

  constructor(
    private readonly connectorId: string,
    private readonly tools: readonly GrokBuildGatewayTool[],
    private readonly options: GrokBuildManagedMcpOptions,
  ) {
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.endpoint = options.callEndpoint ?? "/api/grok/mcp/tools/call";
    this.fetch = this.handleFetch.bind(this) as typeof fetch;
  }

  private async handleFetch(_input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    if ((init.method ?? "GET") === "DELETE") return new Response(null, { status: 204 });
    if ((init.method ?? "GET") !== "POST") return new Response("Method not allowed", { status: 405 });
    let request: JsonObject;
    try {
      const parsed: unknown = JSON.parse(String(init.body ?? ""));
      if (!isObject(parsed)) throw new Error("not an object");
      request = parsed;
    } catch {
      return rpcHttpError("Invalid JSON-RPC payload", 400);
    }
    const id = request.id;
    if (typeof request.method !== "string" || (id !== undefined && typeof id !== "number" && typeof id !== "string")) {
      return rpcHttpError("Invalid JSON-RPC payload", 400);
    }
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (id === undefined) return new Response(null, { status: 202 });
    if (request.method === "initialize") {
      return rpcResult(id, {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: this.connectorId, version: "managed-gateway" },
        instructions: this.tools[0]?.connectorName ?? this.connectorId,
      });
    }
    if (request.method === "tools/list") {
      return rpcResult(id, { tools: this.tools.map((tool) => ({
        name: tool.toolId,
        description: tool.description,
        inputSchema: structuredClone(tool.jsonSchema),
      })) });
    }
    if (request.method !== "tools/call") return rpcProtocolError(id, -32601, "Method not found");
    const params = isObject(request.params) ? request.params : {};
    const tool = typeof params.name === "string"
      ? this.tools.find((entry) => entry.toolId === params.name)
      : undefined;
    if (!tool) return rpcProtocolError(id, -32602, "Unknown managed MCP tool");
    const args = isObject(params.arguments) ? params.arguments : {};
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "x-browser-agent-client-mode": this.options.clientMode ?? "interactive",
      },
      body: JSON.stringify({ call_id: tool.callId, arguments: args }),
      ...(init.signal ? { signal: init.signal } : {}),
    });
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message = gatewayErrorMessage(payload) ?? `HTTP ${response.status}`;
      return rpcHttpError(message, response.status);
    }
    if (!isObject(payload) || !("result" in payload)) return rpcHttpError("Managed MCP response omitted result.", 502);
    const result = payload.result;
    return rpcResult(id, {
      content: [{ type: "text", text: gatewayResultToText(result) }],
      ...(gatewayResultIsError(result) ? { isError: true } : {}),
    });
  }
}

function parseGatewayTool(value: unknown): GrokBuildGatewayTool {
  if (!isObject(value)) throw new Error("Managed MCP tool must be an object.");
  for (const field of ["connector_id", "connector_name", "tool_id", "tool_name", "call_id", "description"] as const) {
    if (typeof value[field] !== "string") throw new Error(`Managed MCP tool is missing '${field}'.`);
  }
  if (!isObject(value.json_schema)) throw new Error("Managed MCP tool json_schema must be an object.");
  return {
    connectorId: value.connector_id as string,
    connectorName: value.connector_name as string,
    toolId: value.tool_id as string,
    toolName: value.tool_name as string,
    callId: value.call_id as string,
    description: value.description as string,
    jsonSchema: structuredClone(value.json_schema),
  };
}

function gatewayResultIsError(value: unknown): boolean {
  return isObject(value) && (value.isError === true || value.is_error === true);
}

/** Exact `gateway_result_to_text`: supported content parts, then JSON fallback. */
export function gatewayResultToText(value: unknown): string {
  if (isObject(value) && Array.isArray(value.content)) {
    const parts = value.content.flatMap((item): string[] => {
      if (!isObject(item)) return [];
      if (item.type === "text" && typeof item.text === "string") return [item.text];
      if (item.type === "image" && typeof item.data === "string") {
        const mime = typeof item.mimeType === "string" ? item.mimeType
          : typeof item.mime_type === "string" ? item.mime_type : "image/png";
        return [`data:${mime};base64,${item.data}`];
      }
      if (item.type === "resource") return [JSON.stringify(item)];
      return [];
    });
    if (parts.length) return parts.join("\n");
  }
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "";
}

function gatewayErrorMessage(value: unknown): string | undefined {
  if (!isObject(value)) return;
  if (typeof value.error === "string") return value.error;
  return isObject(value.error) && typeof value.error.message === "string" ? value.error.message : undefined;
}

function rpcResult(id: string | number, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "Content-Type": "application/json" },
  });
}

function rpcProtocolError(id: string | number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    headers: { "Content-Type": "application/json" },
  });
}

function rpcHttpError(message: string, status: number): Response {
  return new Response(message, { status });
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
