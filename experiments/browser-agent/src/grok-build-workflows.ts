// Copyright 2023-2026 SpaceXAI
// SPDX-License-Identifier: Apache-2.0
// Modified for the Vibewaiting browser port, 2026.

import type { GrokBuildWorkflowEngine, GrokBuildWorkflowOutcome } from "./grok-build-workflow-engine.js";
import {
  GrokBuildWorkflowRegistry,
  formatGrokBuildWorkflowListing,
  normalizeGrokBuildWorkflowPath,
  type GrokBuildWorkflowDefinition,
  type GrokBuildWorkflowFileSystem,
  type GrokBuildWorkflowRegistryOptions,
} from "./grok-build-workflow-registry.js";

export * from "./grok-build-workflow-engine.js";
export * from "./grok-build-workflow-registry.js";
export * from "./grok-build-workflow-host.js";

const DEFAULT_AGENT_BUDGET = 128;
const MAX_AGENT_BUDGET = 1_024;

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
  outcome?: GrokBuildWorkflowOutcome;
}

export interface GrokBuildWorkflowManagerOptions extends GrokBuildWorkflowRegistryOptions {
  runRoot?: string;
  onRunEvent?: (event: GrokBuildWorkflowRunEvent) => void;
}

export class GrokBuildBrowserWorkflowManager {
  readonly registry: GrokBuildWorkflowRegistry;
  private readonly runs = new Map<string, StoredRun>();
  private readonly displayCounts = new Map<string, number>();
  private readonly runRoot: string;

  constructor(
    private readonly vfs: GrokBuildWorkflowFileSystem,
    private readonly engine: GrokBuildWorkflowEngine,
    private readonly options: GrokBuildWorkflowManagerOptions = {},
  ) {
    this.registry = new GrokBuildWorkflowRegistry(vfs, options);
    this.runRoot = normalizeGrokBuildWorkflowPath(options.runRoot ?? "/.grok/workflow-runs");
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
      if (!prior.outcome || (prior.outcome.status !== "paused" && prior.outcome.status !== "budget_exceeded")) {
        throw new Error("workflow run is not paused or budget-limited and cannot be resumed");
      }
      if (prior.outcome.status === "budget_exceeded" && (!normalized.agentBudgetExplicit || normalized.agentBudget <= prior.agentBudget)) {
        throw new Error(`budget-limited workflow resume requires an agent_budget above ${prior.agentBudget}`);
      }
      if (prior.outcome.status === "paused") normalized.agentBudget = prior.agentBudget;
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

    const runId = prior?.runId ?? `wf_${crypto.randomUUID().replaceAll("-", "")}`;
    const count = (this.displayCounts.get(definition.meta.name) ?? 0) + 1;
    this.displayCounts.set(definition.meta.name, count);
    const name = prior?.name ?? (count === 1 ? definition.meta.name : `${definition.meta.name}-${count}`);
    const scriptPath = `${this.runRoot}/${runId}/script.rhai`;
    this.vfs.mkdirSync(`${this.runRoot}/${runId}`, { recursive: true });
    this.vfs.writeFileSync(scriptPath, definition.script);
    this.vfs.writeFileSync(`${this.runRoot}/${runId}/args.json`, JSON.stringify(args));
    const controller = new AbortController();
    const run: StoredRun = { runId, name, definition, args, controller, agentBudget: normalized.agentBudget };
    this.runs.set(runId, run);
    void this.engine.run(definition.script, args, {
      agentBudget: normalized.agentBudget,
      signal: AbortSignal.any([signal, controller.signal]),
      executionId: runId,
      resume: prior !== undefined,
    }).then((outcome) => {
      run.outcome = outcome;
      this.options.onRunEvent?.({ runId, name, outcome });
    }, (error: unknown) => {
      const outcome: GrokBuildWorkflowOutcome = { status: "failed", error: error instanceof Error ? error.message : String(error) };
      run.outcome = outcome;
      this.options.onRunEvent?.({ runId, name, outcome });
    });
    const iterate = ` The editable script projection is at ${scriptPath}. Edit it and launch that \`script_path\` as a new run to iterate; same-process pause resume continues only this run's original immutable source.`;
    return JSON.stringify({
      run_id: runId, task_id: runId, name, script_path: scriptPath,
      message: `Workflow '${name}' started in the background. Progress appears in /workflow runs and completion is reported automatically. '${name}' is the session-unique display handle for user-facing status and /workflow management; keep the structured run id internal.${iterate}`,
    });
  }

  stop(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    run.controller.abort();
    return true;
  }

  outcome(runId: string): GrokBuildWorkflowOutcome | undefined { return this.runs.get(runId)?.outcome; }
}

/** Creates the functional browser manager with the checked-in Rhai WASM evaluator. */
export async function createGrokBuildBrowserWorkflowManager(
  vfs: GrokBuildWorkflowFileSystem,
  host: import("./grok-build-workflow-engine.js").GrokBuildWorkflowHost,
  options: GrokBuildWorkflowManagerOptions = {},
): Promise<GrokBuildBrowserWorkflowManager> {
  const [{ loadGrokBuildRhaiWasm }, { GrokBuildJournalRhaiEngine }] = await Promise.all([
    import("./grok-build-rhai-wasm.js"),
    import("./grok-build-workflow-engine.js"),
  ]);
  const module = await loadGrokBuildRhaiWasm();
  return new GrokBuildBrowserWorkflowManager(vfs, new GrokBuildJournalRhaiEngine(module, host), options);
}
