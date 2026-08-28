// Copyright 2023-2026 SpaceXAI
// SPDX-License-Identifier: Apache-2.0
// Modified for the Vibewaiting browser port, 2026.

const LINE_LIMIT = 500;
const BATCH_LIMIT = 3_000;
const BUFFER_LIMIT = 1_048_576;
const DEBOUNCE_MS = 200;

/** Browser port of native monitor line framing, batching, and XML notification wrapping. */
export class GrokBuildMonitorEventStream {
  private buffer = "";
  private pending: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly taskId: string,
    private readonly description: string,
    private readonly emit: (reminder: string) => void,
  ) {}

  push(chunk: string): void {
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
    const description = this.description.replaceAll('"', "'").replace(/[\r\n]/gu, " ");
    this.emit(`<monitor-event description="${description}" task_id="${this.taskId}">\n${text}\n</monitor-event>`);
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
