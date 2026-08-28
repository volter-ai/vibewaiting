import systemPrompt from "../../../src/grok-build-system-prompt.generated.txt?raw";
import toolProfile from "../../../src/grok-build-tools.generated.json" with { type: "json" };
import {
  collectGrokResponsesStream,
  createGrokResponsesRequest,
  createGrokSessionTitleRequest,
  functionCallOutput,
  responseToConversationInput,
  type GrokCompletedResponse,
  type GrokInferenceLatencyStats,
  type GrokInputItem,
  type GrokResponseOutputItem,
  type GrokTool,
} from "../../../src/grok-browser-protocol.js";
import {
  buildGrokCompactedHistoryWithContext,
  buildGrokCompactionInput,
  createGrokCompactionTranscriptHint,
  formatGrokCompactSummary,
} from "./grok-build-compaction.js";

const BROWSER_VERIFICATION_RULE = `When implementing or fixing anything in a web application (UI, layout, styling, routing, client state, or rendered data), verify your work in the browser before declaring the task complete.

**Use this verification workflow:**
- Open the app with the available browser tools and exercise the changed feature end to end the way a real user would: click, type, submit, navigate.
- A single render screenshot of the changed screen is NOT verification. Confirm behavior, not just appearance.
- Check every page and route that shares the state, data, or components you touched. Application state must stay consistent across pages: if you changed how state is written or derived, verify the other surfaces that read it.
- Hunt for regressions. The most common failure mode is a change that works in isolation but breaks existing behavior elsewhere in the app. Navigate the surrounding flows and look for what broke.
- Verify the paths and edge states your change touches (empty states, error states, route and flag variants), not only the main path.
- When layout or styling changed, check both desktop and mobile viewports.
- If verification finds a problem, fix it and re-verify. Do not finish with unverified UI work.

If no browser tools are available, verify through the closest available substitute (tests, curl against the dev server, rendering scripts) and say what you could not verify.`;

const RULES_SECTION_INTRO = "The rules section has a number of possible rules/memories/context that you should consider. In each subsection, we provide instructions about what information the subsection contains and how you should consider/follow the contents of the subsection.";

export interface GrokBuildRule {
  path?: string;
  content: string;
}

export interface GrokBuildEnvironmentContext {
  systemPrompt?: string;
  os: string;
  shell: string;
  workspacePath: string;
  today: string;
  workspaceRules?: readonly GrokBuildRule[];
  userRules?: readonly GrokBuildRule[];
  startupItems?: readonly GrokInputItem[];
  startupReminders?: readonly string[];
}

export interface GrokBuildToolCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface GrokBuildToolResult {
  output: string;
  isError?: boolean;
  /** Data URLs embedded as input_image parts of the function_call_output. */
  images?: readonly string[];
  /** Text-extracted images sent as native deferred reminder messages after the tool result. */
  deferredImages?: readonly string[];
}

export interface GrokBuildToolRuntime {
  execute(call: GrokBuildToolCall, signal: AbortSignal): Promise<GrokBuildToolResult>;
}

export type GrokBuildEvent =
  | { type: "run_start"; task: string }
  | { type: "turn_start"; turn: number }
  | { type: "assistant"; turn: number; text: string; reasoning: string; synthetic?: true }
  | { type: "response_end"; kind: string; response: GrokCompletedResponse; metrics: GrokInferenceLatencyStats }
  | { type: "tool_start"; turn: number; call: GrokBuildToolCall }
  | { type: "tool_end"; turn: number; call: GrokBuildToolCall; result: GrokBuildToolResult }
  | { type: "retry"; kind: string; attempt: number; maxRetries: number; delayMs: number; status?: number }
  | { type: "compaction_start"; tokens: number; contextWindow: number }
  | { type: "compaction_end"; tokens: number; compactions: number }
  | { type: "complete"; turn: number; text: string }
  | { type: "limit"; turns: number };

