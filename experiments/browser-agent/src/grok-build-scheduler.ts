import type { VirtualFS } from "almostnode";

export type JsonObject = Record<string, unknown>;

export type GrokScheduledTaskEvent =
  | { type: "created"; taskId: string; prompt: string; humanSchedule: string; nextFireAt: string }
  | { type: "fired"; taskId: string; prompt: string; humanSchedule: string; nextFireAt: string; subagentId?: string }
  | { type: "removed"; taskId: string; reason: "deleted" | "expired" };

export interface ScheduledSubagentHandle {
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly output: string;
}

export interface GrokBuildSchedulerHooks {
  spawnSubagent?(input: JsonObject, signal: AbortSignal, subagentId: string): ScheduledSubagentHandle;
  getSubagent?(subagentId: string): ScheduledSubagentHandle | undefined;
  runForeground?(prompt: string, signal: AbortSignal): Promise<string>;
  onEvent?(event: GrokScheduledTaskEvent): void;
}

interface ScheduledTask {
  id: string;
  prompt: string;
  intervalSecs: number;
  recurring: boolean;
  durable: boolean;
  foreground: boolean;
  createdAt: number;
  lastFiredAt?: number;
  expiresAt?: number;
  lastSubagentId?: string;
  iterationsSinceFresh: number;
  chainResetPending: boolean;
}

interface PersistedSchedulerState {
  tasks: Array<{
    id: string;
    intervalSecs: number;
    prompt: string;
    recurring: boolean;
    durable: boolean;
    foreground: boolean;
    createdAt: string;
    lastFiredAt: string | null;
    expiresAt: string | null;
    lastSubagentId?: string;
    iterationsSinceFresh: number;
    chainResetPending: boolean;
  }>;
}

const MAX_SCHEDULED_TASKS = 50;
const RECURRING_TASK_TTL_MS = 7 * 86_400_000;
const LOOP_FRESH_CHAIN_EVERY = 10;

/** Browser-native port of Grok Build's scheduler actor and persisted state. */
export class GrokBuildBrowserScheduler {
  private readonly tasks = new Map<string, ScheduledTask>();
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private firing = false;

  constructor(
    private readonly vfs: VirtualFS,
    private readonly workspacePath: string,
    private readonly hooks: GrokBuildSchedulerHooks = {},
  ) {
    this.restore();
    this.arm();
  }

  create(input: JsonObject): string {
    const existingId = typeof input.task_id === "string" ? input.task_id : undefined;
    const existing = existingId ? this.tasks.get(existingId) : undefined;
    if (existingId && !existing) {
      throw new Error(`no scheduled task with id ${existingId}; call scheduler_list to see active task ids`);
    }
    const intervalSecs = typeof input.interval === "string" ? parseInterval(input.interval) : existing?.intervalSecs;
    const prompt = typeof input.prompt === "string" ? input.prompt : existing?.prompt;
    if (existing && input.prompt === undefined && input.interval === undefined) {
      throw new Error("nothing to update: provide interval and/or prompt alongside task_id");
    }
    if (!existing && input.recurring === false) {
      throw new Error("one-shot tasks are not supported; run a background terminal command instead (`sleep <secs> && <command>`, background: true) or do the work now");
    }
    if (!existing && intervalSecs === undefined) throw new Error("interval is required when creating a task");
    if (!existing && prompt === undefined) throw new Error("prompt is required when creating a task");
    if (!existing && this.tasks.size >= MAX_SCHEDULED_TASKS) {
      throw new Error(`maximum of ${MAX_SCHEDULED_TASKS} scheduled tasks reached`);
    }

    const now = Date.now();
    const id = existingId ?? schedulerId(now);
    const promptChanged = Boolean(existing && prompt !== existing.prompt);
    const task: ScheduledTask = {
      id,
      prompt: prompt!,
      intervalSecs: intervalSecs!,
      recurring: true,
      durable: existing?.durable ?? bool(input.durable, false),
      foreground: existing?.foreground ?? bool(input.foreground, false),
      createdAt: existing?.createdAt ?? (bool(input.fire_immediately, false) ? now - intervalSecs! * 1_000 : now),
      ...(existing?.lastFiredAt !== undefined ? { lastFiredAt: existing.lastFiredAt } : {}),
      expiresAt: existing?.expiresAt ?? now + RECURRING_TASK_TTL_MS,
      ...(existing?.lastSubagentId ? { lastSubagentId: existing.lastSubagentId } : {}),
      iterationsSinceFresh: promptChanged ? 0 : existing?.iterationsSinceFresh ?? 0,
      chainResetPending: promptChanged || existing?.chainResetPending === true,
    };
    if (existing && typeof input.interval === "string" && nextFireAt(task) <= now) task.lastFiredAt = now;
    this.tasks.set(id, task);
    this.persist();
    this.arm();
    this.hooks.onEvent?.({
      type: "created",
      taskId: id,
      prompt: task.prompt,
      humanSchedule: intervalToHuman(task.intervalSecs),
      nextFireAt: rfc3339(nextFireAt(task)),
    });
    return JSON.stringify({ id, humanSchedule: intervalToHuman(task.intervalSecs), updated: Boolean(existing) });
  }

