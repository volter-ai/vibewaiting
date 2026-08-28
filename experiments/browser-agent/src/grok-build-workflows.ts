// Copyright 2023-2026 SpaceXAI
// SPDX-License-Identifier: Apache-2.0
// Modified for the Vibewaiting browser port, 2026.

import type {
  GrokBuildWorkflowEngine,
  GrokBuildWorkflowHost,
  GrokBuildWorkflowOutcome,
  GrokBuildWorkflowValidationReport,
} from "./grok-build-workflow-engine.js";
import {
  GrokBuildWorkflowRegistry,
  extractGrokBuildWorkflowMeta,
  formatGrokBuildWorkflowListing,
  managedGrokBuildBundledWorkflowPaths,
  normalizeGrokBuildWorkflowPath,
  type GrokBuildWorkflowDefinition,
  type GrokBuildWorkflowFileSystem,
  type GrokBuildWorkflowRegistryOptions,
} from "./grok-build-workflow-registry.js";
import { GrokBuildVfsWorkflowJournalStorage } from "./grok-build-workflow-persistence.js";

export * from "./grok-build-workflow-engine.js";
export * from "./grok-build-workflow-registry.js";
export * from "./grok-build-workflow-host.js";

const DEFAULT_AGENT_BUDGET = 128;
const MAX_AGENT_BUDGET = 1_024;
const MAX_ACTIVE_RUNS = 4;
const WORKFLOW_MANIFEST_VERSION = 4;
const MAX_RESTORED_RUNS = 128;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_ARGS_BYTES = 1024 * 1024;

type WorkflowSourceInput =
  | { type: "name"; name: string }
  | { type: "script"; script: string }
  | { type: "script_path"; scriptPath: string }
  | { type: "resume"; runId: string };

interface NormalizedWorkflowInput {
  source: WorkflowSourceInput;
  agentBudget: number;
  agentBudgetExplicit: boolean;
  args: unknown;
  validateOnly: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonblank(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }

export function normalizeGrokBuildWorkflowInput(input: Record<string, unknown>): NormalizedWorkflowInput {
  const tagged = record(input.source);
  const legacy = ["name", "script", "script_path", "resume_from_run_id"].flatMap((key) => nonblank(input[key]) ? [key] : []);
  if (tagged && legacy.length) throw new Error("`source` cannot be combined with legacy `name`, `script`, `script_path`, or `resume_from_run_id` fields");
  if (legacy.length > 1) throw new Error("workflow source fields are mutually exclusive; provide exactly one of `name`, `script`, `script_path`, or `resume_from_run_id`");
  let source: WorkflowSourceInput | undefined;
  if (tagged) {
    const type = tagged.type;
    if (type === "name" && nonblank(tagged.name)) source = { type, name: nonblank(tagged.name)! };
    else if (type === "script" && nonblank(tagged.script)) source = { type, script: tagged.script as string };
    else if (type === "script_path" && nonblank(tagged.script_path)) source = { type, scriptPath: nonblank(tagged.script_path)! };
    else if (type === "resume" && nonblank(tagged.resume_from_run_id)) source = { type, runId: nonblank(tagged.resume_from_run_id)! };
  } else if (legacy[0] === "name") source = { type: "name", name: nonblank(input.name)! };
  else if (legacy[0] === "script") source = { type: "script", script: input.script as string };
  else if (legacy[0] === "script_path") source = { type: "script_path", scriptPath: nonblank(input.script_path)! };
  else if (legacy[0] === "resume_from_run_id") source = { type: "resume", runId: nonblank(input.resume_from_run_id)! };
  if (!source) throw new Error("missing workflow source; provide `source` with exactly one of the `name`, `script`, `script_path`, or `resume` variants");
  const agentBudgetExplicit = input.agent_budget !== undefined && input.agent_budget !== null;
  const budget = agentBudgetExplicit ? input.agent_budget : DEFAULT_AGENT_BUDGET;
  if (!Number.isInteger(budget) || (budget as number) <= 0) throw new Error("`agent_budget` must be a positive integer");
  if ((budget as number) > MAX_AGENT_BUDGET) throw new Error(`\`agent_budget\` must be at most ${MAX_AGENT_BUDGET} agents`);
  const validateOnly = input.validate_only === true;
  if (source.type === "resume" && input.args !== undefined && input.args !== null) throw new Error("resume uses the original immutable source and arguments; do not provide `args`");
  if (source.type === "resume" && validateOnly) throw new Error("`validate_only` cannot be used when resuming a run");
  return { source, agentBudget: budget as number, agentBudgetExplicit, args: input.args ?? null, validateOnly };
}

export interface GrokBuildWorkflowRunEvent {
  runId: string;
  name: string;
  outcome: GrokBuildWorkflowOutcome;
}

interface StoredRun {
  runId: string;
  name: string;
  definition: GrokBuildWorkflowDefinition;
  args: unknown;
  controller: AbortController;
  agentBudget: number;
  epoch: number;
  resumable: boolean;
  terminalStatus?: "interrupted";
  outcome?: GrokBuildWorkflowOutcome;
}

interface BrowserWorkflowManifest {
  version: number;
  script_revision: number;
  state: {
    run_id: string;
    name: string;
    status: string;
    agent_budget: number;
    agents_used: number;
    pause_message?: string;
  };
  browser_outcome?: GrokBuildWorkflowOutcome;
  /** Browser-only retention of native WorkflowSource privilege across reload. */
  browser_source?: GrokBuildWorkflowDefinition["source"];
}

export interface GrokBuildWorkflowManagerOptions extends GrokBuildWorkflowRegistryOptions {
  runRoot?: string;
  onRunEvent?: (event: GrokBuildWorkflowRunEvent) => void;
}

export class GrokBuildBrowserWorkflowManager {
  readonly registry: GrokBuildWorkflowRegistry;
  private readonly runs = new Map<string, StoredRun>();
  private readonly runRoot: string;

