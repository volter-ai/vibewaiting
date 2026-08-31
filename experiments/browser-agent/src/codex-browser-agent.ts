import initCodexWasm, { CodexBrowserCore } from "./generated-codex-wasm/codex_browser_core_wasm.js";
import { collectGrokResponsesStream, type GrokTool } from "../../../src/grok-browser-protocol.js";
import type {
  GrokBuildEvent,
  GrokBuildToolCall,
  GrokBuildToolRuntime,
} from "./grok-build-agent.js";

export interface CodexBrowserModel {
  slug: string;
  displayName: string;
  defaultReasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  supportedReasoningLevels: unknown[];
  instructions: string;
}

export interface CodexBrowserAgentOptions {
  endpoint?: string;
  model: CodexBrowserModel;
  runtime: GrokBuildToolRuntime;
  tools: readonly GrokTool[];
  maxTurns?: number;
  onEvent?: (event: GrokBuildEvent) => void;
  fetch?: typeof globalThis.fetch;
}

interface AcceptedResponse {
  assistantText: string;
  reasoning: string;
  toolCalls: GrokBuildToolCall[];
  hasTools: boolean;
}

const BROWSER_CONTEXT = `

<environment_context>
  <cwd>/</cwd>
  <shell>/bin/sh</shell>
  <platform>browser sandbox</platform>
  <filesystem>persistent virtual filesystem shared with the live preview</filesystem>
  <preview>Vite is already running; edits are reflected through HMR</preview>
</environment_context>

<browser_workspace_rules>
Use the provided browser filesystem and terminal tools to complete the task. Three.js is available from https://esm.sh/three@0.180.0. Build the actual application in /index.html and /src/main.js. Inspect relevant files before editing. After implementation, use the terminal to inspect the result and make at least one follow-up edit so the live HMR path is exercised.
</browser_workspace_rules>`;

let wasmReady: Promise<unknown> | undefined;

async function ensureWasm(): Promise<void> {
  wasmReady ??= initCodexWasm();
  await wasmReady;
}

async function requireResponse(response: Response) {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === "string") message = parsed.error.message;
    } catch {
      // Preserve the upstream response text.
    }
    throw new Error(message || `Codex returned HTTP ${response.status}.`);
  }
  if (!response.body) throw new Error("Codex returned no Responses stream.");
  return collectGrokResponsesStream(response.body);
}

export class CodexBrowserAgent {
  private readonly endpoint: string;
  private readonly runtime: GrokBuildToolRuntime;
  private readonly tools: readonly GrokTool[];
  private readonly maxTurns: number;
  private readonly onEvent?: (event: GrokBuildEvent) => void;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly core: CodexBrowserCore;
  private readonly instructions: string;
  private readonly model: CodexBrowserModel;

  private constructor(options: CodexBrowserAgentOptions) {
    this.endpoint = options.endpoint ?? "/api/codex/responses";
    this.runtime = options.runtime;
    this.tools = options.tools;
    this.maxTurns = options.maxTurns ?? 100;
    this.onEvent = options.onEvent;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.model = options.model;
    this.instructions = `${options.model.instructions}${BROWSER_CONTEXT}`;
    const sessionId = crypto.randomUUID();
    this.core = new CodexBrowserCore(sessionId, crypto.randomUUID());
  }

  static async create(options: CodexBrowserAgentOptions): Promise<CodexBrowserAgent> {
    await ensureWasm();
    return new CodexBrowserAgent(options);
  }

  sourceRevision(): string {
    return CodexBrowserCore.sourceRevision();
  }

  snapshot(): unknown {
    return this.core.snapshot();
  }

  async run(task: string, signal: AbortSignal): Promise<{ status: "complete" | "limit"; text: string }> {
    this.onEvent?.({ type: "run_start", task });
    let request = this.core.buildRequest(
      task,
      this.model.slug,
      this.instructions,
      this.tools,
      this.model.defaultReasoningEffort,
    ) as Record<string, unknown>;
    let finalText = "";

    for (let turn = 1; turn <= this.maxTurns; turn += 1) {
      signal.throwIfAborted();
      this.onEvent?.({ type: "turn_start", turn });
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "Accept": "text/event-stream",
          "x-browser-agent-codex-session": this.core.sessionId,
          "x-browser-agent-codex-thread": this.core.threadId,
        },
        body: JSON.stringify(request),
        signal,
      });
      const streamed = await requireResponse(response);
      const accepted = this.core.acceptResponse(streamed.response) as AcceptedResponse;
      const assistantText = accepted.assistantText || streamed.text;
      const reasoning = accepted.reasoning || streamed.reasoning;
      if (assistantText) finalText = assistantText;
      this.onEvent?.({ type: "assistant", turn, text: assistantText, reasoning });

      if (!accepted.hasTools) {
        this.onEvent?.({ type: "complete", turn, text: finalText });
        return { status: "complete", text: finalText };
      }

      const results = await Promise.all(accepted.toolCalls.map(async (call) => {
        this.onEvent?.({ type: "tool_start", turn, call });
        const result = await this.runtime.execute(call, signal);
        this.onEvent?.({ type: "tool_end", turn, call, result });
        return { call, result };
      }));
      for (const { call, result } of results) {
        this.core.appendToolOutput(call.callId, result.output, Boolean(result.isError));
      }
      request = this.core.buildContinuationRequest(
        this.model.slug,
        this.instructions,
        this.tools,
        this.model.defaultReasoningEffort,
      ) as Record<string, unknown>;
    }

    this.onEvent?.({ type: "limit", turns: this.maxTurns });
    return { status: "limit", text: finalText };
  }
}
