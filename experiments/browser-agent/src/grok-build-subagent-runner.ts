import { createContainer } from "almostnode";
import { GROK_BUILD_TOOLS, GrokBuildSession, type GrokBuildSessionSnapshot, type GrokBuildToolRuntime } from "./grok-build-agent.js";
import { GrokBuildBrowserRuntime, type GrokBuildBrowserServices } from "./grok-build-runtime.js";
import { discoverGrokBuildAgents, renderGrokBuildAgentProjectInstructions, renderGrokBuildAgentPrompt, type GrokBuildAgentDefinition } from "./grok-build-agents.js";
import { discoverGrokBuildSubagentDefinitions, resolveGrokBuildSubagentRuntime, validateGrokBuildSubagentResume } from "./grok-build-subagent-config.js";
import { GrokBuildSubagentAdmission } from "./grok-build-subagent-admission.js";
import { GrokBuildSkillManager } from "./grok-build-skill-manager.js";
import { formatGrokBuildSkillListing } from "./grok-build-skills.js";
import { composeGrokBuildMcpCatalog, resolveGrokBuildAgentMcp } from "./grok-build-agent-mcp.js";
import { createGrokBuildMcpServices, grokBuildMcpServicesFromRegistry, type GrokBuildMcpRegistry } from "./grok-build-mcp.js";
import { projectGrokBuildMcpRuntimeConfig } from "./grok-build-mcp-config-runtime.js";
import type { GrokBuildMcpRuntimeProjectionOptions } from "./grok-build-mcp-config-runtime.js";
import {
  configureGrokBuildAgentTools,
  formatGrokBuildPreloadedSkills,
  grokBuildAgentMemory,
  GrokBuildCompletionTracker,
  GrokBuildHookedRuntime,
  runGrokBuildAgentHooks,
  toolConfigCanonicalNames,
  type GrokBuildAgentHookRunner,
} from "./grok-build-custom-agent.js";
import { createGrokBuildMcpOtlpTraceSink, GrokBuildAgentTraceProducer } from "./grok-build-otlp-trace.js";
import { GrokBuildTelemetryClient } from "./grok-build-telemetry.js";
import type { GrokBuildWorkflowSubagentResult } from "./grok-build-workflows.js";
import { GrokConformanceToolRuntime, type GrokConformanceSubagentLane } from "./grok-build-conformance-runtime.js";
import type { GrokClientMode } from "../../../src/grok-browser-protocol.js";
import type { GrokBuildStartupProfile } from "./grok-build-bootstrap.js";

type BrowserContainer = ReturnType<typeof createContainer>;

interface StoredSubagentSession {
  type: string;
  persona?: string;
  model?: string;
  cwd: string;
  snapshot: GrokBuildSessionSnapshot;
  status: "running" | "completed";
}

export interface GrokBuildBrowserSubagentRunnerOptions {
  container: BrowserContainer;
  services: GrokBuildBrowserServices;
  admission?: GrokBuildSubagentAdmission;
  telemetryClient?: GrokBuildTelemetryClient;
  endpoint(): string;
  startupProfile(): GrokBuildStartupProfile | undefined;
  clientMode(): GrokClientMode;
  rootRuntime(): GrokBuildBrowserRuntime | undefined;
  rootSkillManager(): GrokBuildSkillManager | undefined;
  parentSnapshot(): GrokBuildSessionSnapshot | undefined;
  rootMcpRegistry?(): GrokBuildMcpRegistry;
  parentMcpConfigs?(): readonly import("./grok-build-agent-mcp.js").GrokBuildAcpMcpServer[];
  parentMcpPool?(): readonly import("./grok-build-agent-mcp.js").GrokBuildAcpMcpServer[];
  projectTrusted?(): boolean;
  defaultMcpStartupTimeoutMs?(): number | undefined;
  mcpRelayFetch?: typeof fetch;
  mcpOAuth?: GrokBuildMcpRuntimeProjectionOptions["oauth"];
  traceMetadata?(): { clientName: string; clientVersion: string; serviceVersion: string; appEntrypoint: string } | undefined;
  takeConformanceLane?(): GrokConformanceSubagentLane | undefined;
}

