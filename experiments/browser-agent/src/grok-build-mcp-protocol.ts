/** JSON values accepted by the Model Context Protocol wire format. */
export type McpJson = null | boolean | number | string | McpJson[] | { [key: string]: McpJson };

export type McpJsonObject = { [key: string]: McpJson };

export interface GrokBuildMcpHttpConfig {
  name: string;
  url: string;
  headers?: Readonly<Record<string, string>>;
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  /** Used by tests and by a stateless CORS/credential relay. */
  fetchImpl?: typeof fetch;
  clientVersion?: string;
  exposeImageBase64?: boolean;
}

export interface McpToolDescription {
  name: string;
  description?: string;
  inputSchema?: McpJsonObject;
  _meta?: McpJsonObject;
}

export interface McpCallToolResult {
  content?: McpJson[];
  isError?: boolean;
  is_error?: boolean;
  structuredContent?: McpJson;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number;
  result: McpJson;
}

interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: McpJson };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

const MCP_PROTOCOL_VERSION = "2025-11-25";
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

export class McpProtocolError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: McpJson,
  ) {
    super(message);
    this.name = "McpProtocolError";
  }
}

export class McpHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "McpHttpError";
  }
}

/**
 * Browser implementation of MCP Streamable HTTP.
 *
 * Grok Build currently pins protocol version 2025-11-25. Like its native
 * rmcp transport, this client accepts both JSON and SSE responses, remembers
 * `Mcp-Session-Id`, sends `notifications/initialized`, and paginates tools/list.
 */
export class GrokBuildMcpHttpClient {
  private nextRequestId = 1;
  private sessionId: string | undefined;
  private negotiatedProtocolVersion = MCP_PROTOCOL_VERSION;
  private initialized = false;

