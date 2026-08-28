import type { VirtualFS } from "almostnode";
import { runIsolatedBrowserCommand } from "./grok-build-command-isolation.js";

export interface BrowserTaskRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface BrowserTaskContainer {
  vfs: VirtualFS;
  run(command: string, options?: {
    cwd?: string;
    signal?: AbortSignal;
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
  }): Promise<BrowserTaskRunResult>;
}

export interface BrowserBackgroundTask {
  id: string;
  controller: AbortController;
  promise: Promise<string>;
  status: "running" | "completed" | "failed" | "cancelled" | "timed_out";
  output: string;
  kind: "command" | "monitor" | "subagent" | "workflow";
  command?: string;
  description?: string;
  subagentType?: string;
  toolCalls?: number;
  turns?: number;
  completionDurationMs?: number;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  outputFile: string;
  rawOutputBytes: number;
  truncated: boolean;
  explicitlyCancelled?: boolean;
  timedOut?: boolean;
  /** Resolves after a deferred external task has invoked its service callback. */
  launchStarted?: Promise<void>;
  /** Mutable notification owner used when a child session exits. */
  notificationSink?: (reminder: string) => void;
}

export interface ExternalTaskOptions {
  id: string;
  kind: "subagent" | "workflow";
  parentSignal: AbortSignal;
  promise: (signal: AbortSignal) => Promise<string>;
  description?: string;
  subagentType?: string;
  deferStart?: boolean;
}

const MAX_MULTI_TASK_IDS = 20;
const MAX_TOOL_OUTPUT_BYTES = 40_000;
const OUTPUT_PREVIEW_BYTES = 2_000;
const SOFT_WRAP_WIDTH = 2_000;
const COMMAND_OUTPUT_CHAR_LIMIT = 20_000;
const MONITOR_OUTPUT_CHAR_LIMIT = 10 * 1024 * 1024;
const RETAINED_LOG_BYTES = 64 * 1024 * 1024;
const FRONT_BACK_MARKER = "\n\n... (output truncated) ...\n\n";

/** Native `BackgroundTaskStarted::to_prompt_format` envelope. */
export function formatGrokBackgroundTaskStarted(task: BrowserBackgroundTask, summary: string): string {
  return `<task-id>${task.id}</task-id>\n` +
    `<task-type>bash</task-type>\n` +
    `<output-file>${task.outputFile}</output-file>\n` +
    `<status>running</status>\n` +
    `<summary>${summary}</summary>\n` +
    `Use get_command_or_subagent_output with task_ids=["${task.id}"] when you need the output.`;
}

/** Stateful browser port of Grok Build's terminal/subagent task registry. */
export class GrokBuildBackgroundTasks {
  private readonly tasks = new Map<string, BrowserBackgroundTask>();

  constructor(
    private readonly container: BrowserTaskContainer,
    private readonly workspacePath: string,
  ) {}

  values(): IterableIterator<BrowserBackgroundTask> {
    return this.tasks.values();
  }

  get(id: string): BrowserBackgroundTask | undefined {
    return this.tasks.get(id);
  }

  /** Transfer a live terminal task between session-local registries. */
  take(id: string): BrowserBackgroundTask | undefined {
    const task = this.tasks.get(id);
    if (task) this.tasks.delete(id);
    return task;
  }

  adopt(task: BrowserBackgroundTask): void {
    this.tasks.set(task.id, task);
  }