/** Owns resumable child sessions and their native agent-definition lifecycle. */
export class GrokBuildBrowserSubagentRunner {
  private readonly admission: GrokBuildSubagentAdmission;
  private readonly telemetry: GrokBuildTelemetryClient;
  private readonly sessions = new Map<string, StoredSubagentSession>();
  private readonly pendingStarts = new Set<Promise<void>>();
  private readonly pendingStartsById = new Map<string, () => void>();
  private readonly activeRuns = new Set<Promise<GrokBuildWorkflowSubagentResult>>();
  private readonly runtimeMcpRegistries = new WeakMap<GrokBuildBrowserRuntime, GrokBuildMcpRegistry>();
  private readonly runtimeMcpConfigs = new WeakMap<GrokBuildBrowserRuntime, readonly import("./grok-build-agent-mcp.js").GrokBuildAcpMcpServer[]>();
  private readonly runtimeMcpPools = new WeakMap<GrokBuildBrowserRuntime, readonly import("./grok-build-agent-mcp.js").GrokBuildAcpMcpServer[]>();

  constructor(private readonly options: GrokBuildBrowserSubagentRunnerOptions) {
    this.admission = options.admission ?? new GrokBuildSubagentAdmission();
    this.telemetry = options.telemetryClient ?? new GrokBuildTelemetryClient({ clientMode: options.clientMode });
  }

  async waitForPendingStarts(): Promise<void> {
    await Promise.all([...this.pendingStarts]);
  }

  reserveStart(subagentId: string): void {
    if (this.pendingStartsById.has(subagentId)) return;
    let resolveStarted!: () => void;
    const startedRequest = new Promise<void>((resolve) => { resolveStarted = resolve; });
    this.pendingStarts.add(startedRequest);
    let started = false;
    this.pendingStartsById.set(subagentId, () => {
      if (started) return;
      started = true;
      resolveStarted();
      this.pendingStarts.delete(startedRequest);
      this.pendingStartsById.delete(subagentId);
    });
  }

  async waitForAll(): Promise<void> {
    await Promise.allSettled([...this.activeRuns]);
  }

  async run(
    input: Record<string, unknown>, signal: AbortSignal, subagentId: string,
    parentRuntime = this.options.rootRuntime(),
  ): Promise<GrokBuildWorkflowSubagentResult> {
    this.reserveStart(subagentId);
    const markStarted = this.pendingStartsById.get(subagentId) ?? (() => undefined);
    const execution = this.admission.run(signal, () => this.runAdmitted(
      grokBuildModelSubagentInput(input), signal, subagentId, parentRuntime, markStarted,
    ));
    this.activeRuns.add(execution);
    try {
      return await execution;
    } finally {
      markStarted();
      this.activeRuns.delete(execution);
    }
  }

