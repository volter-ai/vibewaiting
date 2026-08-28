import { describe, expect, it } from "vitest";
import { GrokBuildSubagentAdmission } from "../experiments/browser-agent/src/grok-build-subagent-admission.js";

describe("Grok Build subagent admission", () => {
  it("starts up to the native limit and drains queued children in FIFO order", async () => {
    const admission = new GrokBuildSubagentAdmission(1);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const starts: string[] = [];
    const signal = new AbortController().signal;
    const first = admission.run(signal, async () => { starts.push("first"); await held; return "one"; });
    const second = admission.run(signal, async () => { starts.push("second"); return "two"; });
    const third = admission.run(signal, async () => { starts.push("third"); return "three"; });

    expect(admission.counts()).toEqual({ running: 1, queued: 2 });
    expect(starts).toEqual(["first"]);
    release();
    await expect(Promise.all([first, second, third])).resolves.toEqual(["one", "two", "three"]);
    expect(starts).toEqual(["first", "second", "third"]);
    expect(admission.counts()).toEqual({ running: 0, queued: 0 });
  });

  it("removes a cancelled queued child without consuming a slot", async () => {
    const admission = new GrokBuildSubagentAdmission(1);
    let release!: () => void;
    const first = admission.run(new AbortController().signal, () => new Promise<string>((resolve) => { release = () => resolve("done"); }));
    const controller = new AbortController();
    const queued = admission.run(controller.signal, async () => "never");
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(admission.counts()).toEqual({ running: 1, queued: 0 });
    release();
    await first;
  });
});
