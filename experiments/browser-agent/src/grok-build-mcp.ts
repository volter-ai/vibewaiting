import {
  GrokBuildMcpHttpClient,
  McpHttpError,
  McpProtocolError,
  type GrokBuildMcpHttpConfig,
  type McpCallToolResult,
  type McpJson,
  type McpJsonObject,
  type McpToolDescription,
} from "./grok-build-mcp-protocol.js";
import { searchMcpDocuments } from "./grok-build-mcp-search.js";

const MAX_MCP_DESCRIPTION_LENGTH = 2_048;
const DESCRIPTION_TRUNCATION_SUFFIX = "… [truncated]";
const DEFAULT_MAX_OUTPUT_BYTES = 20_000;
const TOOL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/u;

export interface GrokBuildMcpServerConfig extends GrokBuildMcpHttpConfig {
  disabledTools?: readonly string[];
}

export interface GrokBuildMcpRegistryOptions {
  enabledNativeToolNames?: ReadonlySet<string>;
  nativeToolCorrection?: boolean;
  maxOutputBytes?: number;
}

export interface GrokBuildMcpServices {
  searchTools(query: string, limit: number, signal: AbortSignal): Promise<string>;
  useTool(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}

interface IndexedTool {
  qualifiedName: string;
  serverName: string;
  toolName: string;
  description: string;
  parameters: string[];
  inputSchema: McpJsonObject;
  client: GrokBuildMcpHttpClient;
  exposeImageBase64: boolean;
}

interface ServerState {
  config: GrokBuildMcpServerConfig;
  client: GrokBuildMcpHttpClient;
  status: "idle" | "connecting" | "ready" | "failed";
  instructions: string | undefined;
  error: string | undefined;
  tools: IndexedTool[];
  pending: Promise<void> | undefined;
  notificationRefresh: Promise<void> | undefined;
}

/** Browser-native MCP catalog used by Grok Build's search_tool/use_tool pair. */
export class GrokBuildMcpRegistry {
  private readonly servers = new Map<string, ServerState>();
  private readonly enabledNativeToolNames: ReadonlySet<string>;
  private readonly nativeToolCorrection: boolean;
  private readonly maxOutputBytes: number;

  constructor(configs: readonly GrokBuildMcpServerConfig[], options: GrokBuildMcpRegistryOptions = {}) {
    this.enabledNativeToolNames = options.enabledNativeToolNames ?? new Set();
    this.nativeToolCorrection = options.nativeToolCorrection ?? true;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes <= 0) {
      throw new Error("MCP maxOutputBytes must be a positive integer.");
    }
    for (const config of configs) {
      if (this.servers.has(config.name)) throw new Error(`Duplicate MCP server name '${config.name}'.`);
      const client = new GrokBuildMcpHttpClient(config);
      const state: ServerState = {
        config,
        client,
        status: "idle",
        instructions: undefined,
        error: undefined,
        tools: [],
        pending: undefined,
        notificationRefresh: undefined,
      };
      client.onNotification((method) => {
        if (method !== "notifications/tools/list_changed" || state.status !== "ready" || state.notificationRefresh) return;
        const controller = new AbortController();
        state.notificationRefresh = this.reloadTools(state, controller.signal).finally(() => {
          state.notificationRefresh = undefined;
        });
        return state.notificationRefresh;
      });
      this.servers.set(config.name, state);
    }
  }

  /** Complete all handshakes and build a consistent discovery snapshot. */
  async connectAll(signal: AbortSignal): Promise<void> {
    await Promise.allSettled([...this.servers.values()].map((state) => this.connect(state, signal)));
    signal.throwIfAborted();
  }

  /** Refresh tools/list for one already configured server. */
  async refresh(serverName: string, signal: AbortSignal): Promise<void> {
    const state = this.servers.get(serverName);
    if (!state) throw new Error(`Unknown MCP server '${serverName}'.`);
    state.client.reset();
    state.status = "idle";
    state.pending = undefined;
    await this.connect(state, signal);
  }

  serverSummaries(): Array<{ name: string; description?: string; toolCount: number; toolNames: string[]; status: ServerState["status"]; error?: string }> {
    return [...this.servers.values()].sort((left, right) => left.config.name.localeCompare(right.config.name)).map((state) => ({
      name: state.config.name,
      ...(state.instructions ? { description: sanitizeDescription(state.instructions) } : {}),
      toolCount: state.tools.length,
      toolNames: state.tools.map((tool) => tool.toolName).sort(),
      status: state.status,
      ...(state.error ? { error: state.error } : {}),
    }));
  }

  /** Service callback matching GrokBuildBrowserServices.searchTools. */
  async searchTools(query: string, limit: number, signal: AbortSignal): Promise<string> {
    if (this.servers.size === 0) return noMcpToolsConfigured();
    validateSearchInput(query, limit);
    await this.connectAll(signal);
    return this.formatSearch(query, limit);
  }