  constructor(
    private readonly vfs: GrokBuildWorkflowFileSystem,
    private readonly engine: GrokBuildWorkflowEngine,
    private readonly options: GrokBuildWorkflowManagerOptions = {},
  ) {
    this.registry = new GrokBuildWorkflowRegistry(vfs, options);
    this.runRoot = normalizeGrokBuildWorkflowPath(options.runRoot ?? "/.grok/workflow-runs");
    this.restoreRuns();
  }

  listing(): string | undefined { return formatGrokBuildWorkflowListing(this.registry.list()); }

  async run(input: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const normalized = normalizeGrokBuildWorkflowInput(input);
    let prior: StoredRun | undefined;
    let definition: GrokBuildWorkflowDefinition;
    let args = normalized.args;
    if (normalized.source.type === "resume") {
      prior = this.runs.get(normalized.source.runId);
      if (!prior) throw new Error("no persisted script for that run id");
      if (!prior.outcome || !prior.resumable) {
        throw new Error("workflow run is not resumable and cannot be resumed");
      }
      if (prior.outcome.status === "budget_exceeded" && (!normalized.agentBudgetExplicit || normalized.agentBudget <= prior.agentBudget)) {
        throw new Error(`budget-limited workflow resume requires an agent_budget above ${prior.agentBudget}`);
      }
      if (prior.outcome.status === "budget_exceeded" && prior.agentBudget >= MAX_AGENT_BUDGET) {
        throw new Error("maximum agent budget reached; start a new run");
      }
      normalized.agentBudget = normalized.agentBudgetExplicit
        ? Math.max(prior.agentBudget, normalized.agentBudget)
        : prior.agentBudget;
      definition = prior.definition;
      args = prior.args;
    } else if (normalized.source.type === "name") definition = this.registry.resolveByName(normalized.source.name);
    else if (normalized.source.type === "script") definition = this.registry.resolveInline(normalized.source.script);
    else definition = this.registry.resolveByPath(normalized.source.scriptPath, this.runRoot);

    if (normalized.validateOnly) {
      const report = await this.engine.validate(definition.script, args, { agentBudget: normalized.agentBudget, signal });
      return JSON.stringify({
        run_id: "", task_id: "", name: report.name,
        message: `Smoke check passed for workflow '${report.name}' (${report.phases} declared phases; canned-host path ${report.outcomeSummary}). This did not launch the workflow and did not exercise every branch or live dependency. Offer a real run next.`,
      });
    }

    if ([...this.runs.values()].filter((candidate) => candidate.outcome === undefined).length >= MAX_ACTIVE_RUNS) {
      throw new Error(`session already has the maximum of ${MAX_ACTIVE_RUNS} active workflow runs`);
    }
    const runId = prior?.runId ?? `wf_${crypto.randomUUID().replaceAll("-", "")}`;
    const name = prior?.name ?? this.uniqueDisplayName(definition.meta.name);
    const scriptPath = `${this.runRoot}/${runId}/script.rhai`;
    const serializedArgs = JSON.stringify(args);
    if (new TextEncoder().encode(serializedArgs).byteLength > MAX_ARGS_BYTES) {
      throw new Error(`workflow args exceed ${MAX_ARGS_BYTES} bytes`);
    }
    this.vfs.mkdirSync(`${this.runRoot}/${runId}`, { recursive: true });
    this.vfs.writeFileSync(scriptPath, definition.script);
    this.vfs.writeFileSync(`${this.runRoot}/${runId}/args.json`, serializedArgs);
    if (!prior) {
      this.vfs.mkdirSync(`${this.runRoot}/${runId}/scripts`, { recursive: true });
      this.vfs.writeFileSync(`${this.runRoot}/${runId}/scripts/0.rhai`, definition.script);
    }
    const controller = new AbortController();
    const run: StoredRun = {
      runId, name, definition, args, controller, agentBudget: normalized.agentBudget,
      epoch: (prior?.epoch ?? 0) + 1, resumable: false,
    };
    this.runs.set(runId, run);
    try { this.persistRun(run); }
    catch (error) {
      this.runs.delete(runId);
      throw error;
    }
    const epoch = run.epoch;
    void this.engine.run(definition.script, args, {
      agentBudget: normalized.agentBudget,
      signal: AbortSignal.any([signal, controller.signal]),
      executionId: runId,
      resume: prior !== undefined,
      allowForkContext: definition.source === "builtin",
      ...(prior?.outcome?.status === "failed" ? { resumeFailureDetail: prior.outcome.error } : {}),
    }).then((outcome) => {
      if (this.runs.get(runId) !== run || run.epoch !== epoch || run.outcome?.status === "cancelled") return;
      run.outcome = outcome;
      delete run.terminalStatus;
      run.resumable = outcomeResumable(outcome);
      const reported = this.persistTerminalOutcome(run);
      this.options.onRunEvent?.({ runId, name, outcome: reported });
    }, (error: unknown) => {
      if (this.runs.get(runId) !== run || run.epoch !== epoch || run.outcome?.status === "cancelled") return;
      const outcome: GrokBuildWorkflowOutcome = { status: "failed", error: error instanceof Error ? error.message : String(error) };
      run.outcome = outcome;
      delete run.terminalStatus;
      run.resumable = true;
      const reported = this.persistTerminalOutcome(run);
      this.options.onRunEvent?.({ runId, name, outcome: reported });
    });
    const iterate = ` The editable script projection is at ${scriptPath}. Edit it and launch that \`script_path\` as a new run to iterate; pause resume continues only this run's original immutable source.`;
    return JSON.stringify({
      run_id: runId, task_id: runId, name, script_path: scriptPath,
      message: `Workflow '${name}' started in the background. Progress appears in /workflow runs and completion is reported automatically. '${name}' is the session-unique display handle for user-facing status and /workflow management; keep the structured run id internal.${iterate}`,
    });
  }

