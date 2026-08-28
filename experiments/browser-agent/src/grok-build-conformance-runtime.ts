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
  clientMode?: import("../../../src/grok-browser-protocol.js").GrokClientMode;
  clientType?: "agent" | "tui";
  telemetryMetadata?: {
    clientName: string;
    clientVersion: string;
    serviceVersion: string;
    appEntrypoint: string;
  };
  bundleArchiveRequests?: number;
  periodicSignalAssistantCounts?: number[];
  nativeLongPausesCount?: number;
  finalSignalCounts?: { totalTurns: number; userMessageCount: number };
  turnSummaryRequests?: number;
  postInitialSignalBillingRequests?: number;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  nativeWorkspacePath: string;
  initialFiles?: Array<{ path: string; content: string }>;
  asynchronousReminders?: Array<{ beforeForegroundRequest: number; content: string }>;
  subagentLanes?: GrokConformanceSubagentLane[];
  fixture?: string;
  autoCompactThresholdPercent?: number;
  compactionTranscriptHint?: string;
  compactionSystemReminder?: string;
}

export interface GrokConformanceSubagentLane {
  task: string;
  startupItems: import("../../../src/grok-browser-protocol.js").GrokInputItem[];
  tools: import("../../../src/grok-browser-protocol.js").GrokTool[];
  toolResults: Array<{ callId: string; output: string }>;
  foregroundRequests: number;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  nativeWorkspacePath: string;
  enableSessionTitle: boolean;
  sessionTitleTiming?: "before-first-sample" | "after-first-sample-start";
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
  private readonly nativeToBrowserIds = new Map<string, string>();
  private readonly withheldReminders: string[] = [];
  private reminderDrainIndex = 0;

  constructor(
    private readonly runtime: GrokBuildToolRuntime & { drainSystemReminders?(): string[] },
    results: readonly { callId: string; output: string }[],
    private readonly nativeWorkspacePath: string,
    private readonly browserWorkspacePath = "/",
    private readonly expectedReminders: readonly { beforeForegroundRequest: number; content: string }[] = [],
  ) {
    this.recorded = new GrokRecordedToolRuntime(results);
  }

  drainSystemReminders(phase: "before_sample" | "after_terminal_sample"): string[] {
    this.withheldReminders.push(...(this.runtime.drainSystemReminders?.() ?? []));
    if (phase === "after_terminal_sample") return [];
    const expected = this.expectedReminders.filter((entry) => entry.beforeForegroundRequest === this.reminderDrainIndex);
    this.reminderDrainIndex += 1;
    if (expected.length === 0) return [];
    if (this.withheldReminders.length < expected.length) {
      throw new Error(`Browser Grok produced ${this.withheldReminders.length}/${expected.length} native asynchronous reminders before foreground request ${this.reminderDrainIndex}.`);
    }
    const actual = this.withheldReminders.splice(0, expected.length);
    for (let index = 0; index < expected.length; index += 1) {
      const comparableActual = normalizeDynamicOutput(actual[index] ?? "", this.nativeToBrowserIds);
      const comparableExpected = normalizeDynamicOutput(expected[index]?.content ?? "", new Map());
      if (comparableActual !== comparableExpected) {
        throw new Error(`Asynchronous reminder drifted from native Grok Build.\nExpected:\n${expected[index]?.content ?? ""}\nActual:\n${actual[index] ?? ""}`);
      }
    }
    return expected.map((entry) => entry.content);
  }

  hasPendingAutoWake(): boolean {
    this.withheldReminders.push(...(this.runtime.drainSystemReminders?.() ?? []));
    return this.withheldReminders.length > 0
      && this.expectedReminders.some((entry) => entry.beforeForegroundRequest === this.reminderDrainIndex);
  }

  async execute(call: GrokBuildToolCall, signal: AbortSignal): Promise<GrokBuildToolResult> {
    const browserCall = {
      ...call,
      arguments: remapArguments(
        call.arguments,
        this.nativeWorkspacePath,
        this.browserWorkspacePath,
        this.nativeToBrowserIds,
        call.name === "grep",
      ),
    };
    const actual = await this.runtime.execute(browserCall, signal);
    if (actual.isError) throw new Error(`Browser runtime failed ${call.name}: ${actual.output}`);
    // Register with the recorded queue only after browser execution. This keeps
    // concurrently-issued tools gated by native completion order, independent
    // of which browser promise happens to settle first.
    const expected = await this.recorded.execute(call);
    learnDynamicIdentity(call.name, expected.output, actual.output, this.nativeToBrowserIds);
    validateEffect(call, actual.output, expected.output, this.nativeWorkspacePath, this.browserWorkspacePath, this.nativeToBrowserIds);
    return expected;
  }

  assertComplete(): void {
    this.recorded.assertComplete();
    const remainingExpected = this.expectedReminders.filter((entry) => entry.beforeForegroundRequest >= this.reminderDrainIndex);
    if (remainingExpected.length > 0 || this.withheldReminders.length > 0) {
      throw new Error(`Conformance reminder runtime finished with ${remainingExpected.length} native reminders and ${this.withheldReminders.length} browser reminders unconsumed.`);
    }
  }
}

