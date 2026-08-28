import type { McpJson, McpJsonObject } from "./grok-build-mcp-protocol.js";
import { parseElicitationFormSchema, validateElicitationContent } from "./grok-build-mcp-elicitation.js";

export const MAX_ELICIT_MESSAGE_CHARS = 4_096;
export const MAX_ELICIT_URL_CHARS = 2_048;
export const MAX_ELICIT_ID_CHARS = 128;
export const MAX_ELICIT_SCHEMA_BYTES = 64 * 1_024;

export type McpElicitationResult =
  | { action: "accept"; content?: McpJson }
  | { action: "decline" }
  | { action: "cancel" };

export type McpElicitationRequest =
  | { serverName: string; mode: "form"; message: string; requestedSchema: McpJsonObject }
  | { serverName: string; mode: "url"; message: string; url: string; elicitationId: string };

export interface McpEventHandlers {
  onNotification?(method: string, params: McpJsonObject): void | Promise<void>;
  onElicitation?(request: McpElicitationRequest, signal: AbortSignal): Promise<McpElicitationResult>;
  onElicitationComplete?(elicitationId: string): void | Promise<void>;
}

export interface McpSseEvent {
  event?: string;
  data?: string;
  id?: string;
  retry?: number;
}

/** Incremental SSE decoder matching rmcp's message/control-frame behavior. */
export class McpSseDecoder {
  private buffer = "";
  private pendingCarriageReturn = false;

  push(chunk: string, flush = false): McpSseEvent[] {
    let input = this.pendingCarriageReturn ? `\r${chunk}` : chunk;
    this.pendingCarriageReturn = false;
    if (!flush && input.endsWith("\r")) {
      this.pendingCarriageReturn = true;
      input = input.slice(0, -1);
    }
    this.buffer += input.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    if (flush && this.pendingCarriageReturn) {
      this.buffer += "\n";
      this.pendingCarriageReturn = false;
    }
    const events: McpSseEvent[] = [];
    for (;;) {
      const boundary = this.buffer.indexOf("\n\n");
      if (boundary < 0) break;
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const event = parseEventBlock(block);
      if (event) events.push(event);
    }
    if (flush && this.buffer) {
      const event = parseEventBlock(this.buffer);
      this.buffer = "";
      if (event) events.push(event);
    }
    return events;
  }
}

export function validateElicitationRequest(serverName: string, params: McpJsonObject): McpElicitationRequest | undefined {
  if (typeof params.message !== "string" || !charsWithin(params.message, MAX_ELICIT_MESSAGE_CHARS)) return undefined;
  if (isObject(params.requestedSchema)) {
    if (new TextEncoder().encode(JSON.stringify(params.requestedSchema)).byteLength > MAX_ELICIT_SCHEMA_BYTES) return undefined;
    return { serverName, mode: "form", message: params.message, requestedSchema: params.requestedSchema };
  }
  const elicitationId = typeof params.elicitationId === "string" ? params.elicitationId
    : typeof params.elicitation_id === "string" ? params.elicitation_id : undefined;
  if (typeof params.url !== "string" || !elicitationId
    || !charsWithin(params.url, MAX_ELICIT_URL_CHARS)
    || !charsWithin(elicitationId, MAX_ELICIT_ID_CHARS)) return undefined;
  return { serverName, mode: "url", message: params.message, url: params.url, elicitationId };
}

export function validateElicitationResult(result: McpElicitationResult): McpElicitationResult {
  if (result.action !== "accept") return result;
  if (result.content === undefined) return result;
  if (new TextEncoder().encode(JSON.stringify(result.content)).byteLength > MAX_ELICIT_SCHEMA_BYTES) return { action: "decline" };
  return result;
}

export function validateElicitationResultForRequest(request: McpElicitationRequest | undefined, result: McpElicitationResult): McpElicitationResult {
  const bounded = validateElicitationResult(result);
  if (bounded.action !== "accept" || request?.mode !== "form" || bounded.content === undefined) return bounded;
  try {
    parseElicitationFormSchema(request.requestedSchema);
    const content = validateElicitationContent(request.requestedSchema, bounded.content);
    return content ? { action: "accept", content } : { action: "decline" };
  } catch {
    return { action: "decline" };
  }
}

function parseEventBlock(block: string): McpSseEvent | undefined {
  const data: string[] = [];
  const event: McpSseEvent = {};
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /u, "");
    if (field === "data") data.push(value);
    else if (field === "event") event.event = value;
    else if (field === "id" && !value.includes("\0")) event.id = value;
    else if (field === "retry" && /^\d+$/u.test(value)) event.retry = Number(value);
  }
  if (data.length > 0) event.data = data.join("\n");
  return Object.keys(event).length > 0 ? event : undefined;
}

function charsWithin(value: string, maximum: number): boolean {
  return [...value].length <= maximum;
}

function isObject(value: McpJson | undefined): value is McpJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
