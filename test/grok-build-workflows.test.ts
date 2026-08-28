import { VirtualFS } from "almostnode";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import deepResearchWorkflow from "../experiments/browser-agent/src/builtin-workflows/deep-research.rhai?raw";
import { loadGrokBuildRhaiWasmSync } from "../experiments/browser-agent/src/grok-build-rhai-wasm.js";
import {
  GrokBuildBrowserWorkflowManager,
  GrokBuildJournalRhaiEngine,
  GrokBuildWorkflowRegistry,
  extractGrokBuildWorkflowMeta,
  formatGrokBuildWorkflowListing,
  mergeGrokBuildExtensionListings,
  normalizeGrokBuildWorkflowInput,
  type GrokBuildRhaiContinuationModule,
  type GrokBuildWorkflowEngine,
  type GrokBuildWorkflowHost,
} from "../experiments/browser-agent/src/grok-build-workflows.js";

function workflow(name: string, description = `${name} description`, when?: string): string {
  return `// published workflow\nlet meta = #{\n  name: ${JSON.stringify(name)},\n  description: ${JSON.stringify(description)},\n  ${when ? `when_to_use: ${JSON.stringify(when)},` : ""}\n  phases: [#{ title: "Scan" }, #{ title: "Verify", detail: "Check it" }],\n};\ncomplete(#{ ok: true });`;
}

function write(vfs: VirtualFS, path: string, source: string): void {
  vfs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  vfs.writeFileSync(path, source);
}

