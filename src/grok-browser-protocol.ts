/**
 * Browser-safe translation of Grok Build's Responses API wire protocol.
 *
 * Ported from xAI's Apache-2.0 grok-build sources, principally:
 * - xai-grok-sampler/src/client.rs
 * - xai-grok-sampling-types/src/conversation/responses.rs
 *
 * This module deliberately contains no credential handling, filesystem access,
 * or Node-only APIs. A same-origin relay adds the user's bearer token and sends
 * the resulting request upstream.
 */

export const GROK_BUILD_COMPAT_VERSION = "1.0.5";
export const GROK_BUILD_MODEL = "grok-4.6";
export const GROK_BUILD_AGENT_ID = "4f13d338-6255-5546-8c1d-12bf640aa33b";

export interface GrokFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters: unknown;
}

export interface GrokHostedTool {
  type: string;
  [key: string]: unknown;
}

export type GrokTool = GrokFunctionTool | GrokHostedTool;

export type GrokInputItem = Record<string, unknown> & {
  type: string;
};

export interface GrokResponsesRequest {
  include: ["reasoning.encrypted_content"];
  input: GrokInputItem[];
  model: string;
  prompt_cache_key: string;
  reasoning: {
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
    summary: "concise";
  };
  store: false;
  stream: true;
  tools?: GrokTool[];
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  tool_choice?: unknown;
  text?: unknown;
}

export interface GrokTurnIdentity {
  conversationId: string;
  requestId: string;
  sessionId: string;
  promptIndex: number;
  agentId?: string;
}

export interface GrokHeaderOptions {
  clientVersion?: string;
  userId?: string;
  traceparent?: string;
  bearerToken?: string;
  model?: string;
  /** `null` omits the native header after the first successful compaction. */
  compactionAtTokens?: number | null;
}

export interface GrokResponseOutputItem extends Record<string, unknown> {
  type?: string;
}

export interface GrokCompletedResponse extends Record<string, unknown> {
  output?: GrokResponseOutputItem[];
}

export interface GrokSseEvent extends Record<string, unknown> {
  type?: string;
  delta?: string;
  response?: GrokCompletedResponse;
}

export interface GrokStreamResult {
  response: GrokCompletedResponse;
  text: string;
  reasoning: string;
}

const SESSION_TITLE_SYSTEM_PROMPT = `You are tasked with generating the session title. The user is asking almost always software engineering related questions on their codebase.
We describe the session title below
# Session Title
A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler.

You will be given the user query below encapsulated in <user_query></user_query>.

Just generate the session_title and nothing else`;

export function createGrokSessionTitleRequest(
  userQuery: string,
  model = GROK_BUILD_MODEL,
): Omit<GrokResponsesRequest, "prompt_cache_key"> {
  return {
    include: ["reasoning.encrypted_content"],
    input: [
      { type: "message", role: "system", content: SESSION_TITLE_SYSTEM_PROMPT },
      { type: "message", role: "user", content: `<user_query>\n${userQuery}\n</user_query>` },
    ],
    max_output_tokens: 100,
    model,
    reasoning: { summary: "concise" },
    store: false,
    stream: true,
    temperature: 1,
    tool_choice: { name: "session_title", type: "function" },
    tools: [{
      type: "function",
      name: "session_title",
      description: "Generate the session_title which we use for the user_message",
      parameters: {
        type: "object",
        properties: {
          session_title: {
            type: "string",
            description: "Final session title, just 5-10 word descriptive title for the session. Super info dense, no filler.",
          },
        },
        required: ["session_title"],
        additionalProperties: false,
      },
    }],
  };
}

export function createGrokSessionTitleHeaders(options: GrokHeaderOptions = {}): Record<string, string> {
  return {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    ...(options.bearerToken ? { Authorization: `Bearer ${options.bearerToken}` } : {}),
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-authenticateresponse": "authenticate-response",
    "x-grok-agent-id": "",
    "x-grok-client-identifier": "grok-shell",
    "x-grok-client-mode": "headless",
    "x-grok-client-version": options.clientVersion ?? GROK_BUILD_COMPAT_VERSION,
    "x-grok-conv-id": "",
    "x-grok-model-override": options.model ?? GROK_BUILD_MODEL,
    "x-grok-req-id": "",
    "x-grok-session-id": "",
  };
}

