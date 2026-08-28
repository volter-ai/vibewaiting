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
      if (normalized) this.pending.push(truncate(normalized, LINE_LIMIT, "...(truncated)"));
    }
    if (this.pending.length && this.timer === undefined) this.timer = setTimeout(() => this.flushBatch(), DEBOUNCE_MS);
  }

  flush(): void {
    const normalized = this.buffer.trim();
    this.buffer = "";
    if (normalized) this.pending.push(truncate(normalized, LINE_LIMIT, "...(truncated)"));
    this.flushBatch();
  }

  private flushBatch(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending.length) return;
    const text = truncate(this.pending.splice(0).join("\n"), BATCH_LIMIT, "\n...(truncated)");
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

function truncate(value: string, maximumBytes: number, suffix: string): string {
  if (new TextEncoder().encode(value).length <= maximumBytes) return value;
  const suffixBytes = new TextEncoder().encode(suffix).length;
  return `${utf8Prefix(value, Math.max(0, maximumBytes - suffixBytes))}${suffix}`;
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
