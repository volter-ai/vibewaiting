import type { VirtualFS } from "almostnode";
import { uuidV7 } from "./grok-build-background-tasks.js";

export type JsonObject = Record<string, unknown>;

export type GrokScheduledTaskEvent =
  | { type: "created"; taskId: string; prompt: string; humanSchedule: string; nextFireAt: string; generation: string; revision: number }
  | { type: "fired"; taskId: string; prompt: string; humanSchedule: string; nextFireAt: string; generation: string; revision: number; subagentId?: string }
  | { type: "removed"; taskId: string; reason: "deleted" | "expired"; generation: string; revision: number };

export interface ScheduledSubagentHandle {
  readonly status: "running" | "completed" | "failed" | "cancelled" | "timed_out";
  readonly output: string;
}

export interface GrokBuildSchedulerHooks {
  spawnSubagent?(input: JsonObject, signal: AbortSignal, subagentId: string): ScheduledSubagentHandle;
  getSubagent?(subagentId: string): ScheduledSubagentHandle | undefined;
  runForeground?(prompt: string, signal: AbortSignal): Promise<string>;
  /** Removal events resolve only after the consumer durably accepts them. */
  onEvent?(event: GrokScheduledTaskEvent): unknown;
}

interface PendingRemoval {
  taskId: string;
  event: Extract<GrokScheduledTaskEvent, { type: "removed" }>;
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
const DURABILITY_BARRIER_TIMEOUT_MS = 30_000;

class SchedulerBarrierError extends Error {}

/** Browser-native port of Grok Build's scheduler actor and persisted state. */
export class GrokBuildBrowserScheduler {
  private readonly tasks = new Map<string, ScheduledTask>();
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private firing = false;
  private readonly blockedExpiries = new Set<string>();
  private readonly generation = uuidV7();
  private revision = 0;
  private pendingRemoval: PendingRemoval | undefined;
  private pendingRemovalAttempt: Promise<void> | undefined;

  constructor(
    private readonly vfs: VirtualFS,
    private readonly workspacePath: string,
    private readonly hooks: GrokBuildSchedulerHooks = {},
  ) {
    this.restore();
    for (const task of this.tasks.values()) this.emitCreated(task, false);
    this.arm();
  }

