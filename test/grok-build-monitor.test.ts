import { VirtualFS } from "almostnode";
import { describe, expect, it } from "vitest";
import { GrokBuildBrowserRuntime } from "../experiments/browser-agent/src/grok-build-runtime.js";
import { GrokBuildMonitorEventStream, GrokBuildMonitorRateLimiter } from "../experiments/browser-agent/src/grok-build-monitor.js";

describe("Grok Build browser monitor", () => {
  it("returns the native persistent result and queues sanitized stdout events", async () => {
    const vfs = new VirtualFS();
    const tools = new GrokBuildBrowserRuntime({
      vfs,
      async run(_command, options) {
        options?.onStdout?.("DONE\n");
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const result = await tools.execute({
      callId: "monitor",
      name: "monitor",
      arguments: JSON.stringify({ command: "watch", description: "watch \"prod\"\nlogs", persistent: true }),
    }, new AbortController().signal);
    expect(result.output).toMatch(/^Monitor started \(task [0-9a-f-]{36}, persistent -- runs until kill_task or session end\)\./u);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(tools.drainSystemReminders()).toEqual([
      expect.stringMatching(/^<monitor-event description="watch 'prod' logs" task_id="[0-9a-f-]{36}">\nDONE\n<\/monitor-event>$/u),
      expect.stringMatching(/^Monitor "[0-9a-f-]{36}" ended: \[monitor ended: exited \(code 0\)\]\.\nDescription: watch "prod"\nlogs\nCommand: watch\nDuration: 0\.0s\nUse get_command_or_subagent_output\("[0-9a-f-]{36}"\) for full output\.\n$/u),
    ]);
    expect(tools.drainSystemReminders()).toEqual([]);
  });

  it("validates the native ten-hour non-persistent ceiling", async () => {
    const tools = new GrokBuildBrowserRuntime({
      vfs: new VirtualFS(),
      async run() { return { stdout: "", stderr: "", exitCode: 0 }; },
    });
    await expect(tools.execute({
      callId: "monitor",
      name: "monitor",
      arguments: JSON.stringify({ command: "watch", description: "watch", timeout_ms: 36_000_001 }),
    }, new AbortController().signal)).resolves.toEqual({
      isError: true,
      output: "persistent must be true when timeout_ms exceeds 36000000ms",
    });
  });

  it("matches the native token bucket, recovery notice, and sustained-overload stop", () => {
    let now = 0;
    const limiter = new GrokBuildMonitorRateLimiter(() => now, 1, 2_000);
    expect(limiter.process()).toEqual({ type: "allowed" });
    expect(limiter.process()).toEqual({ type: "suppressed" });
    now = 2_000;
    expect(limiter.process()).toEqual({
      type: "allowed",
      catchUpNotice: "[1 events suppressed -- output rate too high. Consider using kill_command_or_subagent to restart this monitor with a more selective filter.]",
    });
    expect(limiter.process()).toEqual({ type: "suppressed" });

    const sustained = new GrokBuildMonitorRateLimiter(() => now, 1, 2_000);
    expect(sustained.process()).toEqual({ type: "allowed" });
    expect(sustained.process()).toEqual({ type: "suppressed" });
    for (now = 4_000; now <= 34_000; now += 2_000) {
      expect(sustained.process().type).toBe("allowed");
      const outcome = sustained.process();
      if (now === 34_000) expect(outcome).toMatchObject({ type: "auto_stop", message: expect.stringContaining("Monitor stopped") });
      else expect(outcome).toEqual({ type: "suppressed" });
    }
  });

  it("wraps recovery notices as monitor events instead of leaking raw reminders", () => {
    let now = 0;
    const emitted: string[] = [];
    const limiter = new GrokBuildMonitorRateLimiter(() => now, 1, 2_000);
    const stream = new GrokBuildMonitorEventStream("task", "watch", (event) => emitted.push(event), limiter);
    stream.push("one\n"); stream.flush();
    stream.push("suppressed\n"); stream.flush();
    now = 2_000;
    stream.push("two\n"); stream.flush();
    expect(emitted).toHaveLength(3);
    expect(emitted[1]).toContain("1 events suppressed");
    expect(emitted[1]).toMatch(/^<monitor-event[\s\S]*<\/monitor-event>$/u);
    expect(emitted[2]).toContain("\ntwo\n");
  });
});
