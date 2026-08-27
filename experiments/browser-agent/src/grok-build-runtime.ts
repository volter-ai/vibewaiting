import type { VirtualFS } from "almostnode";
import type {
  GrokBuildToolCall,
  GrokBuildToolResult,
  GrokBuildToolRuntime,
} from "./grok-build-agent.js";
import {
  GrokBuildBrowserScheduler,
  type GrokScheduledTaskEvent,
} from "./grok-build-scheduler.js";
import { GrokBuildFileSystemTools } from "./grok-build-filesystem.js";

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface BrowserContainer {
  vfs: VirtualFS;
  run(command: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<RunResult>;
}

export interface GrokBuildBrowserServices {
  spawnSubagent?(input: JsonObject, signal: AbortSignal, subagentId: string): Promise<string>;
  searchTools?(query: string, limit: number, signal: AbortSignal): Promise<string>;
  useTool?(name: string, input: JsonObject, signal: AbortSignal): Promise<string>;
  runWorkflow?(input: JsonObject, signal: AbortSignal): Promise<string>;
  askUser?(questions: unknown[], signal: AbortSignal, context: { planMode: boolean }): Promise<string>;
  generateImage?(input: JsonObject, signal: AbortSignal): Promise<string>;
  editImage?(input: JsonObject, signal: AbortSignal): Promise<string>;
  imageToVideo?(input: JsonObject, signal: AbortSignal): Promise<string>;
  referenceToVideo?(input: JsonObject, signal: AbortSignal): Promise<string>;
  webFetch?(url: string, signal: AbortSignal): Promise<string>;
  runScheduledForeground?(prompt: string, signal: AbortSignal): Promise<string>;
  onScheduledTaskEvent?(event: GrokScheduledTaskEvent): void;
}

export type { GrokScheduledTaskEvent } from "./grok-build-scheduler.js";
export {
  GrokConformanceToolRuntime,
  GrokRecordedToolRuntime,
  type GrokConformanceDriverProfile,
} from "./grok-build-conformance-runtime.js";

interface BackgroundTask {
  id: string;
  controller: AbortController;
  promise: Promise<string>;
  status: "running" | "completed" | "failed" | "cancelled";
  output: string;
  kind: "command" | "monitor" | "subagent" | "workflow";
  command?: string;
  description?: string;
  subagentType?: string;
  startedAt: number;
}

interface Todo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

type JsonObject = Record<string, unknown>;

/** Browser implementation of Grok Build's complete advertised function-tool surface. */
export class GrokBuildBrowserRuntime implements GrokBuildToolRuntime {
  private readonly tasks = new Map<string, BackgroundTask>();
  private readonly todos = new Map<string, Todo>();
  private readonly files: GrokBuildFileSystemTools;
  private readonly scheduler?: GrokBuildBrowserScheduler;
  private nextTask = 1;
  private planMode = false;

  constructor(
    private readonly container: BrowserContainer,
    private readonly workspacePath = "/",
    private readonly services: GrokBuildBrowserServices = {},
    private readonly allowedTools?: ReadonlySet<string>,
  ) {
    this.files = new GrokBuildFileSystemTools(container.vfs, workspacePath);
    if (!allowedTools || allowedTools.has("scheduler_create")) {
      this.scheduler = new GrokBuildBrowserScheduler(container.vfs, workspacePath, {
        spawnSubagent: (input, signal, id) => this.createSubagentTask(input, signal, id),
        getSubagent: (id) => this.tasks.get(id),
        ...(services.runScheduledForeground ? { runForeground: services.runScheduledForeground } : {}),
        ...(services.onScheduledTaskEvent ? { onEvent: services.onScheduledTaskEvent } : {}),
      });
    }
  }

  compactionSystemReminder(now = Date.now()): string | undefined {
    const sections: string[] = [];
    const commands = [...this.tasks.values()].filter((task) => task.status === "running" && task.kind !== "subagent");
    if (commands.length > 0) {
      sections.push(`## Running Background Tasks\nThese tasks are still running:\n${commands.map((task) =>
        `- "${task.id}": \`${task.command ?? ""}\` (running, ${task.kind === "monitor" ? "monitor" : "run_terminal_command"})`).join("\n")}`);
    }
    const activeTodos = [...this.todos.values()].filter((todo) => todo.status === "pending" || todo.status === "in_progress");
    if (activeTodos.length > 0) {
      const completed = [...this.todos.values()].filter((todo) => todo.status === "completed").length;
      const cancelled = [...this.todos.values()].filter((todo) => todo.status === "cancelled").length;
      const trailer = completed && cancelled ? `\n(${completed} completed, ${cancelled} cancelled)`
        : completed ? `\n(${completed} completed)` : cancelled ? `\n(${cancelled} cancelled)` : "";
      sections.push(`## TODO List\nThis is your task list from before the conversation was compacted — it is still active. Keep working through the items below and update their status as you make progress:\n${activeTodos.map((todo) => `- [${todo.status}] ${todo.id}: ${todo.content}`).join("\n")}${trailer}`);
    }
    const subagents = [...this.tasks.values()].filter((task) => task.status === "running" && task.kind === "subagent");
    if (subagents.length > 0) {
      sections.push(`## Running Subagents\nThese subagents were launched before this compaction and are still running. Use \`get_command_or_subagent_output\` with the subagent_id to check their status or retrieve results. Use \`kill_command_or_subagent\` with the subagent_id to cancel a subagent.\n${subagents.map((task) => {
        const type = task.subagentType ? `, type: \`${task.subagentType}\`` : "";
        const description = task.description ? `, task: "${task.description}"` : "";
        return `- subagent_id: \`${task.id}\`${type}${description} (running for ${Math.floor(Math.max(0, now - task.startedAt) / 1_000)}s)`;
      }).join("\n")}`);
    }
    return sections.length > 0 ? `<system-reminder>\n${sections.join("\n\n")}\n</system-reminder>` : undefined;
  }

  async execute(call: GrokBuildToolCall, signal: AbortSignal): Promise<GrokBuildToolResult> {
    if (this.allowedTools && !this.allowedTools.has(call.name)) {
      return failure(`Tool ${call.name} is not available to this subagent capability mode.`);
    }
    let input: JsonObject;
    try {
      const parsed: unknown = JSON.parse(call.arguments || "{}");
      if (!isObject(parsed)) throw new Error("arguments must be a JSON object");
      input = parsed;
    } catch (error) {
      return failure(`Invalid arguments for ${call.name}: ${message(error)}`);
    }

    try {
      const output = await this.dispatch(call.name, input, signal);
      return { output };
    } catch (error) {
      return failure(message(error));
    }
  }

  private async dispatch(name: string, input: JsonObject, signal: AbortSignal): Promise<string> {
    switch (name) {
      case "run_terminal_command": return this.runTerminal(input, signal);
      case "read_file": return this.files.readFile(input);
      case "search_replace": return this.files.searchReplace(input);
      case "list_dir": return this.files.listDir(input);
      case "grep": return this.files.grep(input);
      case "kill_command_or_subagent": return this.killTask(input);
      case "todo_write": return this.todoWrite(input);
      case "get_command_or_subagent_output": return this.getTaskOutput(input);
      case "spawn_subagent": return this.spawnSubagent(input, signal);
      case "scheduler_create": return requiredScheduler(this.scheduler).create(input);
      case "scheduler_delete": return requiredScheduler(this.scheduler).delete(input);
      case "scheduler_list": return requiredScheduler(this.scheduler).list();
      case "monitor": return this.monitor(input, signal);
      case "search_tool": return this.services.searchTools
        ? this.services.searchTools(string(input.query, "query"), integer(input.limit, 5), signal)
        : noMcpToolsConfigured();
      case "use_tool": return requiredService(this.services.useTool, "use_tool")(string(input.tool_name, "tool_name"), object(input.tool_input, "tool_input"), signal);
      case "workflow": return requiredService(this.services.runWorkflow, "workflow")(input, signal);
      case "enter_plan_mode": return this.enterPlanMode();
      case "exit_plan_mode": return this.exitPlanMode();
      case "ask_user_question": return requiredService(this.services.askUser, "ask_user_question")(array(input.questions, "questions"), signal, { planMode: this.planMode });
      case "web_fetch": return requiredService(this.services.webFetch, "web_fetch")(string(input.url, "url"), signal);
      case "image_gen": return requiredService(this.services.generateImage, "image_gen")(input, signal);
      case "image_edit": return requiredService(this.services.editImage, "image_edit")(input, signal);
      case "image_to_video": return requiredService(this.services.imageToVideo, "image_to_video")(input, signal);
      case "reference_to_video": return requiredService(this.services.referenceToVideo, "reference_to_video")(input, signal);
      case "write": return this.files.write(input);
      default: throw new Error(`Unknown Grok Build tool: ${name}`);
    }
  }

  private async runTerminal(input: JsonObject, signal: AbortSignal): Promise<string> {
    const command = string(input.command, "command");
    if (boolean(input.background, false)) return this.startBackground(command, signal);
    if (input.timeout === undefined || input.timeout === null) {
      const task = this.createCommandTask(command, signal, "command");
      const completed = await settleBefore(task.promise, 120_000, signal);
      if (completed !== undefined) return completed;
      return `Command automatically moved to background with task ID: ${task.id}`;
    }
    const controller = new AbortController();
    const timeoutMs = Math.min(integer(input.timeout, 120_000), 36_000_000);
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await this.container.run(command, {
        cwd: this.workspacePath,
        signal: AbortSignal.any([signal, controller.signal]),
      });
      return formatCommandResult(result);
    } finally {
      window.clearTimeout(timer);
    }
  }

  private startBackground(command: string, parentSignal: AbortSignal): string {
    const task = this.createCommandTask(command, parentSignal, "command");
    return `Command started in background with task ID: ${task.id}`;
  }

  private createCommandTask(command: string, parentSignal: AbortSignal, kind: BackgroundTask["kind"]): BackgroundTask {
    const id = `${kind === "monitor" ? "monitor" : "command"}-${this.nextTask++}`;
    const controller = new AbortController();
    const task: BackgroundTask = {
      id,
      controller,
      status: "running",
      output: "",
      promise: Promise.resolve(""),
      kind,
      command,
      startedAt: Date.now(),
    };
    task.promise = this.container.run(command, {
      cwd: this.workspacePath,
      signal: AbortSignal.any([parentSignal, controller.signal]),
    }).then((result) => {
      task.status = "completed";
      task.output = formatCommandResult(result);
      return task.output;
    }, (error: unknown) => {
      task.status = controller.signal.aborted ? "cancelled" : "failed";
      task.output = message(error);
      return task.output;
    });
    this.tasks.set(id, task);
    return task;
  }

  private async spawnSubagent(input: JsonObject, parentSignal: AbortSignal): Promise<string> {
    const id = crypto.randomUUID();
    const task = this.createSubagentTask(input, parentSignal, id);
    if (boolean(input.background, true)) {
      return `Subagent started in background.\nsubagent_id: ${id}\nUse get_command_or_subagent_output with task_ids: ["${id}"] to retrieve its result.`;
    }
    const output = await task.promise;
    if (task.status === "failed") throw new Error(output);
    return `${output}\n\nsubagent_id: ${id}`;
  }

  private createSubagentTask(input: JsonObject, parentSignal: AbortSignal, id: string): BackgroundTask {
    const service = requiredService(this.services.spawnSubagent, "spawn_subagent");
    const controller = new AbortController();
    const task: BackgroundTask = {
      id,
      controller,
      status: "running",
      output: "",
      promise: Promise.resolve(""),
      kind: "subagent",
      ...(typeof input.description === "string" ? { description: input.description } : {}),
      subagentType: typeof input.subagent_type === "string" ? input.subagent_type : "general-purpose",
      startedAt: Date.now(),
    };
    task.promise = service(input, AbortSignal.any([parentSignal, controller.signal]), id).then((output) => {
      task.status = "completed";
      task.output = output;
      return output;
    }, (error: unknown) => {
      task.status = controller.signal.aborted ? "cancelled" : "failed";
      task.output = message(error);
      return task.output;
    });
    this.tasks.set(id, task);
    return task;
  }

  private killTask(input: JsonObject): string {
    const id = string(input.task_id, "task_id");
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Unknown task ID: ${id}`);
    task.controller.abort();
    task.status = "cancelled";
    return `Task ${id} cancelled.`;
  }

  private async getTaskOutput(input: JsonObject): Promise<string> {
    const ids = (Array.isArray(input.task_ids) ? input.task_ids : []).map((value) => String(value));
    if (ids.length === 0) return [...this.tasks.values()].map(formatTask).join("\n\n") || "No background tasks.";
    const tasks = ids.map((id) => this.tasks.get(id) ?? (() => { throw new Error(`Unknown task ID: ${id}`); })());
    const timeoutMs = Math.min(Math.max(0, integer(input.timeout_ms, 0)), 600_000);
    if (timeoutMs > 0) await settleBefore(Promise.all(tasks.map((task) => task.promise)), timeoutMs, new AbortController().signal);
    return tasks.map(formatTask).join("\n\n");
  }

  private todoWrite(input: JsonObject): string {
    if (!boolean(input.merge, true)) this.todos.clear();
    for (const value of array(input.todos, "todos")) {
      if (!isObject(value)) throw new Error("Each todo must be an object");
      const id = string(value.id, "todo.id");
      const prior = this.todos.get(id);
      const status = typeof value.status === "string" ? value.status as Todo["status"] : prior?.status ?? "pending";
      const content = typeof value.content === "string" ? value.content : prior?.content;
      if (!content) throw new Error(`Todo ${id} requires content`);
      this.todos.set(id, { id, content, status });
    }
    return [...this.todos.values()].map((todo) => `- [${todo.status}] ${todo.id}: ${todo.content}`).join("\n");
  }

  private enterPlanMode(): string {
    const planFile = this.planFilePath();
    let status: "empty" | "non-empty";
    if (this.container.vfs.existsSync(planFile)) {
      if (this.container.vfs.statSync(planFile).isDirectory()) {
        throw new Error(`A directory already exists at the plan file path: ${planFile}`);
      }
      status = this.container.vfs.readFileSync(planFile).byteLength === 0 ? "empty" : "non-empty";
    } else {
      this.ensureParent(planFile);
      this.container.vfs.writeFileSync(planFile, "");
      status = "empty";
    }
    this.planMode = true;
    const message = "You have entered plan mode. You should now focus on exploring the codebase and creating an implementation plan.";
    const taskHint = "\n     You can use the spawn_subagent tool with subagent_type=\"explore\" to parallelize codebase exploration without filling your context window.";
    return `${message}\n\nWrite your plan to ${planFile}. The file exists and is ${status}.\n\nIn plan mode, you should:\n1. Thoroughly explore the codebase to understand existing patterns${taskHint}\n2. Identify similar features, codebase architecture, and understand trade-offs\n3. Use ask_user_question if you need to clarify the approach\n4. Design a concrete implementation strategy\n5. Write your plan to the plan file above\n6. When ready, use exit_plan_mode to present your plan to the user.`;
  }

  private exitPlanMode(): string {
    const planFile = this.planFilePath();
    const content = this.container.vfs.existsSync(planFile) && this.container.vfs.statSync(planFile).isFile()
      ? this.container.vfs.readFileSync(planFile, "utf8")
      : "";
    this.planMode = false;
    if (!content.trim()) return "Plan mode exit approved. No plan content was found — you can proceed.";
    return `Your plan has been approved. You can now start coding.\n\nYour plan has been saved at: ${planFile}\n\n## Plan:\n${content}`;
  }

  private planFilePath(): string {
    return join(this.workspacePath, ".grok/plan.md");
  }

  private monitor(input: JsonObject, signal: AbortSignal): string {
    const task = this.createCommandTask(string(input.command, "command"), signal, "monitor");
    return `Monitor started with task ID: ${task.id}`;
  }

  private ensureParent(path: string): void {
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    this.container.vfs.mkdirSync(parent, { recursive: true });
  }

  private resolve(path: string): string {
    const absolute = path.startsWith("/") ? path : join(this.workspacePath, path);
    return normalize(absolute);
  }
}

