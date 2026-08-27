import { describe, expect, it, vi } from "vitest";
import { VirtualFS } from "almostnode";
import {
  GrokBuildBrowserScheduler,
  parseGrokSchedulerInterval,
  type JsonObject,
  type ScheduledSubagentHandle,
} from "../experiments/browser-agent/src/grok-build-scheduler.js";

describe("Grok Build browser scheduler", () => {
  it("ports native interval parsing, clamping, and validation", () => {
    expect(parseGrokSchedulerInterval(" 5m ")).toBe(300);
    expect(parseGrokSchedulerInterval("2h")).toBe(7_200);
    expect(parseGrokSchedulerInterval("1d")).toBe(86_400);
    expect(parseGrokSchedulerInterval("1s")).toBe(60);
    expect(() => parseGrokSchedulerInterval("0m")).toThrow("interval value must be greater than 0");
    expect(() => parseGrokSchedulerInterval("5x")).toThrow('invalid interval suffix: "x"');
    expect(() => parseGrokSchedulerInterval("abc")).toThrow("invalid interval format");
  });

  it("creates, updates, lists, deletes, and restores the native persisted shape", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T20:00:00.000Z"));
    try {
      const vfs = new VirtualFS();
      const scheduler = new GrokBuildBrowserScheduler(vfs, "/");
      const created = JSON.parse(scheduler.create({ interval: "30s", prompt: "Check CI", durable: true }));
      expect(created).toEqual({
        id: expect.stringMatching(/^[0-9a-f]{12}$/u),
        humanSchedule: "every 1 minute",
        updated: false,
      });
      expect(JSON.parse(scheduler.list())).toEqual({ tasks: [{
        id: created.id,
        prompt: "Check CI",
        intervalHuman: "every 1 minute",
        nextFireAt: "2026-08-27T20:01:00.000+00:00",
        createdAt: "2026-08-27T20:00:00.000+00:00",
        recurring: true,
      }] });
      expect(vfs.existsSync("/.grok/scheduler.json")).toBe(true);

      const restored = new GrokBuildBrowserScheduler(vfs, "/");
      expect(restored.list()).toBe(scheduler.list());
      expect(JSON.parse(restored.create({ task_id: created.id, interval: "2m", prompt: "Check deploy" }))).toEqual({
        id: created.id,
        humanSchedule: "every 2 minutes",
        updated: true,
      });
      expect(JSON.parse(restored.list()).tasks[0]).toMatchObject({
        prompt: "Check deploy",
        nextFireAt: "2026-08-27T20:02:00.000+00:00",
      });
      expect(JSON.parse(restored.delete({ id: "missing" }))).toEqual({
        success: false,
        message: "No scheduled task with ID missing found. Use scheduler_list to see active tasks.",
      });
      expect(JSON.parse(restored.delete({ id: created.id }))).toEqual({
        success: true,
        message: `Scheduled task ${created.id} cancelled.`,
      });
      expect(JSON.parse(restored.list())).toEqual({ tasks: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fires immediately as a tracked loop subagent and advances cadence before execution", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T20:00:00.000Z"));
    try {
      const vfs = new VirtualFS();
      const calls: Array<{ input: JsonObject; id: string }> = [];
      const handles = new Map<string, ScheduledSubagentHandle>();
      const events: unknown[] = [];
      const scheduler = new GrokBuildBrowserScheduler(vfs, "/", {
        spawnSubagent(input, _signal, id) {
          calls.push({ input, id });
          const handle = { status: "running", output: "" } as const;
          handles.set(id, handle);
          return handle;
        },
        getSubagent: (id) => handles.get(id),
        onEvent: (event) => events.push(event),
      });
      const created = JSON.parse(scheduler.create({ interval: "1m", prompt: "Check CI", fire_immediately: true }));
      await vi.advanceTimersByTimeAsync(0);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.id).toMatch(/^[0-9a-f-]{36}$/u);
      expect(calls[0]?.input).toMatchObject({
        subagent_type: "general-purpose",
        background: true,
        description: "loop: Check CI (every 1 minute)",
      });
      expect(String(calls[0]?.input.prompt)).toContain(`Scheduled task ${created.id} (every 1 minute)`);
      expect(String(calls[0]?.input.prompt)).toMatch(/short status[\s\S]*Check CI$/u);
      expect(JSON.parse(scheduler.list()).tasks[0].nextFireAt).toBe("2026-08-27T20:01:00.000+00:00");
      expect(events).toEqual([
        expect.objectContaining({ type: "created", taskId: created.id }),
        expect.objectContaining({ type: "fired", taskId: created.id, subagentId: calls[0]?.id }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects unsupported one-shot and invalid update requests", () => {
    const scheduler = new GrokBuildBrowserScheduler(new VirtualFS(), "/");
    expect(() => scheduler.create({ interval: "1m", prompt: "once", recurring: false })).toThrow("one-shot tasks are not supported");
    expect(() => scheduler.create({ task_id: "missing", prompt: "x" })).toThrow("no scheduled task with id missing");
    const { id } = JSON.parse(scheduler.create({ interval: "1m", prompt: "loop" }));
    expect(() => scheduler.create({ task_id: id })).toThrow("nothing to update");
  });
});
