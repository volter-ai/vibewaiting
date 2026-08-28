/** JSON values accepted by the Model Context Protocol wire format. */
export type McpJson = null | boolean | number | string | McpJson[] | { [key: string]: McpJson };
export type McpJsonObject = { [key: string]: McpJson };

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

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number;
  result: McpJson;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: McpJson };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export function parseMcpTool(value: McpJson, server: string): McpToolDescription {
  const tool = asMcpObject(value, `tool from '${server}'`);
  if (typeof tool.name !== "string" || !tool.name) throw new Error(`MCP server '${server}' returned a tool without a name.`);
  const parsed: McpToolDescription = { name: tool.name };
  if (typeof tool.description === "string") parsed.description = tool.description;
  if (isMcpObject(tool.inputSchema)) parsed.inputSchema = tool.inputSchema;
  if (isMcpObject(tool._meta)) parsed._meta = tool._meta;
  return parsed;
}

export function parseMcpJson(text: string, source: string): McpJson {
  try {
    return JSON.parse(text) as McpJson;
  } catch (cause) {
    throw new Error(`Invalid JSON from ${source}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export function toJsonRpcResponse(value: McpJson): JsonRpcResponse | undefined {
  if (!isMcpObject(value) || value.jsonrpc !== "2.0" || !(typeof value.id === "number" || typeof value.id === "string" || value.id === null)) return undefined;
  if (!("result" in value) && !(isMcpObject(value.error) && typeof value.error.code === "number" && typeof value.error.message === "string")) return undefined;
  return value as unknown as JsonRpcResponse;
}

export function asMcpObject(value: McpJson, label: string): McpJsonObject {
  if (!isMcpObject(value)) throw new Error(`${label} must be a JSON object.`);
  return value;
}

export function isMcpObject(value: McpJson | undefined): value is McpJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function matchesMcpMessageEvent(event: string | undefined): boolean {
  return event === undefined || event === "" || event === "message";
}

export function mcpResponseContainsId(value: McpJson, id: number): boolean {
  return Array.isArray(value)
    ? value.some((item) => isMcpObject(item) && item.id === id)
    : isMcpObject(value) && value.id === id;
}
