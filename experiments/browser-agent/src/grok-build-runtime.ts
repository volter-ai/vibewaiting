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
import {
  GrokBuildBackgroundTasks,
  formatGrokBackgroundTaskStarted,
  type BrowserBackgroundTask,
} from "./grok-build-background-tasks.js";
import { formatGrokMonitorEvents, GrokBuildMonitorEventStream } from "./grok-build-monitor.js";
import { tryBrowserNodeCheck } from "./browser-node-check.js";
import { parseGrokLenientU64, selfMatchingPkillError } from "./grok-build-command-input.js";
import { installBrowserCommandIsolation } from "./grok-build-command-isolation.js";
import {
  GrokBuildPermissionManager,
  type GrokBuildPermissionPrompter,
  type GrokBuildPermissionRequest,
  type GrokBuildPermissionStore,
} from "./grok-build-permissions.js";

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface BrowserContainer {
  vfs: VirtualFS;
  run(command: string, options?: {
    cwd?: string;
    signal?: AbortSignal;
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
  }): Promise<RunResult>;
}

export interface GrokBuildBrowserServices {
  spawnSubagent?(input: JsonObject, signal: AbortSignal, subagentId: string): Promise<string | GrokBuildSubagentExecutionResult>;
  onSubagentScheduled?(subagentId: string): void;
  searchTools?(query: string, limit: number, signal: AbortSignal): Promise<string>;
  useTool?(name: string, input: JsonObject, signal: AbortSignal): Promise<string>;
  runWorkflow?(input: JsonObject, signal: AbortSignal): Promise<string>;
  askUser?(questions: unknown[], signal: AbortSignal, context: { planMode: boolean }): Promise<string>;
  generateImage?(input: JsonObject, signal: AbortSignal): Promise<string>;
  editImage?(input: JsonObject, signal: AbortSignal): Promise<string>;
  imageToVideo?(input: JsonObject, signal: AbortSignal): Promise<string>;
  referenceToVideo?(input: JsonObject, signal: AbortSignal): Promise<string>;
  webFetch?(url: string, signal: AbortSignal): Promise<string>;
  runScheduledForeground?(prompt: string, signal: AbortSignal, context: { taskId: string; humanSchedule: string }): Promise<string>;
  onScheduledTaskEvent?(event: GrokScheduledTaskEvent): void;
  approvePlanModeEntry?(signal: AbortSignal): Promise<boolean>;
  approvePlanModeExit?(plan: string, signal: AbortSignal): Promise<{
    outcome: "approved" | "cancelled" | "abandoned";
    feedback?: string;
  }>;
  onMonitorEvent?(reminder: string): void;
  onSystemReminderQueued?(event: GrokBuildSystemReminderEvent): void;
  suggestSkillPath?(requestedPath: string): string | undefined;
  requestToolPermission?: GrokBuildPermissionPrompter;
}

export interface GrokBuildSubagentExecutionResult {
  childSessionId?: string;
  output: string;
  success: boolean;
  durationMs: number;
  toolCalls?: number;
  turns?: number;
}

export interface GrokBuildSystemReminderEvent {
  promptId: string;
  taskId: string;
  source: "command_completed" | "monitor_completed" | "monitor_event" | "subagent_completed";
  reminder: string;
}

export type { GrokScheduledTaskEvent } from "./grok-build-scheduler.js";
export {
  GrokConformanceToolRuntime,
  GrokRecordedToolRuntime,
  type GrokConformanceDriverProfile,
} from "./grok-build-conformance-runtime.js";

interface Todo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

type JsonObject = Record<string, unknown>;

/** Browser implementation of Grok Build's complete advertised function-tool surface. */
export class GrokBuildBrowserRuntime implements GrokBuildToolRuntime {
  private readonly background: GrokBuildBackgroundTasks;
  private readonly todos = new Map<string, Todo>();
  private readonly files: GrokBuildFileSystemTools;
  private readonly scheduler?: GrokBuildBrowserScheduler;
  private planMode = false;
  private awaitingPlanApproval = false;
  private planApprovalInFlight = false;
  private readonly asynchronousReminders: GrokBuildSystemReminderEvent[] = [];
  private pendingNotificationPromptId: string | undefined;
  private readonly reportedTaskCompletions = new Set<string>();
  private readonly permissions: GrokBuildPermissionManager | undefined;

