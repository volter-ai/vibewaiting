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

  it("creates, updates, lists, deletes, and restores the native persisted shape", async () => {
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
        nextFireAt: "2026-08-27T20:01:00+00:00",
        createdAt: "2026-08-27T20:00:00+00:00",
        recurring: true,
      }] });
      expect(vfs.existsSync("/.grok/scheduler.json")).toBe(true);

      const restored = new GrokBuildBrowserScheduler(vfs, "/", { onEvent() {} });
      expect(restored.list()).toBe(scheduler.list());
      expect(JSON.parse(restored.create({ task_id: created.id, interval: "2m", prompt: "Check deploy" }))).toEqual({
        id: created.id,
        humanSchedule: "every 2 minutes",
        updated: true,
      });
      expect(JSON.parse(restored.list()).tasks[0]).toMatchObject({
        prompt: "Check deploy",
        nextFireAt: "2026-08-27T20:02:00+00:00",
      });
      expect(JSON.parse(await restored.delete({ id: "missing" }))).toEqual({
        success: false,
        message: "No scheduled task with ID missing found. Use scheduler_list to see active tasks.",
      });
      expect(JSON.parse(await restored.delete({ id: created.id }))).toEqual({
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
        completion_output_cap: 4_000,
        spawn_depth: 0,
        loop_task_id: created.id,
      });
      expect(String(calls[0]?.input.prompt)).toContain(`Scheduled task ${created.id} (every 1 minute)`);
      expect(String(calls[0]?.input.prompt)).toMatch(/short status[\s\S]*Check CI$/u);
      expect(JSON.parse(scheduler.list()).tasks[0].nextFireAt).toBe("2026-08-27T20:01:00+00:00");
      expect(events).toEqual([
        expect.objectContaining({ type: "created", taskId: created.id, generation: expect.stringMatching(/^[0-9a-f-]{36}$/u), revision: 1 }),
        expect.objectContaining({ type: "fired", taskId: created.id, subagentId: calls[0]?.id, generation: expect.stringMatching(/^[0-9a-f-]{36}$/u), revision: 2 }),
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

  it("requires an acknowledging removal consumer without mutating the task", async () => {
    const scheduler = new GrokBuildBrowserScheduler(new VirtualFS(), "/");
    const { id } = JSON.parse(scheduler.create({ interval: "1m", prompt: "keep me" }));
    await expect(scheduler.delete({ id })).rejects.toThrow("durable scheduler removal requires an acknowledging notification consumer");
    expect(JSON.parse(scheduler.list()).tasks).toHaveLength(1);
  });

  it("retries the identical tombstone and blocks mutations until acknowledgement", async () => {
    const events: Array<Record<string, unknown>> = [];
    let rejectTombstone = true;
    const scheduler = new GrokBuildBrowserScheduler(new VirtualFS(), "/", {
      async onEvent(event) {
        events.push(event);
        if (event.type === "removed" && rejectTombstone) throw new Error("updates unavailable");
      },
    });
    const { id } = JSON.parse(scheduler.create({ interval: "1m", prompt: "retry ack", durable: false }));

    await expect(scheduler.delete({ id })).rejects.toThrow("failed to publish scheduler tombstone: updates unavailable");
    expect(JSON.parse(scheduler.list()).tasks).toEqual([]);
    expect(() => scheduler.create({ interval: "1m", prompt: "blocked" })).toThrow(`scheduler removal for ${id} is pending`);

    rejectTombstone = false;
    await expect(scheduler.delete({ id })).resolves.toContain(`Scheduled task ${id} cancelled.`);
    const removed = events.filter((event) => event.type === "removed");
    expect(removed).toHaveLength(2);
    expect(removed[1]).toEqual(removed[0]);
    expect(JSON.parse(scheduler.create({ interval: "1m", prompt: "unblocked" })).updated).toBe(false);
  });

  it("bounds a tombstone acknowledgement at the native 30-second barrier", async () => {
    vi.useFakeTimers();
    try {
      let hang = true;
      const scheduler = new GrokBuildBrowserScheduler(new VirtualFS(), "/", {
        onEvent(event) {
          if (event.type === "removed" && hang) return new Promise<void>(() => undefined);
        },
      });
      const { id } = JSON.parse(scheduler.create({ interval: "1m", prompt: "timeout ack" }));
      const deletion = scheduler.delete({ id });
      const rejected = expect(deletion).rejects.toThrow("scheduler removal timed out");
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(() => scheduler.create({ interval: "1m", prompt: "blocked" })).toThrow(`scheduler removal for ${id} is pending`);
      hang = false;
      await expect(scheduler.delete({ id })).resolves.toContain(`Scheduled task ${id} cancelled.`);
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes concurrent deletes behind one acknowledged tombstone", async () => {
    let acknowledge!: () => void;
    const ack = new Promise<void>((resolve) => { acknowledge = resolve; });
    let tombstones = 0;
    const scheduler = new GrokBuildBrowserScheduler(new VirtualFS(), "/", {
      onEvent(event) {
        if (event.type !== "removed") return;
        tombstones += 1;
        return ack;
      },
    });
    const { id } = JSON.parse(scheduler.create({ interval: "1m", prompt: "serialize" }));
    const first = scheduler.delete({ id });
    const second = scheduler.delete({ id });
    acknowledge();
    await expect(first).resolves.toContain(`Scheduled task ${id} cancelled.`);
    await expect(second).resolves.toContain(`No scheduled task with ID ${id} found.`);
    expect(tombstones).toBe(1);
    scheduler.dispose();
  });

  it("keeps a removal reservation across persistence failure and emits only after retry", async () => {
    const vfs = new VirtualFS();
    const events: Array<Record<string, unknown>> = [];
    const scheduler = new GrokBuildBrowserScheduler(vfs, "/", { onEvent: (event) => { events.push(event); } });
    const { id } = JSON.parse(scheduler.create({ interval: "1m", prompt: "retry persistence" }));
    const write = vi.spyOn(vfs, "writeFileSync").mockImplementationOnce(() => { throw new Error("disk unavailable"); });

    await expect(scheduler.delete({ id })).rejects.toThrow("failed to persist scheduler resources: disk unavailable");
    expect(events.filter((event) => event.type === "removed")).toEqual([]);
    expect(() => scheduler.create({ interval: "1m", prompt: "blocked" })).toThrow(`scheduler removal for ${id} is pending`);

    await expect(scheduler.delete({ id })).resolves.toContain(`Scheduled task ${id} cancelled.`);
    expect(events.filter((event) => event.type === "removed")).toHaveLength(1);
    write.mockRestore();
  });

  it("blocks an unacknowledgeable durable expiry and never resurrects after an ACK failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T20:00:00Z"));
    try {
      const vfs = new VirtualFS();
      const seed = new GrokBuildBrowserScheduler(vfs, "/");
      const { id } = JSON.parse(seed.create({ interval: "1m", prompt: "expire", durable: true }));
      seed.dispose();
      const state = JSON.parse(vfs.readFileSync("/.grok/scheduler.json", "utf8"));
      state.tasks[0].expiresAt = "2026-08-27T19:59:00+00:00";
      vfs.writeFileSync("/.grok/scheduler.json", JSON.stringify(state));

      const blocked = new GrokBuildBrowserScheduler(vfs, "/");
      await vi.advanceTimersByTimeAsync(0);
      expect(JSON.parse(blocked.list()).tasks).toEqual([expect.objectContaining({ id })]);
      blocked.dispose();

      const events: Array<Record<string, unknown>> = [];
      const failingAck = new GrokBuildBrowserScheduler(vfs, "/", {
        onEvent(event) {
          events.push(event);
          if (event.type === "removed") throw new Error("journal offline");
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(JSON.parse(failingAck.list()).tasks).toEqual([]);
      expect(events).toContainEqual(expect.objectContaining({ type: "removed", taskId: id, reason: "expired", revision: 1 }));
      expect(JSON.parse(vfs.readFileSync("/.grok/scheduler.json", "utf8")).tasks).toEqual([]);
      failingAck.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
