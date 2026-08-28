import { describe, expect, it, vi } from "vitest";
import { VirtualFS } from "almostnode";
import {
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
    expect((await execute("todo_write", { todos: [{ id: "1", content: "Inspect", status: "in_progress" }] })).output).toBe("- [in_progress] 1: Inspect");
    await execute("write", { file_path: "/src/new.js", content: "export {}" });
    expect(vfs.readFileSync("/src/new.js", "utf8")).toBe("export {}");
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    await expect(execute("run_terminal_command", { command: "echo ok", timeout: 1000 }))
      .resolves.toEqual({ output: "exit: 0\nok" });
    vi.unstubAllGlobals();
  });

  it("reports unavailable service-backed capabilities explicitly", async () => {
    const { tools } = runtime();
    await expect(tools.execute({ callId: "1", name: "image_gen", arguments: JSON.stringify({ prompt: "Pong" }) }, new AbortController().signal))
      .resolves.toMatchObject({ isError: true, output: expect.stringContaining("service adapter") });
  });

  it("returns native MCP-empty discovery and tracks browser subagents through poll and kill", async () => {
    const vfs = new VirtualFS();
    let finish!: (value: string) => void;
    const child = new Promise<string>((resolve) => { finish = resolve; });
    const tools = new GrokBuildBrowserRuntime({ vfs, async run() { return { stdout: "", stderr: "", exitCode: 0 }; } }, "/", {
      async spawnSubagent(_input, _signal, id) {
        expect(id).toMatch(/^[0-9a-f-]{36}$/u);
        return child;
      },
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
    await expect(tools.execute({ callId: "poll", name: "get_command_or_subagent_output", arguments: JSON.stringify({ task_ids: [id] }) }, signal))
      .resolves.toMatchObject({ output: expect.stringContaining("Status: running") });
    finish("Inspection complete");
    await child;
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await expect(tools.execute({ callId: "poll", name: "get_command_or_subagent_output", arguments: JSON.stringify({ task_ids: [id] }) }, signal))
      .resolves.toMatchObject({ output: expect.stringContaining("Status: completed") });
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
      const command = await tools.execute({ callId: "command", name: "run_terminal_command", arguments: '{"command":"npm run dev","background":true}' }, signal);
      const commandId = /task ID: ([0-9a-f-]+)/u.exec(command.output)?.[1];
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
      const taskId = /task ID: ([0-9a-f-]+)/u.exec(started.output)?.[1];
      expect(taskId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);

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
});
