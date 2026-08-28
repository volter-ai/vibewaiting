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
  initialFiles?: Array<{ path: string; content: string }>;
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
    validateEffect(call, actual.output, expected.output, this.nativeWorkspacePath, this.browserWorkspacePath);
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

function validateEffect(call: GrokBuildToolCall, actual: string, expected: string, nativeRoot: string, browserRoot: string): void {
  const normalizedExpected = remapPathText(expected, nativeRoot, browserRoot);
  const [comparableActual, comparableExpected] = isLongListingCall(call)
    ? [normalizeLongListing(actual), normalizeLongListing(normalizedExpected)]
    : [actual, normalizedExpected];
  if (comparableActual !== comparableExpected) {
    throw new Error(`${call.name} output drifted from native Grok Build.\nExpected:\n${normalizedExpected}\nActual:\n${actual}`);
  }
}

function isLongListingCall(call: GrokBuildToolCall): boolean {
  if (call.name !== "run_terminal_command") return false;
  try {
    const value = JSON.parse(call.arguments) as { command?: unknown };
    return typeof value.command === "string" && /\bls\s+-[A-Za-z]*l[A-Za-z]*\b/u.test(value.command);
  } catch {
    return false;
  }
}

/** Ignores only OS-owned ls metadata; entry order, type, names, and file sizes remain strict. */
function normalizeLongListing(output: string): string {
  return output.split("\n").flatMap((line) => {
    if (/^total\s+\d+$/u.test(line)) return [];
    const fields = line.trim().split(/\s+/u);
    if (!/^[bcdlps-][rwxStTs-]{9}@?$/u.test(fields[0] ?? "") || fields.length < 9) return [line];
    const type = fields[0]![0];
    const size = fields[4];
    const name = fields.slice(8).join(" ").replace(/\/$/u, "");
    return [`<ls-entry type=${type} size=${type === "-" ? size : "directory"} name=${name}>`];
  }).join("\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