  constructor(
    private readonly container: BrowserContainer,
    private readonly workspacePath = "/",
    private readonly services: GrokBuildBrowserServices = {},
    private readonly allowedTools?: ReadonlySet<string>,
    /** Native nested agents share the root coordinator and scheduler. */
    private readonly controlPlaneOwner?: GrokBuildBrowserRuntime,
    /** Native currently wires only a child definition's bypassPermissions mode. */
    private readonly bypassPermissions = false,
  ) {
    installBrowserCommandIsolation(container);
    this.permissions = controlPlaneOwner?.permissions
      ?? (services.requestToolPermission ? new GrokBuildPermissionManager(services.requestToolPermission, permissionStore(container.vfs)) : undefined);
    this.files = new GrokBuildFileSystemTools(container.vfs, workspacePath);
    this.background = new GrokBuildBackgroundTasks(container, workspacePath);
    const restoredPlanMode = this.restorePlanMode();
    this.planMode = restoredPlanMode.active;
    this.awaitingPlanApproval = restoredPlanMode.awaitingPlanApproval;
    if (!allowedTools || allowedTools.has("scheduler_create")) {
      this.scheduler = controlPlaneOwner?.scheduler ?? new GrokBuildBrowserScheduler(container.vfs, workspacePath, {
        spawnSubagent: (input, signal, id) => this.createSubagentTask(input, signal, id),
        getSubagent: (id) => this.background.get(id),
        ...(services.runScheduledForeground ? { runForeground: services.runScheduledForeground } : {}),
        ...(services.onScheduledTaskEvent ? { onEvent: services.onScheduledTaskEvent } : {}),
      });
    }
  }

  isAlwaysApprove(): boolean { return this.permissions?.isAlwaysApprove() ?? true; }

  setAlwaysApprove(enabled: boolean): boolean { return this.permissions?.setAlwaysApprove(enabled) ?? enabled; }