  async runAdmitted(
    input: Record<string, unknown>, signal: AbortSignal, subagentId: string,
    parentRuntime?: GrokBuildBrowserRuntime,
    markStarted: () => void = () => undefined,
  ): Promise<GrokBuildWorkflowSubagentResult> {
    const { container } = this.options;
    const startupProfile = this.options.startupProfile();
    const type = typeof input.subagent_type === "string" ? input.subagent_type : "general-purpose";
    const requestedModel = typeof input.model === "string" ? input.model : undefined;
    const requestedPersona = typeof input.persona === "string" ? input.persona : undefined;
    const resumeFrom = typeof input.resume_from === "string" ? input.resume_from : undefined;
    const prior = resumeFrom ? this.sessions.get(resumeFrom) : undefined;
    const conformance = prior ? undefined : this.options.takeConformanceLane?.();
    if (resumeFrom && !prior) throw new Error(`Unknown completed subagent: ${resumeFrom}`);
    if (prior?.status !== undefined && prior.status !== "completed") throw new Error(`Subagent ${resumeFrom} is still running.`);
    if (prior) validateGrokBuildSubagentResume(type, requestedPersona, {
      subagentType: prior.type, ...(prior.persona ? { persona: prior.persona } : {}),
      ...(prior.model ? { model: prior.model } : {}), cwd: prior.cwd,
    });
    if (!prior && requestedModel && !["grok-4.5", "grok-4.6"].includes(requestedModel)) {
      throw new Error(`Unsupported subagent model: ${requestedModel}`);
    }
    const requestedCwd = typeof input.cwd === "string" ? normalizeBrowserPath(input.cwd) : "/";
    const cwd = prior && container.vfs.existsSync(prior.cwd) && container.vfs.statSync(prior.cwd).isDirectory() ? prior.cwd
      : prior ? "/" : requestedCwd;
    if (!container.vfs.existsSync(cwd) || !container.vfs.statSync(cwd).isDirectory()) throw new Error(`Subagent cwd is not a directory: ${cwd}`);
    const definition = discoverGrokBuildAgents(container.vfs, { cwd }).find((candidate) => candidate.name === type);
    if (!definition) throw new Error(`Unknown subagent type: ${type}`);
    const definitions = discoverGrokBuildSubagentDefinitions(container.vfs, { cwd });
    const runtimeConfig = resolveGrokBuildSubagentRuntime(type, definition, {
      ...(!prior && requestedModel ? { model: requestedModel } : {}),
      ...(typeof input.reasoning_effort === "string" ? { reasoningEffort: input.reasoning_effort } : {}),
      ...(requestedPersona ? { persona: requestedPersona } : {}),
      ...(typeof input.capability_mode === "string" && ["read-only", "read-write", "execute", "all"].includes(input.capability_mode)
        ? { capabilityMode: input.capability_mode as "read-only" | "read-write" | "execute" | "all" } : {}),
      ...(input.isolation === "worktree" || input.isolation === "none" ? { isolation: input.isolation } : {}),
      ...(input.fork_context === true ? { forkContext: true } : {}),
    }, definitions, container.vfs, cwd, startupProfile?.model);
    if (runtimeConfig.personaError) throw new Error(runtimeConfig.personaError);
    if (runtimeConfig.isolation === "worktree") throw new Error("Browser projects do not have a host Git worktree; use isolation=none.");
    const effectiveModel = prior?.model ?? (["grok-4.5", "grok-4.6"].includes(runtimeConfig.model ?? "")
      ? runtimeConfig.model : startupProfile?.model);
    const liveModelProfile = startupProfile?.models.find((candidate) => candidate.model === effectiveModel || candidate.id === effectiveModel)
      ?? (effectiveModel === startupProfile?.model ? startupProfile : undefined);
    const endpoint = this.options.endpoint();
    const trace = new GrokBuildAgentTraceProducer({
      sessionId: subagentId,
      modelId: effectiveModel ?? "grok-4.6",
      responsesEndpoint: endpoint,
      clientType: "Generic",
      querySource: "subagent",
      agentName: type,
      reasoningEffort: conformance?.reasoningEffort ?? "medium",
      subagentType: type,
    });

    const allowed = subagentToolNames(type, runtimeConfig.capabilityMode, definition);
    if (definition.memory) for (const name of ["read_file", "search_replace", "write"]) allowed.add(name);
    const baseTools = GROK_BUILD_TOOLS.filter((tool) => tool.type === "function"
      ? typeof tool.name === "string" && allowed.has(tool.name)
      : allowed.has(tool.type));
    const parentConfigs = parentRuntime ? this.runtimeMcpConfigs.get(parentRuntime) : undefined;
    const parentPool = parentRuntime ? this.runtimeMcpPools.get(parentRuntime) : undefined;
    const mcpResolution = resolveGrokBuildAgentMcp({
      definition: {
        mcpServers: definition.mcpServers,
        mcpInheritance: definition.mcpInheritance,
        scope: definition.source === "builtin" ? "built-in" : definition.source,
      },
      parentConfigs: parentConfigs ?? this.options.parentMcpConfigs?.() ?? [],
      parentPool: parentPool ?? this.options.parentMcpPool?.() ?? [],
      projectTrusted: this.options.projectTrusted?.() ?? true,
    });
    const mcpCatalog = composeGrokBuildMcpCatalog(mcpResolution.owned, mcpResolution.inherited);
    const defaultMcpStartupTimeoutMs = this.options.defaultMcpStartupTimeoutMs?.();
    const ownedRuntimeConfigs = mcpResolution.owned.map((server) => projectGrokBuildMcpRuntimeConfig(container.vfs, server, {
      cwd,
      sessionId: subagentId,
      ...(defaultMcpStartupTimeoutMs !== undefined ? { defaultStartupTimeoutMs: defaultMcpStartupTimeoutMs } : {}),
      ...(this.options.mcpRelayFetch ? { relayFetch: this.options.mcpRelayFetch } : {}),
      ...(this.options.mcpOAuth ? { oauth: this.options.mcpOAuth } : {}),
    }));
    const parentRegistry = parentRuntime ? this.runtimeMcpRegistries.get(parentRuntime) : undefined;
    const rootRegistry = parentRegistry ?? this.options.rootMcpRegistry?.();
    const childRegistry = rootRegistry
      ? rootRegistry.fork(
          ownedRuntimeConfigs,
          new Set((mcpResolution.inherited ?? []).map((server) => server.name)),
          new Set(mcpResolution.owned.map((server) => server.name)),
          { traceSink: createGrokBuildMcpOtlpTraceSink(trace.tracer) },
        )
      : createGrokBuildMcpServices(ownedRuntimeConfigs, { traceSink: createGrokBuildMcpOtlpTraceSink(trace.tracer) }).registry;
    const browserMcp = grokBuildMcpServicesFromRegistry(childRegistry);
    let runtime!: GrokBuildBrowserRuntime;
    let skillManager!: GrokBuildSkillManager;
    const subagentServices: GrokBuildBrowserServices = {
      ...this.options.services,
      // Child-local completions are consumed by the child turn or transferred
      // during teardown. They must not enqueue a root wake before ownership moves.
      onSystemReminderQueued: () => undefined,
      ...(mcpCatalog.length ? { searchTools: browserMcp.services.searchTools, useTool: browserMcp.services.useTool } : {}),
      spawnSubagent: (childInput, childSignal, childId) => this.run(childInput, childSignal, childId, runtime),
      suggestSkillPath: (path) => skillManager.suggestSkillPath(path),
    };
    runtime = new GrokBuildBrowserRuntime(container, cwd, subagentServices, allowed, this.options.rootRuntime());
    this.runtimeMcpRegistries.set(runtime, childRegistry);
    this.runtimeMcpConfigs.set(runtime, mcpResolution.owned);
    this.runtimeMcpPools.set(runtime, mcpCatalog);
    skillManager = new GrokBuildSkillManager(container.vfs, cwd);
    const rootSkills = this.options.rootSkillManager();
    const discoveredSkills = definition.inheritSkills && rootSkills
      ? rootSkills.startupSkills()
      : definition.discoverSkills ? skillManager.startupSkills() : [];
    const preloadedSkills = formatGrokBuildPreloadedSkills(container.vfs, definition.skills, discoveredSkills);
    const subagentSkills = discoveredSkills.filter((skill) => !preloadedSkills.paths.has(skill.path));
    const subagentSkillListing = formatGrokBuildSkillListing(subagentSkills);
    const startupSkillReminder = subagentSkillListing ? `<system-reminder>\n${subagentSkillListing}\n</system-reminder>` : undefined;
    const projectInstructionReminder = definition.agentsMd ? renderGrokBuildAgentProjectInstructions(container.vfs, cwd) : undefined;
    const memory = grokBuildAgentMemory(container.vfs, definition, cwd);
    const promptDefinition: GrokBuildAgentDefinition = {
      ...definition,
      promptBody: `${preloadedSkills.injection}${definition.promptBody ?? ""}${memory.injection}`,
    };
    const configured = configureGrokBuildAgentTools(baseTools, runtime, definition);
    const hookRunner: GrokBuildAgentHookRunner = {
      async run(command, hookOptions) {
        const controller = new AbortController();
        const timer = globalThis.setTimeout(() => controller.abort(new DOMException("Hook timed out", "TimeoutError")), hookOptions.timeoutMs);
        try { return await container.run(command, { cwd: hookOptions.cwd, signal: AbortSignal.any([hookOptions.signal, controller.signal]) }); }
        finally { globalThis.clearTimeout(timer); }
      },
    };
    const hookedRuntime = new GrokBuildHookedRuntime(configured.runtime, definition.hooks, cwd, hookRunner);
    const conformanceRuntime = conformance
      ? new GrokConformanceToolRuntime(
          hookedRuntime,
          conformance.toolResults,
          conformance.nativeWorkspacePath,
          cwd,
          [],
          conformance.unrecordedTerminalToolCallIds,
          conformance.terminalToolCallIds,
        )
      : undefined;
    const agentRuntime: GrokBuildToolRuntime = conformanceRuntime ?? hookedRuntime;
    const platform = globalThis.navigator?.platform || "Browser";
    const systemPrompt = renderGrokBuildAgentPrompt(promptDefinition, {
      ...(runtimeConfig.roleInstructions ? { roleInstructions: runtimeConfig.roleInstructions } : {}),
      ...(runtimeConfig.personaInstructions ? { personaInstructions: runtimeConfig.personaInstructions } : {}),
      osName: `${platform} (browser sandbox subagent)`,
      shellPath: "/bin/sh", workingDirectory: cwd, currentDate: new Date().toISOString().slice(0, 10),
      toolNamesByKind: subagentPromptToolKinds(allowed),
    }) ?? "";
    const baseSnapshot = prior?.snapshot ?? (input.fork_context === true ? this.options.parentSnapshot() : undefined);
    let latest = baseSnapshot ? subagentSnapshotWithSystemPrompt(baseSnapshot, systemPrompt, subagentId) : undefined;
    const completionTracker = new GrokBuildCompletionTracker(configured.canonicalToolName);
    let turns = 0;
    let toolCalls = 0;
    const session = new GrokBuildSession({
      endpoint,
      environment: {
        systemPrompt,
        os: `${platform} (browser sandbox subagent)`,
        shell: "/bin/sh",
        workspacePath: cwd,
        today: new Date().toISOString().slice(0, 10),
        ...(conformance ? { startupItems: conformance.startupItems } : {}),
        ...(startupSkillReminder || projectInstructionReminder
          ? { startupReminders: [projectInstructionReminder, startupSkillReminder].filter((value): value is string => Boolean(value)) } : {}),
      },
      runtime: agentRuntime,
      tools: conformance?.tools ?? configured.tools,
      sessionId: subagentId,
      ...(conformance ? { enableSessionTitle: conformance.enableSessionTitle } : {}),
      sessionTitleTiming: conformance?.sessionTitleTiming ?? "after-first-sample-start",
      ...(definition.discoverSkills ? { getPostToolSystemReminder: (call: Parameters<GrokBuildSkillManager["afterToolCall"]>[0], result: Parameters<GrokBuildSkillManager["afterToolCall"]>[1]) => skillManager.afterToolCall(call, result) } : {}),
      ...(definition.discoverSkills ? { onCompaction: () => skillManager.onCompaction() } : {}),
      drainSystemReminders: () => runtime.drainSystemReminders(),
      ...(effectiveModel ? { model: effectiveModel } : {}),
      clientMode: this.options.clientMode(),
      clientIdentifier: "grok-shell",
      ...(conformance?.reasoningEffort ? { reasoningEffort: conformance.reasoningEffort } : runtimeConfig.reasoningEffort && runtimeConfig.reasoningEffort !== "max"
        ? { reasoningEffort: runtimeConfig.reasoningEffort as "none" | "minimal" | "low" | "medium" | "high" | "xhigh" } : {}),
      ...(conformance?.compactionAtTokens !== undefined
        ? { compactionAtTokens: conformance.compactionAtTokens }
        : liveModelProfile?.compactionAtTokens !== undefined ? { compactionAtTokens: liveModelProfile.compactionAtTokens } : {}),
      ...(conformance?.compactionsRemaining !== undefined
        ? { compactionsRemaining: conformance.compactionsRemaining }
        : liveModelProfile?.compactionsRemaining !== undefined ? { compactionsRemaining: liveModelProfile.compactionsRemaining } : {}),
      ...(liveModelProfile?.contextWindow !== undefined ? { contextWindow: liveModelProfile.contextWindow } : {}),
      ...(liveModelProfile?.autoCompactThresholdPercent !== undefined
        ? { autoCompactThresholdPercent: liveModelProfile.autoCompactThresholdPercent }
        : startupProfile?.autoCompactThresholdPercent !== undefined
          ? { autoCompactThresholdPercent: startupProfile.autoCompactThresholdPercent }
          : {}),
      maxTurns: conformance?.foregroundRequests ?? definition.maxTurns ?? 100,
      onResponseStart(kind) {
        if (kind === "foreground") markStarted();
      },
      onEvent(event) {
        if (event.type === "tool_start") toolCalls += 1;
        completionTracker.event(event);
        trace.record(event);
      },
      ...(latest ? { restore: latest } : {}),
      onCheckpoint: (snapshot) => {
        latest = snapshot;
        this.storeSession(subagentId, type, requestedPersona, effectiveModel, cwd, snapshot, "running");
      },
    });
    if (!latest) latest = session.snapshot();
    this.storeSession(subagentId, type, requestedPersona, effectiveModel, cwd, latest, "running");
    const started = performance.now();
    try {
      await runGrokBuildAgentHooks(definition.hooks, "SessionStart", type, cwd, hookRunner, signal);
      const runTurn = async (prompt: string) => {
        turns += 1;
        const promptGate = await runGrokBuildAgentHooks(definition.hooks, "UserPromptSubmit", prompt, cwd, hookRunner, signal);
        if (promptGate.denied) throw new Error(promptGate.denied);
        return session.run(prompt, signal);
      };
      let result = await completionTracker.run(String(input.prompt ?? ""), definition.completionRequirement, signal, runTurn);
      for (let stopAttempt = 0; result.status === "complete" && stopAttempt < (definition.maxTurns ?? 100); stopAttempt += 1) {
        const stopGate = await runGrokBuildAgentHooks(definition.hooks, "SubagentStop", type, cwd, hookRunner, signal);
        if (!stopGate.denied) break;
        result = await completionTracker.run(stopGate.denied, definition.completionRequirement, signal, runTurn);
      }
      conformanceRuntime?.assertComplete();
      this.storeSession(subagentId, type, requestedPersona, effectiveModel, cwd, session.snapshot(), "completed");
      const usage = session.usage();
      return {
        childSessionId: subagentId,
        success: result.status === "complete",
        output: result.text || `Subagent ${subagentId} completed.`,
        ...(result.status === "limit" ? { error: "Subagent reached its maximum turn limit." } : {}),
        totalTokensUsed: usage.totalTokensUsed,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        toolCalls,
        turns,
        ...(usage.incomplete ? { usageIncomplete: true } : {}),
      };
    } catch (error) {
      if (signal.aborted) throw error;
      this.storeSession(subagentId, type, requestedPersona, effectiveModel, cwd, session.snapshot(), "completed");
      const usage = session.usage();
      const message = error instanceof Error ? error.message : String(error);
      return {
        childSessionId: subagentId, success: false, output: message, error: message,
        totalTokensUsed: usage.totalTokensUsed,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        toolCalls,
        turns,
        ...(usage.incomplete ? { usageIncomplete: true } : {}),
      };
    } finally {
      markStarted();
      const owner = parentRuntime ?? this.options.rootRuntime();
      if (owner && owner !== runtime) runtime.reparentBackgroundTasksTo(owner);
      void browserMcp.registry.closeAll(new AbortController().signal).catch(() => undefined);
      void this.telemetry.exportAgentTraceSpans(trace.finish(), this.options.traceMetadata?.()).catch(() => undefined);
    }
  }