  /** A non-blocking snapshot, useful while background handshakes are in flight. */
  formatSearch(query: string, limit = 5): string {
    validateSearchInput(query, limit);
    const tools = [...this.servers.values()].flatMap((state) => state.tools);
    const ranked = searchMcpDocuments(tools, query, limit);
    const groups: Array<{ server: string; score: number; tools: Array<Record<string, unknown>> }> = [];
    for (const tool of ranked) {
      const rendered = {
        tool_name: tool.qualifiedName,
        description: truncateDescription(tool.description),
        score: tool.score,
        input_schema: tool.inputSchema,
      };
      const group = groups.find((candidate) => candidate.server === tool.serverName);
      if (group) group.tools.push(rendered);
      else groups.push({ server: tool.serverName, score: tool.score, tools: [rendered] });
    }
    groups.sort((left, right) => right.score - left.score);
    const initialized = [...this.servers.values()].every((state) => state.status === "ready" || state.status === "failed");
    const results = groups.map(({ server, tools: groupedTools }) => ({ server, tools: groupedTools }));
    let note: string | null = null;
    if (!initialized) note = "Some MCP servers are still connecting. Results may be incomplete.";
    else if (tools.length === 0 && results.length === 0) {
      note = "No MCP tools are available in this session. Connect MCP servers here, or if this is a subagent, check the agent's mcpInheritance.";
    }
    return JSON.stringify({
      results,
      total_hidden_tools: tools.length,
      status: initialized ? "ready" : "partial",
      note,
    }, null, 2);
  }

  /** Service callback matching GrokBuildBrowserServices.useTool. */
  async useTool(qualifiedName: string, input: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    if (!qualifiedName.includes("__")) {
      if (this.nativeToolCorrection && this.enabledNativeToolNames.has(qualifiedName)) {
        throw new Error(`\`${qualifiedName}\` is a native tool, not an MCP integration tool. Call \`${qualifiedName}\` directly as its own tool call instead of routing it through \`use_tool\`.`);
      }
      throw new Error(`'${qualifiedName}' is not a valid MCP tool name. Tool names must be qualified as \`server__tool\` (e.g., \`linear__save_issue\`). Use \`search_tool\` to discover available tools.`);
    }
    const split = parseQualifiedName(qualifiedName);
    if (!split) throw new Error(`invalid tool name: '${qualifiedName}'`);
    const state = this.servers.get(split.server);
    if (!state) throw new Error(`MCP server '${split.server}' not found`);
    await this.connect(state, signal);
    let tool = state.tools.find((candidate) => candidate.qualifiedName === qualifiedName);
    if (!tool) {
      await this.refresh(split.server, signal);
      tool = state.tools.find((candidate) => candidate.qualifiedName === qualifiedName);
    }
    if (!tool) throw new Error(`MCP tool '${qualifiedName}' not found`);

    let result: McpCallToolResult;
    try {
      result = await tool.client.callTool(tool.toolName, input as McpJsonObject, signal);
    } catch (error) {
      if (!shouldReconnect(error)) throw error;
      await this.refresh(split.server, signal);
      const refreshed = state.tools.find((candidate) => candidate.qualifiedName === qualifiedName);
      if (!refreshed) throw new Error(`MCP tool '${qualifiedName}' disappeared after reconnect.`);
      result = await refreshed.client.callTool(refreshed.toolName, input as McpJsonObject, signal);
      tool = refreshed;
    }
    const logicalError = result.isError === true || result.is_error === true;
    const text = formatCallResult(result, tool.exposeImageBase64, logicalError);
    if (logicalError) {
      throw new Error(`Failed to call ${tool.toolName}: ${text}`);
    }
    return truncateMcpOutput(text, this.maxOutputBytes);
  }

  private connect(state: ServerState, signal: AbortSignal): Promise<void> {
    if (state.status === "ready" || state.status === "failed") return Promise.resolve();
    if (state.pending) return state.pending;
    state.status = "connecting";
    state.error = undefined;
    state.pending = (async () => {
      try {
        const initialized = await state.client.initialize(signal);
        state.instructions = initialized.instructions;
        await this.reloadTools(state, signal);
        state.status = "ready";
      } catch (error) {
        state.status = "failed";
        state.error = error instanceof Error ? error.message : String(error);
        state.tools = [];
        throw error;
      } finally {
        state.pending = undefined;
      }
    })();
    return state.pending;
  }

  private async reloadTools(state: ServerState, signal: AbortSignal): Promise<void> {
    const listed = await state.client.listTools(signal);
    state.tools = listed.flatMap((tool) => indexTool(state, tool));
  }
}