export interface GrokBuildSessionOptions {
  endpoint: string;
  environment: GrokBuildEnvironmentContext;
  runtime: GrokBuildToolRuntime;
  maxTurns?: number;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  enableTurnSummary?: boolean;
  strictSideCalls?: boolean;
  onEvent?: (event: GrokBuildEvent) => void;
  restore?: GrokBuildSessionSnapshot;
  onCheckpoint?: (snapshot: GrokBuildSessionSnapshot) => void;
  /** Test seam for native retry timing. Production uses real abort-aware timers. */
  retrySleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  retryJitter?: (baseMs: number) => number;
  sessionId?: string;
  enableSessionTitle?: boolean;
  tools?: readonly GrokTool[];
  model?: string;
  contextWindow?: number;
  autoCompactThresholdPercent?: number;
  maxCompactions?: number;
  compactionTranscriptHint?: string;
  compactionSystemReminder?: string;
  getCompactionSystemReminder?: () => string | undefined;
  onCompaction?: () => void;
  getPostToolSystemReminder?: (call: GrokBuildToolCall, result: GrokBuildToolResult) => string | undefined;
  drainSystemReminders?: (phase: "before_sample" | "after_terminal_sample") => readonly string[];
  /** Await completion bookkeeping that native orders before the post-turn side call. */
  beforeTurnSummary?: () => void | Promise<void>;
  persistCompactionSegment?: (segment: {
    index: number;
    location: string;
    items: readonly GrokInputItem[];
    summary: string;
    timestamp: string;
  }) => void | Promise<void>;
}

export const GROK_BUILD_TOOLS = structuredClone(toolProfile.tools) as GrokTool[];
export const GROK_BUILD_SOURCE_REVISION = toolProfile.sourceRevision;

export interface GrokBuildSessionSnapshot {
  version: 1;
  sourceRevision: string;
  sessionId: string;
  requestId: string;
  promptIndex: number;
  titleCreated: boolean;
  input: GrokInputItem[];
  estimatedTokens?: number;
  measuredInputBytes?: number;
  compactionCount?: number;
}

export interface GrokBuildSessionUsage {
  /** Sum of provider-reported input + output tokens for this session object. */
  totalTokensUsed: number;
  /** True when at least one completed provider response omitted usable usage. */
  incomplete: boolean;
}

export class GrokBuildSession {
  private readonly sessionId: string;
  private requestId: string;
  private promptIndex: number;
  private titleCreated: boolean;
  private readonly input: GrokInputItem[];
  private estimatedTokens: number;
  private measuredInputBytes: number;
  private compactionCount: number;
  private totalTokensUsed = 0;
  private incompleteUsageResponses = 0;

  constructor(private readonly options: GrokBuildSessionOptions) {
    const restored = options.restore;
    if (restored && (restored.version !== 1 || restored.sourceRevision !== GROK_BUILD_SOURCE_REVISION)) {
      throw new Error("The saved Grok Build session belongs to a different native source revision.");
    }
    this.sessionId = restored?.sessionId ?? options.sessionId ?? crypto.randomUUID();
    this.requestId = restored?.requestId ?? crypto.randomUUID();
    this.promptIndex = restored?.promptIndex ?? 0;
    this.titleCreated = restored?.titleCreated ?? false;
    this.input = restored ? structuredClone(restored.input) : [];
    this.estimatedTokens = restored?.estimatedTokens ?? 0;
    this.measuredInputBytes = restored?.measuredInputBytes ?? 0;
    this.compactionCount = restored?.compactionCount ?? 0;
  }

  snapshot(): GrokBuildSessionSnapshot {
    return {
      version: 1,
      sourceRevision: GROK_BUILD_SOURCE_REVISION,
      sessionId: this.sessionId,
      requestId: this.requestId,
      promptIndex: this.promptIndex,
      titleCreated: this.titleCreated,
      input: structuredClone(this.input),
      estimatedTokens: this.estimatedTokens,
      measuredInputBytes: this.measuredInputBytes,
      compactionCount: this.compactionCount,
    };
  }

  usage(): GrokBuildSessionUsage {
    return { totalTokensUsed: this.totalTokensUsed, incomplete: this.incompleteUsageResponses > 0 };
  }