  createCommand(
    command: string,
    parentSignal: AbortSignal,
    kind: "command" | "monitor",
    onOutput?: (chunk: string, task: BrowserBackgroundTask) => void,
    maxRuntimeMs?: number,
    requestedOutputFile?: string,
    requestedTaskId?: string,
  ): BrowserBackgroundTask {
    const id = requestedTaskId ?? uuidV7();
    const controller = new AbortController();
    const outputFile = requestedOutputFile ?? `/tmp/${id}.log`;
    this.ensureOutputFile(outputFile);
    let streamed = false;
    let combined = "";
    const append = (chunk: string): void => {
      if (!chunk) return;
      streamed = true;
      task.rawOutputBytes += utf8Length(chunk);
      combined = utf8Prefix(combined + chunk, RETAINED_LOG_BYTES);
      const view = ringOutput(combined, kind === "monitor" ? MONITOR_OUTPUT_CHAR_LIMIT : COMMAND_OUTPUT_CHAR_LIMIT);
      task.output = view.output;
      task.truncated = view.truncated || task.rawOutputBytes > utf8Length(combined);
      this.container.vfs.writeFileSync(outputFile, combined);
      onOutput?.(chunk, task);
    };
    const task: BrowserBackgroundTask = {
      id,
      controller,
      status: "running",
      output: "",
      promise: Promise.resolve(""),
      kind,
      command,
      startedAt: Date.now(),
      outputFile,
      rawOutputBytes: 0,
      truncated: false,
    };
    const timeout = maxRuntimeMs !== undefined ? setTimeout(() => {
      if (task.status !== "running") return;
      task.timedOut = true;
      controller.abort(new DOMException("Task timed out", "TimeoutError"));
    }, Math.max(0, maxRuntimeMs)) : undefined;
    task.promise = runIsolatedBrowserCommand(this.container, command, {
      cwd: this.workspacePath,
      signal: AbortSignal.any([parentSignal, controller.signal]),
      onStdout: append,
      onStderr: append,
    }).then((result) => {
      const output = streamed ? combined : joinOutput(result.stdout, result.stderr);
      const cancelled = Boolean(task.explicitlyCancelled);
      const timedOut = Boolean(task.timedOut && !cancelled);
      this.finish(task, output, timedOut ? "timed_out" : cancelled ? "cancelled" : result.exitCode === 0 ? "completed" : "failed", timedOut || cancelled ? undefined : result.exitCode, streamed);
      return task.output;
    }, (error: unknown) => {
      const timedOut = Boolean(task.timedOut && !task.explicitlyCancelled);
      const cancelled = Boolean(task.explicitlyCancelled);
      const output = streamed ? combined : timedOut || cancelled ? "" : error instanceof Error ? error.message : String(error);
      this.finish(task, output, timedOut ? "timed_out" : cancelled ? "cancelled" : "failed", timedOut || cancelled ? undefined : 1, streamed);
      return task.output;
    }).finally(() => { if (timeout !== undefined) clearTimeout(timeout); });
    this.tasks.set(id, task);
    return task;
  }

  createExternal(options: ExternalTaskOptions): BrowserBackgroundTask {
    const controller = new AbortController();
    let resolveLaunchStarted!: () => void;
    const launchStarted = new Promise<void>((resolve) => { resolveLaunchStarted = resolve; });
    const task: BrowserBackgroundTask = {
      id: options.id,
      controller,
      status: "running",
      output: "",
      promise: Promise.resolve(""),
      kind: options.kind,
      ...(options.description ? { description: options.description } : {}),
      ...(options.subagentType ? { subagentType: options.subagentType } : {}),
      startedAt: Date.now(),
      outputFile: "",
      rawOutputBytes: 0,
      truncated: false,
      launchStarted,
    };
    const start = options.deferStart
      ? new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
      : Promise.resolve();
    task.promise = start.then(() => {
      try {
        return options.promise(AbortSignal.any([options.parentSignal, controller.signal]));
      } finally {
        resolveLaunchStarted();
      }
    }).then((output) => {
      this.finish(task, output, "completed", 0);
      return task.output;
    }, (error: unknown) => {
      const cancelled = controller.signal.aborted;
      const output = cancelled ? "Subagent was cancelled" : error instanceof Error ? error.message : String(error);
      this.finish(task, output, cancelled ? "cancelled" : "failed", cancelled ? undefined : 1);
      return task.output;
    });
    this.tasks.set(task.id, task);
    return task;
  }

  kill(taskId: string): string {
    const task = this.tasks.get(taskId);
    if (!task) {
      const ids = [...this.tasks.values()].filter((candidate) => candidate.kind === "command" || candidate.kind === "monitor").map((candidate) => candidate.id);
      return ids.length === 0
        ? `Task or subagent ${taskId} not found. No background tasks or subagents exist in this session.`
        : `Task or subagent ${taskId} not found. Known bash task IDs: [${ids.join(", ")}]`;
    }
    if (task.status !== "running") {
      return task.kind === "subagent"
        ? `already_exited: Subagent already ${task.status}`
        : "already_exited: Task had already completed";
    }
    task.explicitlyCancelled = true;
    task.status = "cancelled";
    task.endedAt = Date.now();
    task.controller.abort(new DOMException("Task terminated", "AbortError"));
    return task.kind === "subagent"
      ? "killed: Subagent cancellation initiated"
      : "killed: Task was terminated successfully";
  }