  compactionSystemReminder(now = Date.now()): string | undefined {
    const sections: string[] = [];
    const commands = [...this.background.values()].filter((task) => task.status === "running" && task.kind !== "subagent");
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
    const subagents = [...this.background.values()].filter((task) => task.status === "running" && task.kind === "subagent");
    if (subagents.length > 0) {
      sections.push(`## Running Subagents\nThese subagents were launched before this compaction and are still running. Use \`get_command_or_subagent_output\` with the subagent_id to check their status or retrieve results. Use \`kill_command_or_subagent\` with the subagent_id to cancel a subagent.\n${subagents.map((task) => {
        const type = task.subagentType ? `, type: \`${task.subagentType}\`` : "";
        const description = task.description ? `, task: "${task.description}"` : "";
        return `- subagent_id: \`${task.id}\`${type}${description} (running for ${Math.floor(Math.max(0, now - task.startedAt) / 1_000)}s)`;
      }).join("\n")}`);
    }
    return sections.length > 0 ? `<system-reminder>\n${sections.join("\n\n")}\n</system-reminder>` : undefined;
  }

  async waitForPendingSubagentLaunches(): Promise<void> {
    const launches = [...this.background.values()]
      .filter((task) => task.kind === "subagent" && task.status === "running")
      .flatMap((task) => task.launchStarted ? [task.launchStarted] : []);
    await Promise.all(launches);
  }

  async waitForRunningSubagents(): Promise<void> {
    const tasks = [...this.background.values()]
      .filter((task) => task.kind === "subagent" && task.status === "running");
    await Promise.allSettled(tasks.map((task) => task.promise));
  }

  drainSystemReminders(options: { includeAutoWake?: boolean } = {}): string[] {
    const includeAutoWake = options.includeAutoWake ?? true;
    const pending = this.asynchronousReminders.filter((entry) => includeAutoWake || entry.source === "monitor_event");
    if (pending.length === 0) return [];
    const drainedIds = new Set(pending.map((entry) => entry.promptId));
    for (let index = this.asynchronousReminders.length - 1; index >= 0; index -= 1) {
      if (drainedIds.has(this.asynchronousReminders[index]!.promptId)) this.asynchronousReminders.splice(index, 1);
    }
    if (this.pendingNotificationPromptId && drainedIds.has(this.pendingNotificationPromptId)) {
      this.pendingNotificationPromptId = undefined;
    }
    const monitorEvents = pending.filter((entry) => entry.source === "monitor_event").map((entry) => entry.reminder);
    if (monitorEvents.length === 0) return pending.map((entry) => systemReminder(entry.reminder));
    const formatted = formatGrokMonitorEvents(monitorEvents);
    let inserted = false;
    const drained: string[] = [];
    for (const entry of pending) {
      if (entry.source === "monitor_event") {
        if (!inserted && formatted) drained.push(formatted);
        inserted = true;
      } else {
        drained.push(entry.reminder);
      }
    }
    return drained.map(systemReminder);
  }

  takeSystemReminder(promptId: string): string | undefined {
    return this.takeSystemReminders(promptId)[0];
  }

  takeSystemReminders(promptId: string): string[] {
    if (promptId.startsWith("notifications-")) {
      const events = this.asynchronousReminders.filter((entry) => entry.promptId === promptId && entry.source === "monitor_event");
      if (events.length === 0) return [];
      for (let index = this.asynchronousReminders.length - 1; index >= 0; index -= 1) {
        if (this.asynchronousReminders[index]?.promptId === promptId) this.asynchronousReminders.splice(index, 1);
      }
      if (this.pendingNotificationPromptId === promptId) this.pendingNotificationPromptId = undefined;
      const formatted = formatGrokMonitorEvents(events.map((entry) => entry.reminder));
      return formatted ? [systemReminder(formatted)] : [];
    }
    const entries = this.asynchronousReminders.filter((entry) => entry.promptId === promptId);
    if (entries.length === 0) return [];
    for (let index = this.asynchronousReminders.length - 1; index >= 0; index -= 1) {
      if (this.asynchronousReminders[index]?.promptId === promptId) this.asynchronousReminders.splice(index, 1);
    }
    return entries.map((entry) => systemReminder(entry.reminder));
  }

  hasPendingPlanApproval(): boolean {
    return this.planMode && this.awaitingPlanApproval;
  }

  /** Re-issue a persisted plan approval after a browser/session reconnect. */
  async resumePendingPlanApproval(signal: AbortSignal): Promise<string | undefined> {
    if (!this.hasPendingPlanApproval() || this.planApprovalInFlight) return undefined;
    const planFile = this.planFilePath();
    const content = this.container.vfs.existsSync(planFile) && this.container.vfs.statSync(planFile).isFile()
      ? this.container.vfs.readFileSync(planFile, "utf8")
      : "";
    if (!content.trim()) {
      this.setPlanState(true, false);
      return undefined;
    }
    if (!this.services.approvePlanModeExit) return undefined;
    this.planApprovalInFlight = true;
    try {
      const approval = normalizePlanApproval(await this.services.approvePlanModeExit(content, signal));
      this.setPlanState(this.planMode, false);
      if (approval.outcome === "abandoned") {
        this.setPlanState(false, false);
        return undefined;
      }
      if (approval.outcome === "cancelled") return revisePlanMessage(approval.feedback);
      this.setPlanState(false, false);
      return "The user approved the plan. Implement the plan in plan.md.";
    } catch {
      // A delivered reverse-request that loses its browser/client remains
      // parked so the next restore can issue it again.
      this.setPlanState(true, true);
      return undefined;
    } finally {
      this.planApprovalInFlight = false;
    }
  }

  /**
   * Native subagent teardown reparents every surviving terminal task to its
   * parent session. The process and output file stay intact; only registry and
   * notification ownership move.
   */
  reparentBackgroundTasksTo(parent: GrokBuildBrowserRuntime): string[] {
    const reparented: string[] = [];
    for (const task of [...this.background.values()]) {
      if (task.status !== "running" || (task.kind !== "command" && task.kind !== "monitor")) continue;
      const transferred = this.background.take(task.id);
      if (!transferred || (transferred.kind !== "command" && transferred.kind !== "monitor")) continue;
      transferred.notificationSink = parent.reminderSink(transferred.kind, transferred.id);
      parent.background.adopt(transferred);
      reparented.push(transferred.id);
    }
    return reparented;
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
    const planRejection = this.planModeEditRejection(call.name, input);
    if (planRejection) return { output: planRejection };

    try {
      const access = this.permissionAccess(call, input);
      if (access && this.permissions && !this.bypassPermissions) {
        const decision = await this.permissions.authorize(access, signal);
        if (!decision.allowed) return failure(`${decision.reason ?? "User rejected the execution"} for tool \`${call.name}\``);
      }
      const output = await this.dispatch(call.name, input, signal, call.callId);
      return typeof output === "string" ? { output } : output;
    } catch (error) {
      return failure(message(error));
    }
  }

  private permissionAccess(call: GrokBuildToolCall, input: JsonObject): GrokBuildPermissionRequest | undefined {
    const base = { toolCallId: call.callId, toolName: call.name, input };
    switch (call.name) {
      case "read_file": return { ...base, kind: "read", ...(typeof input.target_file === "string" ? { detail: this.resolve(input.target_file) } : {}) };
      case "list_dir": return { ...base, kind: "read", ...(typeof input.target_directory === "string" ? { detail: this.resolve(input.target_directory) } : {}) };
      case "grep": return { ...base, kind: "grep", ...(typeof input.path === "string" ? { detail: this.resolve(input.path) } : {}) };
      case "search_replace":
      case "write": {
        const path = typeof input.file_path === "string" ? this.resolve(input.file_path) : undefined;
        if (this.planMode && path === this.planFilePath()) return;
        return { ...base, kind: "edit", ...(path ? { detail: path } : {}) };
      }
      case "run_terminal_command": return { ...base, kind: "bash", ...(typeof input.command === "string" ? { detail: input.command } : {}) };
      case "use_tool": return { ...base, kind: "mcp", ...(typeof input.tool_name === "string" ? { detail: input.tool_name } : {}) };
      case "web_fetch": return { ...base, kind: "web_fetch", ...(typeof input.url === "string" ? { detail: input.url } : {}) };
      default: return;
    }
  }

  private async dispatch(name: string, input: JsonObject, signal: AbortSignal, callId: string): Promise<string | GrokBuildToolResult> {
    switch (name) {
      case "run_terminal_command": return this.runTerminal(input, signal, callId);
      case "read_file": return this.readFile(input);
      case "search_replace": return this.files.searchReplace(input);
      case "list_dir": return this.files.listDir(input);
      case "grep": return this.files.grep(input);
      case "kill_command_or_subagent": return this.killTask(input);
      case "todo_write": return this.todoWrite(input);
      case "get_command_or_subagent_output": return this.getTaskOutput(input);
      case "spawn_subagent": return this.spawnSubagent(input, signal);
      case "scheduler_create": return formatSchedulerCreateOutput(requiredScheduler(this.scheduler).create(input));
      case "scheduler_delete": return formatSchedulerDeleteOutput(await requiredScheduler(this.scheduler).delete(input));
      case "scheduler_list": return formatSchedulerListOutput(requiredScheduler(this.scheduler).list());
      case "monitor": return this.monitor(input, signal, callId);
      case "search_tool": return this.services.searchTools
        ? this.services.searchTools(string(input.query, "query"), integer(input.limit, 5), signal)
        : noMcpToolsConfigured();
      case "use_tool": return requiredService(this.services.useTool, "use_tool")(string(input.tool_name, "tool_name"), object(input.tool_input, "tool_input"), signal);
      case "workflow": return requiredService(this.services.runWorkflow, "workflow")(input, signal);
      case "enter_plan_mode": return this.enterPlanMode(signal);
      case "exit_plan_mode": return this.exitPlanMode(signal);
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

  private async readFile(input: JsonObject): Promise<GrokBuildToolResult> {
    try {
      return await this.files.readFile(input);
    } catch (error) {
      const messageText = message(error);
      const requested = typeof input.target_file === "string" ? this.resolve(input.target_file) : undefined;
      const suggestion = requested && / does not exist\.$/u.test(messageText)
        ? this.services.suggestSkillPath?.(requested)
        : undefined;
      return failure(suggestion
        ? `${messageText}\nThe skill you are looking for is registered at:\n${suggestion}`
        : messageText);
    }
  }

  private async runTerminal(input: JsonObject, signal: AbortSignal, callId: string): Promise<string> {
    const command = string(input.command, "command", true);
    if (typeof input.description !== "string") throw new Error("missing field `description`");
    const processSafetyError = selfMatchingPkillError(command);
    if (processSafetyError) throw new Error(processSafetyError);
    if (boolean(input.background, false)) return this.startBackground(command, signal, backgroundTimeout(input.timeout), callId);
    const builtin = tryBrowserNodeCheck(this.container.vfs, this.workspacePath, command);
    if (builtin) return formatCommandResult(builtin);
    if (input.timeout === undefined || input.timeout === null) {
      const task = this.createCommandTask(command, signal, "command", undefined, callId, true);
      const completed = await settleBefore(task.promise, 120_000, signal);
      if (completed !== undefined) {
        return formatCommandResult({
          stdout: sanitizeWorkspaceShellOutput(command, completed, this.workspacePath),
          stderr: "",
          exitCode: task.exitCode ?? (task.status === "failed" ? 1 : 0),
        });
      }
      task.notificationSink = this.reminderSink("command", task.id);
      this.watchBackgroundCompletion(task);
      return formatGrokBackgroundTaskStarted(
        task,
        `Command "${command}" exceeded the default timeout and was automatically moved to background. Process is still running.`,
      );
    }
    const controller = new AbortController();
    const timeoutMs = boundedCommandTimeout(input.timeout, 120_000);
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    const timer = globalThis.setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Command timed out", "TimeoutError"));
    }, timeoutMs);
    try {
      const result = await this.container.run(command, {
        cwd: this.workspacePath,
        signal: AbortSignal.any([signal, controller.signal]),
        onStdout: (chunk) => { stdout += chunk; },
        onStderr: (chunk) => { stderr += chunk; },
      });
      return formatCommandResult({
        ...result,
        stdout: sanitizeWorkspaceShellOutput(command, result.stdout, this.workspacePath),
      });
    } catch (error) {
      if (!timedOut) throw error;
      const output = [stdout, stderr].filter(Boolean).join(stdout && stderr ? "\n" : "");
      return `exit: killed (timeout)${output ? `\n${output}` : ""}`;
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  private startBackground(command: string, parentSignal: AbortSignal, maxRuntimeMs: number | undefined, callId: string): string {
    const task = this.createCommandTask(command, parentSignal, "command", maxRuntimeMs, callId);
    task.notificationSink = this.reminderSink("command", task.id);
    this.watchBackgroundCompletion(task);
    return formatGrokBackgroundTaskStarted(task, `Background task ${task.id} started`);
  }

  private watchBackgroundCompletion(task: BrowserBackgroundTask): void {
    void task.promise.then(() => {
      if (task.explicitlyCancelled || this.reportedTaskCompletions.has(task.id)) return;
      this.reportedTaskCompletions.add(task.id);
      task.notificationSink?.(formatBashCompletion(task));
    });
  }

  private createCommandTask(command: string, parentSignal: AbortSignal, kind: "command" | "monitor", maxRuntimeMs?: number, callId?: string, useCallIdAsTaskId = false): BrowserBackgroundTask {
    const name = callId?.replace(/[^A-Za-z0-9_.-]/gu, "_");
    const outputFile = name ? join("/tmp/grok-build-session/terminal", `${kind === "monitor" ? "monitor-" : ""}${name}.log`) : undefined;
    return this.background.createCommand(command, parentSignal, kind, undefined, maxRuntimeMs, outputFile, useCallIdAsTaskId ? callId : undefined);
  }

  private async spawnSubagent(input: JsonObject, parentSignal: AbortSignal): Promise<string> {
    if (this.controlPlaneOwner && this.controlPlaneOwner !== this) {
      return this.controlPlaneOwner.spawnSubagent(input, parentSignal);
    }
    const id = crypto.randomUUID();
    const task = this.createSubagentTask(input, parentSignal, id);
    if (boolean(input.background, true)) {
      this.watchSubagentCompletion(task);
      return `Subagent started in background.\nsubagent_id: ${id}\ntype: ${task.subagentType ?? "general-purpose"}\ndescription: ${task.description ?? ""}\n\n` +
        `When you need its result, use get_command_or_subagent_output with task_ids=["${id}"] and a positive timeout_ms.`;
    }
    const output = await task.promise;
    if (task.status === "failed") throw new Error(output);
    return `${output}\n\nsubagent_id: ${id}`;
  }

  private createSubagentTask(input: JsonObject, parentSignal: AbortSignal, id: string): BrowserBackgroundTask {
    const service = requiredService(this.services.spawnSubagent, "spawn_subagent");
    this.services.onSubagentScheduled?.(id);
    const completionOutputCap = Number.isSafeInteger(input.completion_output_cap) && Number(input.completion_output_cap) >= 0
      ? Number(input.completion_output_cap)
      : undefined;
    let task!: BrowserBackgroundTask;
    task = this.background.createExternal({
      id,
      kind: "subagent",
      parentSignal,
      promise: async (childSignal) => {
        const result = await service(input, childSignal, id);
        const output = typeof result === "string" ? result : result.output;
        if (typeof result !== "string") {
          if (result.toolCalls !== undefined) task.toolCalls = result.toolCalls;
          if (result.turns !== undefined) task.turns = result.turns;
          task.completionDurationMs = result.durationMs;
          if (!result.success) throw new Error(output);
          const type = task.subagentType ?? "general-purpose";
          const sessionId = result.childSessionId ?? id;
          const content = completionOutputCap === undefined ? output : capCompletionOutput(output, completionOutputCap);
          return `${content}\n\n<subagent_meta>id=${sessionId}, type=${type}, tool_calls=${result.toolCalls ?? 0}, turns=${result.turns ?? 0}, duration_ms=${Math.max(0, Math.round(result.durationMs))}</subagent_meta>\n\n` +
            `<subagent_result>\nsubagent_id: ${sessionId}\nsubagent_type: ${type}\n` +
            `To continue this subagent's conversation, use resume_from="${sessionId}".\n</subagent_result>`;
        }
        return completionOutputCap === undefined ? output : capCompletionOutput(output, completionOutputCap);
      },
      ...(typeof input.description === "string" ? { description: input.description } : {}),
      subagentType: typeof input.subagent_type === "string" ? input.subagent_type : "general-purpose",
      deferStart: true,
    });
    return task;
  }

  private watchSubagentCompletion(task: BrowserBackgroundTask): void {
    void task.promise.then(() => {
      if (task.explicitlyCancelled || this.reportedTaskCompletions.has(task.id)) return;
      this.reportedTaskCompletions.add(task.id);
      const status = task.status === "completed" ? "successfully" : "with failure";
      const duration = (task.completionDurationMs ?? Math.max(0, (task.endedAt ?? Date.now()) - task.startedAt)) / 1_000;
      const durationText = duration.toFixed(1);
      const summaryReminder = `While you were idle, 1 background subagent completed:\n` +
        `- [${task.subagentType ?? "general-purpose"}] "${task.description ?? ""}" — completed ${status} (${durationText}s, ${task.toolCalls ?? 0} tool calls)\n` +
        `  subagent_id: ${task.id}. Use get_command_or_subagent_output("${task.id}") to see the full output.\n`;
      const reminder = `Background subagent "${task.id}" (${task.subagentType ?? "general-purpose"}: "${task.description ?? ""}") completed ${status}.\n` +
        `Duration: ${durationText}s | Tool calls: ${task.toolCalls ?? 0} | Turns: ${task.turns ?? 0}\n` +
        `Use get_task_output("${task.id}") to see the full output.`;
      const promptId = `subagent-completed-${task.id}`;
      const event: GrokBuildSystemReminderEvent = {
        promptId,
        taskId: task.id,
        source: "subagent_completed",
        reminder,
      };
      this.asynchronousReminders.push({ ...event, reminder: summaryReminder }, event);
      this.services.onSystemReminderQueued?.(event);
    });
  }

  private killTask(input: JsonObject): string {
    const taskId = string(input.task_id, "task_id", true);
    if (!this.background.get(taskId) && this.controlPlaneOwner && this.controlPlaneOwner !== this) {
      return this.controlPlaneOwner.killTask(input);
    }
    return this.background.kill(taskId);
  }

  private async getTaskOutput(input: JsonObject): Promise<string> {
    const ids = taskIds(input);
    if (ids.length > 0 && ids.every((id) => !this.background.get(id)) && this.controlPlaneOwner && this.controlPlaneOwner !== this) {
      return this.controlPlaneOwner.getTaskOutput(input);
    }
    const output = await this.background.output(input);
    const consumed = ids.filter((id) => {
      const status = this.background.get(id)?.status;
      return status !== undefined && status !== "running";
    });
    for (const id of consumed) {
      this.reportedTaskCompletions.add(id);
      for (let index = this.asynchronousReminders.length - 1; index >= 0; index -= 1) {
        if (this.asynchronousReminders[index]?.taskId === id) this.asynchronousReminders.splice(index, 1);
      }
    }
    return output;
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
    const summary = [...this.todos.values()].map((todo) => `- [${todo.status}] ${todo.id}: ${todo.content}`).join("\n");
    return summary ? `${summary}\n` : "";
  }

  private async enterPlanMode(signal: AbortSignal): Promise<string> {
    if (this.services.approvePlanModeEntry && !await this.services.approvePlanModeEntry(signal)) {
      throw new Error("User declined to enter plan mode.");
    }
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
    this.setPlanMode(true);
    const message = "You have entered plan mode. You should now focus on exploring the codebase and creating an implementation plan.";
    const taskHint = "\n     You can use the spawn_subagent tool with subagent_type=\"explore\" to parallelize codebase exploration without filling your context window.";
    return `${message}\n\nWrite your plan to ${planFile}. The file exists and is ${status}.\n\nIn plan mode, you should:\n1. Thoroughly explore the codebase to understand existing patterns${taskHint}\n2. Identify similar features, codebase architecture, and understand trade-offs\n3. Use ask_user_question if you need to clarify the approach\n4. Design a concrete implementation strategy\n5. Write your plan to the plan file above\n6. When ready, use exit_plan_mode to present your plan to the user.`;
  }

  private async exitPlanMode(signal: AbortSignal): Promise<string> {
    const planFile = this.planFilePath();
    const content = this.container.vfs.existsSync(planFile) && this.container.vfs.statSync(planFile).isFile()
      ? this.container.vfs.readFileSync(planFile, "utf8")
      : "";
    this.setPlanState(true, true);
    let approval: { outcome: "approved" | "cancelled" | "abandoned"; feedback?: string };
    try {
      approval = this.services.approvePlanModeExit
        ? normalizePlanApproval(await this.services.approvePlanModeExit(content, signal))
        : { outcome: "approved" };
    } catch (error) {
      if (signal.aborted) {
        this.setPlanState(true, false);
        throw error;
      }
      // Non-abort failures mean a delivered browser interaction disappeared;
      // preserve the persisted gate for resume/reconnect.
      throw new Error("Plan approval could not be completed because the client disconnected. Plan mode remains active; the approval will reappear on reconnect.", { cause: error });
    }
    this.setPlanState(true, false);
    if (approval.outcome === "abandoned") {
      this.setPlanState(false, false);
      return "The user chose to abandon the plan entirely (via the Abandon option in the plan approval dialog). Plan mode has been disabled. Do not call exit_plan_mode again unless the user explicitly asks to re-enter plan mode.";
    }
    if (approval.outcome === "cancelled") {
      return content.trim()
        ? revisePlanMessage(approval.feedback)
        : "The user does not want to exit plan mode. Continue planning and ask the user what they would like to do.";
    }
    this.setPlanState(false, false);
    if (!content.trim()) return "Plan mode exit approved. No plan content was found — you can proceed.";
    return `Your plan has been approved. You can now start coding.\n\nYour plan has been saved at: ${planFile}\n\n## Plan:\n${content}`;
  }

  private planModeEditRejection(name: string, input: JsonObject): string | undefined {
    if (!this.planMode || (name !== "search_replace" && name !== "write")) return;
    const target = typeof input.file_path === "string" ? this.resolve(input.file_path) : "";
    const planFile = this.planFilePath();
    if (target === planFile) return;
    return `Rejected: file edits are not allowed in plan mode - the only editable file is the plan file (${planFile}).`;
  }

  private setPlanMode(active: boolean): void {
    this.setPlanState(active, false);
  }

  private setPlanState(active: boolean, awaitingPlanApproval: boolean): void {
    this.planMode = active;
    this.awaitingPlanApproval = active && awaitingPlanApproval;
    const path = join(this.workspacePath, ".grok/plan-mode.json");
    this.ensureParent(path);
    this.container.vfs.writeFileSync(path, JSON.stringify({ version: 1, active, awaitingPlanApproval: this.awaitingPlanApproval }));
  }

  private restorePlanMode(): { active: boolean; awaitingPlanApproval: boolean } {
    const path = join(this.workspacePath, ".grok/plan-mode.json");
    if (!this.container.vfs.existsSync(path) || !this.container.vfs.statSync(path).isFile()) return { active: false, awaitingPlanApproval: false };
    try {
      const state = JSON.parse(this.container.vfs.readFileSync(path, "utf8")) as { version?: unknown; active?: unknown; awaitingPlanApproval?: unknown };
      const active = state.version === 1 && state.active === true;
      return { active, awaitingPlanApproval: active && state.awaitingPlanApproval === true };
    } catch {
      return { active: false, awaitingPlanApproval: false };
    }
  }

  private planFilePath(): string {
    return join(this.workspacePath, ".grok/plan.md");
  }

  private monitor(input: JsonObject, signal: AbortSignal, callId: string): string {
    const command = string(input.command, "command", true);
    const description = string(input.description, "description", true);
    const persistent = boolean(input.persistent, false);
    const requestedTimeout = input.timeout_ms === undefined || input.timeout_ms === null
      ? 36_000_000
      : strictUnsignedInteger(input.timeout_ms);
    if (!persistent && requestedTimeout > 36_000_000) {
      throw new Error("persistent must be true when timeout_ms exceeds 36000000ms");
    }
    let stream: GrokBuildMonitorEventStream | undefined;
    let task: BrowserBackgroundTask;
    const emit = (reminder: string): void => task.notificationSink?.(reminder);
    const outputName = callId.replace(/[^A-Za-z0-9_.-]/gu, "_");
    task = this.background.createCommand(command, signal, "monitor", (chunk, current) => {
      stream ??= new GrokBuildMonitorEventStream(current.id, description, emit);
      stream.push(chunk);
    }, persistent ? undefined : requestedTimeout, join("/tmp/grok-build-session/terminal", `monitor-${outputName}.log`));
    task.description = description;
    task.notificationSink = this.reminderSink("monitor", task.id);
    stream ??= new GrokBuildMonitorEventStream(task.id, description, emit);
    void task.promise.finally(() => {
      stream?.flush();
      if (!task.explicitlyCancelled) emit(formatMonitorCompletion(task));
    });
    const timeoutMs = persistent ? 0 : requestedTimeout;
    return persistent
      ? `Monitor started (task ${task.id}, persistent -- runs until kill_task or session end).\nYou will be notified on each event. Keep working -- do not poll or sleep.\nEvents may arrive while you are waiting for the user -- an event is not their reply.`
      : `Monitor started (task ${task.id}, timeout ${timeoutMs}ms).\nYou will be notified on each event. Keep working -- do not poll or sleep.\nEvents may arrive while you are waiting for the user -- an event is not their reply.`;
  }

  private ensureParent(path: string): void {
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    this.container.vfs.mkdirSync(parent, { recursive: true });
  }

  private reminderSink(kind: "command" | "monitor", taskId: string): (reminder: string) => void {
    return (reminder) => {
      const monitorEvent = kind === "monitor" && reminder.startsWith('<monitor-event description="');
      const source = monitorEvent ? "monitor_event" : kind === "monitor" ? "monitor_completed" : "command_completed";
      if (source === "monitor_completed") {
        for (let index = this.asynchronousReminders.length - 1; index >= 0; index -= 1) {
          const pending = this.asynchronousReminders[index];
          if (pending?.taskId === taskId && pending.source === "monitor_event") this.asynchronousReminders.splice(index, 1);
        }
      }
      const event: GrokBuildSystemReminderEvent = {
        promptId: source === "monitor_event"
          ? this.pendingNotificationPromptId ??= `notifications-${crypto.randomUUID()}`
          : `task-completed-${taskId}`,
        taskId,
        source,
        reminder,
      };
      this.asynchronousReminders.push(event);
      if (kind === "monitor") this.services.onMonitorEvent?.(reminder);
      this.services.onSystemReminderQueued?.(event);
    };
  }

  private resolve(path: string): string {
    const absolute = path.startsWith("/") ? path : join(this.workspacePath, path);
    return normalize(absolute);
  }
}

/** Native task-coordinator truncation: cap UTF-8 bytes, then add its footer. */
export function capCompletionOutput(output: string, cap: number): string {
  const bytes = new TextEncoder().encode(output);
  if (bytes.length <= cap) return output;
  const shown = utf8PrefixBytes(output, cap);
  const shownBytes = new TextEncoder().encode(shown).length;
  return `${shown}\n[output truncated: ${shownBytes} of ${bytes.length} bytes shown]`;
}

function normalizePlanApproval(value: unknown): { outcome: "approved" | "cancelled" | "abandoned"; feedback?: string } {
  if (!value || typeof value !== "object") return { outcome: "cancelled" };
  const approval = value as { outcome?: unknown; feedback?: unknown };
  const outcome = approval.outcome === "approved" || approval.outcome === "abandoned"
    ? approval.outcome
    : "cancelled";
  return {
    outcome,
    ...(typeof approval.feedback === "string" ? { feedback: approval.feedback } : {}),
  };
}

function permissionStore(vfs: VirtualFS): GrokBuildPermissionStore {
  const path = "/.grok/permission_grok-pager.json";
  return {
    load() {
      if (!vfs.existsSync(path) || !vfs.statSync(path).isFile()) return;
      try {
        const value = JSON.parse(vfs.readFileSync(path, "utf8")) as { version?: unknown; allowed?: unknown; denied?: unknown };
        if (value.version !== 1) return;
        return {
          allowed: Array.isArray(value.allowed) ? value.allowed.filter((item): item is string => typeof item === "string") : [],
          denied: Array.isArray(value.denied) ? value.denied.filter((item): item is string => typeof item === "string") : [],
        };
      } catch { return; }
    },
    save(state) {
      vfs.mkdirSync("/.grok", { recursive: true });
      vfs.writeFileSync(path, JSON.stringify({ version: 1, ...state }));
    },
  };
}

function revisePlanMessage(feedback: string | undefined): string {
  const trimmed = feedback?.trim();
  return trimmed
    ? `The user wants to revise the plan. The user said:\n${trimmed}`
    : "The user wants to revise the plan. Ask the user what changes they would like to make.";
}

function utf8PrefixBytes(value: string, maximumBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  let end = Math.min(maximumBytes, bytes.length);
  while (end > 0) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, end)); }
    catch { end -= 1; }
  }
  return "";
}