  enqueueSystemReminder(reminder: string): void {
    if (!reminder.trim()) return;
    this.input.push({ type: "message", role: "user", content: reminder });
    this.checkpoint();
  }

  private checkpoint(): void {
    this.options.onCheckpoint?.(this.snapshot());
  }

  async run(task: string, signal: AbortSignal): Promise<{ status: "complete" | "limit"; text: string }> {
    return this.runInternal(task, signal, false);
  }

  async resume(signal: AbortSignal): Promise<{ status: "complete" | "limit"; text: string }> {
    return this.runInternal("", signal, true, `task-completed-${crypto.randomUUID()}`, 1);
  }

  private async runInternal(task: string, signal: AbortSignal, resume: boolean, requestId?: string, turnLimit?: number): Promise<{ status: "complete" | "limit"; text: string }> {
    this.options.onEvent?.({ type: "run_start", task });
    this.requestId = requestId ?? crypto.randomUUID();
    this.promptIndex += 1;
    if (!resume && !this.titleCreated && this.options.enableSessionTitle !== false) {
      await this.createSessionTitle(task, signal);
      this.titleCreated = true;
    }
    if (!resume && this.input.length === 0) {
      this.input.push(...createInitialConversation(task, this.options.environment));
    } else if (!resume) {
      this.input.push({ type: "message", role: "user", content: task });
    }
    this.checkpoint();
    const maxTurns = turnLimit ?? this.options.maxTurns ?? 100;

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      signal.throwIfAborted();
      this.options.onEvent?.({ type: "turn_start", turn });
      await this.maybeCompact(signal);
      for (const reminder of this.options.drainSystemReminders?.("before_sample") ?? []) {
        this.input.push({ type: "message", role: "user", content: reminder });
      }
      const response = await this.sample(signal);
      const replay = responseToConversationInput(response.response);
      this.input.push(...replay);
      this.recordTokenUsage(response.response);
      this.checkpoint();
      this.options.onEvent?.({
        type: "assistant",
        turn,
        text: response.text,
        reasoning: response.reasoning,
        ...(resume ? { synthetic: true as const } : {}),
      });

      const calls = responseToolCalls(response.response.output ?? []);
      if (calls.length === 0) {
        const midSampleReminders = this.options.drainSystemReminders?.("after_terminal_sample") ?? [];
        if (midSampleReminders.length > 0) {
          for (const reminder of midSampleReminders) {
            this.input.push({ type: "message", role: "user", content: reminder });
          }
          this.checkpoint();
          continue;
        }
        this.options.onEvent?.({ type: "complete", turn, text: response.text });
        if (this.options.enableTurnSummary) {
          try {
            await this.options.beforeTurnSummary?.();
            await this.createTurnSummary(signal);
          } catch (error) {
            if (this.options.strictSideCalls) throw error;
          }
        }
        this.checkpoint();
        return { status: "complete", text: response.text };
      }
      if (turn === maxTurns) {
        if (resume) {
          this.checkpoint();
          return { status: "complete", text: response.text };
        }
        this.options.onEvent?.({ type: "limit", turns: maxTurns });
        this.checkpoint();
        return { status: "limit", text: response.text };
      }

      await executeGrokToolBatch(calls, this.options.runtime, signal, async (call, execute) => {
        this.options.onEvent?.({ type: "tool_start", turn, call });
        let result: GrokBuildToolResult;
        try {
          result = await execute();
        } catch (error) {
          result = { output: error instanceof Error ? error.message : String(error), isError: true };
        }
        this.input.push(functionCallOutput(call.callId, result.images?.length
          ? [
              { type: "input_text", text: result.output },
              ...result.images.map((imageUrl) => ({ type: "input_image" as const, image_url: imageUrl, detail: "auto" as const })),
            ]
          : result.output));
        for (const imageUrl of result.deferredImages ?? []) {
          this.input.push({
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "[Image extracted from tool result above]" },
              { type: "input_image", image_url: imageUrl, detail: "auto" },
            ],
          });
        }
        const reminder = this.options.getPostToolSystemReminder?.(call, result);
        if (reminder) this.input.push({ type: "message", role: "user", content: reminder });
        this.checkpoint();
        this.options.onEvent?.({ type: "tool_end", turn, call, result });
      });
    }

    throw new Error("Grok Build session reached an impossible loop state.");
  }

  private async createSessionTitle(task: string, signal: AbortSignal): Promise<void> {
    await this.requestStream({
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "x-browser-agent-request-kind": "session-title",
      },
      body: JSON.stringify(createGrokSessionTitleRequest(task, this.options.model)),
    }, "session-title", signal);
  }

  private async sample(signal: AbortSignal) {
    const request = createGrokResponsesRequest({
      input: this.input,
      tools: this.options.tools ?? GROK_BUILD_TOOLS,
      sessionId: this.sessionId,
      ...(this.options.model ? { model: this.options.model } : {}),
      reasoningEffort: this.options.reasoningEffort ?? "high",
    });
    return this.requestStream({
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "x-browser-agent-conversation": this.sessionId,
        "x-browser-agent-request": this.requestId,
        "x-browser-agent-session": this.sessionId,
        "x-browser-agent-turn": String(this.promptIndex),
        ...(this.compactionCount > 0 ? { "x-browser-agent-compacted": String(this.compactionCount) } : {}),
      },
      body: JSON.stringify(request),
    }, "foreground", signal);
  }

  private async createTurnSummary(signal: AbortSignal): Promise<void> {
    const user = this.input.findLast((item) => item.role === "user" && typeof item.content === "string");
    const content = typeof user?.content === "string" ? user.content : "";
    if (!content.trim()) return;
    const request = createGrokResponsesRequest({
      input: [...this.input, {
        type: "message",
        role: "user",
        content: createTurnSummaryInstruction(createTurnSummaryAnchor(content)),
      }],
      tools: this.options.tools ?? GROK_BUILD_TOOLS,
      sessionId: this.sessionId,
      ...(this.options.model ? { model: this.options.model } : {}),
      reasoningEffort: this.options.reasoningEffort ?? "high",
    });
    await this.requestStream({
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "x-browser-agent-conversation": `turn-summary-${crypto.randomUUID()}`,
        "x-browser-agent-request": `xai-turn-summary-${crypto.randomUUID()}`,
        "x-browser-agent-request-kind": "turn-summary",
        "x-browser-agent-session": this.sessionId,
        ...(this.compactionCount > 0 ? { "x-browser-agent-compacted": String(this.compactionCount) } : {}),
      },
      body: JSON.stringify(request),
    }, "turn-summary", signal);
  }

  private async maybeCompact(signal: AbortSignal): Promise<void> {
    const contextWindow = this.options.contextWindow ?? 500_000;
    const threshold = this.options.autoCompactThresholdPercent ?? 80;
    const maxCompactions = this.options.maxCompactions ?? Number.MAX_SAFE_INTEGER;
    const tokens = this.currentEstimatedTokens();
    if (this.compactionCount >= maxCompactions || tokens * 100 < contextWindow * threshold) return;
    this.options.onEvent?.({ type: "compaction_start", tokens, contextWindow });
    const request = createGrokResponsesRequest({
      input: buildGrokCompactionInput(this.input),
      tools: this.options.tools ?? GROK_BUILD_TOOLS,
      sessionId: this.sessionId,
      ...(this.options.model ? { model: this.options.model } : {}),
      temperature: 1,
      toolChoice: "auto",
    });
    let summary = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await this.requestStream({
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "x-browser-agent-conversation": this.sessionId,
          "x-browser-agent-request": `xai-compact-${crypto.randomUUID()}`,
          "x-browser-agent-request-kind": "compaction",
          "x-browser-agent-session": this.sessionId,
          "x-browser-agent-compaction-at": String(Math.floor(contextWindow * threshold / 100)),
          ...(this.compactionCount > 0 ? { "x-browser-agent-compacted": String(this.compactionCount) } : {}),
        },
        body: JSON.stringify(request),
      }, "compaction", signal);
      summary = result.text;
      if (formatGrokCompactSummary(summary).length >= 500) break;
      if (attempt === 3) throw new Error("Grok compaction returned a degenerate summary three times.");
      await (this.options.retrySleep ?? abortableSleep)(3_000, signal);
    }
    const defaultCompactionLocation = `/.grok/sessions/${encodeURIComponent(this.options.environment.workspacePath)}/${this.sessionId}/compaction`;
    const transcriptHint = this.options.compactionTranscriptHint
      ?? createGrokCompactionTranscriptHint(defaultCompactionLocation);
    const transcriptLocation = transcriptLocationFromHint(transcriptHint) ?? defaultCompactionLocation;
    await this.options.persistCompactionSegment?.({
      index: this.compactionCount,
      location: transcriptLocation,
      items: structuredClone(this.input),
      summary: formatGrokCompactSummary(summary),
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
    });
    const systemReminder = this.options.compactionSystemReminder ?? this.options.getCompactionSystemReminder?.();
    this.input.splice(0, this.input.length, ...buildGrokCompactedHistoryWithContext(this.input, summary, {
      transcriptHint,
      ...(systemReminder ? { systemReminder } : {}),
    }));
    this.options.onCompaction?.();
    this.compactionCount += 1;
    this.measuredInputBytes = inputBytes(this.input);
    this.estimatedTokens = Math.ceil(this.measuredInputBytes / 4);
    this.checkpoint();
    this.options.onEvent?.({ type: "compaction_end", tokens: this.estimatedTokens, compactions: this.compactionCount });
  }

  private currentEstimatedTokens(): number {
    const bytes = inputBytes(this.input);
    if (this.measuredInputBytes === 0 || this.estimatedTokens === 0) return Math.ceil(bytes / 4);
    return this.estimatedTokens + Math.ceil(Math.max(0, bytes - this.measuredInputBytes) / 4);
  }

  private recordTokenUsage(response: GrokCompletedResponse): void {
    const usage = response.usage;
    if (usage && typeof usage === "object" && !Array.isArray(usage)) {
      const record = usage as Record<string, unknown>;
      const total = numberValue(record.total_tokens)
        ?? sumNumbers(record.input_tokens, record.output_tokens)
        ?? numberValue(record.input_tokens);
      if (total !== undefined) this.estimatedTokens = total;
    }
    if (this.estimatedTokens === 0) this.estimatedTokens = Math.ceil(inputBytes(this.input) / 4);
    this.measuredInputBytes = inputBytes(this.input);
  }

  private async requestStream(init: RequestInit, kind: string, signal: AbortSignal) {
    const result = await requestGrokStream(this.options.endpoint, init, kind, signal, {
      ...(this.options.retrySleep ? { sleep: this.options.retrySleep } : {}),
      ...(this.options.retryJitter ? { jitter: this.options.retryJitter } : {}),
      onRetry: (retry) => this.options.onEvent?.({ type: "retry", kind, ...retry }),
    });
    if (result.metrics) this.options.onEvent?.({ type: "response_end", kind, response: result.response, metrics: result.metrics });
    const tokens = responseTotalTokens(result.response);
    if (tokens === undefined) this.incompleteUsageResponses += 1;
    else this.totalTokensUsed = Math.min(Number.MAX_SAFE_INTEGER, this.totalTokensUsed + tokens);
    return result;
  }
}