export function createGrokBuildMcpServices(
  configs: readonly GrokBuildMcpServerConfig[],
  options?: GrokBuildMcpRegistryOptions,
): { registry: GrokBuildMcpRegistry; services: GrokBuildMcpServices } {
  const registry = new GrokBuildMcpRegistry(configs, options);
  return {
    registry,
    services: {
      searchTools: (query, limit, signal) => registry.searchTools(query, limit, signal),
      useTool: (name, input, signal) => registry.useTool(name, input, signal),
    },
  };
}

function indexTool(state: ServerState, tool: McpToolDescription): IndexedTool[] {
  if (state.config.disabledTools?.includes(tool.name)) return [];
  const qualifiedName = `${state.config.name}__${tool.name}`;
  if (!parseQualifiedName(qualifiedName) || !TOOL_NAME_PATTERN.test(qualifiedName)) return [];
  const visibility = object(tool._meta?.ui)?.visibility;
  if (Array.isArray(visibility) && !visibility.includes("model")) return [];
  const schema: McpJsonObject = { ...(tool.inputSchema ?? {}) };
  if (!("type" in schema)) schema.type = "object";
  return [{
    qualifiedName,
    serverName: state.config.name,
    toolName: tool.name,
    description: tool.description ?? "",
    parameters: Object.keys(object(schema.properties) ?? {}).sort(),
    inputSchema: schema,
    client: state.client,
    exposeImageBase64: state.config.exposeImageBase64 ?? false,
  }];
}

function parseQualifiedName(name: string): { server: string; tool: string } | undefined {
  const boundaries: number[] = [];
  for (let index = 0; index < name.length - 1; index += 1) if (name.slice(index, index + 2) === "__") boundaries.push(index);
  if (boundaries.length !== 1) return undefined;
  const boundary = boundaries[0];
  if (boundary === undefined) return undefined;
  const server = name.slice(0, boundary);
  const tool = name.slice(boundary + 2);
  return server && tool ? { server, tool } : undefined;
}

function shouldReconnect(error: unknown): boolean {
  if (error instanceof McpProtocolError) {
    if ([-32700, -32600, -32601, -32602].includes(error.code)) return false;
    return !/unauthorized|forbidden|authentication|authorization|oauth/i.test(error.message);
  }
  if (error instanceof McpHttpError) return error.status !== 401 && error.status !== 403 && error.status !== 407;
  const detail = error instanceof Error ? error.message : String(error);
  return !/timed out|abort|unauthorized|forbidden|authentication|authorization|oauth/i.test(detail);
}

function formatCallResult(result: McpCallToolResult, exposeImageBase64: boolean, logicalError: boolean): string {
  const parts: string[] = [];
  for (const item of result.content ?? []) {
    const content = object(item);
    if (!content) continue;
    if (content.type === "text" && typeof content.text === "string") parts.push(content.text);
    else if (!logicalError && content.type === "image" && typeof content.data === "string") {
      const mime = typeof content.mimeType === "string" ? content.mimeType : typeof content.mime_type === "string" ? content.mime_type : "image/png";
      const uri = `data:${mime};base64,${content.data}`;
      parts.push(exposeImageBase64 ? `${uri}\n<mcp_image_base64 mime="${mime}">\n${content.data}\n</mcp_image_base64>` : uri);
    } else if (!logicalError && content.type === "resource") parts.push(JSON.stringify(item));
  }
  return parts.join("\n");
}

function truncateMcpOutput(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  const preview = new TextDecoder().decode(bytes.slice(0, maxBytes)).replace(/\uFFFD$/u, "");
  return `${preview}\n\n[MCP output truncated: showing first ${formatBytes(maxBytes)} of ${formatBytes(bytes.byteLength)}.]`;
}

function truncateDescription(value: string): string {
  if (value.length <= MAX_MCP_DESCRIPTION_LENGTH || [...value].length <= MAX_MCP_DESCRIPTION_LENGTH) return value;
  // Rust budgets using the UTF-8 byte length of the suffix (15), then takes chars.
  return [...value].slice(0, MAX_MCP_DESCRIPTION_LENGTH - new TextEncoder().encode(DESCRIPTION_TRUNCATION_SUFFIX).byteLength).join("") + DESCRIPTION_TRUNCATION_SUFFIX;
}

function sanitizeDescription(value: string): string {
  return value.split(/[\r\n]/u).flatMap((line) => line.trim().split(/\s+/u)).filter(Boolean).join(" ");
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = bytes / 1_024;
  for (const unit of units) {
    if (value < 1_023.95) return `${value.toFixed(1)} ${unit}`;
    value /= 1_024;
  }
  return `${value.toFixed(1)} EB`;
}

function validateSearchInput(query: string, limit: number): void {
  if (!query) throw new Error("query must be a non-empty string");
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 255) throw new Error("limit must be an integer between 0 and 255");
}

function object(value: McpJson | undefined): McpJsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function noMcpToolsConfigured(): string {
  return JSON.stringify({
    results: [],
    total_hidden_tools: 0,
    note: "No integration tools are configured. MCP servers are not connected.",
  }, null, 2);
}