  create(input: JsonObject): string {
    if (this.pendingRemoval) throw new Error(`scheduler removal for ${this.pendingRemoval.taskId} is pending`);
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
    if (!existing && !bool(input.recurring, true)) {
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
    this.emitCreated(task, true);
    return JSON.stringify({ id, humanSchedule: intervalToHuman(task.intervalSecs), updated: Boolean(existing) });
  }

  async delete(input: JsonObject): Promise<string> {
    const id = requiredString(input.id, "id");
    if (this.pendingRemoval?.taskId === id) {
      if (this.pendingRemovalAttempt) {
        await this.pendingRemovalAttempt;
        return deleteResult(id, false);
      }
      await this.completePendingRemoval();
      return deleteResult(id, true);
    }
    if (this.pendingRemoval) throw new Error(`scheduler removal for ${this.pendingRemoval.taskId} is pending`);
    if (!this.tasks.has(id)) return deleteResult(id, false);
    if (!this.hooks.onEvent) {
      throw new Error("durable scheduler removal requires an acknowledging notification consumer");
    }

    this.suspendTimer();
    this.tasks.delete(id);
    this.pendingRemoval = {
      taskId: id,
      event: {
        type: "removed",
        taskId: id,
        reason: "deleted",
        generation: this.generation,
        revision: this.revision + 1,
      },
    };
    await this.completePendingRemoval();
    return deleteResult(id, true);
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

  dispose(): void {
    this.controller.abort(new DOMException("Scheduler stopped", "AbortError"));
    if (this.timer !== undefined) globalThis.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private emitCreated(task: ScheduledTask, transition: boolean): void {
    if (transition) this.revision += 1;
    this.hooks.onEvent?.({
      type: "created",
      taskId: task.id,
      prompt: task.prompt,
      humanSchedule: intervalToHuman(task.intervalSecs),
      nextFireAt: rfc3339(nextFireAt(task)),
      generation: this.generation,
      revision: this.revision,
    });
  }

  private async completePendingRemoval(): Promise<void> {
    if (this.pendingRemovalAttempt) return this.pendingRemovalAttempt;
    const attempt = Promise.resolve().then(() => this.performPendingRemoval());
    this.pendingRemovalAttempt = attempt;
    try {
      await attempt;
    } finally {
      if (this.pendingRemovalAttempt === attempt) this.pendingRemovalAttempt = undefined;
    }
  }

  private async performPendingRemoval(): Promise<void> {
    const pending = this.pendingRemoval;
    if (!pending) return;
    if (!this.hooks.onEvent) {
      // Native targets are immutable. Releasing this reservation prevents all
      // later scheduler mutations from being wedged if the target disappeared.
      this.pendingRemoval = undefined;
      throw new Error("durable scheduler removal requires an acknowledging notification consumer");
    }
    try {
      this.persist();
    } catch (error) {
      throw new Error(`failed to persist scheduler resources: ${message(error)}`);
    }
    try {
      await awaitDurabilityBarrier(this.hooks.onEvent(pending.event), this.controller.signal);
    } catch (error) {
      if (error instanceof SchedulerBarrierError) throw error;
      throw new Error(`failed to publish scheduler tombstone: ${message(error)}`);
    }
    // A failed acknowledgement keeps this reservation and therefore reuses
    // the same generation/revision tombstone when delete is retried.
    this.pendingRemoval = undefined;
    this.revision = pending.event.revision;
    this.arm();
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
    this.suspendTimer();
    const next = [...this.tasks.values()]
      .filter((task) => !this.blockedExpiries.has(task.id))
      .map(nextWakeAt).sort((left, right) => left - right)[0];
    if (next === undefined) return;
    const delay = Math.min(Math.max(0, next - Date.now()), 2_147_483_647);
    this.timer = globalThis.setTimeout(() => {
      this.timer = undefined;
      void this.fireDue();
    }, delay);
  }

  private suspendTimer(): void {
    if (this.timer !== undefined) globalThis.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async fireDue(): Promise<void> {
    if (this.firing) return;
    this.firing = true;
    try {
      while (true) {
        const now = Date.now();
        const task = [...this.tasks.values()].find((candidate) => !this.blockedExpiries.has(candidate.id) && nextWakeAt(candidate) <= now);
        if (!task) break;
        if (task.expiresAt !== undefined && now >= task.expiresAt) {
          await this.expireTask(task);
          continue;
        }
        if (task.lastSubagentId && this.hooks.getSubagent?.(task.lastSubagentId)?.status === "running") {
          task.lastFiredAt = now;
          this.persist();
          this.emitCreated(task, false);
          continue;
        }
        const previousLastFiredAt = task.lastFiredAt;
        task.lastFiredAt = now;
        const humanSchedule = intervalToHuman(task.intervalSecs);
        const next = rfc3339(nextFireAt(task));
        let subagentId: string | undefined;
        if (task.foreground) {
          if (this.hooks.runForeground) void this.hooks.runForeground(formatScheduledTaskPrompt(task), this.controller.signal).catch(() => undefined);
        } else if (this.hooks.spawnSubagent) {
          subagentId = uuidV7();
          const previous = task.lastSubagentId ? this.hooks.getSubagent?.(task.lastSubagentId) : undefined;
          const restart = task.chainResetPending || task.iterationsSinceFresh >= LOOP_FRESH_CHAIN_EVERY || previous?.status !== "completed";
          const priorSummary = restart && previous?.output ? truncateChars(previous.output, 600) : undefined;
          try {
            this.hooks.spawnSubagent({
              prompt: formatLoopIterationPrompt(task, humanSchedule, priorSummary),
              description: `loop: ${truncateChars(task.prompt.split("\n")[0] || task.prompt, 60)} (${humanSchedule})`,
              subagent_type: "general-purpose",
              background: true,
              completion_output_cap: 4_000,
              spawn_depth: 0,
              loop_task_id: task.id,
              ...(restart ? {} : { resume_from: task.lastSubagentId }),
            }, this.controller.signal, subagentId);
          } catch {
            if (previousLastFiredAt === undefined) delete task.lastFiredAt;
            else task.lastFiredAt = previousLastFiredAt;
            this.persist();
            continue;
          }
          task.lastSubagentId = subagentId;
          task.iterationsSinceFresh = restart ? 1 : task.iterationsSinceFresh + 1;
          task.chainResetPending = false;
        }
        this.persist();
        this.revision += 1;
        this.hooks.onEvent?.({
          type: "fired", taskId: task.id, prompt: task.prompt, humanSchedule, nextFireAt: next,
          generation: this.generation, revision: this.revision,
          ...(subagentId ? { subagentId } : {}),
        });
      }
    } finally {
      this.firing = false;
      this.arm();
    }
  }

  private async expireTask(task: ScheduledTask): Promise<void> {
    if (task.durable && !this.hooks.onEvent) {
      this.blockedExpiries.add(task.id);
      return;
    }
    this.tasks.delete(task.id);
    const event: Extract<GrokScheduledTaskEvent, { type: "removed" }> = {
      type: "removed",
      taskId: task.id,
      reason: "expired",
      generation: this.generation,
      revision: this.revision + 1,
    };
    if (task.durable) {
      try {
        this.persist();
      } catch {
        this.tasks.set(task.id, task);
        this.blockedExpiries.add(task.id);
        return;
      }
      try {
        await awaitDurabilityBarrier(this.hooks.onEvent!(event), this.controller.signal);
      } catch {
        // Persistence already committed the absence. As in native, an
        // acknowledgement failure does not resurrect or retry the expiry.
        return;
      }
      this.revision = event.revision;
      return;
    }
    try { this.persist(); } catch { /* Non-durable expiry is best effort. */ }
    this.revision = event.revision;
    this.hooks.onEvent?.(event);
  }
}

export function parseGrokSchedulerInterval(value: string): number {
  return parseInterval(value);
}

function deleteResult(id: string, removed: boolean): string {
  return JSON.stringify(removed
    ? { success: true, message: `Scheduled task ${id} cancelled.` }
    : { success: false, message: `No scheduled task with ID ${id} found. Use scheduler_list to see active tasks.` });
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
  return uuidV7(now).replaceAll("-", "").slice(0, 12);
}

function nextFireAt(task: ScheduledTask): number {
  return (task.lastFiredAt ?? task.createdAt) + task.intervalSecs * 1_000;
}

function nextWakeAt(task: ScheduledTask): number {
  return task.expiresAt === undefined ? nextFireAt(task) : Math.min(nextFireAt(task), task.expiresAt);
}

function rfc3339(timestamp: number): string {
  return new Date(timestamp).toISOString().replace(/\.000Z$/u, "+00:00").replace(/Z$/u, "+00:00");
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
  if (value === undefined) return fallback;
  if (value === null) return false;
  if (typeof value === "boolean") return value;
  if (value === 1 || (typeof value === "string" && ["true", "yes", "1"].includes(value.trim().toLowerCase()))) return true;
  if (value === 0 || (typeof value === "string" && ["false", "no", "0"].includes(value.trim().toLowerCase()))) return false;
  throw new Error(`expected a boolean (true/false, "true"/"false", "yes"/"no", "1"/"0", 1/0), got ${JSON.stringify(value)}`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function awaitDurabilityBarrier(value: unknown, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new SchedulerBarrierError("scheduler removal cancelled");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort: (() => void) | undefined;
  try {
    await Promise.race([
      Promise.resolve(value),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SchedulerBarrierError("scheduler removal timed out")), DURABILITY_BARRIER_TIMEOUT_MS);
        const aborted = (): void => reject(new SchedulerBarrierError("scheduler removal cancelled"));
        signal.addEventListener("abort", aborted, { once: true });
        removeAbort = () => signal.removeEventListener("abort", aborted);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbort?.();
  }
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