function responseTotalTokens(response: GrokCompletedResponse): number | undefined {
  const usage = response.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const record = usage as Record<string, unknown>;
  return numberValue(record.total_tokens) ?? sumNumbers(record.input_tokens, record.output_tokens);
}

function transcriptLocationFromHint(hint: string): string | undefined {
  return hint.match(/available at ([^\n]+)\/segment_\*\.md\./u)?.[1];
}

type GrokToolExecutor = () => Promise<GrokBuildToolResult>;

/**
 * Native Grok Build starts a tool batch concurrently, except calls targeting
 * a path that is written elsewhere in the same batch share a FIFO file lock.
 * Results remain completion-ordered when they are appended to the transcript.
 */
export async function executeGrokToolBatch(
  calls: readonly GrokBuildToolCall[],
  runtime: GrokBuildToolRuntime,
  signal: AbortSignal,
  handle: (call: GrokBuildToolCall, execute: GrokToolExecutor) => Promise<void> = async (_call, execute) => { await execute(); },
): Promise<void> {
  const paths = calls.map(toolCallPath);
  const writePaths = new Set(calls.flatMap((call, index) => paths[index] && !isReadOnlyPathTool(call.name) ? [paths[index]!] : []));
  const tails = new Map<string, Promise<void>>();

  await Promise.all(calls.map(async (call, index) => {
    const path = paths[index];
    const execute = (): Promise<GrokBuildToolResult> => runtime.execute(call, signal);
    if (!path || !writePaths.has(path)) {
      await handle(call, execute);
      return;
    }
    const previous = tails.get(path) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    tails.set(path, previous.then(() => current));
    await previous;
    try {
      await handle(call, execute);
    } finally {
      release();
    }
  }));
}