function formatMonitorCompletion(task: BrowserBackgroundTask): string {
  const reason = task.timedOut
    ? "killed by signal timeout"
    : task.exitCode === undefined
      ? "ended"
      : `exited (code ${task.exitCode})`;
  const duration = Math.max(0, (task.endedAt ?? Date.now()) - task.startedAt) / 1_000;
  return `Monitor "${task.id}" ended: [monitor ended: ${reason}].\nDescription: ${task.description ?? "monitor"}\nCommand: ${task.command ?? ""}\nDuration: ${duration.toFixed(1)}s\nUse get_command_or_subagent_output("${task.id}") for full output.\n`;
}

function formatBashCompletion(task: BrowserBackgroundTask): string {
  const status = task.timedOut
    ? "terminated by signal timeout"
    : `exit code: ${task.exitCode ?? "unknown"}`;
  const duration = Math.max(0, (task.endedAt ?? Date.now()) - task.startedAt) / 1_000;
  return `Background task "${task.id}" completed (${status}).\nCommand: ${task.command ?? ""} | Duration: ${duration.toFixed(1)}s\nUse get_command_or_subagent_output("${task.id}") to see the full output.`;
}

function formatCommandResult(result: RunResult): string {
  const output = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? "\n" : "");
  return `exit: ${result.exitCode}${output ? `\n${output}` : ""}`;
}