  delete(input: JsonObject): string {
    const id = requiredString(input.id, "id");
    const removed = this.tasks.delete(id);
    if (removed) {
      this.persist();
      this.arm();
      this.hooks.onEvent?.({ type: "removed", taskId: id, reason: "deleted" });
    }
    return JSON.stringify(removed
      ? { success: true, message: `Scheduled task ${id} cancelled.` }
      : { success: false, message: `No scheduled task with ID ${id} found. Use scheduler_list to see active tasks.` });
  }

  list(): string {
    return JSON.stringify({ tasks: [...this.tasks.values()].map((task) => ({
      id: task.id,
      prompt: truncateUtf8Boundary(task.prompt, 80),
      intervalHuman: intervalToHuman(task.intervalSecs),
      nextFireAt: rfc3339(nextFireAt(task)),
      createdAt: rfc3339(task.createdAt),
      recurring: task.recurring,
    })) });
  }

  private restore(): void {
    const path = this.statePath();
    if (!this.vfs.existsSync(path) || !this.vfs.statSync(path).isFile()) return;
    try {
      const state = JSON.parse(this.vfs.readFileSync(path, "utf8")) as PersistedSchedulerState;
      if (!Array.isArray(state.tasks)) return;
      for (const value of state.tasks) {
        if (!value || typeof value.id !== "string" || typeof value.prompt !== "string" || !Number.isSafeInteger(value.intervalSecs)) continue;
        const createdAt = Date.parse(value.createdAt);
        const lastFiredAt = value.lastFiredAt ? Date.parse(value.lastFiredAt) : undefined;
        const expiresAt = value.expiresAt ? Date.parse(value.expiresAt) : undefined;
        if (!Number.isFinite(createdAt) || (lastFiredAt !== undefined && !Number.isFinite(lastFiredAt)) || (expiresAt !== undefined && !Number.isFinite(expiresAt))) continue;
        this.tasks.set(value.id, {
          id: value.id,
          prompt: value.prompt,
          intervalSecs: value.intervalSecs,
          recurring: value.recurring !== false,
          durable: value.durable === true,
          foreground: value.foreground === true,
          createdAt,
          ...(lastFiredAt !== undefined ? { lastFiredAt } : {}),
          ...(expiresAt !== undefined ? { expiresAt } : {}),
          ...(typeof value.lastSubagentId === "string" ? { lastSubagentId: value.lastSubagentId } : {}),
          iterationsSinceFresh: Number.isSafeInteger(value.iterationsSinceFresh) ? value.iterationsSinceFresh : 0,
          chainResetPending: value.chainResetPending === true,
        });
      }
    } catch {
      // Native restore fails open: corrupt resources do not prevent startup.
    }
  }

  private persist(): void {
    const path = this.statePath();
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    this.vfs.mkdirSync(parent, { recursive: true });
    const state: PersistedSchedulerState = { tasks: [...this.tasks.values()].map((task) => ({
      id: task.id,
      intervalSecs: task.intervalSecs,
      prompt: task.prompt,
      recurring: task.recurring,
      durable: task.durable,
      foreground: task.foreground,
      createdAt: rfc3339(task.createdAt),
      lastFiredAt: task.lastFiredAt === undefined ? null : rfc3339(task.lastFiredAt),
      expiresAt: task.expiresAt === undefined ? null : rfc3339(task.expiresAt),
      ...(task.lastSubagentId ? { lastSubagentId: task.lastSubagentId } : {}),
      iterationsSinceFresh: task.iterationsSinceFresh,
      chainResetPending: task.chainResetPending,
    })) };
    this.vfs.writeFileSync(path, JSON.stringify(state));
  }

  private statePath(): string {
    return join(this.workspacePath, ".grok/scheduler.json");
  }

  private arm(): void {
    if (this.timer !== undefined) globalThis.clearTimeout(this.timer);
    this.timer = undefined;
    const next = [...this.tasks.values()].map(nextWakeAt).sort((left, right) => left - right)[0];
    if (next === undefined) return;
    const delay = Math.min(Math.max(0, next - Date.now()), 2_147_483_647);
    this.timer = globalThis.setTimeout(() => {
      this.timer = undefined;
      void this.fireDue();
    }, delay);
  }