function toolCallPath(call: GrokBuildToolCall): string | undefined {
  try {
    const input: unknown = JSON.parse(call.arguments || "{}");
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const record = input as Record<string, unknown>;
    const value = [record.file_path, record.path, record.target_file].find((candidate) => typeof candidate === "string");
    if (typeof value !== "string") return;
    const parts: string[] = [];
    for (const part of value.replaceAll("\\", "/").split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop(); else parts.push(part);
    }
    return `/${parts.join("/")}`;
  } catch {
    return;
  }
}

function isReadOnlyPathTool(name: string): boolean {
  return name === "read_file";
}

export function createTurnSummaryAnchor(content: string): string {
  const normalized = content.split(/\s+/u).filter(Boolean).join(" ").replaceAll("<", "").replaceAll(">", "");
  const encoded = new TextEncoder().encode(normalized);
  if (encoded.length <= 120) return normalized;
  let output = "";
  let bytes = 0;
  for (const character of normalized) {
    const width = new TextEncoder().encode(character).length;
    if (bytes + width > 120) break;
    output += character;
    bytes += width;
  }
  return `${output.trimEnd()}…`;
}

export function createTurnSummaryInstruction(anchor: string): string {
  return `<system-reminder>Write an ultra-short dashboard line that captures the AGENT'S REPLY for the last turn only — everything after the user message beginning: "${anchor}". Focus on what the assistant concluded, answered, recommended, or delivered — not a meta description of the turn (avoid "Explained…", "Answered…", "Greeted…", "Reviewed…"). User-role messages wrapped in reminder tags like this one are injected context, not the user.

Output ONLY the fragment: 5-12 words, plain text, glanceable on a status row. Prefer the payload: answer, finding, change, or decision needed. Do NOT call any tools — respond with plain text only.

Synthetic examples (style only — adapt to THIS turn, do not copy):
\`queue_worker\` shutdown race fixed; suite green
Payment retries: exp backoff in \`billing/retry.rs\`, 5× on 429
Retry backoff wired into \`billing/retry.rs\`; tests pending
Need decision: keep or drop \`sqlx\` cache before refactor
Black — matches the terminal aesthetic

Bad (never):
- Lead with Explained / Answered / Greeted / Reviewed / Confirmed / Flagged / Summarized
- Labels, quotes, bullets, markdown, code fences, multi-sentence dumps
- Filler like "no code changes" or "awaiting task" unless that is the whole point
- Summarize earlier turns or the whole session
- Call tools or invent content not in the agent's reply</system-reminder>`;
}