  async output(input: Record<string, unknown>): Promise<string> {
    if (Object.prototype.hasOwnProperty.call(input, "task_ids") && Object.prototype.hasOwnProperty.call(input, "task_id")) {
      throw new Error("duplicate field `task_ids`");
    }
    const ids = resolveTaskIds(input.task_ids ?? input.task_id);
    if (ids.length === 0) throw new Error("Provide a non-empty task_ids list.");
    if (ids.length > MAX_MULTI_TASK_IDS) throw new Error(`task_ids exceeds maximum of ${MAX_MULTI_TASK_IDS} entries.`);
    const wait = boundedTimeout(input.timeout_ms);
    const tasks = ids.map((id) => this.tasks.get(id));
    if (wait.effectiveMs > 0) {
      await settleBefore(Promise.all(tasks.filter((task) => task?.status === "running").map((task) => task!.promise)), wait.effectiveMs);
    }
    if (ids.length === 1) {
      const task = tasks[0];
      if (!task) {
        const known = [...this.tasks.values()].filter((candidate) => candidate.kind === "command" || candidate.kind === "monitor").map((candidate) => candidate.id);
        return known.length === 0
          ? `Task ${ids[0]} not found. No background tasks or subagents exist in this session.`
          : `Task ${ids[0]} not found. Known task IDs: [${known.join(", ")}]`;
      }
      return formatSingleTask(task, wait);
    }
    const results = ids.map((id, index) => tasks[index] ? taskView(tasks[index]!, wait) : notFoundView(id));
    const completed = results.filter((result) => ["completed", "failed", "cancelled", "timed_out"].includes(result.status)).length;
    const mode = wait.effectiveMs > 0 ? "wait_all" : "poll";
    const lines = [`=== Multi-wait (${mode}) ===`];
    for (const result of results) {
      lines.push(`--- Task ${result.taskId} [${result.status}] ---\nCommand: ${result.command}\nDuration: ${result.durationSecs.toFixed(2)}s`);
      if (result.exitCode !== undefined) lines.push(`Exit Code: ${result.exitCode}`);
      if (result.output) lines.push(result.output);
    }
    lines.push(`\n${completed}/${results.length} tasks completed (${mode})`);
    return lines.join("\n");
  }

  private finish(
    task: BrowserBackgroundTask,
    output: string,
    status: BrowserBackgroundTask["status"],
    exitCode: number | undefined,
    preserveStreamedOutput = false,
  ): void {
    const explicitlyCancelled = task.status === "cancelled";
    if (explicitlyCancelled) status = "cancelled";
    task.status = status;
    task.endedAt = Date.now();
    if (!preserveStreamedOutput) {
      task.rawOutputBytes = utf8Length(output);
      if (task.kind === "command" || task.kind === "monitor") {
        const retained = utf8Prefix(output, RETAINED_LOG_BYTES);
        const view = ringOutput(retained, task.kind === "monitor" ? MONITOR_OUTPUT_CHAR_LIMIT : COMMAND_OUTPUT_CHAR_LIMIT);
        task.output = view.output;
        task.truncated = view.truncated || task.rawOutputBytes > utf8Length(retained);
        output = retained;
      } else {
        task.output = output;
      }
    }
    if (!explicitlyCancelled && exitCode !== undefined) task.exitCode = exitCode;
    if (task.outputFile) this.container.vfs.writeFileSync(task.outputFile, output);
  }

  private ensureOutputFile(path: string): void {
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    this.container.vfs.mkdirSync(parent, { recursive: true });
    this.container.vfs.writeFileSync(path, "");
  }
}

interface TaskView {
  taskId: string;
  command: string;
  status: BrowserBackgroundTask["status"] | "not_found";
  durationSecs: number;
  exitCode?: number;
  output: string;
  outputFile: string;
  truncated: boolean;
}

interface WaitRequest {
  requestedMs: number;
  effectiveMs: number;
}