  stop(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.outcome?.status === "completed" || run.outcome?.status === "failed" || run.outcome?.status === "cancelled") return false;
    run.controller.abort();
    run.outcome = { status: "cancelled" };
    run.resumable = true;
    this.persistTerminalOutcome(run);
    this.options.onRunEvent?.({ runId, name: run.name, outcome: run.outcome });
    return true;
  }

  outcome(runId: string): GrokBuildWorkflowOutcome | undefined { return this.runs.get(runId)?.outcome; }

  private uniqueDisplayName(base: string): string {
    const names = new Set([...this.runs.values()].map((run) => run.name));
    if (!names.has(base)) return base;
    let ordinal = 2;
    while (names.has(`${base}-${ordinal}`)) ordinal += 1;
    return `${base}-${ordinal}`;
  }

  private persistRun(run: StoredRun): void {
    const status = run.terminalStatus ?? outcomeStatus(run.outcome);
    const detail = outcomeDetail(run.outcome);
    const manifest: BrowserWorkflowManifest = {
      version: WORKFLOW_MANIFEST_VERSION,
      script_revision: 0,
      state: {
        run_id: run.runId,
        name: run.name,
        status,
        agent_budget: run.agentBudget,
        agents_used: this.journalAgentCount(run.runId),
        ...(detail ? { pause_message: detail } : {}),
      },
      ...(run.outcome ? { browser_outcome: run.outcome } : {}),
      browser_source: run.definition.source,
    };
    const source = JSON.stringify(manifest);
    if (new TextEncoder().encode(source).byteLength > MAX_MANIFEST_BYTES) throw new Error(`workflow manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
    this.vfs.writeFileSync(`${this.runRoot}/${run.runId}/state.json`, source);
  }

  private persistTerminalOutcome(run: StoredRun): GrokBuildWorkflowOutcome {
    try {
      this.persistRun(run);
      return run.outcome!;
    } catch (error) {
      const interrupted: GrokBuildWorkflowOutcome = {
        status: "failed",
        error: `workflow terminal state could not be persisted: ${error instanceof Error ? error.message : String(error)}; run is interrupted`,
      };
      run.outcome = interrupted;
      run.terminalStatus = "interrupted";
      run.resumable = false;
      try { this.persistRun(run); } catch { /* The in-memory interrupted state remains authoritative. */ }
      return interrupted;
    }
  }

  private journalAgentCount(runId: string): number {
    try {
      return new GrokBuildVfsWorkflowJournalStorage(this.vfs, this.runRoot)
        .load(runId).filter((entry) => entry.kind === "spawn_agent").length;
    } catch { return 0; }
  }

  private restoreRuns(): void {
    if (!this.vfs.existsSync(this.runRoot) || !this.vfs.statSync(this.runRoot).isDirectory()) return;
    const runIds = [...this.vfs.readdirSync(this.runRoot)].filter((name) => /^wf_[a-zA-Z0-9_-]+$/u.test(name)).sort().slice(-MAX_RESTORED_RUNS);
    for (const runId of runIds) {
      const directory = `${this.runRoot}/${runId}`;
      const manifestPath = `${directory}/state.json`;
      const argsPath = `${directory}/args.json`;
      const immutablePath = `${directory}/scripts/0.rhai`;
      const scriptPath = this.vfs.existsSync(immutablePath) ? immutablePath : `${directory}/script.rhai`;
      try {
        const manifestBytes = this.vfs.readFileSync(manifestPath);
        if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) continue;
        const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)) as BrowserWorkflowManifest;
        if (manifest.state?.run_id !== runId) continue;
        const script = this.vfs.readFileSync(scriptPath, "utf8");
        const args = JSON.parse(this.vfs.readFileSync(argsPath, "utf8")) as unknown;
        const definition: GrokBuildWorkflowDefinition = {
          meta: extractGrokBuildWorkflowMeta(script), script,
          source: manifest.browser_source === "builtin" ? "builtin" : "file", path: scriptPath,
        };
        let outcome = manifest.browser_outcome ?? restoredOutcome(manifest.state.status, manifest.state.pause_message);
        if (manifest.version !== WORKFLOW_MANIFEST_VERSION || manifest.state.status === "active") {
          outcome = { status: "failed", error: manifest.version !== WORKFLOW_MANIFEST_VERSION
            ? "this workflow predates current accounting and cannot be resumed; start a new run"
            : "browser reload interrupted an active workflow; start a new run" };
        }
        const run: StoredRun = {
          runId, name: manifest.state.name, definition, args,
          controller: new AbortController(), agentBudget: manifest.state.agent_budget,
          epoch: 0,
          ...(manifest.state.status === "active" || manifest.state.status === "interrupted" || manifest.version !== WORKFLOW_MANIFEST_VERSION
            ? { terminalStatus: "interrupted" as const } : {}),
          resumable: manifest.version === WORKFLOW_MANIFEST_VERSION
            && manifest.state.status !== "active"
            && manifest.state.status !== "interrupted"
            && outcome !== undefined
            && outcomeResumable(outcome),
          ...(outcome ? { outcome } : {}),
        };
        this.runs.set(runId, run);
        if (manifest.state.status === "active" || manifest.version !== WORKFLOW_MANIFEST_VERSION) this.persistRun(run);
      } catch { /* Native restore skips malformed or incomplete run directories. */ }
    }
  }
}

function outcomeStatus(outcome: GrokBuildWorkflowOutcome | undefined): string {
  if (!outcome) return "active";
  if (outcome.status === "completed") return "complete";
  if (outcome.status === "budget_exceeded") return "budget_limited";
  if (outcome.status === "cancelled") return "cancelled";
  if (outcome.status === "failed") return "failed";
  return outcome.kind === "user" ? "user_paused"
    : outcome.kind === "back_off" ? "back_off_paused"
      : outcome.kind === "no_progress" ? "no_progress_paused"
        : outcome.kind === "infra" ? "infra_paused" : "blocked";
}

function outcomeDetail(outcome: GrokBuildWorkflowOutcome | undefined): string | undefined {
  if (outcome?.status === "failed") return outcome.error;
  if (outcome?.status === "paused" || outcome?.status === "budget_exceeded") return outcome.message;
  return;
}

function outcomeResumable(outcome: GrokBuildWorkflowOutcome): boolean {
  return outcome.status === "paused" || outcome.status === "budget_exceeded" || outcome.status === "failed" || outcome.status === "cancelled";
}

function restoredOutcome(status: string, detail?: string): GrokBuildWorkflowOutcome | undefined {
  if (status === "active") return;
  if (status === "complete") return { status: "completed", result: null };
  if (status === "cancelled") return { status: "cancelled" };
  if (status === "failed" || status === "interrupted") return { status: "failed", error: detail ?? status };
  if (status === "budget_limited") return { status: "budget_exceeded", message: detail ?? "workflow agent budget exceeded" };
  const kinds: Record<string, string> = {
    user_paused: "user", back_off_paused: "back_off", no_progress_paused: "no_progress", infra_paused: "infra", blocked: "verification",
  };
  return { status: "paused", kind: kinds[status] ?? "verification", message: detail ?? "workflow paused" };
}

class GrokBuildLazyWorkflowEngine implements GrokBuildWorkflowEngine {
  private loading: Promise<GrokBuildWorkflowEngine> | undefined;

  constructor(
    private readonly host: GrokBuildWorkflowHost,
    private readonly storage: GrokBuildVfsWorkflowJournalStorage,
  ) {}

  run(
    script: string,
    args: unknown,
    options: Parameters<GrokBuildWorkflowEngine["run"]>[2],
  ): Promise<GrokBuildWorkflowOutcome> {
    return this.engine().then((engine) => engine.run(script, args, options));
  }

  validate(
    script: string,
    args: unknown,
    options: Parameters<GrokBuildWorkflowEngine["validate"]>[2],
  ): Promise<GrokBuildWorkflowValidationReport> {
    return this.engine().then((engine) => engine.validate(script, args, options));
  }

  private engine(): Promise<GrokBuildWorkflowEngine> {
    this.loading ??= Promise.all([
      import("./grok-build-rhai-wasm.js"),
      import("./grok-build-workflow-engine.js"),
    ]).then(async ([{ loadGrokBuildRhaiWasm }, { GrokBuildJournalRhaiEngine }]) => new GrokBuildJournalRhaiEngine(
      await loadGrokBuildRhaiWasm(),
      this.host,
      this.storage,
    ));
    return this.loading;
  }
}

/** Creates the browser manager immediately and loads the 6 MiB Rhai WASM only on first workflow use. */
export async function createGrokBuildBrowserWorkflowManager(
  vfs: GrokBuildWorkflowFileSystem,
  host: GrokBuildWorkflowHost,
  options: GrokBuildWorkflowManagerOptions = {},
): Promise<GrokBuildBrowserWorkflowManager> {
  const runRoot = normalizeGrokBuildWorkflowPath(options.runRoot ?? "/.grok/workflow-runs");
  const managedBundledWorkflowPaths = options.managedBundledWorkflowPaths
    ?? await managedGrokBuildBundledWorkflowPaths(vfs);
  const storage = new GrokBuildVfsWorkflowJournalStorage(vfs, runRoot);
  return new GrokBuildBrowserWorkflowManager(
    vfs,
    new GrokBuildLazyWorkflowEngine(host, storage),
    { ...options, managedBundledWorkflowPaths },
  );
}