export function createInitialConversation(
  task: string,
  environment: GrokBuildEnvironmentContext,
): GrokInputItem[] {
  if (environment.startupItems) {
    return environment.startupItems.map((item) => structuredClone(item));
  }
  const conversation: GrokInputItem[] = [
    { type: "message", role: "system", content: environment.systemPrompt ?? systemPrompt },
    { type: "message", role: "user", content: createUserMessagePrefix(environment) },
  ];
  for (const reminder of environment.startupReminders ?? []) {
    conversation.push({ type: "message", role: "user", content: reminder });
  }
  conversation.push({ type: "message", role: "user", content: `<user_query>\n${task}\n</user_query>` });
  return conversation;
}

export function createUserMessagePrefix(environment: GrokBuildEnvironmentContext): string {
  let prefix = `<user_info>\nOS Version: ${environment.os}\nShell: ${environment.shell}\nWorkspace Path: ${environment.workspacePath}\nToday's date: ${environment.today}\nNote: Prefer using relative paths over absolute paths as tool call args when possible.\n</user_info>`;
  const userRules = [{ content: BROWSER_VERIFICATION_RULE }, ...(environment.userRules ?? [])];
  const rules = formatRulesSection(environment.workspaceRules ?? [], userRules);
  if (rules) prefix += `\n\n${rules}`;
  return prefix;
}

