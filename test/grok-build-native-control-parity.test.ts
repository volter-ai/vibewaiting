import { VirtualFS } from "almostnode";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { discoverGrokBuildAgents } from "../experiments/browser-agent/src/grok-build-agents.js";
import { GrokBuildBrowserRuntime } from "../experiments/browser-agent/src/grok-build-runtime.js";
import { GrokBuildSubagentAdmission } from "../experiments/browser-agent/src/grok-build-subagent-admission.js";
import {
  formatGrokBuildInterjection,
  formatGrokBuildInterrupt,
  grokBuildQueueCombinePrefixLength,
  joinGrokBuildQueuedPromptTexts,
  type GrokBuildQueueCombineGate,
} from "../experiments/browser-agent/src/grok-build-prompt-queue.js";
import {
  formatGrokQuestionOutcome,
  type GrokQuestion,
} from "../experiments/browser-agent/src/grok-build-question-dialog.js";
import deepResearchWorkflow from "../experiments/browser-agent/src/builtin-workflows/deep-research.rhai?raw";
import { loadGrokBuildRhaiWasmSync } from "../experiments/browser-agent/src/grok-build-rhai-wasm.js";
import {
  GrokBuildBrowserWorkflowHost,
  GrokBuildJournalRhaiEngine,
  type GrokBuildWorkflowSubagentResult,
} from "../experiments/browser-agent/src/grok-build-workflows.js";

const fixtureUrl = new URL("./fixtures/grok-conformance/native-control-behaviors-v1.json", import.meta.url);
const fixtureBytes = readFileSync(fixtureUrl);
const corpus = JSON.parse(fixtureBytes.toString("utf8")) as NativeControlCorpus;

