export interface BrowserCommandRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface BrowserCommandRunOptions {
  cwd?: string;
  signal?: AbortSignal;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

export interface BrowserCommandContainer {
  run(command: string, options?: BrowserCommandRunOptions): Promise<BrowserCommandRunResult>;
}

interface QueuedExecution {
  command: string;
  options: BrowserCommandRunOptions;
  run: BrowserCommandContainer["run"];
  resolve: (result: BrowserCommandRunResult) => void;
  reject: (error: unknown) => void;
  cancelWhileQueued?: () => void;
}

interface ExecutionGate {
  active: boolean;
  queue: QueuedExecution[];
}

const gates = new WeakMap<object, ExecutionGate>();
const originals = new WeakMap<object, BrowserCommandContainer["run"]>();
const cancelledResult = (): BrowserCommandRunResult => ({ stdout: "", stderr: "", exitCode: 130 });

/**
 * Install isolation on the container itself so command consumers outside the
 * Grok tool runtime (workflow steps and agent hooks) share the same gate. The
 * object identity and `run()` signature remain unchanged.
 */
export function installBrowserCommandIsolation<T extends BrowserCommandContainer>(container: T): T {
  const key = container as object;
  if (originals.has(key)) return container;
  const original = container.run.bind(container);
  originals.set(key, original);
  container.run = ((command: string, options: BrowserCommandRunOptions = {}) =>
    enqueue(container, command, options, original)) as T["run"];
  return container;
}

/**
 * AlmostNode 0.2.14 stores its stream callbacks and abort signal in module
 * globals. Until it exposes per-execution context, overlapping `run()` calls
 * can deliver one process's bytes to another process and clear each other's
 * cancellation signal. Serialize at the shared container boundary so root and
 * subagent runtimes cannot enter that unsafe region together.
 *
 * A command cancelled while queued resolves immediately and is removed from
 * the FIFO without entering AlmostNode.
 */
export function runIsolatedBrowserCommand(
  container: BrowserCommandContainer,
  command: string,
  options: BrowserCommandRunOptions,
): Promise<BrowserCommandRunResult> {
  const original = originals.get(container as object) ?? container.run.bind(container);
  const delayed = leadingSleep(command);
  if (delayed) return runCancellableSleep(container, delayed, options, original);
  return enqueue(container, command, options, original);
}

async function runCancellableSleep(
  container: BrowserCommandContainer,
  delayed: { milliseconds: number; remainder?: string },
  options: BrowserCommandRunOptions,
  run: BrowserCommandContainer["run"],
): Promise<BrowserCommandRunResult> {
  const completed = await cancellableDelay(delayed.milliseconds, options.signal);
  if (!completed) return cancelledResult();
  if (!delayed.remainder) return { stdout: "", stderr: "", exitCode: 0 };
  return enqueue(container, delayed.remainder, options, run);
}

function leadingSleep(command: string): { milliseconds: number; remainder?: string } | undefined {
  const match = /^\s*sleep\s+(\d+(?:\.\d+)?)([smhd]?)(?:\s*&&\s*([\s\S]+))?\s*$/u.exec(command);
  if (!match) return undefined;
  const multiplier = match[2] === "m" ? 60_000
    : match[2] === "h" ? 3_600_000
      : match[2] === "d" ? 86_400_000
        : 1_000;
  const milliseconds = Number(match[1]) * multiplier;
  if (!Number.isFinite(milliseconds)) return undefined;
  return { milliseconds, ...(match[3] ? { remainder: match[3] } : {}) };
}

function cancellableDelay(milliseconds: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(() => finish(true), milliseconds);
    const aborted = (): void => finish(false);
    const finish = (completed: boolean): void => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      resolve(completed);
    };
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function enqueue(
  container: BrowserCommandContainer,
  command: string,
  options: BrowserCommandRunOptions,
  run: BrowserCommandContainer["run"],
): Promise<BrowserCommandRunResult> {
  if (options.signal?.aborted) return Promise.resolve(cancelledResult());
  const key = container as object;
  const gate = gates.get(key) ?? { active: false, queue: [] };
  if (!gates.has(key)) gates.set(key, gate);

  return new Promise<BrowserCommandRunResult>((resolve, reject) => {
    const entry: QueuedExecution = { command, options, run, resolve, reject };
    if (options.signal) {
      entry.cancelWhileQueued = () => {
        const index = gate.queue.indexOf(entry);
        if (index < 0) return;
        gate.queue.splice(index, 1);
        options.signal?.removeEventListener("abort", entry.cancelWhileQueued!);
        resolve(cancelledResult());
        if (!gate.active && gate.queue.length === 0) gates.delete(key);
      };
      options.signal.addEventListener("abort", entry.cancelWhileQueued, { once: true });
    }
    gate.queue.push(entry);
    pump(container, key, gate);
  });
}

function pump(
  container: BrowserCommandContainer,
  key: object,
  gate: ExecutionGate,
): void {
  if (gate.active) return;
  const entry = gate.queue.shift();
  if (!entry) {
    gates.delete(key);
    return;
  }
  if (entry.cancelWhileQueued) entry.options.signal?.removeEventListener("abort", entry.cancelWhileQueued);
  if (entry.options.signal?.aborted) {
    entry.resolve(cancelledResult());
    pump(container, key, gate);
    return;
  }

  gate.active = true;
  let result: Promise<BrowserCommandRunResult>;
  try {
    result = entry.run(entry.command, entry.options);
  } catch (error) {
    result = Promise.reject(error);
  }
  void result.then(entry.resolve, entry.reject).finally(() => {
    gate.active = false;
    pump(container, key, gate);
  });
}