export function formatRulesSection(
  workspaceRules: readonly GrokBuildRule[],
  userRules: readonly GrokBuildRule[],
): string | undefined {
  if (workspaceRules.length === 0 && userRules.length === 0) return;
  let output = `<rules>\n${RULES_SECTION_INTRO}\n\n\n`;
  if (workspaceRules.length > 0) {
    output += '<always_applied_workspace_rules description="These are workspace-level rules that the agent must always follow.">\n';
    output += workspaceRules.map((rule) => `<always_applied_workspace_rule name="${rule.path ?? ""}">${ruleBody(rule, true)}</always_applied_workspace_rule>\n`).join("\n");
    output += `</always_applied_workspace_rules>${userRules.length > 0 ? "\n\n" : "\n"}`;
  }
  if (userRules.length > 0) {
    output += '<user_rules description="These are rules set by the user that you should follow if appropriate.">\n';
    output += userRules.map((rule) => `<user_rule>${ruleBody(rule, Boolean(rule.path))}</user_rule>\n`).join("\n");
    output += "</user_rules>\n";
  }
  return `${output}</rules>`;
}

async function requireGrokStream(response: Response, kind: string, startedAt: number, attempts: number) {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new GrokHttpError(
      body || `Grok ${kind} request returned HTTP ${response.status}.`,
      response.status,
      response.headers,
    );
  }
  if (!response.body) throw new Error(`Grok ${kind} request returned no Responses stream.`);
  return collectGrokResponsesStream(response.body, undefined, { startedAt, attempts });
}

const DEFAULT_MAX_RETRIES = 15;
const RATE_LIMIT_RETRY_THRESHOLD = 2;
const MAX_RETRY_BACKOFF_MS = 30_000;

interface GrokRetryHooks {
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  jitter?: (baseMs: number) => number;
  onRetry?: (retry: { attempt: number; maxRetries: number; delayMs: number; status?: number }) => void;
}

class GrokHttpError extends Error {
  constructor(message: string, readonly status: number, readonly headers: Headers) {
    super(message);
    this.name = "GrokHttpError";
  }
}

/** Browser port of xai-grok-sampler's request retry boundary. */
async function requestGrokStream(
  endpoint: string,
  init: RequestInit,
  kind: string,
  signal: AbortSignal,
  hooks: GrokRetryHooks = {},
) {
  let retryCount = 0;
  for (;;) {
    signal.throwIfAborted();
    const startedAt = globalThis.performance?.now() ?? Date.now();
    try {
      const response = await fetch(endpoint, { ...init, signal });
      return await requireGrokStream(response, kind, startedAt, retryCount + 1);
    } catch (error) {
      signal.throwIfAborted();
      const decision = classifyGrokRetry(error, retryCount, hooks.jitter);
      if (!decision) throw error;
      retryCount += 1;
      hooks.onRetry?.({
        attempt: retryCount,
        maxRetries: decision.maxRetries,
        delayMs: decision.delayMs,
        ...(error instanceof GrokHttpError ? { status: error.status } : {}),
      });
      await (hooks.sleep ?? abortableSleep)(decision.delayMs, signal);
    }
  }
}