describe("pinned native Grok control-behavior equivalence corpus", () => {
  it("pins the reviewed native revision, source provenance, and immutable corpus bytes", () => {
    expect(corpus.sourceRevision).toBe("9684fa3cdbf2995e30ea8b9b637f1db008f144fc");
    expect(corpus.kind).toBe("deterministic-native-source-equivalence");
    expect(corpus.provenance).toHaveLength(10);
    expect(corpus.provenance.every(({ path, sha256 }) => path.startsWith("crates/") && /^[0-9a-f]{64}$/u.test(sha256))).toBe(true);
    expect(createHash("sha256").update(fixtureBytes).digest("hex"))
      .toBe("4d2094857ddac07c2f262a5d1222f925c129ec9c8da1b2de56c73f4d9a17765b");
  });

  it("matches every native prompt merge gate and steer/interrupt envelope case", () => {
    for (const testCase of corpus.promptQueue.prefixCases) {
      const items: GrokBuildQueueCombineGate[] = testCase.items.map((item) => ({
        id: item.id,
        text: item.text,
        isPlainPrompt: item.isPlainPrompt ?? true,
        isSynthetic: item.isSynthetic ?? false,
        isExpandedSkill: item.isExpandedSkill ?? false,
        isBash: item.isBash ?? false,
        hasImages: item.hasImages ?? false,
      }));
      expect(grokBuildQueueCombinePrefixLength(items, new Set(testCase.skipIds)), testCase.name).toBe(testCase.length);
      if (testCase.joined !== undefined) expect(joinGrokBuildQueuedPromptTexts(items.map(({ text }) => text)), testCase.name).toBe(testCase.joined);
    }
    expect(formatGrokBuildInterjection("stop and fix the test first")).toBe(corpus.promptQueue.interjection);
    expect(formatGrokBuildInterrupt("do the other thing")).toBe(corpus.promptQueue.interrupt);
    const crossing = corpus.promptQueue.crossingScalar;
    const formatted = formatGrokBuildInterjection(crossing.character.repeat(crossing.inputCount));
    expect(formatted).toContain(crossing.character.repeat(crossing.keptCount));
    expect(formatted).not.toContain(crossing.character.repeat(crossing.keptCount + 1));
  });

  it("matches native bundled-agent defaults, frontmatter contract, and completion recovery shape", () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync("/.grok/agents", { recursive: true });
    vfs.writeFileSync("/.grok/agents/contract-agent.md", corpus.agents.definition);
    const definitions = discoverGrokBuildAgents(vfs);
    expect(definitions.slice(0, 3).map(({ name }) => name)).toEqual(corpus.agents.builtinNames);
    const definition = definitions.find(({ name }) => name === corpus.agents.expected.name);
    expect(definition).toMatchObject(corpus.agents.expected);
  });

  it("matches native subagent default admission, FIFO scheduling, and queued cancellation", async () => {
    expect(new GrokBuildSubagentAdmission().maxConcurrent).toBe(corpus.subagents.defaultMaxConcurrent);
    const admission = new GrokBuildSubagentAdmission(1);
    const starts: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const signal = new AbortController().signal;
    const first = admission.run(signal, async () => { starts.push("first"); await held; return "first"; });
    const second = admission.run(signal, async () => { starts.push("second"); return "second"; });
    const third = admission.run(signal, async () => { starts.push("third"); return "third"; });
    release();
    await expect(Promise.all([first, second, third])).resolves.toEqual(corpus.subagents.fifo);
    expect(starts).toEqual(corpus.subagents.fifo);

    let releaseBlocker!: () => void;
    const blocker = admission.run(signal, () => new Promise<string>((resolve) => { releaseBlocker = () => resolve("done"); }));
    const cancelled = new AbortController();
    let cancelledStarted = false;
    const queued = admission.run(cancelled.signal, async () => { cancelledStarted = true; return "wrong"; });
    cancelled.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    releaseBlocker();
    await blocker;
    expect(cancelledStarted).toBe(corpus.subagents.cancelledQueuedStarts);
  });

  it("matches all native ask-user result paths byte-for-byte", () => {
    const questions = corpus.questions.questions as GrokQuestion[];
    expect(formatGrokQuestionOutcome(questions, { type: "accepted", answers: [
      { question: questions[0]!, labels: ["Redis"], preview: "redis preview" },
      { question: questions[1]!, labels: ["Tests", "Other"], notes: "Also run lint" },
    ] })).toBe(corpus.questions.accepted);
    expect(formatGrokQuestionOutcome(questions, { type: "chat", answers: [
      { question: questions[0]!, labels: ["Redis"] },
    ] })).toBe(corpus.questions.chat);
    expect(formatGrokQuestionOutcome(questions, { type: "skip", answers: [] })).toBe(corpus.questions.skip);
    expect(formatGrokQuestionOutcome(questions, { type: "cancelled" })).toBe(corpus.questions.cancelled);
  });

  it("matches native plan entry, edit gate, revision, abandon, empty exit, and restored approval", async () => {
    const vfs = new VirtualFS();
    let entryApproved = false;
    const exits = [
      { outcome: "cancelled" as const, feedback: "Add rollback steps" },
      { outcome: "abandoned" as const },
    ];
    const runtime = browserRuntime(vfs, {
      approvePlanModeEntry: async () => entryApproved,
      approvePlanModeExit: async () => exits.shift() ?? { outcome: "approved" as const },
    });
    const signal = new AbortController().signal;
    await expect(execute(runtime, "enter_plan_mode", {})).resolves.toMatchObject({ isError: true, output: corpus.plan.declinedEntry });
    entryApproved = true;
    await execute(runtime, "enter_plan_mode", {});
    await expect(execute(runtime, "write", { file_path: "/blocked.ts", content: "no" })).resolves.toMatchObject({ output: corpus.plan.editGate });
    await execute(runtime, "write", { file_path: "/.grok/plan.md", content: "# Plan\n\nShip it.\n" });
    await expect(execute(runtime, "exit_plan_mode", {})).resolves.toMatchObject({ output: corpus.plan.revision });
    await expect(execute(runtime, "exit_plan_mode", {})).resolves.toMatchObject({ output: corpus.plan.abandoned });

    const empty = browserRuntime(new VirtualFS(), {
      approvePlanModeEntry: async () => true,
      approvePlanModeExit: async () => ({ outcome: "approved" as const }),
    });
    await execute(empty, "enter_plan_mode", {});
    await expect(execute(empty, "exit_plan_mode", {})).resolves.toMatchObject({ output: corpus.plan.emptyExit });

    const persisted = new VirtualFS();
    const disconnected = browserRuntime(persisted, {
      approvePlanModeEntry: async () => true,
      approvePlanModeExit: async () => { throw new Error("client disconnected"); },
    });
    await execute(disconnected, "enter_plan_mode", {});
    persisted.writeFileSync("/.grok/plan.md", "# Plan\n\nResume it.\n");
    await execute(disconnected, "exit_plan_mode", {});
    const restored = browserRuntime(persisted, {
      approvePlanModeExit: async () => ({ outcome: "approved" as const }),
    });
    await expect(restored.resumePendingPlanApproval(signal)).resolves.toBe(corpus.plan.resumed);
  });

  it("matches native workflow pause and JSON-schema correction accounting through real Rhai WASM", async () => {
    const wasm = readFileSync(new URL("../experiments/browser-agent/src/generated-rhai-wasm/grok_workflow_rhai_wasm_bg.wasm", import.meta.url));
    const module = loadGrokBuildRhaiWasmSync(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
    const noArgs = new GrokBuildJournalRhaiEngine(module, { async call() { throw new Error("unexpected host call"); } });
    await expect(noArgs.run(deepResearchWorkflow, null, { agentBudget: 128, signal: new AbortController().signal }))
      .resolves.toEqual(corpus.workflow.noArgs);

    let call = 0;
    const host = new GrokBuildBrowserWorkflowHost({
      vfs: new VirtualFS(),
      async spawnSubagent(_input, _signal, id) {
        const native = corpus.workflow.schemaAttempts[call++]!;
        return { childSessionId: id, ...native } satisfies GrokBuildWorkflowSubagentResult;
      },
    });
    const engine = new GrokBuildJournalRhaiEngine(module, host);
    const script = `let meta = #{ name: "contract", description: "contract" };
      let result = agent("Inspect", #{ output_schema: #{ type: "object", required: ["ok"], properties: #{ ok: #{ type: "boolean" } } } });
      complete(result);`;
    const outcome = await engine.run(script, {}, { agentBudget: 1, signal: new AbortController().signal });
    expect(outcome).toMatchObject({ status: "completed", result: corpus.workflow.schemaResult });
    expect(call).toBe(2);
  });
});

