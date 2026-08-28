// Copyright 2023-2026 SpaceXAI
// SPDX-License-Identifier: Apache-2.0
// Modified for the Vibewaiting browser port, 2026.

interface QueuedRun<T> {
  signal: AbortSignal;
  start: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason: unknown) => void;
}

/** Session-scoped FIFO port of Grok Build's default 32-child queue admission policy. */
export class GrokBuildSubagentAdmission {
  private running = 0;
  private readonly queue: Array<QueuedRun<unknown>> = [];

  constructor(readonly maxConcurrent = 32) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new Error("Subagent concurrency must be a positive integer.");
  }

  counts(): { running: number; queued: number } {
    return { running: this.running, queued: this.queue.length };
  }

  run<T>(signal: AbortSignal, start: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.running < this.maxConcurrent) return this.start(start);
    return new Promise<T>((resolve, reject) => {
      const entry: QueuedRun<T> = { signal, start, resolve, reject };
      this.queue.push(entry as QueuedRun<unknown>);
      signal.addEventListener("abort", () => {
        const index = this.queue.indexOf(entry as QueuedRun<unknown>);
        if (index < 0) return;
        this.queue.splice(index, 1);
        reject(signal.reason ?? new DOMException("Subagent cancelled while queued", "AbortError"));
      }, { once: true });
    });
  }

  private async start<T>(run: () => Promise<T>): Promise<T> {
    this.running += 1;
    try { return await run(); }
    finally {
      this.running -= 1;
      this.drain();
    }
  }

  private drain(): void {
    while (this.running < this.maxConcurrent && this.queue.length) {
      const next = this.queue.shift()!;
      if (next.signal.aborted) {
        next.reject(next.signal.reason ?? new DOMException("Subagent cancelled while queued", "AbortError"));
        continue;
      }
      void this.start(next.start).then(next.resolve, next.reject);
    }
  }
}
