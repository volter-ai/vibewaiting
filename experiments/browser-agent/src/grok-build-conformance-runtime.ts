import type {
  GrokBuildToolCall,
  GrokBuildToolResult,
  GrokBuildToolRuntime,
} from "./grok-build-agent.js";

export interface GrokConformanceDriverProfile {
  formatVersion: number;
  task: string;
  startupItems: import("../../../src/grok-browser-protocol.js").GrokInputItem[];
  tools: import("../../../src/grok-browser-protocol.js").GrokTool[];
  toolResults: Array<{ callId: string; output: string }>;
  foregroundRequests: number;
  modelRequests: number;
  turnSummaryRequests?: number;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  nativeWorkspacePath: string;
  fixture?: string;
  autoCompactThresholdPercent?: number;
  compactionTranscriptHint?: string;
  compactionSystemReminder?: string;
}

/** Deterministic tool runtime used only by strict native-corpus replay. */
export class GrokRecordedToolRuntime implements GrokBuildToolRuntime {
  private readonly pending = new Map<string, (result: GrokBuildToolResult) => void>();
  private index = 0;

  constructor(private readonly results: readonly { callId: string; output: string }[]) {}

  execute(call: GrokBuildToolCall): Promise<GrokBuildToolResult> {
    return new Promise((resolve, reject) => {
      if (this.pending.has(call.callId)) {
        reject(new Error(`Duplicate recorded tool call: ${call.callId}`));
        return;
      }
      this.pending.set(call.callId, resolve);
      queueMicrotask(() => this.drain());
    });
  }

  assertComplete(): void {
    if (this.index !== this.results.length) {
      throw new Error(`Recorded runtime consumed ${this.index}/${this.results.length} tool results.`);
    }
  }

  private drain(): void {
    while (this.index < this.results.length) {
      const next = this.results[this.index];
      if (!next) return;
      const resolve = this.pending.get(next.callId);
      if (!resolve) return;
      this.pending.delete(next.callId);
      this.index += 1;
      resolve({ output: next.output });
    }
  }
}

/**
 * Executes native-recorded calls in the browser sandbox, validates their
 * effects, then releases native text in native completion order.
 */
export class GrokConformanceToolRuntime implements GrokBuildToolRuntime {
  private readonly recorded: GrokRecordedToolRuntime;

  constructor(
    private readonly runtime: GrokBuildToolRuntime,
    results: readonly { callId: string; output: string }[],
    private readonly nativeWorkspacePath: string,
    private readonly browserWorkspacePath = "/",
  ) {
    this.recorded = new GrokRecordedToolRuntime(results);
  }

  async execute(call: GrokBuildToolCall, signal: AbortSignal): Promise<GrokBuildToolResult> {
    const browserCall = {
      ...call,
      arguments: remapArguments(call.arguments, this.nativeWorkspacePath, this.browserWorkspacePath),
    };
    const actual = await this.runtime.execute(browserCall, signal);
    if (actual.isError) throw new Error(`Browser runtime failed ${call.name}: ${actual.output}`);
    const expected = await this.recorded.execute(call);
    validateEffect(call.name, actual.output, expected.output, this.nativeWorkspacePath, this.browserWorkspacePath);
    return expected;
  }

  assertComplete(): void {
    this.recorded.assertComplete();
  }
}

function remapArguments(argumentsJson: string, nativeRoot: string, browserRoot: string): string {
  const value: unknown = JSON.parse(argumentsJson || "{}");
  return JSON.stringify(remapJson(value, nativeRoot, browserRoot));
}

function remapJson(value: unknown, nativeRoot: string, browserRoot: string): unknown {
  if (typeof value === "string") return remapPathText(value, nativeRoot, browserRoot);
  if (Array.isArray(value)) return value.map((item) => remapJson(item, nativeRoot, browserRoot));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remapJson(item, nativeRoot, browserRoot)]));
}

function remapPathText(value: string, nativeRoot: string, browserRoot: string): string {
  if (nativeRoot === browserRoot || !nativeRoot) return value;
  const root = browserRoot === "/" ? "" : browserRoot.replace(/\/$/u, "");
  return value.replaceAll(`${nativeRoot}/`, `${root}/`).replaceAll(nativeRoot, browserRoot);
}

function validateEffect(name: string, actual: string, expected: string, nativeRoot: string, browserRoot: string): void {
  if (!["read_file", "list_dir", "grep"].includes(name)) return;
  const normalizedExpected = remapPathText(expected, nativeRoot, browserRoot);
  if (actual !== normalizedExpected) {
    throw new Error(`${name} output drifted from native Grok Build.\nExpected:\n${normalizedExpected}\nActual:\n${actual}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
