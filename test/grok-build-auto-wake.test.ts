import { describe, expect, it } from "vitest";
import { GrokBuildAutoWakeCoordinator } from "../experiments/browser-agent/src/grok-build-auto-wake.js";

describe("Grok Build browser auto-wake coordinator", () => {
  it("serializes synthetic turns and never combines independent completions", async () => {
    let releaseIdle!: () => void;
    const idle = new Promise<void>((resolve) => { releaseIdle = resolve; });
    const reminders = new Map([["task-completed-a", "A"], ["task-completed-b", "B"]]);
    const wakes: string[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const coordinator = new GrokBuildAutoWakeCoordinator({
      waitForIdle: () => idle,
      claimReminder: (id) => reminders.has(id) ? { messages: [reminders.get(id)!] } : undefined,
      async runWake(id, payload) {
        wakes.push(`${id}:${payload.messages.join("|")}`);
        if (wakes.length === 1) await first;
      },
    });

    coordinator.enqueue("task-completed-a");
    coordinator.enqueue("task-completed-b");
    releaseIdle();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(wakes).toEqual(["task-completed-a:A"]);
    releaseFirst();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(wakes).toEqual(["task-completed-a:A", "task-completed-b:B"]);
  });

  it("drops wake requests whose reminder was consumed by a foreground wait", async () => {
    const wakes: string[] = [];
    const coordinator = new GrokBuildAutoWakeCoordinator({
      async waitForIdle() {},
      claimReminder: () => undefined,
      async runWake(id) { wakes.push(id); },
    });
    coordinator.enqueue("task-completed-consumed");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(wakes).toEqual([]);
  });

  it("does not strand a new-session wake when the prior idle wait is cleared", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let waits = 0;
    const wakes: string[] = [];
    const coordinator = new GrokBuildAutoWakeCoordinator({
      waitForIdle: () => ++waits === 1 ? blocked : Promise.resolve(),
      claimReminder: (id) => ({ messages: [id] }),
      async runWake(id) { wakes.push(id); },
    });
    coordinator.enqueue("old");
    coordinator.clear();
    coordinator.enqueue("new");
    release();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(wakes).toEqual(["new"]);
  });
});