export function createGrokResponsesRequest(options: {
  input: readonly GrokInputItem[];
  tools?: readonly GrokTool[];
  sessionId: string;
  model?: string;
  reasoningEffort?: GrokResponsesRequest["reasoning"]["effort"];
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  toolChoice?: unknown;
  text?: unknown;
}): GrokResponsesRequest {
  const request: GrokResponsesRequest = {
    include: ["reasoning.encrypted_content"],
    input: options.input.map((item) => structuredClone(item)),
    model: options.model ?? GROK_BUILD_MODEL,
    prompt_cache_key: options.sessionId,
    reasoning: {
      ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
      summary: "concise",
    },
    store: false,
    stream: true,
    ...(options.tools && options.tools.length > 0
      ? { tools: options.tools.map((tool) => structuredClone(tool)) }
      : {}),
    ...(options.maxOutputTokens !== undefined ? { max_output_tokens: options.maxOutputTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.topP !== undefined ? { top_p: options.topP } : {}),
    ...(options.toolChoice !== undefined ? { tool_choice: structuredClone(options.toolChoice) } : {}),
    ...(options.text !== undefined ? { text: structuredClone(options.text) } : {}),
  };
  patchReasoningTextTypes(request.input);
  return request;
}

/** Build the headers that Grok Build applies to every foreground Responses call. */
export function createGrokResponsesHeaders(
  identity: GrokTurnIdentity,
  options: GrokHeaderOptions = {},
): Record<string, string> {
  if (!Number.isSafeInteger(identity.promptIndex) || identity.promptIndex < 1) {
    throw new Error("Grok promptIndex must be a positive integer.");
  }
  return {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    ...(options.bearerToken ? { Authorization: `Bearer ${options.bearerToken}` } : {}),
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-authenticateresponse": "authenticate-response",
    ...(options.compactionAtTokens === null
      ? {}
      : { "x-compaction-at": String(options.compactionAtTokens ?? 400_000) }),
    "x-compactions-remaining": "1",
    "x-grok-agent-id": identity.agentId ?? GROK_BUILD_AGENT_ID,
    "x-grok-client-identifier": "grok-shell",
    "x-grok-client-mode": "headless",
    "x-grok-client-version": options.clientVersion ?? GROK_BUILD_COMPAT_VERSION,
    "x-grok-conv-id": identity.conversationId,
    "x-grok-doom-loop-check": "1024",
    "x-grok-model-override": options.model ?? GROK_BUILD_MODEL,
    "x-grok-req-id": identity.requestId,
    "x-grok-session-id": identity.sessionId,
    "x-grok-turn-idx": String(identity.promptIndex),
    ...(options.userId ? { "x-grok-user-id": options.userId } : {}),
    ...(options.traceparent ? { traceparent: options.traceparent } : {}),
  };
}

/** Native recap/dashboard side-call headers: foreground identity without a turn index. */
export function createGrokSideCallHeaders(
  identity: Omit<GrokTurnIdentity, "promptIndex">,
  options: GrokHeaderOptions = {},
): Record<string, string> {
  const headers = createGrokResponsesHeaders({ ...identity, promptIndex: 1 }, options);
  delete headers["x-grok-turn-idx"];
  return headers;
}

/**
 * Translate a completed Responses output back into the exact item families
 * Grok Build replays on the next tool-loop request.
 */
export function responseToConversationInput(response: GrokCompletedResponse): GrokInputItem[] {
  const replay: GrokInputItem[] = [];
  const assistantText: string[] = [];
  const calls: GrokInputItem[] = [];

  for (const rawItem of response.output ?? []) {
    const item = structuredClone(rawItem);
    switch (item.type) {
      case "message": {
        const content = Array.isArray(item.content) ? item.content : [];
        for (const part of content) {
          if (isObject(part) && part.type === "output_text" && typeof part.text === "string") {
            assistantText.push(part.text);
          }
        }
        break;
      }
      case "function_call": {
        const { call_id, name, arguments: args } = item;
        calls.push({
          type: "function_call",
          call_id: stringOrEmpty(call_id),
          name: stringOrEmpty(name),
          arguments: stringOrEmpty(args),
        });
        break;
      }
      case "reasoning": {
        delete item.status;
        replay.push(item as GrokInputItem);
        break;
      }
      case "web_search_call":
      case "custom_tool_call":
      case "code_interpreter_call":
        replay.push(item as GrokInputItem);
        break;
      default:
        break;
    }
  }

  if (assistantText.length > 0) {
    replay.push({ type: "message", role: "assistant", content: assistantText.join("\n") });
  }
  replay.push(...calls);
  return replay;
}

export function functionCallOutput(callId: string, output: string): GrokInputItem {
  return { type: "function_call_output", call_id: callId, output };
}

/** Parse and expose every Responses SSE event without buffering the fetch body. */
export async function* parseGrokResponsesSse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<GrokSseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const blocks = pending.split(/\r?\n\r?\n/u);
      pending = done ? "" : blocks.pop() ?? "";
      for (const block of blocks) {
        const event = parseSseBlock(block);
        if (event) yield event;
      }
      if (done) {
        const finalEvent = parseSseBlock(pending);
        if (finalEvent) yield finalEvent;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function collectGrokResponsesStream(
  stream: ReadableStream<Uint8Array>,
  onEvent?: (event: GrokSseEvent) => void,
): Promise<GrokStreamResult> {
  let text = "";
  let reasoning = "";
  let completed: GrokCompletedResponse | undefined;
  for await (const event of parseGrokResponsesSse(stream)) {
    onEvent?.(event);
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
    if (event.type === "response.reasoning_summary_text.delta" && typeof event.delta === "string") {
      reasoning += event.delta;
    }
    if (event.type === "response.completed" && isObject(event.response)) completed = event.response;
    if (event.type === "error") throw new Error(errorMessage(event));
  }
  if (!completed) throw new Error("Grok Responses stream ended without response.completed.");
  return { response: completed, text, reasoning };
}

function patchReasoningTextTypes(items: GrokInputItem[]): void {
  for (const item of items) {
    if (item.type !== "reasoning" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isObject(part) && part.type === undefined) part.type = "reasoning_text";
    }
  }
}

function parseSseBlock(block: string): GrokSseEvent | undefined {
  const data = block
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /u, ""))
    .join("\n");
  if (!data || data === "[DONE]") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch (error) {
    throw new Error(`Grok returned malformed SSE JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(parsed)) throw new Error("Grok returned a non-object SSE event.");
  return parsed;
}

function errorMessage(event: GrokSseEvent): string {
  const error = event.error;
  if (isObject(error) && typeof error.message === "string") return error.message;
  return "Grok Responses stream returned an error event.";
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