  constructor(readonly config: GrokBuildMcpHttpConfig) {
    validateHttpConfig(config);
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  reset(): void {
    this.sessionId = undefined;
    this.initialized = false;
    this.negotiatedProtocolVersion = MCP_PROTOCOL_VERSION;
  }

  async initialize(signal: AbortSignal): Promise<{ instructions?: string }> {
    if (this.initialized) return {};
    const response = await this.rpc("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        extensions: {
          "io.modelcontextprotocol/ui": {
            mimeTypes: ["text/html;profile=mcp-app"],
          },
        },
      },
      clientInfo: {
        name: `grok-shell-${this.config.name}`,
        version: this.config.clientVersion ?? "browser-port",
      },
    }, signal, this.config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS, false);
    const result = asObject(response, "initialize result");
    if (typeof result.protocolVersion === "string") {
      this.negotiatedProtocolVersion = result.protocolVersion;
    }
    await this.notify("notifications/initialized", signal);
    this.initialized = true;
    return typeof result.instructions === "string" ? { instructions: result.instructions } : {};
  }

  async listTools(signal: AbortSignal): Promise<McpToolDescription[]> {
    await this.initialize(signal);
    const tools: McpToolDescription[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (;;) {
      const raw = await this.rpc(
        "tools/list",
        cursor === undefined ? {} : { cursor },
        signal,
        this.config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      );
      const result = asObject(raw, "tools/list result");
      if (!Array.isArray(result.tools)) throw new Error(`MCP server '${this.config.name}' returned tools/list without a tools array.`);
      for (const item of result.tools) tools.push(parseTool(item, this.config.name));
      if (typeof result.nextCursor !== "string" || result.nextCursor.length === 0) break;
      if (seenCursors.has(result.nextCursor)) {
        throw new Error(`MCP server '${this.config.name}' repeated tools/list cursor '${result.nextCursor}'.`);
      }
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    return tools;
  }

  async callTool(name: string, args: McpJsonObject, signal: AbortSignal): Promise<McpCallToolResult> {
    await this.initialize(signal);
    const result = await this.rpc(
      "tools/call",
      { name, arguments: args },
      signal,
      this.config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    );
    return asObject(result, "tools/call result") as McpCallToolResult;
  }

  private async notify(method: string, signal: AbortSignal): Promise<void> {
    await this.post({ jsonrpc: "2.0", method }, undefined, signal, this.config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
  }

  private async rpc(
    method: string,
    params: McpJsonObject,
    signal: AbortSignal,
    timeoutMs: number,
    includeProtocolVersion = true,
  ): Promise<McpJson> {
    const id = this.nextRequestId++;
    const responses = await this.post(
      { jsonrpc: "2.0", id, method, params },
      id,
      signal,
      timeoutMs,
      includeProtocolVersion,
    );
    const response = responses.find((candidate) => candidate.id === id);
    if (!response) throw new Error(`MCP server '${this.config.name}' did not return JSON-RPC response ${id}.`);
    if ("error" in response) throw new McpProtocolError(response.error.message, response.error.code, response.error.data);
    return response.result;
  }

  private async post(
    payload: McpJsonObject,
    expectedId: number | undefined,
    signal: AbortSignal,
    timeoutMs: number,
    includeProtocolVersion = true,
  ): Promise<JsonRpcResponse[]> {
    const headers = new Headers(this.config.headers);
    // Protocol-required values win over configured values, matching native.
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json, text/event-stream");
    if (this.sessionId) headers.set("Mcp-Session-Id", this.sessionId);
    if (includeProtocolVersion) headers.set("MCP-Protocol-Version", this.negotiatedProtocolVersion);
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(new DOMException("MCP request timed out.", "TimeoutError")), timeoutMs);
    let response: Response;
    try {
      response = await (this.config.fetchImpl ?? fetch)(this.config.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.any([signal, controller.signal]),
        credentials: "omit",
        redirect: "error",
      });
    } catch (cause) {
      if (controller.signal.aborted && !signal.aborted) {
        throw new Error(`MCP server '${this.config.name}' timed out after ${Math.ceil(timeoutMs / 1_000)} seconds.`);
      }
      throw cause;
    } finally {
      globalThis.clearTimeout(timer);
    }

    const returnedSessionId = response.headers.get("Mcp-Session-Id");
    if (returnedSessionId) this.sessionId = returnedSessionId;
    if (!response.ok) {
      const detail = (await response.text()).trim();
      throw new McpHttpError(
        `MCP server '${this.config.name}' returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
        response.status,
      );
    }
    if (response.status === 202 || response.status === 204) return [];
    const text = await response.text();
    if (!text.trim()) return [];
    const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
    const values = contentType.includes("text/event-stream") ? parseSseJson(text) : [parseJson(text, this.config.name)];
    const responses = values.flatMap((value) => Array.isArray(value) ? value : [value])
      .map(toJsonRpcResponse)
      .filter((value): value is JsonRpcResponse => value !== undefined);
    if (expectedId !== undefined && responses.length === 0) {
      throw new Error(`MCP server '${this.config.name}' returned no JSON-RPC response in its ${contentType || "unknown"} payload.`);
    }
    return responses;
  }
}

function validateHttpConfig(config: GrokBuildMcpHttpConfig): void {
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

function parseTool(value: McpJson, server: string): McpToolDescription {
  const tool = asObject(value, `tool from '${server}'`);
  if (typeof tool.name !== "string" || !tool.name) throw new Error(`MCP server '${server}' returned a tool without a name.`);
  const parsed: McpToolDescription = { name: tool.name };
  if (typeof tool.description === "string") parsed.description = tool.description;
  if (isObject(tool.inputSchema)) parsed.inputSchema = tool.inputSchema;
  if (isObject(tool._meta)) parsed._meta = tool._meta;
  return parsed;
}

function parseSseJson(body: string): McpJson[] {
  const values: McpJson[] = [];
  for (const event of body.replaceAll("\r\n", "\n").split("\n\n")) {
    const data = event.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /u, ""))
      .join("\n");
    if (data && data !== "[DONE]") values.push(parseJson(data, "SSE event"));
  }
  return values;
}

function parseJson(text: string, source: string): McpJson {
  try {
    return JSON.parse(text) as McpJson;
  } catch (cause) {
    throw new Error(`Invalid JSON from ${source}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function toJsonRpcResponse(value: McpJson): JsonRpcResponse | undefined {
  if (!isObject(value) || value.jsonrpc !== "2.0" || !(typeof value.id === "number" || typeof value.id === "string" || value.id === null)) return undefined;
  if (!("result" in value) && !(isObject(value.error) && typeof value.error.code === "number" && typeof value.error.message === "string")) return undefined;
  return value as unknown as JsonRpcResponse;
}

function asObject(value: McpJson, label: string): McpJsonObject {
  if (!isObject(value)) throw new Error(`${label} must be a JSON object.`);
  return value;
}

function isObject(value: McpJson | undefined): value is McpJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
