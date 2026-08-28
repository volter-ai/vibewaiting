import { describe, expect, it, vi } from "vitest";
import { VirtualFS } from "almostnode";
import {
  capCompletionOutput,
  GrokBuildBrowserRuntime,
  GrokConformanceToolRuntime,
} from "../experiments/browser-agent/src/grok-build-runtime.js";

function runtime() {
  const vfs = new VirtualFS();
  vfs.mkdirSync("/src", { recursive: true });
  vfs.writeFileSync("/src/main.js", Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"));
  return { vfs, tools: new GrokBuildBrowserRuntime({ vfs, async run() { return { stdout: "ok", stderr: "", exitCode: 0 }; } }) };
}

describe("Grok Build browser tool runtime", () => {
  it("caps scheduler-loop completion output by UTF-8 bytes with the native footer", () => {
    expect(capCompletionOutput("abcdef", 4)).toBe("abcd\n[output truncated: 4 of 6 bytes shown]");
    expect(capCompletionOutput("a💡b", 3)).toBe("a\n[output truncated: 1 of 6 bytes shown]");
    expect(capCompletionOutput("short", 8)).toBe("short");
  });

  it("implements native concise reads, exact edits, trees, grep, todos, and writes", async () => {
    const { vfs, tools } = runtime();
    const signal = new AbortController().signal;
    const execute = (name: string, args: object) => tools.execute({ callId: name, name, arguments: JSON.stringify(args) }, signal);

    expect((await execute("read_file", { target_file: "/src/main.js" })).output).toContain("1→line 1\nline 2");
    expect((await execute("read_file", { target_file: "/src/main.js" })).output).toContain("10→line 10");
    expect((await execute("search_replace", { file_path: "/src/main.js", old_string: "line 2", new_string: "changed" })).isError).toBeUndefined();
    expect(vfs.readFileSync("/src/main.js", "utf8")).toContain("changed");
    expect((await execute("list_dir", { target_directory: "/" })).output).toBe("- /\n  - src/\n    - main.js");
    expect((await execute("grep", { pattern: "changed", path: "/" })).output).toContain("Found 1 matching lines\n/src/main.js\n2:changed");
    expect((await execute("todo_write", { todos: [{ id: "1", content: "Inspect", status: "in_progress" }] })).output).toBe("- [in_progress] 1: Inspect\n");
    await execute("write", { file_path: "/src/new.js", content: "export {}" });
    expect(vfs.readFileSync("/src/new.js", "utf8")).toBe("export {}");
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    await expect(execute("run_terminal_command", { command: "echo ok", description: "Print a test value", timeout: 1000 }))
      .resolves.toEqual({ output: "exit: 0\nok" });
    vi.unstubAllGlobals();
  });

  it("reports unavailable service-backed capabilities explicitly", async () => {
    const { tools } = runtime();
    await expect(tools.execute({ callId: "1", name: "image_gen", arguments: JSON.stringify({ prompt: "Pong" }) }, new AbortController().signal))
      .resolves.toMatchObject({ isError: true, output: expect.stringContaining("service adapter") });
  });

  it("appends the native registered-skill recovery hint to a missing read", async () => {
    const vfs = new VirtualFS();
    const tools = new GrokBuildBrowserRuntime({
      vfs,
      async run() { return { stdout: "", stderr: "", exitCode: 0 }; },
    }, "/", {
      suggestSkillPath: (path) => path === "/wrong/review/SKILL.md" ? "/.grok/skills/review/SKILL.md" : undefined,
    });
    await expect(tools.execute({
      callId: "read",
      name: "read_file",
      arguments: JSON.stringify({ target_file: "/wrong/review/SKILL.md" }),
    }, new AbortController().signal)).resolves.toEqual({
      isError: true,
      output: "Error: /wrong/review/SKILL.md does not exist.\nThe skill you are looking for is registered at:\n/.grok/skills/review/SKILL.md",
    });
  });

  it("reparents a live nested-child monitor registry and all later notifications to the root", async () => {
    vi.useFakeTimers();
    try {
      const vfs = new VirtualFS();
      let onStdout: ((chunk: string) => void) | undefined;
      let finish!: (result: { stdout: string; stderr: string; exitCode: number }) => void;
      const running = new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => { finish = resolve; });
      const container = {
        vfs,
        async run(_command: string, options?: { onStdout?: (chunk: string) => void }) {
          onStdout = options?.onStdout;
          return running;
        },
      };
      const child = new GrokBuildBrowserRuntime(container, "/", {});
      const middle = new GrokBuildBrowserRuntime(container, "/", {});
      const parent = new GrokBuildBrowserRuntime(container, "/", {});
      const started = await child.execute({
        callId: "child-monitor",
        name: "monitor",
        arguments: JSON.stringify({ command: "tail -f app.log", description: "app log", persistent: true }),
      }, new AbortController().signal);
      const id = /task ([0-9a-f-]+)/u.exec(started.output)?.[1];
      expect(id).toBeTruthy();

      onStdout?.("before transfer\n");
      await vi.advanceTimersByTimeAsync(200);
      expect(child.drainSystemReminders().join("\n")).toContain("before transfer");

      expect(child.reparentBackgroundTasksTo(middle)).toEqual([id]);
      expect(middle.reparentBackgroundTasksTo(parent)).toEqual([id]);
      onStdout?.("after transfer\n");
      await vi.advanceTimersByTimeAsync(200);
      expect(child.drainSystemReminders()).toEqual([]);
      expect(parent.drainSystemReminders().join("\n")).toContain("after transfer");

      finish({ stdout: "", stderr: "", exitCode: 0 });
      await running;
      await vi.advanceTimersByTimeAsync(0);
      expect(parent.drainSystemReminders().join("\n")).toContain(`Monitor "${id}" ended`);
      const polled = await parent.execute({
        callId: "poll",
        name: "get_command_or_subagent_output",
        arguments: JSON.stringify({ task_ids: [id] }),
      }, new AbortController().signal);
      expect(polled.output).toContain("Status: completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns native MCP-empty discovery and tracks browser subagents through poll and kill", async () => {
    const vfs = new VirtualFS();
    let finish!: (value: string) => void;
    const child = new Promise<string>((resolve) => { finish = resolve; });
    const wakes: Array<{ promptId: string; source: string }> = [];
    const tools = new GrokBuildBrowserRuntime({ vfs, async run() { return { stdout: "", stderr: "", exitCode: 0 }; } }, "/", {
      async spawnSubagent(_input, _signal, id) {
        expect(id).toMatch(/^[0-9a-f-]{36}$/u);
        return child;
      },
      onSystemReminderQueued(event) { wakes.push(event); },
    });
    const signal = new AbortController().signal;
    const search = await tools.execute({ callId: "search", name: "search_tool", arguments: '{"query":"linear"}' }, signal);
    expect(JSON.parse(search.output)).toEqual({
      results: [],
      total_hidden_tools: 0,
      note: "No integration tools are configured. MCP servers are not connected.",
    });

    const started = await tools.execute({
      callId: "spawn",
      name: "spawn_subagent",
      arguments: JSON.stringify({ prompt: "Inspect", description: "Inspect files", background: true }),
    }, signal);
    const id = /subagent_id: ([0-9a-f-]+)/u.exec(started.output)?.[1];
    expect(id).toBeTruthy();
    expect(started.output).toBe(`Subagent started in background.\nsubagent_id: ${id}\ntype: general-purpose\ndescription: Inspect files\n\nWhen you need its result, use get_command_or_subagent_output with task_ids=["${id}"] and a positive timeout_ms.`);
    await expect(tools.execute({ callId: "poll", name: "get_command_or_subagent_output", arguments: JSON.stringify({ task_ids: [id] }) }, signal))
      .resolves.toMatchObject({ output: expect.stringContaining("Status: running") });
    finish("Inspection complete");
    await child;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(wakes).toEqual([expect.objectContaining({ promptId: `subagent-completed-${id}`, source: "subagent_completed" })]);
    expect(tools.takeSystemReminder(`subagent-completed-${id}`)).toContain(`Background subagent "${id}"`);
    await expect(tools.execute({ callId: "poll", name: "get_command_or_subagent_output", arguments: JSON.stringify({ task_ids: [id] }) }, signal))
      .resolves.toMatchObject({ output: expect.stringContaining("Status: completed") });
  });

  it("auto-wakes an idle parent with native background-subagent metadata", async () => {
    const wakes: Array<{ promptId: string; source: string }> = [];
    const tools = new GrokBuildBrowserRuntime({
      vfs: new VirtualFS(),
      async run() { return { stdout: "", stderr: "", exitCode: 0 }; },
    }, "/", {
      async spawnSubagent() {
        return { output: "Reviewed", success: true, durationMs: 1_250, toolCalls: 3, turns: 2 };
      },
      onSystemReminderQueued(event) { wakes.push(event); },
    });
    const started = await tools.execute({
      callId: "spawn",
      name: "spawn_subagent",
      arguments: '{"prompt":"Inspect","description":"Inspect files","subagent_type":"explore","background":true}',
    }, new AbortController().signal);
    const id = /subagent_id: ([0-9a-f-]+)/u.exec(started.output)?.[1] ?? "";
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(wakes).toEqual([expect.objectContaining({ promptId: `subagent-completed-${id}`, source: "subagent_completed" })]);
    expect(tools.takeSystemReminder(`subagent-completed-${id}`)).toMatch(
      new RegExp(`^<system-reminder>\\nBackground subagent "${id}" \\(explore: "Inspect files"\\) completed successfully\\.\\nDuration: .* \\| Tool calls: 3 \\| Turns: 2`, "u"),
    );
  });

  it("routes nested subagents and scheduled work through the native root-owned control plane", async () => {
    const vfs = new VirtualFS();
    const container = { vfs, async run() { return { stdout: "", stderr: "", exitCode: 0 }; } };
    let finish!: (value: string) => void;
    const nested = new Promise<string>((resolve) => { finish = resolve; });
    const wakes: string[] = [];
    const root = new GrokBuildBrowserRuntime(container, "/", {
      spawnSubagent: async () => nested,
      onSystemReminderQueued: (event) => wakes.push(event.promptId),
      onScheduledTaskEvent: () => undefined,
    });
    const child = new GrokBuildBrowserRuntime(container, "/", {
      spawnSubagent: async () => { throw new Error("child coordinator must not be used"); },
      onScheduledTaskEvent: () => { throw new Error("child scheduler must not be used"); },
    }, undefined, root);
    const signal = new AbortController().signal;

    const started = await child.execute({
      callId: "nested",
      name: "spawn_subagent",
      arguments: '{"prompt":"Inspect","description":"Nested inspection","background":true}',
    }, signal);
    const nestedId = /subagent_id: ([0-9a-f-]+)/u.exec(started.output)?.[1] ?? "";
    expect(nestedId).toBeTruthy();
    await expect(root.execute({
      callId: "root-poll", name: "get_command_or_subagent_output", arguments: JSON.stringify({ task_ids: [nestedId] }),
    }, signal)).resolves.toMatchObject({ output: expect.stringContaining("Status: running") });
    await expect(child.execute({
      callId: "child-poll", name: "get_command_or_subagent_output", arguments: JSON.stringify({ task_ids: [nestedId] }),
    }, signal)).resolves.toMatchObject({ output: expect.stringContaining("Status: running") });

    const scheduled = await child.execute({
      callId: "schedule",
      name: "scheduler_create",
      arguments: '{"interval":"7d","prompt":"Review the project"}',
    }, signal);
    const scheduledId = /ID: ([^,]+)/u.exec(scheduled.output)?.[1] ?? "";
    expect(scheduledId).toBeTruthy();
    const rootSchedule = await root.execute({ callId: "list", name: "scheduler_list", arguments: "{}" }, signal);
    expect(JSON.parse(rootSchedule.output)).toEqual([expect.objectContaining({ id: scheduledId, prompt: "Review the project" })]);

    finish("Nested inspection complete");
    await nested;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(wakes).toEqual([`subagent-completed-${nestedId}`]);
  });

  it("rebuilds native active task, todo, and subagent state after compaction", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T20:00:00Z"));
    try {
      const vfs = new VirtualFS();
      const neverCommand = new Promise<{ stdout: string; stderr: string; exitCode: number }>(() => undefined);
      const neverSubagent = new Promise<string>(() => undefined);
      const tools = new GrokBuildBrowserRuntime({ vfs, async run() { return neverCommand; } }, "/", {
        async spawnSubagent() { return neverSubagent; },
      });
      const signal = new AbortController().signal;
      const command = await tools.execute({ callId: "command", name: "run_terminal_command", arguments: '{"command":"npm run dev","description":"Start development server","background":true}' }, signal);
      const commandId = /<task-id>([0-9a-f-]+)<\/task-id>/u.exec(command.output)?.[1];
      const child = await tools.execute({
        callId: "child",
        name: "spawn_subagent",
        arguments: '{"prompt":"Inspect","description":"Inspect files","subagent_type":"explore","background":true}',
      }, signal);
      const childId = /subagent_id: ([0-9a-f-]+)/u.exec(child.output)?.[1];
      await tools.execute({
        callId: "todos",
        name: "todo_write",
        arguments: JSON.stringify({ todos: [
          { id: "active", content: "Implement game", status: "in_progress" },
          { id: "done", content: "Inspect", status: "completed" },
        ] }),
      }, signal);
      vi.setSystemTime(new Date("2026-08-27T20:00:07Z"));

      expect(tools.compactionSystemReminder()).toBe(`<system-reminder>
## Running Background Tasks
These tasks are still running:
- "${commandId}": \`npm run dev\` (running, run_terminal_command)

## TODO List
This is your task list from before the conversation was compacted — it is still active. Keep working through the items below and update their status as you make progress:
- [in_progress] active: Implement game
(1 completed)

## Running Subagents
These subagents were launched before this compaction and are still running. Use \`get_command_or_subagent_output\` with the subagent_id to check their status or retrieve results. Use \`kill_command_or_subagent\` with the subagent_id to cancel a subagent.
- subagent_id: \`${childId}\`, type: \`explore\`, task: "Inspect files" (running for 7s)
</system-reminder>`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-backgrounds an omitted-timeout foreground command and bounds task-output waits", async () => {
    vi.useFakeTimers();
    try {
      const vfs = new VirtualFS();
      const never = new Promise<{ stdout: string; stderr: string; exitCode: number }>(() => undefined);
      const tools = new GrokBuildBrowserRuntime({ vfs, async run() { return never; } });
      const signal = new AbortController().signal;
      const command = tools.execute({
        callId: "command",
        name: "run_terminal_command",
        arguments: JSON.stringify({ command: "vite", description: "Start preview" }),
      }, signal);
      await vi.advanceTimersByTimeAsync(120_000);
      const started = await command;
      expect(started.output).toBe(
        '<task-id>command</task-id>\n' +
        '<task-type>bash</task-type>\n' +
        '<output-file>/tmp/grok-build-session/terminal/command.log</output-file>\n' +
        '<status>running</status>\n' +
        '<summary>Command "vite" exceeded the default timeout and was automatically moved to background. Process is still running.</summary>\n' +
        'Use get_command_or_subagent_output with task_ids=["command"] when you need the output.',
      );
      const taskId = "command";

      const poll = tools.execute({
        callId: "poll",
        name: "get_command_or_subagent_output",
        arguments: JSON.stringify({ task_ids: [taskId], timeout_ms: 25 }),
      }, signal);
      await vi.advanceTimersByTimeAsync(25);
      await expect(poll).resolves.toMatchObject({ output: expect.stringContaining("Status: running") });
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders explicit foreground timeouts and tracks positive background timeouts", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    try {
      const vfs = new VirtualFS();
      const tools = new GrokBuildBrowserRuntime({
        vfs,
        run(_command, options) {
          options?.onStdout?.("partial output");
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
          });
        },
      });
      const signal = new AbortController().signal;
      const foreground = tools.execute({
        callId: "foreground-timeout",
        name: "run_terminal_command",
        arguments: JSON.stringify({ command: "slow", description: "Exercise timeout", timeout: 25 }),
      }, signal);
      await vi.advanceTimersByTimeAsync(25);
      await expect(foreground).resolves.toEqual({ output: "exit: killed (timeout)\npartial output" });

      const started = await tools.execute({
        callId: "background-timeout",
        name: "run_terminal_command",
        arguments: JSON.stringify({ command: "slow", description: "Exercise background timeout", background: true, timeout: 40 }),
      }, signal);
      const taskId = /<task-id>([0-9a-f-]+)<\/task-id>/u.exec(started.output)?.[1];
      await vi.advanceTimersByTimeAsync(40);
      await expect(tools.execute({
        callId: "poll-timeout",
        name: "get_command_or_subagent_output",
        arguments: JSON.stringify({ task_ids: [taskId] }),
      }, signal)).resolves.toMatchObject({
        output: expect.stringMatching(/Status: timed_out[\s\S]*partial output/u),
      });
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("preserves native trailing-newline rendering", async () => {
    const { vfs, tools } = runtime();
    vfs.writeFileSync("/src/trailing.txt", "first\nsecond\n");
    await expect(tools.execute({
      callId: "read",
      name: "read_file",
      arguments: JSON.stringify({ target_file: "/src/trailing.txt" }),
    }, new AbortController().signal)).resolves.toEqual({ output: "1→first\nsecond\n" });
  });

  it("matches native read windows, negative offsets, empty files, and the 1000-line cap", async () => {
    const { vfs, tools } = runtime();
    const signal = new AbortController().signal;
    const read = (args: object) => tools.execute({ callId: "read", name: "read_file", arguments: JSON.stringify({ target_file: "/src/window.txt", ...args }) }, signal);
    vfs.writeFileSync("/src/window.txt", "a\nb\nc");
    await expect(read({ offset: -2 })).resolves.toEqual({ output: "3→c" });
    await expect(read({ offset: -1 })).resolves.toEqual({ output: "(no lines returned)" });
    await expect(read({ offset: 99 })).resolves.toEqual({ output: "(no lines returned: the requested window is past the end of the file; the file has 3 lines)" });
    vfs.writeFileSync("/src/window.txt", "");
    await expect(read({})).resolves.toEqual({ output: "File is empty." });
    vfs.writeFileSync("/src/window.txt", Array.from({ length: 1_005 }, (_, index) => `line ${index + 1}`).join("\n"));
    const capped = await read({});
    expect(capped.output).toContain("1000→line 1000");
    expect(capped.output).not.toContain("line 1001");
  });

  it("matches native search_replace success and logical-error text", async () => {
    const { vfs, tools } = runtime();
    const signal = new AbortController().signal;
    const edit = (args: object) => tools.execute({ callId: "edit", name: "search_replace", arguments: JSON.stringify({ file_path: "src/edit.txt", ...args }) }, signal);
    vfs.writeFileSync("/src/edit.txt", "alpha\nbeta alpha\n");
    await expect(edit({ old_string: "beta", new_string: "gamma" })).resolves.toEqual({ output: "The file src/edit.txt has been updated successfully." });
    await expect(edit({ old_string: "alpha", new_string: "delta" })).resolves.toMatchObject({
      isError: true,
      output: expect.stringContaining("Use replace_all to replace all occurrences"),
    });
    await expect(edit({ old_string: "gamma nope", new_string: "x" })).resolves.toMatchObject({
      isError: true,
      output: expect.stringContaining("Nearest match: line 2: gamma alpha"),
    });
  });

  it("seeds, preserves, and surfaces the native plan file", async () => {
    const { vfs, tools } = runtime();
    const signal = new AbortController().signal;
    const enter = await tools.execute({ callId: "enter", name: "enter_plan_mode", arguments: "{}" }, signal);
    expect(enter.output).toContain("You have entered plan mode.");
    expect(enter.output).toContain("Write your plan to /.grok/plan.md. The file exists and is empty.");
    expect(vfs.readFileSync("/.grok/plan.md", "utf8")).toBe("");

    vfs.writeFileSync("/.grok/plan.md", "# Plan\n\n1. Build it.\n");
    const reenter = await tools.execute({ callId: "enter-again", name: "enter_plan_mode", arguments: "{}" }, signal);
    expect(reenter.output).toContain("The file exists and is non-empty.");
    expect(vfs.readFileSync("/.grok/plan.md", "utf8")).toBe("# Plan\n\n1. Build it.\n");

    await expect(tools.execute({ callId: "exit", name: "exit_plan_mode", arguments: "{}" }, signal)).resolves.toEqual({
      output: "Your plan has been approved. You can now start coding.\n\nYour plan has been saved at: /.grok/plan.md\n\n## Plan:\n# Plan\n\n1. Build it.\n",
    });
  });

  it("requires plan approval, gates edits to plan.md, and remains active after revision feedback", async () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync("/src", { recursive: true });
    vfs.writeFileSync("/src/main.ts", "old");
    let entryApproved = false;
    const exits: Array<"cancelled" | "approved"> = ["cancelled", "approved"];
    const tools = new GrokBuildBrowserRuntime({ vfs, async run() { return { stdout: "", stderr: "", exitCode: 0 }; } }, "/", {
      async approvePlanModeEntry() { return entryApproved; },
      async approvePlanModeExit() {
        const outcome = exits.shift() ?? "approved";
        return outcome === "cancelled" ? { outcome, feedback: "Add rollback steps" } : { outcome };
      },
    });
    const signal = new AbortController().signal;
    const execute = (name: string, args: object) => tools.execute({ callId: name, name, arguments: JSON.stringify(args) }, signal);

    await expect(execute("enter_plan_mode", {})).resolves.toEqual({
      isError: true,
      output: "User declined to enter plan mode.",
    });
    entryApproved = true;
    await execute("enter_plan_mode", {});
    await expect(execute("write", { file_path: "/src/main.ts", content: "new" })).resolves.toEqual({
      output: "Rejected: file edits are not allowed in plan mode - the only editable file is the plan file (/.grok/plan.md).",
    });
    expect(vfs.readFileSync("/src/main.ts", "utf8")).toBe("old");
    await expect(execute("write", { file_path: "/.grok/plan.md", content: "# Plan\n\n1. Change it.\n" })).resolves.toEqual({
      output: "Wrote file successfully to /.grok/plan.md.",
    });
    await expect(execute("exit_plan_mode", {})).resolves.toEqual({
      output: "The user wants to revise the plan. The user said:\nAdd rollback steps",
    });
    await expect(execute("write", { file_path: "/src/main.ts", content: "still blocked" })).resolves.toEqual({
      output: "Rejected: file edits are not allowed in plan mode - the only editable file is the plan file (/.grok/plan.md).",
    });
    await expect(execute("exit_plan_mode", {})).resolves.toMatchObject({
      output: expect.stringContaining("Your plan has been approved"),
    });
    await expect(execute("write", { file_path: "/src/main.ts", content: "new" })).resolves.toEqual({ output: "Wrote file successfully to /src/main.ts." });
  });

  it("persists a disconnected plan approval and re-parks it after restore", async () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync("/source.ts", "old");
    const disconnected = new GrokBuildBrowserRuntime({ vfs, async run() { return { stdout: "", stderr: "", exitCode: 0 }; } }, "/", {
      async approvePlanModeExit() { throw new Error("client disconnected"); },
    });
    const signal = new AbortController().signal;
    await disconnected.execute({ callId: "enter", name: "enter_plan_mode", arguments: "{}" }, signal);
    vfs.writeFileSync("/.grok/plan.md", "# Plan\n\n1. Build it.\n");
    await expect(disconnected.execute({ callId: "exit", name: "exit_plan_mode", arguments: "{}" }, signal)).resolves.toEqual({
      isError: true,
      output: "Plan approval could not be completed because the client disconnected. Plan mode remains active; the approval will reappear on reconnect.",
    });
    expect(disconnected.hasPendingPlanApproval()).toBe(true);
    expect(JSON.parse(vfs.readFileSync("/.grok/plan-mode.json", "utf8"))).toMatchObject({
      active: true,
      awaitingPlanApproval: true,
    });

    const restored = new GrokBuildBrowserRuntime({ vfs, async run() { return { stdout: "", stderr: "", exitCode: 0 }; } }, "/", {
      async approvePlanModeExit() { return { outcome: "approved" }; },
    });
    expect(restored.hasPendingPlanApproval()).toBe(true);
    await expect(restored.resumePendingPlanApproval(signal)).resolves.toBe("The user approved the plan. Implement the plan in plan.md.");
    expect(restored.hasPendingPlanApproval()).toBe(false);
    await expect(restored.execute({
      callId: "write",
      name: "write",
      arguments: JSON.stringify({ file_path: "/source.ts", content: "new" }),
    }, signal)).resolves.toMatchObject({ output: "Wrote file successfully to /source.ts." });
  });

  it("intercepts empty-plan exits and fails closed on unknown approval outcomes", async () => {
    const vfs = new VirtualFS();
    const seenPlans: string[] = [];
    const tools = new GrokBuildBrowserRuntime({ vfs, async run() { return { stdout: "", stderr: "", exitCode: 0 }; } }, "/", {
      async approvePlanModeExit(plan) {
        seenPlans.push(plan);
        return { outcome: "unknown" } as never;
      },
    });
    const signal = new AbortController().signal;
    await tools.execute({ callId: "enter", name: "enter_plan_mode", arguments: "{}" }, signal);
    await expect(tools.execute({ callId: "exit", name: "exit_plan_mode", arguments: "{}" }, signal)).resolves.toEqual({
      output: "The user does not want to exit plan mode. Continue planning and ask the user what they would like to do.",
    });
    expect(seenPlans).toEqual([""]);
    await expect(tools.execute({
      callId: "write",
      name: "write",
      arguments: JSON.stringify({ file_path: "/blocked.ts", content: "no" }),
    }, signal)).resolves.toMatchObject({ output: expect.stringContaining("not allowed in plan mode") });
  });

  it("matches native grep modes, context markers, filters, caps, and gitignore traversal", async () => {
    const { vfs, tools } = runtime();
    const signal = new AbortController().signal;
    const grep = (args: object) => tools.execute({ callId: "grep", name: "grep", arguments: JSON.stringify(args) }, signal);
    vfs.mkdirSync("/.git", { recursive: true });
    vfs.mkdirSync("/ignored", { recursive: true });
    vfs.writeFileSync("/.gitignore", "ignored/\n*.log\n");
    vfs.writeFileSync("/ignored/secret.ts", "needle");
    vfs.writeFileSync("/debug.log", "needle");
    vfs.writeFileSync("/src/context.ts", "before\nNeedle one\nafter\ngap one\ngap two\nneedle two\n");

    await expect(grep({ pattern: "needle", path: "/", type: "ts", "-i": true, "-C": 1 })).resolves.toEqual({
      output: '<workspace_result workspace_path="/">\nFound 2 matching lines\n/src/context.ts\n1-before\n2:Needle one\n3-after\n--\n5-gap two\n6:needle two\n7-\n</workspace_result>',
    });
    await expect(grep({ pattern: "needle", path: "/", output_mode: "files_with_matches" })).resolves.toEqual({
      output: '<workspace_result workspace_path="/">\nFound 1 files\n/src/context.ts\n</workspace_result>',
    });
    await expect(grep({ pattern: "needle", path: "/", output_mode: "count" })).resolves.toEqual({
      output: '<workspace_result workspace_path="/">\nFound 1 across 1 files\n/src/context.ts:1\n</workspace_result>',
    });
    expect((await tools.execute({ callId: "list", name: "list_dir", arguments: '{"target_directory":"/"}' }, signal)).output)
      .not.toMatch(/ignored|debug\.log/u);
  });

  it("executes recorded calls in-browser while releasing native outputs in native completion order", async () => {
    const { vfs, tools } = runtime();
    vfs.writeFileSync("/src/game.js", "old\n");
    const conformance = new GrokConformanceToolRuntime(tools, [
      { callId: "write", output: "Wrote file successfully to /private/tmp/native/src/game.js." },
      { callId: "read", output: "1→export const ready = true;\n" },
    ], "/private/tmp/native", "/");
    const signal = new AbortController().signal;

    await expect(conformance.execute({
      callId: "write",
      name: "write",
      arguments: JSON.stringify({ file_path: "/private/tmp/native/src/game.js", content: "export const ready = true;\n" }),
    }, signal)).resolves.toEqual({ output: "Wrote file successfully to /private/tmp/native/src/game.js." });
    await expect(conformance.execute({
      callId: "read",
      name: "read_file",
      arguments: JSON.stringify({ target_file: "/private/tmp/native/src/game.js" }),
    }, signal)).resolves.toEqual({ output: "1→export const ready = true;\n" });
    expect(vfs.readFileSync("/src/game.js", "utf8")).toBe("export const ready = true;\n");
    expect(() => conformance.assertComplete()).not.toThrow();
  });

  it("gates and validates native asynchronous reminders at their recorded foreground boundary", async () => {
    const nativeId = "11111111-1111-4111-8111-111111111111";
    const browserId = "22222222-2222-4222-8222-222222222222";
    const expectedReminder = `<system-reminder>\nMonitor "${nativeId}" ended: [monitor ended: exited (code 0)].\nDescription: verify\nCommand: echo ok\nDuration: 0.1s\nUse get_command_or_subagent_output("${nativeId}") for full output.\n\n</system-reminder>`;
    let drained = false;
    const browser = {
      async execute() {
        return { output: `Monitor started (task ${browserId}, timeout 15000ms).\nYou will be notified on each event. Keep working -- do not poll or sleep.\nEvents may arrive while you are waiting for the user -- an event is not their reply.` };
      },
      drainSystemReminders() {
        if (drained) return [];
        drained = true;
        return [`<system-reminder>\nMonitor "${browserId}" ended: [monitor ended: exited (code 0)].\nDescription: verify\nCommand: echo ok\nDuration: 0.0s\nUse get_command_or_subagent_output("${browserId}") for full output.\n\n</system-reminder>`];
      },
    };
    const conformance = new GrokConformanceToolRuntime(browser, [{
      callId: "monitor",
      output: `Monitor started (task ${nativeId}, timeout 15000ms).\nYou will be notified on each event. Keep working -- do not poll or sleep.\nEvents may arrive while you are waiting for the user -- an event is not their reply.`,
    }], "/private/tmp/native", "/", [{ beforeForegroundRequest: 1, content: expectedReminder }]);

    await conformance.execute({ callId: "monitor", name: "monitor", arguments: "{}" }, new AbortController().signal);
    expect(conformance.drainSystemReminders("before_sample")).toEqual([]);
    expect(conformance.hasPendingAutoWake()).toBe(true);
    expect(conformance.drainSystemReminders("before_sample")).toEqual([expectedReminder]);
    expect(() => conformance.assertComplete()).not.toThrow();
  });

  it("widens native-truncated grep while requiring every native match", async () => {
    const execute = vi.fn(async (_call: { arguments: string }) => ({
      output: '<workspace_result workspace_path="/">\nFound 3 matching lines\n/src/a.js\n3:three\n1:one\n2:two\n</workspace_result>',
    }));
    const expected = '<workspace_result workspace_path="/private/tmp/native">\nFound at least 2 matching lines\n/private/tmp/native/src/a.js\n1:one\n2:two\n</workspace_result>';
    const conformance = new GrokConformanceToolRuntime({ execute }, [{ callId: "grep", output: expected }], "/private/tmp/native", "/");
    await expect(conformance.execute({
      callId: "grep",
      name: "grep",
      arguments: '{"pattern":".","path":"/private/tmp/native"}',
    }, new AbortController().signal)).resolves.toEqual({ output: expected });
    expect(JSON.parse(execute.mock.calls[0]?.[0].arguments ?? "{}")).toMatchObject({ path: "/", head_limit: 2_000 });
  });

  it("formats scheduler tools through the native model-facing projection", async () => {
    const { tools } = runtime();
    const signal = new AbortController().signal;
    const created = await tools.execute({
      callId: "create",
      name: "scheduler_create",
      arguments: '{"interval":"1m","prompt":"check"}',
    }, signal);
    const id = /ID: ([0-9a-f]+)/u.exec(created.output)?.[1] ?? "";
    expect(created.output).toBe(`Scheduled task created (ID: ${id}, every 1 minute).`);
    expect((await tools.execute({ callId: "list", name: "scheduler_list", arguments: "{}" }, signal)).output).toContain(`"id": "${id}"`);
  });

  it("keeps ls entry names and file sizes strict while ignoring host-owned long-listing metadata", async () => {
    const actual = `exit: 0\ntotal 3\ndrwxr-xr-x 1 user user 0 Jan 1 00:00 .\ndrwxr-xr-x 1 user user 0 Jan 1 00:00 ..\n-rw-r--r-- 1 user user 152 Aug 27 21:14 package.json\ndrwxr-xr-x 1 user user 0 Aug 27 21:14 src/`;
    const expected = `exit: 0\ntotal 16\ndrwxr-xr-x@ 5 yueranyuan wheel 160 Aug 27 21:01 .\ndrwxrwxrwt 9990 root wheel 319680 Aug 27 21:01 ..\n-rw-r--r--@ 1 yueranyuan wheel 152 Aug 27 20:57 package.json\ndrwxr-xr-x@ 3 yueranyuan wheel 96 Aug 27 20:53 src`;
    const runtime = { execute: vi.fn(async () => ({ output: actual })) };
    const conformance = new GrokConformanceToolRuntime(runtime, [{ callId: "ls", output: expected }], "/private/tmp/native", "/");
    await expect(conformance.execute({
      callId: "ls",
      name: "run_terminal_command",
      arguments: '{"command":"ls -la /private/tmp/native","description":"List project files"}',
    }, new AbortController().signal)).resolves.toEqual({ output: expected });

    const drift = new GrokConformanceToolRuntime(runtime, [{ callId: "ls", output: expected.replace("152", "153") }], "/private/tmp/native", "/");
    await expect(drift.execute({
      callId: "ls",
      name: "run_terminal_command",
      arguments: '{"command":"ls -la /private/tmp/native","description":"List project files"}',
    }, new AbortController().signal)).rejects.toThrow("output drifted");
  });
});