  private storeSession(
    id: string, type: string, persona: string | undefined, model: string | undefined,
    cwd: string, snapshot: GrokBuildSessionSnapshot, status: StoredSubagentSession["status"],
  ): void {
    this.sessions.set(id, {
      type, ...(persona ? { persona } : {}), ...(model ? { model } : {}), cwd, snapshot, status,
    });
  }
}

/** Native ignores harness-only capability overrides in model-facing JSON. */
export function grokBuildModelSubagentInput(input: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...input };
  delete sanitized.capability_mode;
  return sanitized;
}

export function subagentToolNames(type: string, capabilityMode: string | undefined, definition: GrokBuildAgentDefinition): Set<string> {
  const read = ["read_file", "list_dir", "grep", "todo_write", "web_search", "x_search", "web_fetch", "get_command_or_subagent_output", "kill_command_or_subagent", "enter_plan_mode", "exit_plan_mode"];
  const write = ["search_replace", "write", "image_gen", "image_edit", "image_to_video", "reference_to_video"];
  const execute = ["run_terminal_command"];
  const all = [...read, ...write, ...execute, "scheduler_create", "scheduler_delete", "scheduler_list", "monitor", "search_tool", "use_tool"];
  let allowed = type === "explore" ? new Set(["read_file", "list_dir", "grep"])
    : type === "plan" ? new Set(["read_file", "list_dir", "grep", "todo_write", "web_search"])
      : new Set(all);
  if (definition.injectDefaultTools) for (const optional of optionalToolNames()) allowed.add(optional);
  const configured = toolConfigCanonicalNames(definition.toolConfig);
  if (configured) {
    const declared = new Set(configured);
    if (definition.injectDefaultTools) for (const optional of optionalToolNames()) declared.add(optional);
    allowed = new Set([...allowed].filter((name) => declared.has(name)));
  }
  if (!definition.injectDefaultTools) for (const optional of optionalToolNames()) allowed.delete(optional);
  if (definition.tools.length) {
    const kindAliases: Record<string, readonly string[]> = {
      read: ["read_file"], write: ["write"], edit: ["search_replace"], bash: execute, execute,
      glob: ["list_dir"], list: ["list_dir"], grep: ["grep"], search: ["grep"], plan: ["todo_write"],
    };
    const explicit = new Set<string>();
    const canonicalNames = canonicalSubagentToolNames();
    let unresolved = false;
    let hasAgentDirective = false;
    for (const entry of definition.tools) {
      if (/^(?:agent|task)(?:\([^)]*\))?$/iu.test(entry)) { hasAgentDirective = true; continue; }
      const canonical = canonicalNames[entry] ?? entry;
      if (allowed.has(canonical)) explicit.add(canonical);
      else if (kindAliases[entry.toLowerCase()]) for (const name of kindAliases[entry.toLowerCase()]!) if (allowed.has(name)) explicit.add(name);
      else if (!entry.startsWith("mcp__")) unresolved = true;
    }
    if (!unresolved) {
      for (const always of ["search_tool", "use_tool"]) if (allowed.has(always)) explicit.add(always);
      if (hasAgentDirective) for (const dependency of ["get_command_or_subagent_output", "kill_command_or_subagent"]) if (allowed.has(dependency)) explicit.add(dependency);
      allowed = explicit;
    }
  }
  const canonicalDenied = canonicalSubagentToolNames();
  for (const denied of definition.disallowedTools) allowed.delete(canonicalDenied[denied] ?? denied);
  const ceiling = capabilityMode === "read-only" ? new Set(read)
    : capabilityMode === "read-write" ? new Set([...read, ...write])
      : capabilityMode === "execute" ? new Set([...read, ...execute]) : undefined;
  if (ceiling) allowed = new Set([...allowed].filter((name) => ceiling.has(name)));
  return allowed;
}