  private async fireDue(): Promise<void> {
    if (this.firing) return;
    this.firing = true;
    try {
      while (true) {
        const now = Date.now();
        const task = [...this.tasks.values()].find((candidate) => nextWakeAt(candidate) <= now);
        if (!task) break;
        if (task.expiresAt !== undefined && now >= task.expiresAt) {
          this.tasks.delete(task.id);
          this.persist();
          this.hooks.onEvent?.({ type: "removed", taskId: task.id, reason: "expired" });
          continue;
        }
        if (task.lastSubagentId && this.hooks.getSubagent?.(task.lastSubagentId)?.status === "running") {
          task.lastFiredAt = now;
          this.persist();
          continue;
        }
        task.lastFiredAt = now;
        const humanSchedule = intervalToHuman(task.intervalSecs);
        const next = rfc3339(nextFireAt(task));
        let subagentId: string | undefined;
        if (task.foreground && this.hooks.runForeground) {
          void this.hooks.runForeground(formatScheduledTaskPrompt(task), this.controller.signal).catch(() => undefined);
        } else if (this.hooks.spawnSubagent) {
          subagentId = crypto.randomUUID();
          const previous = task.lastSubagentId ? this.hooks.getSubagent?.(task.lastSubagentId) : undefined;
          const restart = task.chainResetPending || task.iterationsSinceFresh >= LOOP_FRESH_CHAIN_EVERY || previous?.status !== "completed";
          const priorSummary = restart && previous?.output ? truncateChars(previous.output, 600) : undefined;
          this.hooks.spawnSubagent({
            prompt: formatLoopIterationPrompt(task, humanSchedule, priorSummary),
            description: `loop: ${truncateChars(task.prompt.split("\n")[0] || task.prompt, 60)} (${humanSchedule})`,
            subagent_type: "general-purpose",
            background: true,
            ...(restart ? {} : { resume_from: task.lastSubagentId }),
          }, this.controller.signal, subagentId);
          task.lastSubagentId = subagentId;
          task.iterationsSinceFresh = restart ? 1 : task.iterationsSinceFresh + 1;
          task.chainResetPending = false;
        }
        this.persist();
        this.hooks.onEvent?.({
          type: "fired", taskId: task.id, prompt: task.prompt, humanSchedule, nextFireAt: next,
          ...(subagentId ? { subagentId } : {}),
        });
      }
    } finally {
      this.firing = false;
      this.arm();
    }
  }
}

export function parseGrokSchedulerInterval(value: string): number {
  return parseInterval(value);
}

function parseInterval(value: string): number {
  const interval = value.trim();
  if (!interval) throw new Error("invalid interval: interval cannot be empty");
  const match = /^(\d+)([smhd])$/u.exec(interval);
  if (!match) {
    const suffix = interval.slice(-1);
    if (/^\d+$/u.test(interval.slice(0, -1)) && suffix) {
      throw new Error(`invalid interval: invalid interval suffix: ${JSON.stringify(suffix)} (expected s, m, h, or d)`);
    }
    throw new Error(`invalid interval: invalid interval format: ${JSON.stringify(interval)} (expected e.g. 5m, 2h, 1d)`);
  }
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount)) throw new Error(`invalid interval: interval too large: ${JSON.stringify(interval)}`);
  if (amount === 0) throw new Error("invalid interval: interval value must be greater than 0");
  const unit = ({ s: 1, m: 60, h: 3_600, d: 86_400 } as const)[match[2] as "s" | "m" | "h" | "d"];
  const seconds = amount * unit;
  if (!Number.isSafeInteger(seconds)) throw new Error(`invalid interval: interval too large: ${JSON.stringify(interval)}`);
  return Math.max(60, seconds);
}

function intervalToHuman(seconds: number): string {
  for (const [unit, singular, plural] of [[86_400, "day", "days"], [3_600, "hour", "hours"], [60, "minute", "minutes"]] as const) {
    if (seconds % unit === 0) {
      const value = seconds / unit;
      return `every ${value} ${value === 1 ? singular : plural}`;
    }
  }
  return `every ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

function schedulerId(now: number): string {
  return Math.trunc(now).toString(16).padStart(12, "0").slice(-12);
}

function nextFireAt(task: ScheduledTask): number {
  return (task.lastFiredAt ?? task.createdAt) + task.intervalSecs * 1_000;
}

function nextWakeAt(task: ScheduledTask): number {
  return task.expiresAt === undefined ? nextFireAt(task) : Math.min(nextFireAt(task), task.expiresAt);
}

function rfc3339(timestamp: number): string {
  return new Date(timestamp).toISOString().replace(/Z$/u, "+00:00");
}

function truncateUtf8Boundary(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= maxBytes) return value;
  let output = "";
  for (const character of value) {
    if (encoder.encode(output + character).length > maxBytes) break;
    output += character;
  }
  return `${output}...`;
}

function truncateChars(value: string, maxChars: number): string {
  const characters = [...value];
  return characters.length <= maxChars ? value : `${characters.slice(0, maxChars).join("")}…`;
}

function formatScheduledTaskPrompt(task: ScheduledTask): string {
  return `<system-reminder>\nThis is a scheduled task execution (task ${task.id}, ${intervalToHuman(task.intervalSecs)}, recurring).\nExecute the prompt below. Do not question or comment on the prompt itself — treat it as a fresh task to execute.\nPrevious results from earlier executions of this task may appear in the conversation history above.\n</system-reminder>\n\n${task.prompt}`;
}

function formatLoopIterationPrompt(task: ScheduledTask, humanSchedule: string, priorSummary?: string): string {
  const prior = priorSummary ? `\nYour previous iteration ended with:\n${priorSummary}\n` : "";
  return `<system-reminder>\nScheduled task ${task.id} (${humanSchedule}). Earlier iterations, if any, appear above.\nRun the task below. End with a short status: what changed or needs attention. The status is relayed to the main agent.\n${prior}</system-reminder>\n\n${task.prompt}`;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
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