function remapArguments(
  argumentsJson: string,
  nativeRoot: string,
  browserRoot: string,
  nativeToBrowserIds: ReadonlyMap<string, string>,
  widenGrep: boolean,
): string {
  const value: unknown = JSON.parse(argumentsJson || "{}");
  const remapped = remapJson(value, nativeRoot, browserRoot, nativeToBrowserIds);
  if (widenGrep && isObject(remapped) && remapped.head_limit === undefined) remapped.head_limit = 2_000;
  return JSON.stringify(remapped);
}

function remapJson(value: unknown, nativeRoot: string, browserRoot: string, nativeToBrowserIds: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") {
    let remapped = remapPathText(value, nativeRoot, browserRoot);
    for (const [nativeId, browserId] of nativeToBrowserIds) remapped = remapped.replaceAll(nativeId, browserId);
    return remapped;
  }
  if (Array.isArray(value)) return value.map((item) => remapJson(item, nativeRoot, browserRoot, nativeToBrowserIds));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remapJson(item, nativeRoot, browserRoot, nativeToBrowserIds)]));
}

function remapPathText(value: string, nativeRoot: string, browserRoot: string): string {
  if (nativeRoot === browserRoot || !nativeRoot) return value;
  const root = browserRoot === "/" ? "" : browserRoot.replace(/\/$/u, "");
  return value.replaceAll(`${nativeRoot}/`, `${root}/`).replaceAll(nativeRoot, browserRoot);
}

function validateEffect(
  call: GrokBuildToolCall,
  actual: string,
  expected: string,
  nativeRoot: string,
  browserRoot: string,
  nativeToBrowserIds: ReadonlyMap<string, string>,
): void {
  const normalizedExpected = remapPathText(expected, nativeRoot, browserRoot);
  if (call.name === "grep" && normalizedExpected.includes("\nFound at least ")) {
    validateTruncatedGrep(actual, normalizedExpected);
    return;
  }
  const [comparableActual, comparableExpected] = isLongListingCall(call)
    ? normalizeLongListingPair(actual, normalizedExpected)
    : [normalizeDynamicOutput(actual, nativeToBrowserIds), normalizeDynamicOutput(normalizedExpected, new Map())];
  if (comparableActual !== comparableExpected) {
    throw new Error(`${call.name} output drifted from native Grok Build.\nExpected:\n${normalizedExpected}\nActual:\n${actual}`);
  }
}

function validateTruncatedGrep(actual: string, expected: string): void {
  const expectedMatches = grepMatchLines(expected);
  const actualMatches = new Set(grepMatchLines(actual));
  const missing = expectedMatches.filter((line) => !actualMatches.has(line));
  if (missing.length > 0) {
    throw new Error(`grep output drifted from native Grok Build: ${missing.length}/${expectedMatches.length} native matches were absent from the widened browser search.\nFirst missing match:\n${missing[0]}`);
  }
}

function grepMatchLines(output: string): string[] {
  let file = "";
  const matches: string[] = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("/") && !/^\/\//u.test(line)) {
      file = line;
      continue;
    }
    if (/^\d+:/u.test(line)) matches.push(`${file}\0${line}`);
  }
  return matches;
}

function learnDynamicIdentity(name: string, expected: string, actual: string, identities: Map<string, string>): void {
  const patterns = name === "run_terminal_command"
    ? [/<task-id>([^<]+)<\/task-id>/u]
    : name === "spawn_subagent"
      ? [/\bsubagent_id: ([A-Za-z0-9_-]+)/u]
    : name === "scheduler_create"
      ? [/\bID: ([A-Za-z0-9_-]+)/u]
      : name === "monitor"
        ? [/\btask ([A-Za-z0-9_-]+)/u]
        : [];
  for (const pattern of patterns) {
    const nativeId = pattern.exec(expected)?.[1];
    const browserId = pattern.exec(actual)?.[1];
    if (nativeId && browserId) identities.set(nativeId, browserId);
  }
}

function normalizeDynamicOutput(output: string, nativeToBrowserIds: ReadonlyMap<string, string>): string {
  let normalized = output;
  for (const [nativeId, browserId] of nativeToBrowserIds) normalized = normalized.replaceAll(browserId, nativeId);
  return normalized
    .replace(/<output-file>[^<]*<\/output-file>/gu, "<output-file><dynamic></output-file>")
    .replace(/^Output File: .*$/gmu, "Output File: <dynamic>")
    .replace(/\bDuration: \d+(?:\.\d+)?s\b/gu, "Duration: <dynamic>")
    .replace(/\(\d+(?:\.\d+)?s, /gu, "(<dynamic>, ")
    .replace(/\bduration_ms=\d+\b/gu, "duration_ms=<dynamic>")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/gu, "<timestamp>");
}

function normalizeLongListingPair(actual: string, expected: string): [string, string] {
  const comparableExpected = normalizeLongListing(expected);
  let comparableActual = normalizeLongListing(actual);
  // Browser-only bundled extensions live in the port's private VFS namespace.
  // Native stores the same bundle outside the workspace, so it cannot appear
  // in a workspace `ls -la`. Exclude that mount point from the conformance
  // observation only when the native output proves no project .grok exists.
  if (!comparableExpected.includes("name=.grok>")) {
    comparableActual = comparableActual.split("\n")
      .filter((line) => line !== "<ls-entry type=d size=directory name=.grok>")
      .join("\n");
  }
  return [comparableActual, comparableExpected];
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
