import {
  McpSseDecoder,
  validateElicitationRequest,
  validateElicitationResult,
  type McpEventHandlers,
} from "./grok-build-mcp-events.js";
import { GrokBuildMcpOAuthClient, type GrokBuildMcpOAuthOptions } from "./grok-build-mcp-oauth.js";

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
  oauth?: GrokBuildMcpOAuthOptions;
  events?: McpEventHandlers;
  /** Native opens a resumable GET SSE stream whenever the server issues a session ID. */
  enableEventStream?: boolean;
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
  private readonly oauth: GrokBuildMcpOAuthClient | undefined;
  private eventStreamController: AbortController | undefined;
  private readonly pendingServerRequests = new Map<string, AbortController>();
  private readonly notificationListeners = new Set<(method: string, params: McpJsonObject) => void | Promise<void>>();
  private readonly fetchImpl: typeof fetch;

  constructor(readonly config: GrokBuildMcpHttpConfig) {
    validateHttpConfig(config);
    this.fetchImpl = config.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.oauth = config.oauth ? new GrokBuildMcpOAuthClient(
      config.name,
      config.url,
      config.oauth,
      this.fetchImpl,
      config.headers,
    ) : undefined;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  onNotification(listener: (method: string, params: McpJsonObject) => void | Promise<void>): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  reset(): void {
    this.eventStreamController?.abort();
    this.eventStreamController = undefined;
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
        ...(this.config.events?.onElicitation ? {
          elicitation: {
            form: { schemaValidation: true },
            url: {},
          },
        } : {}),
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
    if (this.sessionId && (this.config.enableEventStream ?? true)) this.startEventStream();
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

  async close(signal: AbortSignal): Promise<void> {
    this.eventStreamController?.abort();
    this.eventStreamController = undefined;
    if (!this.sessionId) return;
    const headers = await this.requestHeaders(signal, true);
    const response = await this.fetchImpl(this.config.url, {
      method: "DELETE", headers, signal, credentials: "omit", redirect: "error",
    });
    if (!response.ok && response.status !== 405) throw new McpHttpError(`MCP server '${this.config.name}' returned HTTP ${response.status} while closing its session.`, response.status);
    this.sessionId = undefined;
    this.initialized = false;
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
    try {
      return await this.postOnce(payload, expectedId, signal, timeoutMs, includeProtocolVersion, false);
    } catch (error) {
      if (!(error instanceof McpHttpError) || ![401, 403].includes(error.status) || !this.oauth) throw error;
      await this.oauth.invalidate();
      return this.postOnce(payload, expectedId, signal, timeoutMs, includeProtocolVersion, true);
    }
  }

  private async postOnce(
    payload: McpJsonObject,
    expectedId: number | undefined,
    signal: AbortSignal,
    timeoutMs: number,
    includeProtocolVersion: boolean,
    forceOAuth: boolean,
  ): Promise<JsonRpcResponse[]> {
    const headers = await this.requestHeaders(signal, includeProtocolVersion, forceOAuth);
    headers.set("Content-Type", "application/json");
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(new DOMException("MCP request timed out.", "TimeoutError")), timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.config.url, {
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
    const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
    const values = contentType.includes("text/event-stream")
      ? await this.readSseResponse(response, expectedId, signal)
      : await response.text().then((text) => text.trim() ? [parseJson(text, this.config.name)] : []);
    await this.handleIncomingValues(values, signal);
    const responses = values.flatMap((value) => Array.isArray(value) ? value : [value])
      .map(toJsonRpcResponse)
      .filter((value): value is JsonRpcResponse => value !== undefined);
    if (expectedId !== undefined && responses.length === 0) {
      throw new Error(`MCP server '${this.config.name}' returned no JSON-RPC response in its ${contentType || "unknown"} payload.`);
    }
    return responses;
  }

  private async requestHeaders(signal: AbortSignal, includeProtocolVersion: boolean, forceOAuth = false): Promise<Headers> {
    const headers = new Headers(this.config.headers);
    headers.set("Accept", "application/json, text/event-stream");
    if (this.sessionId) headers.set("Mcp-Session-Id", this.sessionId);
    if (includeProtocolVersion) headers.set("MCP-Protocol-Version", this.negotiatedProtocolVersion);
    const token = await this.oauth?.accessToken(signal, forceOAuth);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return headers;
  }

  private async readSseResponse(response: Response, expectedId: number | undefined, signal: AbortSignal): Promise<McpJson[]> {
    if (!response.body) return [];
    const reader = response.body.getReader();
    const text = new TextDecoder();
    const decoder = new McpSseDecoder();
    const values: McpJson[] = [];
    try {
      for (;;) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        for (const event of decoder.push(chunk.done ? text.decode() : text.decode(chunk.value, { stream: true }), chunk.done)) {
          if (!matchesMessageEvent(event.event) || !event.data) continue;
          const value = parseJson(event.data, "SSE event");
          values.push(value);
          if (expectedId !== undefined && responseContainsId(value, expectedId)) {
            await reader.cancel();
            return values;
          }
        }
        if (chunk.done) return values;
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async handleIncomingValues(values: McpJson[], signal: AbortSignal): Promise<void> {
    for (const value of values.flatMap((item) => Array.isArray(item) ? item : [item])) {
      if (!isObject(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") continue;
      const params = isObject(value.params) ? value.params : {};
      if (value.id !== undefined && (typeof value.id === "number" || typeof value.id === "string")) {
        void this.handleServerRequest(value.id, value.method, params, signal);
      } else {
        await this.handleNotification(value.method, params);
      }
    }
  }

  private async handleNotification(method: string, params: McpJsonObject): Promise<void> {
    if (method === "notifications/cancelled") {
      const id = params.requestId ?? params.request_id;
      if (typeof id === "string" || typeof id === "number") this.pendingServerRequests.get(String(id))?.abort();
    } else if (method === "notifications/elicitation/complete") {
      const id = params.elicitationId ?? params.elicitation_id;
      if (typeof id === "string" && [...id].length <= 128) await this.config.events?.onElicitationComplete?.(id);
    }
    await this.config.events?.onNotification?.(method, params);
    await Promise.all([...this.notificationListeners].map((listener) => listener(method, params)));
  }

  private async handleServerRequest(id: string | number, method: string, params: McpJsonObject, parentSignal: AbortSignal): Promise<void> {
    const controller = new AbortController();
    this.pendingServerRequests.set(String(id), controller);
    let response: McpJsonObject;
    try {
      if (method !== "elicitation/create") {
        response = { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
      } else {
        const request = validateElicitationRequest(this.config.name, params);
        let result = request && this.config.events?.onElicitation
          ? await this.config.events.onElicitation(request, AbortSignal.any([parentSignal, controller.signal]))
          : { action: "decline" as const };
        if (controller.signal.aborted) result = { action: "cancel" };
        response = { jsonrpc: "2.0", id, result: validateElicitationResult(result) as unknown as McpJson };
      }
    } catch (error) {
      response = { jsonrpc: "2.0", id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } };
    } finally {
      this.pendingServerRequests.delete(String(id));
    }
    await this.post(response, undefined, parentSignal, this.config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS);
  }

  private startEventStream(): void {
    this.eventStreamController?.abort();
    const controller = new AbortController();
    this.eventStreamController = controller;
    void this.runEventStream(controller.signal).catch(() => undefined);
  }

  private async runEventStream(signal: AbortSignal): Promise<void> {
    let lastEventId: string | undefined;
    let serverRetryMs: number | undefined;
    let failures = 0;
    while (!signal.aborted && this.sessionId) {
      try {
        const headers = await this.requestHeaders(signal, true);
        if (lastEventId) headers.set("Last-Event-ID", lastEventId);
        const response = await this.fetchImpl(this.config.url, { method: "GET", headers, signal, credentials: "omit", redirect: "error" });
        if (response.status === 405) return;
        if (!response.ok) throw new McpHttpError(`MCP server '${this.config.name}' event stream returned HTTP ${response.status}.`, response.status);
        if (!response.body) return;
        const reader = response.body.getReader();
        const text = new TextDecoder();
        const decoder = new McpSseDecoder();
        for (;;) {
          const chunk = await reader.read();
          for (const event of decoder.push(chunk.done ? text.decode() : text.decode(chunk.value, { stream: true }), chunk.done)) {
            if (event.id !== undefined) lastEventId = event.id;
            if (event.retry !== undefined) serverRetryMs = event.retry;
            if (matchesMessageEvent(event.event) && event.data) {
              const value = parseJson(event.data, "MCP event stream");
              await this.handleIncomingValues([value], signal);
            }
          }
          if (chunk.done) break;
        }
        failures = 0;
      } catch (error) {
        if (signal.aborted) return;
        failures += 1;
      }
      const exponential = 1_000 * (2 ** Math.min(Math.max(0, failures - 1), 16));
      await abortableDelay(serverRetryMs ?? (failures ? exponential : 1_000), signal);
    }
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

function matchesMessageEvent(event: string | undefined): boolean {
  return event === undefined || event === "" || event === "message";
}

function responseContainsId(value: McpJson, id: number): boolean {
  return Array.isArray(value)
    ? value.some((item) => isObject(item) && item.id === id)
    : isObject(value) && value.id === id;
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      globalThis.clearTimeout(timer);
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    }, { once: true });
  });
}
