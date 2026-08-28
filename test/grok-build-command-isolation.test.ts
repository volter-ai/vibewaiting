import { describe, expect, it } from "vitest";
import { VirtualFS } from "almostnode";
import { GrokBuildBrowserRuntime } from "../experiments/browser-agent/src/grok-build-runtime.js";
import {
  installBrowserCommandIsolation,
  runIsolatedBrowserCommand,
  type BrowserCommandRunOptions,
  type BrowserCommandRunResult,
} from "../experiments/browser-agent/src/grok-build-command-isolation.js";

describe("AlmostNode command execution isolation", () => {
  it("keeps adversarial background output and cancellation attached to their command", async () => {
    const started: string[] = [];
    const controls = new Map<string, {
      emit: (chunk: string) => void;
      signal?: AbortSignal;
      finish: (result: BrowserCommandRunResult) => void;
    }>();
    // This intentionally models AlmostNode's unsafe module-global callback:
    // an overlapping run would replace `currentStdout` for the first process.
    let currentStdout: ((chunk: string) => void) | undefined;
    const container = {
      vfs: new VirtualFS(),
      async run(command: string, options: BrowserCommandRunOptions = {}): Promise<BrowserCommandRunResult> {
        started.push(command);
        currentStdout = options.onStdout;
        return new Promise((resolve) => {
          const finish = (result: BrowserCommandRunResult): void => {
            currentStdout = undefined;
            resolve(result);
          };
          controls.set(command, {
            emit: (chunk) => { currentStdout?.(chunk); },
            ...(options.signal ? { signal: options.signal } : {}),
            finish,
          });
          options.signal?.addEventListener("abort", () => finish(cancelled()), { once: true });
        });
      },
    };
    const runtime = new GrokBuildBrowserRuntime(container);
    const signal = new AbortController().signal;
    const firstStart = await runtime.execute(tool("first-call", "first"), signal);
    const secondStart = await runtime.execute(tool("second-call", "second"), signal);
    const firstId = /task ID: ([0-9a-f-]+)/u.exec(firstStart.output)?.[1] ?? "";
    const secondId = /task ID: ([0-9a-f-]+)/u.exec(secondStart.output)?.[1] ?? "";

    expect(started).toEqual(["first"]);
    controls.get("first")?.emit("first-only\n");
    await runtime.execute({
      callId: "kill-first",
      name: "kill_command_or_subagent",
      arguments: JSON.stringify({ task_id: firstId }),
    }, signal);
    await microtasks();

    expect(started).toEqual(["first", "second"]);
    expect(controls.get("second")?.signal?.aborted).toBe(false);
    controls.get("second")?.emit("second-only\n");
    controls.get("second")?.finish({ stdout: "", stderr: "", exitCode: 0 });
    await microtasks();

    const firstOutput = await runtime.execute(outputTool("first-output", firstId), signal);
    const secondOutput = await runtime.execute(outputTool("second-output", secondId), signal);
    expect(firstOutput.output).toContain("first-only");
    expect(firstOutput.output).not.toContain("second-only");
    expect(secondOutput.output).toContain("second-only");
    expect(secondOutput.output).not.toContain("first-only");
  });

  it("covers direct workflow and hook consumers after one runtime-side install", async () => {
    const started: string[] = [];
    const active = new Map<string, (result: BrowserCommandRunResult) => void>();
    const container = {
      async run(command: string): Promise<BrowserCommandRunResult> {
        started.push(command);
        return new Promise((resolve) => { active.set(command, resolve); });
      },
    };
    expect(installBrowserCommandIsolation(container)).toBe(container);
    expect(installBrowserCommandIsolation(container)).toBe(container);

    const hook = container.run("hook");
    const workflow = container.run("workflow");
    expect(started).toEqual(["hook"]);
    active.get("hook")?.({ stdout: "hook", stderr: "", exitCode: 0 });
    await hook;
    await microtasks();
    expect(started).toEqual(["hook", "workflow"]);
    active.get("workflow")?.({ stdout: "workflow", stderr: "", exitCode: 0 });
    await workflow;
  });

  it("never overlaps callback ownership on one shared container", async () => {
    const started: string[] = [];
    const active = new Map<string, {
      options: BrowserCommandRunOptions;
      resolve: (result: BrowserCommandRunResult) => void;
    }>();
    const container = {
      async run(command: string, options: BrowserCommandRunOptions = {}): Promise<BrowserCommandRunResult> {
        started.push(command);
        return new Promise((resolve) => { active.set(command, { options, resolve }); });
      },
    };
    const firstChunks: string[] = [];
    const secondChunks: string[] = [];
    const first = runIsolatedBrowserCommand(container, "first", { onStdout: (chunk) => firstChunks.push(chunk) });
    const second = runIsolatedBrowserCommand(container, "second", { onStdout: (chunk) => secondChunks.push(chunk) });
    await microtasks();

    expect(started).toEqual(["first"]);
    active.get("first")?.options.onStdout?.("only-first");
    active.get("first")?.resolve({ stdout: "only-first", stderr: "", exitCode: 0 });
    await first;
    await microtasks();

    expect(started).toEqual(["first", "second"]);
    active.get("second")?.options.onStdout?.("only-second");
    active.get("second")?.resolve({ stdout: "only-second", stderr: "", exitCode: 0 });
    await second;
    expect(firstChunks).toEqual(["only-first"]);
    expect(secondChunks).toEqual(["only-second"]);
  });

  it("settles queued cancellation without entering or corrupting the FIFO", async () => {
    const started: string[] = [];
    const active = new Map<string, (result: BrowserCommandRunResult) => void>();
    const container = {
      async run(command: string): Promise<BrowserCommandRunResult> {
        started.push(command);
        return new Promise((resolve) => { active.set(command, resolve); });
      },
    };
    const first = runIsolatedBrowserCommand(container, "first", {});
    const queuedController = new AbortController();
    const cancelled = runIsolatedBrowserCommand(container, "cancelled", { signal: queuedController.signal });
    const third = runIsolatedBrowserCommand(container, "third", {});
    await microtasks();
    expect(started).toEqual(["first"]);

    queuedController.abort();
    await expect(cancelled).resolves.toEqual({ stdout: "", stderr: "", exitCode: 130 });
    expect(started).toEqual(["first"]);

    active.get("first")?.({ stdout: "", stderr: "", exitCode: 0 });
    await first;
    await microtasks();
    expect(started).toEqual(["first", "third"]);
    active.get("third")?.({ stdout: "", stderr: "", exitCode: 0 });
    await third;
  });
});

async function microtasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function tool(callId: string, command: string) {
  return { callId, name: "run_terminal_command", arguments: JSON.stringify({ command, background: true }) };
}

function outputTool(callId: string, taskId: string) {
  return { callId, name: "get_command_or_subagent_output", arguments: JSON.stringify({ task_id: taskId }) };
}

function cancelled(): BrowserCommandRunResult {
  return { stdout: "", stderr: "", exitCode: 130 };
}
