// Copyright 2023-2026 SpaceXAI
// SPDX-License-Identifier: Apache-2.0
// Modified for the Vibewaiting browser port, 2026.

const LINE_LIMIT = 500;
const BATCH_LIMIT = 3_000;
const BUFFER_LIMIT = 1_048_576;
const DEBOUNCE_MS = 200;
const RATE_LIMIT_CAPACITY = 10;
const RATE_LIMIT_REFILL_MS = 2_000;
const AUTO_STOP_THRESHOLD_MS = 30_000;

export type MonitorRateLimitOutcome =
  | { type: "allowed"; catchUpNotice?: string }
  | { type: "suppressed" }
  | { type: "auto_stop"; message: string };

/** Source-equivalent token bucket and sustained-suppression tracker. */
export class GrokBuildMonitorRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private suppressedCount = 0;
  private lastSuppression: number | undefined;
  private suppressionStart: number | undefined;
  private stopped = false;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly capacity = RATE_LIMIT_CAPACITY,
    private readonly refillMs = RATE_LIMIT_REFILL_MS,
    private readonly killToolName = "kill_command_or_subagent",
  ) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  process(): MonitorRateLimitOutcome {
    if (this.stopped) return { type: "suppressed" };
    const now = this.now();
    const refills = Math.floor((now - this.lastRefill) / this.refillMs);
    if (refills > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + refills);
      this.lastRefill += refills * this.refillMs;
    }
    if (this.tokens > 0) {
      this.tokens -= 1;
      if (this.suppressedCount === 0) return { type: "allowed" };
      const notice = `[${this.suppressedCount} events suppressed -- output rate too high. Consider using ${this.killToolName} to restart this monitor with a more selective filter.]`;
      this.suppressedCount = 0;
      if (this.lastSuppression !== undefined && now - this.lastSuppression > this.refillMs * 3) {
        this.suppressionStart = undefined;
      }
      return { type: "allowed", catchUpNotice: notice };
    }
    this.suppressedCount += 1;
    this.lastSuppression = now;
    this.suppressionStart ??= now;
    const elapsed = now - this.suppressionStart;
    if (elapsed > AUTO_STOP_THRESHOLD_MS) {
      this.stopped = true;
      return {
        type: "auto_stop",
        message: `[Monitor stopped -- your script produced too much output (${this.suppressedCount} events suppressed over ${Math.floor(elapsed / 1_000)}s). Write a new monitor command that filters more aggressively -- pipe through grep --line-buffered, awk, or a wrapper script that only emits the specific events you need.]`,
      };
    }
    return { type: "suppressed" };
  }
}

/** Browser port of native monitor line framing, batching, and XML notification wrapping. */
export class GrokBuildMonitorEventStream {
  private buffer = "";
  private pending: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    private readonly taskId: string,
    private readonly description: string,
    private readonly emit: (reminder: string) => void,
    private readonly rateLimiter = new GrokBuildMonitorRateLimiter(),
  ) {}

  push(chunk: string): void {
    if (this.stopped) return;
    this.buffer += chunk;
    if (new TextEncoder().encode(this.buffer).length > BUFFER_LIMIT) this.buffer = utf8Tail(this.buffer, BUFFER_LIMIT);
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const normalized = line.trim();
      if (normalized) this.pending.push(truncateNative(normalized, LINE_LIMIT, "...(truncated)"));
    }
    if (this.pending.length && this.timer === undefined) this.timer = setTimeout(() => this.flushBatch(), DEBOUNCE_MS);
  }

  flush(): void {
    const normalized = this.buffer.trim();
    this.buffer = "";
    if (normalized) this.pending.push(truncateNative(normalized, LINE_LIMIT, "...(truncated)"));
    this.flushBatch();
  }

  private flushBatch(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending.length) return;
    const text = truncateNative(this.pending.splice(0).join("\n"), BATCH_LIMIT, "\n...(truncated)");
    const outcome = this.rateLimiter.process();
    if (outcome.type === "suppressed") return;
    const description = this.description.replaceAll('"', "'").replace(/[\r\n]/gu, " ");
    const wrap = (body: string): string => `<monitor-event description="${description}" task_id="${this.taskId}">\n${body}\n</monitor-event>`;
    if (outcome.type === "auto_stop") {
      this.stopped = true;
      this.emit(wrap(outcome.message));
      return;
    }
    if (outcome.catchUpNotice) this.emit(wrap(outcome.catchUpNotice));
    this.emit(wrap(text));
  }
}

interface ParsedMonitorEvent {
  taskId: string;
  description: string;
  inner: string;
}

/** Final model-facing projection of native's buffered monitor event drain. */
export function formatGrokMonitorEvents(events: readonly string[], taskOutputTool = "get_command_or_subagent_output"): string | undefined {
  if (events.length === 0) return undefined;
  const parsed = events.map(parseMonitorEvent);
  if (parsed.length === 1) {
    const event = parsed[0]!;
    return `<monitor-event task_id="${event.taskId}">\n[${event.description || "event"}] ${event.inner}\n</monitor-event>`;
  }
  const groups = new Map<string, ParsedMonitorEvent[]>();
  for (const event of parsed) {
    const group = groups.get(event.taskId);
    if (group) group.push(event);
    else groups.set(event.taskId, [event]);
  }
  let output = `${parsed.length} monitor events from ${groups.size} ${groups.size === 1 ? "monitor" : "monitors"} (use ${taskOutputTool} to identify each monitor):`;
  for (const [taskId, group] of groups) {
    const description = group.find((event) => event.description)?.description || "event";
    output += `\n\n<monitor description="${description}" task_id="${taskId}">`;
    for (let index = 0; index < group.length; index += 1) output += `\n[${index + 1}] ${group[index]!.inner}`;
    output += "\n</monitor>";
  }
  return output;
}

function parseMonitorEvent(value: string): ParsedMonitorEvent {
  const prefix = '<monitor-event description="';
  const openEnd = value.indexOf(">\n", prefix.length);
  const close = "\n</monitor-event>";
  if (!value.startsWith(prefix) || openEnd < 0 || !value.endsWith(close)) {
    return { taskId: "unknown", description: "event", inner: value };
  }
  const open = value.slice(prefix.length, openEnd);
  const anchor = open.lastIndexOf('" task_id="');
  if (anchor < 0 || !open.endsWith('"')) return { taskId: "unknown", description: "event", inner: value };
  return {
    description: sanitizeDescription(open.slice(0, anchor)),
    taskId: open.slice(anchor + 11, -1),
    inner: value.slice(openEnd + 2, -close.length),
  };
}

function sanitizeDescription(value: string): string {
  return value.replaceAll('"', "'").replace(/[\r\n]/gu, " ");
}

function truncateNative(value: string, maximumBytes: number, suffix: string): string {
  if (new TextEncoder().encode(value).length <= maximumBytes) return value;
  // Rust's monitor truncators retain `maximumBytes` of payload and append the
  // marker afterwards; the marker is intentionally outside the payload cap.
  return `${utf8Prefix(value, maximumBytes)}${suffix}`;
}

function utf8Prefix(value: string, maximumBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  let end = Math.min(maximumBytes, bytes.length);
  while (end > 0) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, end)); }
    catch { end -= 1; }
  }
  return "";
}

function utf8Tail(value: string, maximumBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  let start = Math.max(0, bytes.length - maximumBytes);
  while (start < bytes.length) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(start)); }
    catch { start += 1; }
  }
  return "";
}