describe("Grok Build browser workflows", () => {
  it("extracts native pure-literal metadata and enforces native validation bounds", () => {
    expect(extractGrokBuildWorkflowMeta(workflow("review-pr", "Review a PR", "When reviewing changes"))).toEqual({
      name: "review-pr",
      description: "Review a PR",
      whenToUse: "When reviewing changes",
      phases: [{ title: "Scan" }, { title: "Verify", detail: "Check it" }],
    });
    expect(() => extractGrokBuildWorkflowMeta("let x = 1; let meta = #{ name: \"x\", description: \"d\" };"))
      .toThrow("first statement must be");
    expect(() => extractGrokBuildWorkflowMeta(workflow("two--hyphens"))).toThrow("lowercase ASCII");
    expect(() => extractGrokBuildWorkflowMeta('let meta = #{ name: "x", description: "d", phases: [#{ title: "Same" }, #{ title: "Same" }] };'))
      .toThrow("duplicate meta.phases[].title");
    expect(() => extractGrokBuildWorkflowMeta('let meta = #{ name: "x", description: "d", surprise: true };'))
      .toThrow("unknown field");
  });

  it("discovers bundle, builtin, project, and user scopes with native shadow order", () => {
    const vfs = new VirtualFS();
    write(vfs, "/.grok/bundled/workflows/deep-research.rhai", workflow("deep-research", "Published update"));
    write(vfs, "/workspace/.grok/workflows/review-pr.rhai", workflow("review-pr", "Project review"));
    write(vfs, "/user-workflows/user-flow.rhai", workflow("user-flow", "User flow"));
    write(vfs, "/workspace/.grok/workflows/mismatch.rhai", workflow("not-mismatch"));
    const registry = new GrokBuildWorkflowRegistry(vfs, {
      workspacePath: "/workspace",
      userWorkflowPath: "/user-workflows",
      builtins: [{ script: workflow("deep-research", "Compiled fallback"), path: "/native/deep_research.rhai" }],
    });

    expect(registry.list().map((entry) => [entry.meta.name, entry.source])).toEqual([
      ["deep-research", "bundled"],
      ["review-pr", "project"],
      ["user-flow", "user"],
    ]);
    expect(registry.resolveByName("deep-research").meta.description).toBe("Published update");
    expect(() => registry.resolveByName("Unknown")).toThrow("invalid workflow name");
    expect(() => registry.resolveByName("missing")).toThrow("unknown workflow");
  });

  it("formats and merges the native model-facing workflow listing", () => {
    const vfs = new VirtualFS();
    write(vfs, "/.grok/bundled/workflows/review-pr.rhai", workflow("review-pr", "Review a GitHub PR.", "Review a pull request"));
    const listing = formatGrokBuildWorkflowListing(new GrokBuildWorkflowRegistry(vfs).list());
    expect(listing).toBe(`The following workflows are available:

- review-pr: Review a GitHub PR.
  Use when: Review a pull request
  Absolute path: /.grok/bundled/workflows/review-pr.rhai`);
    expect(mergeGrokBuildExtensionListings("skills", listing)).toBe(`skills\n\n${listing}`);
    expect(formatGrokBuildWorkflowListing([])).toBeUndefined();
  });

  it("accepts tagged and legacy tool inputs but rejects conflicts and invalid resumes", () => {
    expect(normalizeGrokBuildWorkflowInput({ source: { type: "name", name: " deep-research " } })).toMatchObject({
      source: { type: "name", name: "deep-research" }, agentBudget: 128, args: null, validateOnly: false,
    });
    expect(normalizeGrokBuildWorkflowInput({ script_path: " flow.rhai ", agent_budget: 1024 }).source)
      .toEqual({ type: "script_path", scriptPath: "flow.rhai" });
    expect(() => normalizeGrokBuildWorkflowInput({ name: "a", script: "b" })).toThrow("mutually exclusive");
    expect(() => normalizeGrokBuildWorkflowInput({ source: { type: "name", name: "a" }, name: "a" })).toThrow("cannot be combined");
    expect(() => normalizeGrokBuildWorkflowInput({ resume_from_run_id: "wf_1", args: {} })).toThrow("original immutable");
    expect(() => normalizeGrokBuildWorkflowInput({ name: "a", agent_budget: 1025 })).toThrow("at most 1024");
  });

  it("drives asynchronous host calls through deterministic Rhai journal replay", async () => {
    const module: GrokBuildRhaiContinuationModule = {
      evaluate({ journal }) {
        if (journal.length === 0) return { type: "host_requests", requests: [
          { seq: 0, kind: "spawn_agent", requestHash: "a", payload: { prompt: "one" } },
          { seq: 1, kind: "spawn_agent", requestHash: "b", payload: { prompt: "two" } },
        ] };
        expect(journal.map((entry) => entry.requestHash)).toEqual(["a", "b"]);
        return { type: "completed", result: journal.map((entry) => entry.value) };
      },
    };
    const host: GrokBuildWorkflowHost = { call: vi.fn(async (request) => `result-${request.seq}`) };
    const engine = new GrokBuildJournalRhaiEngine(module, host);
    await expect(engine.run(workflow("panel"), {}, { agentBudget: 2, signal: new AbortController().signal }))
      .resolves.toEqual({ status: "completed", result: ["result-0", "result-1"] });
    expect(host.call).toHaveBeenCalledTimes(2);
    await expect(engine.run(workflow("panel"), {}, { agentBudget: 1, signal: new AbortController().signal }))
      .resolves.toEqual({ status: "budget_exceeded", message: "workflow agent budget exceeded: requested 2, maximum 1" });
  });

  it("executes the real bundled deep-research workflow in browser Rhai WASM", async () => {
    const wasmFile = readFileSync(new URL("../experiments/browser-agent/src/generated-rhai-wasm/grok_workflow_rhai_wasm_bg.wasm", import.meta.url));
    const wasmBytes = wasmFile.buffer.slice(wasmFile.byteOffset, wasmFile.byteOffset + wasmFile.byteLength) as ArrayBuffer;
    const module = loadGrokBuildRhaiWasmSync(wasmBytes);
    const host: GrokBuildWorkflowHost = { call: vi.fn(async () => { throw new Error("the no-args path must pause before host calls"); }) };
    const engine = new GrokBuildJournalRhaiEngine(module, host);

    await expect(engine.run(deepResearchWorkflow, null, { agentBudget: 128, signal: new AbortController().signal }))
      .resolves.toEqual({
        status: "paused",
        kind: "verification",
        message: "No research query was provided. Run /deep-research <query>, or pass args.query.",
      });
    expect(host.call).not.toHaveBeenCalled();

    await expect(engine.validate(deepResearchWorkflow, { query: "browser Rhai", breadth: 2 }, {
      agentBudget: 128,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      name: "deep-research",
      phases: 4,
      outcomeSummary: expect.stringContaining("completed:"),
    });

    const agentScript = 'let meta = #{ name: "wasm-agent", description: "real wasm host replay" }; let r = agent("inspect"); complete(r.output);';
    const agentHost: GrokBuildWorkflowHost = { call: vi.fn(async () => ({ output: "WASM replay complete" })) };
    const agentEngine = new GrokBuildJournalRhaiEngine(module, agentHost);
    await expect(agentEngine.run(agentScript, {}, { agentBudget: 1, signal: new AbortController().signal }))
      .resolves.toEqual({ status: "completed", result: "WASM replay complete" });
    expect(agentHost.call).toHaveBeenCalledTimes(1);
  });

  it("validates with the native canned host and launches background runs with editable projections", async () => {
    const vfs = new VirtualFS();
    write(vfs, "/.grok/bundled/workflows/review.rhai", workflow("review", "Review code"));
    let finish!: (value: { status: "completed"; result: unknown }) => void;
    const pending = new Promise<{ status: "completed"; result: unknown }>((resolve) => { finish = resolve; });
    const engine: GrokBuildWorkflowEngine = {
      async validate(script) {
        const meta = extractGrokBuildWorkflowMeta(script);
        return { name: meta.name, phases: meta.phases.length, outcomeSummary: "completed: null" };
      },
      async run() { return pending; },
    };
    const event = vi.fn();
    const manager = new GrokBuildBrowserWorkflowManager(vfs, engine, { onRunEvent: event });
    const signal = new AbortController().signal;

    const validated = JSON.parse(await manager.run({ name: "review", validate_only: true }, signal)) as Record<string, unknown>;
    expect(validated).toMatchObject({ run_id: "", name: "review" });
    expect(validated.message).toContain("2 declared phases");

    const launched = JSON.parse(await manager.run({ name: "review", args: { target: "HEAD" } }, signal)) as {
      run_id: string; task_id: string; name: string; script_path: string;
    };
    expect(launched.run_id).toMatch(/^wf_[0-9a-f]{32}$/u);
    expect(launched.task_id).toBe(launched.run_id);
    expect(launched.name).toBe("review");
    expect(vfs.readFileSync(launched.script_path, "utf8")).toBe(workflow("review", "Review code"));
    expect(vfs.readFileSync(launched.script_path.replace("script.rhai", "args.json"), "utf8")).toBe('{"target":"HEAD"}');
    finish({ status: "completed", result: { ok: true } });
    await pending;
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(manager.outcome(launched.run_id)).toEqual({ status: "completed", result: { ok: true } });
    expect(event).toHaveBeenCalledWith(expect.objectContaining({ runId: launched.run_id, name: "review" }));
  });

  it("resumes only paused runs with the same immutable args and execution journal", async () => {
    const vfs = new VirtualFS();
    write(vfs, "/.grok/bundled/workflows/wait.rhai", workflow("wait"));
    const calls: Array<{ args: unknown; options: { executionId?: string; resume?: boolean; agentBudget: number } }> = [];
    const engine: GrokBuildWorkflowEngine = {
      async validate() { throw new Error("unused"); },
      async run(_script, args, options) {
        calls.push({ args, options });
        return calls.length === 1
          ? { status: "paused", kind: "back_off", message: "needs input" }
          : { status: "completed", result: "resumed" };
      },
    };
    const manager = new GrokBuildBrowserWorkflowManager(vfs, engine);
    const signal = new AbortController().signal;
    const first = JSON.parse(await manager.run({ name: "wait", args: { immutable: true }, agent_budget: 9 }, signal)) as { run_id: string };
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await manager.run({ resume_from_run_id: first.run_id, agent_budget: 99 }, signal);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      args: { immutable: true },
      options: { executionId: first.run_id, resume: true, agentBudget: 9 },
    });
    await expect(manager.run({ resume_from_run_id: first.run_id }, signal)).rejects.toThrow("cannot be resumed");
  });
});
