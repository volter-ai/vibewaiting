import { VirtualFS } from "almostnode";
import { describe, expect, it } from "vitest";
import { GrokBuildBrowserRuntime } from "../experiments/browser-agent/src/grok-build-runtime.js";

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
});