function taskView(task: BrowserBackgroundTask, wait: WaitRequest): TaskView {
  let output = task.output;
  let truncated = task.truncated;
  if (utf8Length(output) > MAX_TOOL_OUTPUT_BYTES) {
    output = `${utf8Prefix(output, OUTPUT_PREVIEW_BYTES)}\n\n[Output truncated - ${task.rawOutputBytes} bytes total. Use read_file on ${task.outputFile} for full content]`;
    truncated = true;
  } else {
    output = softWrapLines(output, SOFT_WRAP_WIDTH);
  }
  if (task.status === "running") {
    const subject = task.kind === "subagent" ? "subagent" : "task";
    const waitHint = wait.effectiveMs > 0
      ? wait.requestedMs > wait.effectiveMs
        ? `Waited ${formatDuration(wait.effectiveMs)}, the per-call maximum, of the ${formatDuration(wait.requestedMs)} you requested; the ${subject} is still running. You do not need to call this again.`
        : `Waited the requested ${formatDuration(wait.effectiveMs)}; the ${subject} is still running.`
      : "Use timeout_ms to wait for completion.";
    output = `${output}${output ? "\n\n" : ""}${waitHint} You will be notified automatically when the ${subject} completes.`;
  }
  return {
    taskId: task.id,
    command: task.kind === "subagent"
      ? `[subagent:${task.subagentType ?? "general-purpose"}] ${task.description ?? ""}`
      : task.kind === "monitor"
        ? `[monitor] ${task.description ?? ""}`
        : task.command ?? "",
    status: task.status,
    durationSecs: Math.max(0, (task.endedAt ?? Date.now()) - task.startedAt) / 1_000,
    ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
    output,
    outputFile: task.outputFile,
    truncated,
  };
}

function ringOutput(value: string, charLimit: number): { output: string; truncated: boolean } {
  const characters = [...value];
  if (characters.length <= charLimit) return { output: value, truncated: false };
  const half = Math.floor(charLimit / 2);
  return {
    output: `${characters.slice(0, half).join("").trimEnd()}${FRONT_BACK_MARKER}${characters.slice(-half).join("").trimStart()}`,
    truncated: true,
  };
}

function notFoundView(taskId: string): TaskView {
  return { taskId, command: "", status: "not_found", durationSecs: 0, output: `Task ${taskId} not found.`, outputFile: "", truncated: false };
}

function formatSingleTask(task: BrowserBackgroundTask, wait: WaitRequest): string {
  const result = taskView(task, wait);
  const lines = [
    `=== Task ${result.taskId} ===`,
    `Command: ${result.command}`,
    `Status: ${result.status}`,
    `Duration: ${result.durationSecs.toFixed(2)}s`,
  ];
  if (result.exitCode !== undefined) lines.push(`Exit Code: ${result.exitCode}`);
  if (result.outputFile) lines.push(`Output File: ${result.outputFile}`);
  lines.push("", "=== Output ===", result.output || (result.status === "running" ? "(no output yet)" : "(no output)"));
  if (result.truncated) lines.push("[truncated - use read_file on output_file for full content]");
  return lines.join("\n");
}

function resolveTaskIds(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" && typeof item !== "number") {
      throw new Error(`expected a list of string ids (or a single string), got ${JSON.stringify(value)}`);
    }
    const id = String(item).trim();
    if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return ids;
}

function boundedTimeout(value: unknown): WaitRequest {
  if (value === undefined || value === null) return { requestedMs: 0, effectiveMs: 0 };
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("Expected an integer");
  const requestedMs = Number(value);
  return { requestedMs, effectiveMs: Math.min(requestedMs, 600_000) };
}

async function settleBefore(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function joinOutput(stdout: string, stderr: string): string {
  return [stdout, stderr].filter(Boolean).join(stdout && stderr ? "\n" : "");
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  let end = Math.min(maxBytes, bytes.length);
  while (end > 0) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

function softWrapLines(value: string, width: number): string {
  return value.split("\n").map((line) => {
    if ([...line].length <= width) return line;
    const chars = [...line];
    const chunks: string[] = [];
    for (let index = 0; index < chars.length; index += width) chunks.push(chars.slice(index, index + width).join(""));
    return chunks.join("\n");
  }).join("\n");
}

function formatDuration(ms: number): string {
  return ms < 1_000 ? `${ms}ms` : `${Math.floor(ms / 1_000)}s`;
}

/** RFC 9562 UUIDv7 with millisecond ordering and cryptographic random tail. */
export function uuidV7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