function browserRuntime(vfs: VirtualFS, services: ConstructorParameters<typeof GrokBuildBrowserRuntime>[2]): GrokBuildBrowserRuntime {
  return new GrokBuildBrowserRuntime({
    vfs,
    async run() { return { stdout: "", stderr: "", exitCode: 0 }; },
  }, "/", services);
}

function execute(runtime: GrokBuildBrowserRuntime, name: string, input: Record<string, unknown>) {
  return runtime.execute({ callId: crypto.randomUUID(), name, arguments: JSON.stringify(input) }, new AbortController().signal);
}

interface NativeControlCorpus {
  sourceRevision: string;
  kind: string;
  provenance: Array<{ path: string; sha256: string }>;
  promptQueue: {
    prefixCases: Array<{
      name: string;
      items: Array<Partial<GrokBuildQueueCombineGate> & Pick<GrokBuildQueueCombineGate, "id" | "text">>;
      skipIds: string[];
      length: number;
      joined?: string;
    }>;
    interjection: string;
    interrupt: string;
    crossingScalar: { character: string; inputCount: number; keptCount: number };
  };
  agents: { builtinNames: string[]; definition: string; expected: Record<string, unknown> & { name: string } };
  subagents: { defaultMaxConcurrent: number; fifo: string[]; cancelledQueuedStarts: boolean };
  questions: { questions: GrokQuestion[]; accepted: string; chat: string; skip: string; cancelled: string };
  plan: { declinedEntry: string; editGate: string; revision: string; emptyExit: string; abandoned: string; resumed: string };
  workflow: {
    noArgs: { status: "paused"; kind: string; message: string };
    schemaAttempts: Array<Omit<GrokBuildWorkflowSubagentResult, "childSessionId">>;
    schemaResult: Record<string, unknown>;
  };
}