function classifyGrokRetry(
  error: unknown,
  retryCount: number,
  jitter: ((baseMs: number) => number) | undefined,
): { delayMs: number; maxRetries: number } | undefined {
  const status = error instanceof GrokHttpError ? error.status : undefined;
  const retryVetoed = error instanceof GrokHttpError
    && error.headers.get("x-should-retry")?.trim().toLowerCase() === "false";
  if (retryVetoed) return;

  if (status === 429) {
    const nextAttempt = retryCount + 1;
    if (nextAttempt >= Math.min(DEFAULT_MAX_RETRIES, RATE_LIMIT_RETRY_THRESHOLD)) return;
    const retryAfterMs = parseRetryAfterMs(error instanceof GrokHttpError ? error.headers.get("Retry-After") : null);
    const baseMs = retryAfterMs ?? retryBackoffMs(nextAttempt);
    return { delayMs: applyRetryJitter(baseMs, jitter), maxRetries: RATE_LIMIT_RETRY_THRESHOLD - 1 };
  }

  const retryableStatus = status !== undefined
    && status >= 500
    && status <= 599
    && status !== 525
    && status !== 526;
  const retryableTransport = status === undefined && isRetryableTransportError(error);
  if (!retryableStatus && !retryableTransport) return;
  const nextAttempt = retryCount + 1;
  if (nextAttempt >= DEFAULT_MAX_RETRIES) return;
  const retryAfterMs = error instanceof GrokHttpError ? parseRetryAfterMs(error.headers.get("Retry-After")) : undefined;
  const baseMs = Math.min(retryAfterMs ?? retryBackoffMs(nextAttempt), MAX_RETRY_BACKOFF_MS);
  return { delayMs: applyRetryJitter(baseMs, jitter), maxRetries: DEFAULT_MAX_RETRIES - 1 };
}

function retryBackoffMs(attempt: number): number {
  return Math.min(2_000 * (2 ** Math.max(0, attempt - 1)), MAX_RETRY_BACKOFF_MS);
}

function applyRetryJitter(baseMs: number, jitter?: (baseMs: number) => number): number {
  if (jitter) return Math.max(0, Math.round(jitter(baseMs)));
  return Math.max(0, Math.round(baseMs * (0.8 + Math.random() * 0.4)));
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1_000, 120_000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return;
  const delay = date - Date.now();
  return delay > 0 ? Math.min(delay, 120_000) : undefined;
}

function isRetryableTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return !(error instanceof DOMException && error.name === "AbortError")
    && !(error instanceof SyntaxError)
    && !message.startsWith("Grok returned malformed SSE JSON:")
    && message !== "Grok returned a non-object SSE event.";
}

function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = globalThis.setTimeout(done, delayMs);
    signal.addEventListener("abort", aborted, { once: true });
    function done(): void {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted(): void {
      globalThis.clearTimeout(timer);
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    }
  });
}

function responseToolCalls(items: readonly GrokResponseOutputItem[]): GrokBuildToolCall[] {
  return items.flatMap((item) => item.type === "function_call"
    ? [{
        callId: stringValue(item.call_id),
        name: stringValue(item.name),
        arguments: stringValue(item.arguments),
      }]
    : []);
}

function ruleBody(rule: GrokBuildRule, neutralize: boolean): string {
  let content = rule.content;
  if (neutralize) {
    for (const [needle, replacement] of [
      ["</rules>", "&lt;/rules>"],
      ["<rules>", "&lt;rules>"],
      ["</system-reminder>", "&lt;/system-reminder>"],
      ["<system-reminder>", "&lt;system-reminder>"],
      ["</system_reminder>", "&lt;/system_reminder>"],
      ["<system_reminder>", "&lt;system_reminder>"],
    ] as const) content = content.replaceAll(needle, replacement);
    content = content.trim();
  }
  return `${content.startsWith("\n") ? "" : "\n"}${content}${content.endsWith("\n") ? "" : "\n"}`;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function inputBytes(input: readonly GrokInputItem[]): number {
  return new TextEncoder().encode(JSON.stringify(input)).byteLength;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sumNumbers(left: unknown, right: unknown): number | undefined {
  const a = numberValue(left);
  const b = numberValue(right);
  return a !== undefined && b !== undefined ? a + b : undefined;
}