function optionalToolNames(): readonly string[] {
  return ["web_search", "x_search", "web_fetch", "image_gen", "image_edit", "image_to_video", "reference_to_video", "write", "enter_plan_mode", "exit_plan_mode", "ask_user_question"];
}

function canonicalSubagentToolNames(): Record<string, string> {
  return {
    run_terminal_cmd: "run_terminal_command", get_task_output: "get_command_or_subagent_output",
    kill_task: "kill_command_or_subagent", task: "spawn_subagent",
  };
}

function subagentPromptToolKinds(allowed: ReadonlySet<string>): Record<string, string | undefined> {
  return {
    read: allowed.has("read_file") ? "read_file" : undefined,
    edit: allowed.has("search_replace") ? "search_replace" : undefined,
    execute: allowed.has("run_terminal_command") ? "run_terminal_command" : undefined,
    list: allowed.has("list_dir") ? "list_dir" : undefined,
    search: allowed.has("grep") ? "grep" : undefined,
    web_search: allowed.has("web_search") ? "web_search" : undefined,
    plan: allowed.has("todo_write") ? "todo_write" : undefined,
    background_task_action: allowed.has("get_command_or_subagent_output") ? "get_command_or_subagent_output" : undefined,
  };
}

function subagentSnapshotWithSystemPrompt(source: GrokBuildSessionSnapshot, systemPrompt: string, sessionId: string): GrokBuildSessionSnapshot {
  const snapshot = structuredClone(source);
  const system = snapshot.input.find((item) => item.type === "message" && item.role === "system");
  if (system && system.type === "message") system.content = systemPrompt;
  else snapshot.input.unshift({ type: "message", role: "system", content: systemPrompt });
  snapshot.sessionId = sessionId;
  snapshot.requestId = crypto.randomUUID();
  snapshot.promptIndex = 0;
  snapshot.titleCreated = false;
  return snapshot;
}

function normalizeBrowserPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return `/${parts.join("/")}`;
}