function formatCommandResult(result: RunResult): string {
  const output = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? "\n" : "");
  return output || `Process exited with code ${result.exitCode}`;
}

function formatTask(task: BackgroundTask): string {
  return `Task ${task.id} [${task.status}]${task.output ? `\n${task.output}` : ""}`;
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function join(left: string, right: string): string {
  return normalize(`${left}/${right}`);
}

function noMcpToolsConfigured(): string {
  return JSON.stringify({
    results: [],
    total_hidden_tools: 0,
    note: "No integration tools are configured. MCP servers are not connected.",
  }, null, 2);
}

async function settleBefore<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T | undefined> {
  signal.throwIfAborted();
  let timer: number | undefined;
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve, reject) => {
        timer = globalThis.setTimeout(resolve, timeoutMs);
        abortListener = () => reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}

function requiredService<T extends (...args: never[]) => Promise<string>>(service: T | undefined, name: string): T {
  if (!service) throw new Error(`${name} requires an explicitly configured browser/serverless service adapter.`);
  return service;
}

function requiredScheduler(scheduler: GrokBuildBrowserScheduler | undefined): GrokBuildBrowserScheduler {
  if (!scheduler) throw new Error("scheduler tools are not available to this subagent capability mode.");
  return scheduler;
}

function string(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw new Error(`${name} must be a${allowEmpty ? "" : " non-empty"} string`);
  return value;
}

function integer(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value)) throw new Error("Expected an integer");
  return value as number;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function object(value: unknown, name: string): JsonObject {
  if (!isObject(value)) throw new Error(`${name} must be an object`);
  return value;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function failure(output: string): GrokBuildToolResult {
  return { output, isError: true };
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