function sanitizeWorkspaceShellOutput(command: string, output: string, workspacePath: string): string {
  if (workspacePath !== "/" || !/\bls\s+-[A-Za-z]*l[A-Za-z]*\b/u.test(command)) return output;
  // almostnode needs /tmp for process plumbing. It is outside the logical
  // project, so do not expose it as if it were a user-owned workspace entry.
  return output.split("\n").filter((line) => !/^d\S*\s+\d+\s+\S+\s+\S+\s+\d+\s+\S+\s+\d+\s+\S+\s+tmp\/?$/u.test(line)).join("\n");
}

function boundedCommandTimeout(value: unknown, fallback: number): number {
  const timeout = value === undefined || value === null ? fallback : parseGrokLenientU64(value);
  // A foreground zero means the configured default in native Grok Build.
  if (timeout === 0) return fallback;
  return Math.min(timeout, 36_000_000);
}

function backgroundTimeout(value: unknown): number | undefined {
  if (value === undefined || value === null) return;
  const timeout = parseGrokLenientU64(value);
  return timeout === 0 ? undefined : timeout;
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

function requiredService<T extends (...args: never[]) => Promise<unknown>>(service: T | undefined, name: string): T {
  if (!service) throw new Error(`${name} requires an explicitly configured browser/serverless service adapter.`);
  return service;
}

function requiredScheduler(scheduler: GrokBuildBrowserScheduler | undefined): GrokBuildBrowserScheduler {
  if (!scheduler) throw new Error("scheduler tools are not available to this subagent capability mode.");
  return scheduler;
}

function formatSchedulerCreateOutput(output: string): string {
  const parsed = JSON.parse(output) as { id: string; humanSchedule: string; updated: boolean };
  return `Scheduled task ${parsed.updated ? "updated" : "created"} (ID: ${parsed.id}, ${parsed.humanSchedule}).`;
}

function formatSchedulerDeleteOutput(output: string): string {
  return (JSON.parse(output) as { message: string }).message;
}

function formatSchedulerListOutput(output: string): string {
  const { tasks } = JSON.parse(output) as { tasks: unknown[] };
  return tasks.length === 0 ? "No scheduled tasks." : JSON.stringify(tasks, null, 2);
}

function taskIds(input: JsonObject): string[] {
  const value = input.task_ids ?? input.task_id;
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

function systemReminder(content: string): string {
  return content.startsWith("<system-reminder>\n") ? content : `<system-reminder>\n${content}\n</system-reminder>`;
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

function strictUnsignedInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("Expected a non-negative integer");
  return value as number;
}

function boolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === null) return false;
  if (typeof value === "boolean") return value;
  if (value === 1 || (typeof value === "string" && ["true", "yes", "1"].includes(value.trim().toLowerCase()))) return true;
  if (value === 0 || (typeof value === "string" && ["false", "no", "0"].includes(value.trim().toLowerCase()))) return false;
  throw new Error(`expected a boolean (true/false, "true"/"false", "yes"/"no", "1"/"0", 1/0), got ${JSON.stringify(value)}`);
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
