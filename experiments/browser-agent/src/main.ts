import { createContainer, ViteDevServer } from "almostnode";
import {
  GROK_BUILD_TOOLS,
  GrokBuildSession,
  type GrokBuildEvent,
} from "./grok-build-agent.js";
import {
  GrokBuildBrowserRuntime,
  GrokConformanceToolRuntime,
  GrokRecordedToolRuntime,
  type GrokConformanceDriverProfile,
  type GrokBuildBrowserServices,
} from "./grok-build-runtime.js";
import {
  resolveSandboxOrigin,
} from "./sandbox-protocol.js";
import { BrowserSandboxBridge } from "./browser-sandbox-bridge.js";
import { THREE_MODULE_ASSET_PATH } from "../sandbox-service-worker-hardening.js";
import { BrowserGrokAuthController } from "./browser-grok-auth.js";
import {
  autosaveBrowserProject,
  clearBrowserAgentSession,
  clearBrowserProject,
  clearVirtualFileSystem,
  loadBrowserProject,
  loadBrowserAgentSession,
  requestPersistentBrowserStorage,
  restoreBrowserProject,
  saveBrowserAgentSession,
  saveBrowserProject,
  type BrowserProjectAutosave,
} from "./browser-project-store.js";
import {
  GROK_COMPACTION_INDEX_HEADER,
  countGrokCompactionTurns,
  extractGrokCompactionKeywords,
  grokCompactionSegmentFilename,
  renderGrokCompactionIndexRow,
  renderGrokCompactionSegment,
} from "./grok-build-compaction-store.js";
import { GrokBuildWebFetchClient } from "./grok-build-web-fetch.js";
import { GrokBuildMediaClient } from "./grok-build-media.js";
import {
  GrokBuildStartupCoordinator,
  type GrokBuildStartupProfile,
} from "./grok-build-bootstrap.js";
import { syncGrokBuildBundle } from "./grok-build-bundle.js";
import {
  createGrokBuildSkillReminder,
  discoverGrokBuildSkills,
  formatGrokBuildSkillListing,
} from "./grok-build-skills.js";
import { GrokBuildSkillManager } from "./grok-build-skill-manager.js";
import { askGrokUserQuestions } from "./grok-build-question-dialog.js";
import { approveGrokPlanEntry, approveGrokPlanExit } from "./grok-build-plan-dialog.js";
import { createGrokBuildMcpServices } from "./grok-build-mcp.js";
import {
  createGrokBuildBrowserWorkflowManager,
  GrokBuildBrowserWorkflowHost,
  mergeGrokBuildExtensionListings,
  type GrokBuildBrowserWorkflowManager,
  type GrokBuildWorkflowOutcome,
} from "./grok-build-workflows.js";
import deepResearchWorkflow from "./builtin-workflows/deep-research.rhai?raw";
import { GrokBuildTelemetryLifecycle } from "./grok-build-telemetry.js";
import { createGrokBuildMcpOtlpTraceSink, GrokBuildBrowserOtlpTracer } from "./grok-build-otlp-trace.js";
import { GrokBuildBrowserSubagentRunner } from "./grok-build-subagent-runner.js";
import {
  GrokBuildLivePromptCoordinator,
} from "./grok-build-prompt-queue.js";
import { missingBrowserAgentCapabilities } from "./browser-capabilities.js";

const VIRTUAL_PORT = 4176;
const THREE_VERSION = "0.180.0";

const runtimeStatus = document.querySelector<HTMLElement>("#runtime-status")!;
const runtimeDot = document.querySelector<HTMLElement>(".runtime-dot")!;
const authStatus = document.querySelector<HTMLElement>("#auth-status")!;
const connectGrokButton = document.querySelector<HTMLButtonElement>("#connect-grok")!;
const disconnectGrokButton = document.querySelector<HTMLButtonElement>("#disconnect-grok")!;
const deviceAuth = document.querySelector<HTMLElement>("#device-auth")!;
const deviceCode = document.querySelector<HTMLElement>("#device-code")!;
const deviceLink = document.querySelector<HTMLAnchorElement>("#device-link")!;
const relayEndpoint = document.querySelector<HTMLInputElement>("#relay-endpoint")!;
const taskInput = document.querySelector<HTMLTextAreaElement>("#task")!;
const runButton = document.querySelector<HTMLButtonElement>("#run")!;
const stopButton = document.querySelector<HTMLButtonElement>("#stop")!;
const resetButton = document.querySelector<HTMLButtonElement>("#reset")!;
const agentState = document.querySelector<HTMLElement>("#agent-state")!;
const turnCount = document.querySelector<HTMLElement>("#turn-count")!;
const hmrCount = document.querySelector<HTMLElement>("#hmr-count")!;
const iframeLoads = document.querySelector<HTMLElement>("#iframe-loads")!;
const trajectory = document.querySelector<HTMLOListElement>("#trajectory")!;
const preview = document.querySelector<HTMLIFrameElement>("#preview")!;
const previewUrl = document.querySelector<HTMLElement>("#preview-url")!;
const renderedRevision = document.querySelector<HTMLElement>("#rendered-revision")!;
const sandboxMode = document.querySelector<HTMLElement>("#sandbox-mode")!;

const missingCapabilities = missingBrowserAgentCapabilities(globalThis);
if (missingCapabilities.length > 0) {
  runtimeStatus.textContent = "Browser runtime unsupported";
  runtimeDot.classList.add("failed");
  authStatus.textContent = `Missing: ${missingCapabilities.join(", ")}`;
  runButton.disabled = true;
  resetButton.disabled = true;
  connectGrokButton.disabled = true;
  throw new Error(`This browser cannot run the Grok sandbox: ${missingCapabilities.join(", ")}`);
}

const container = createContainer();
const server = new ViteDevServer(container.vfs, { port: VIRTUAL_PORT, root: "/" });
const bridge = container.serverBridge;
const webFetchClient = new GrokBuildWebFetchClient(container.vfs);
const rootOtlpTracer = new GrokBuildBrowserOtlpTracer();
const mcpRuntime = createGrokBuildMcpServices([], {
  enabledNativeToolNames: new Set<string>(GROK_BUILD_TOOLS.flatMap((tool): string[] =>
    tool.type === "function" && "name" in tool && typeof tool.name === "string" ? [tool.name] : [tool.type])),
  traceSink: createGrokBuildMcpOtlpTraceSink(rootOtlpTracer),
});
let workflowManager: GrokBuildBrowserWorkflowManager | undefined;
const workflowCompletionReminders: string[] = [];

let activeRun: AbortController | undefined;
let hmrEvents = 0;
let iframeLoadCount = 0;
let runtimeReady = false;
let authReady = false;
const conformanceOrigin = new URLSearchParams(location.search).get("conformance");
const startupCoordinator = new GrokBuildStartupCoordinator({
  tools: GROK_BUILD_TOOLS,
  ...(conformanceOrigin ? {
    storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
  } : {}),
});
let conformanceProfile: GrokConformanceDriverProfile | undefined;
let projectAutosave: BrowserProjectAutosave | undefined;
let agentSessionPersistenceGeneration = 0;
let restoredAgentSession: import("./grok-build-agent.js").GrokBuildSessionSnapshot | undefined;
let agentSession: GrokBuildSession | undefined;
let telemetryLifecycle: GrokBuildTelemetryLifecycle | undefined;
let liveStartupProfile: GrokBuildStartupProfile | undefined;
let bundleSync: Promise<void> | undefined;
const mediaClient = new GrokBuildMediaClient(container.vfs, (input, init) => fetch(input, init), () => agentSession?.snapshot().sessionId);
let conformanceRuntime: GrokConformanceToolRuntime | undefined;
let recordedRuntime: GrokRecordedToolRuntime | undefined;
let rootBrowserRuntime: GrokBuildBrowserRuntime | undefined;
let rootSkillManager: GrokBuildSkillManager | undefined;
const agentIdleWaiters = new Set<() => void>();
const livePrompts = new GrokBuildLivePromptCoordinator();
let scheduledForegroundQueue: Promise<void> = Promise.resolve();
let subagentRunner: GrokBuildBrowserSubagentRunner;
const configuredSandboxOrigin = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_SANDBOX_ORIGIN;
const sandboxOrigin = resolveSandboxOrigin(location, configuredSandboxOrigin);
const sandboxNonce = crypto.randomUUID();
const sandboxBridge = new BrowserSandboxBridge({
  preview,
  origin: sandboxOrigin,
  nonce: sandboxNonce,
  port: VIRTUAL_PORT,
  bridge,
  htmlModuleRewrites: {
    [`https://esm.sh/three@${THREE_VERSION}`]: THREE_MODULE_ASSET_PATH,
  },
  onPreviewLoad() {
    iframeLoadCount += 1;
    iframeLoads.textContent = String(iframeLoadCount);
  },
  onRendered(revision) {
    renderedRevision.textContent = `Rendered: ${revision}`;
  },
  onError(error) {
    runtimeStatus.textContent = "Browser sandbox failed";
    runtimeDot.classList.add("failed");
    eventItem("error", "Runtime failed", error.message);
  },
});

const STARTER_SOURCE = `
document.body.innerHTML = \`
  <main style="min-height:100vh;display:grid;place-items:center;background:#050713;color:#7d938f;font:600 13px system-ui">
    Browser project ready. Run the agent to build Pong.
  </main>
\`;
window.parent.postMessage({ type: "browser-agent-rendered", revision: "starter" }, "*");
if (import.meta.hot) import.meta.hot.accept();
`;

function syncRunAvailability(): void {
  runButton.disabled = Boolean(activeRun && conformanceOrigin) || !runtimeReady || (!conformanceOrigin && !authReady);
  runButton.textContent = activeRun && !conformanceOrigin ? "Send now" : "Run browser agent";
  runButton.title = activeRun && !conformanceOrigin ? "Send now; Shift-click to queue as the next turn" : "";
}

function startBundleSync(): Promise<void> {
  if (bundleSync) return bundleSync;
  if (!conformanceOrigin && !authReady) return Promise.resolve();
  bundleSync = syncGrokBuildBundle(container.vfs)
    .then((result) => {
      if (result.updated) {
        if (rootSkillManager) {
          rootSkillManager.updateStartupBaseline(discoverGrokBuildSkills(container.vfs));
          const reminder = createGrokBuildSkillReminder(rootSkillManager.startupSkills());
          if (reminder) agentSession?.enqueueSystemReminder(reminder);
        }
        projectAutosave?.schedule();
        eventItem("", "Grok bundle updated", `${result.source} · ${result.manifest?.version ?? "unknown version"}`);
      }
    })
    .catch((error) => {
      console.warn("Grok Build bundle sync failed", error);
    })
    .finally(() => { bundleSync = undefined; });
  return bundleSync;
}

function currentCompactionReminder(runtime: GrokBuildBrowserRuntime): string | undefined {
  const listing = mergeGrokBuildExtensionListings(
    formatGrokBuildSkillListing(discoverGrokBuildSkills(container.vfs)),
    workflowManager?.listing(),
  );
  const runtimeReminder = runtime.compactionSystemReminder();
  const sections: string[] = [];
  if (listing) sections.push(`## Available Skills\n${listing}`);
  if (runtimeReminder) sections.push(runtimeReminder.replace(/^<system-reminder>\n|\n<\/system-reminder>$/gu, ""));
  return sections.length ? `<system-reminder>\n${sections.join("\n\n")}\n</system-reminder>` : undefined;
}

function startupExtensionReminder(skillManager: GrokBuildSkillManager): string | undefined {
  const listing = mergeGrokBuildExtensionListings(
    formatGrokBuildSkillListing(skillManager.startupSkills()),
    workflowManager?.listing(),
  );
  return listing ? `<system-reminder>\n${listing}\n</system-reminder>` : undefined;
}

function workflowCompletionReminder(name: string, runId: string, outcome: GrokBuildWorkflowOutcome): string {
  const status = outcome.status === "budget_exceeded" ? "budget-limited" : outcome.status;
  const detail = outcome.status === "completed" ? JSON.stringify(outcome.result)
    : outcome.status === "failed" ? outcome.error
      : "message" in outcome ? outcome.message : undefined;
  return `<system-reminder>\nWhile you were idle, 1 background workflow run stopped (finished or paused):\n\n- Workflow '${name}' (run id ${runId}) — status: ${status}${detail ? `\n  ${outcome.status === "completed" ? "Result" : "Detail"}: ${detail}` : ""}\n</system-reminder>`;
}

const authController = new BrowserGrokAuthController({
  elements: {
    status: authStatus,
    connectButton: connectGrokButton,
    disconnectButton: disconnectGrokButton,
    devicePanel: deviceAuth,
    deviceCode,
    deviceLink,
  },
  onReadyChange(ready) {
    authReady = ready;
    syncRunAvailability();
  },
  onAuthenticated() {
    if (runtimeReady) startBundleSync();
    void startupCoordinator.refreshAfterAuth().then((profile) => { liveStartupProfile = profile; }).catch(() => undefined);
  },
});

function seedProject(profile?: GrokConformanceDriverProfile): void {
  if (profile?.initialFiles?.length) {
    for (const file of profile.initialFiles) {
      const path = file.path.startsWith("/") ? file.path : `/${file.path}`;
      const separator = path.lastIndexOf("/");
      if (separator > 0) container.vfs.mkdirSync(path.slice(0, separator), { recursive: true });
      container.vfs.writeFileSync(path, file.content);
    }
    return;
  }
  const nativePongFixture = profile?.fixture === "three-pong-starter-v1";
  container.vfs.mkdirSync("/src", { recursive: true });
  container.vfs.writeFileSync(
    "/package.json",
    JSON.stringify(
      nativePongFixture ? {
        name: "native-browser-grok-pong-fixture",
        private: true,
        type: "module",
        scripts: { check: "node --check src/main.js" },
      } : {
        name: "browser-grok-build-project",
        private: true,
        type: "module",
        scripts: { dev: "vite" },
        dependencies: { three: THREE_VERSION },
      },
      null,
      2,
    ) + (nativePongFixture ? "\n" : ""),
  );
  container.vfs.writeFileSync(
    "/index.html",
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${nativePongFixture ? "Conformance Pong Fixture" : "Browser Agent Project"}</title>
    <script type="importmap">{"imports":{"three":"https://esm.sh/three@${THREE_VERSION}"}}</script>
  </head>
  <body><script type="module" src="/src/main.js"></script></body>
</html>${nativePongFixture ? "\n" : ""}`,
  );
  container.vfs.writeFileSync("/src/main.js", nativePongFixture
    ? `document.body.innerHTML = "<main>Replace this starter with the requested game.</main>";\n\nwindow.parent?.postMessage({ type: "browser-agent-rendered", revision: "starter" }, "*");\n\nif (import.meta.hot) import.meta.hot.accept();\n`
    : STARTER_SOURCE);
}

function eventItem(kind: string, label: string, body: string, output?: string): void {
  const item = document.createElement("li");
  item.className = `event ${kind}`;
  const heading = document.createElement("div");
  heading.className = "label";
  heading.textContent = label;
  const paragraph = document.createElement("p");
  paragraph.textContent = body;
  item.append(heading, paragraph);
  if (output) {
    const pre = document.createElement("pre");
    pre.textContent = output;
    item.append(pre);
  }
  trajectory.append(item);
  trajectory.scrollTop = trajectory.scrollHeight;
}

function eventHandler(event: GrokBuildEvent): void {
  telemetryLifecycle?.record(event, agentSession?.snapshot().requestId);
  switch (event.type) {
    case "run_start":
      eventItem("", "Task", event.task);
      break;
    case "turn_start":
      turnCount.textContent = String(event.turn);
      agentState.textContent = "Thinking";
      break;
    case "assistant":
      eventItem("", `Grok · turn ${event.turn}`, event.text || event.reasoning || "Calling tools.");
      break;
    case "response_end":
      break;
    case "tool_start":
      agentState.textContent = `Running ${event.call.name}`;
      eventItem("command", event.call.name, event.call.arguments);
      break;
    case "tool_end": {
      eventItem(
        event.result.isError ? "error" : "",
        event.result.isError ? "Tool error" : "Tool complete",
        event.call.name,
        (event.result.output || "(no output)").slice(0, 4_000),
      );
      break;
    }
    case "retry":
      eventItem("error", `Retrying ${event.kind}`, `Attempt ${event.attempt}/${event.maxRetries} after ${event.delayMs}ms${event.status ? ` · HTTP ${event.status}` : ""}`);
      break;
    case "compaction_start":
      agentState.textContent = "Compacting context";
      eventItem("", "Compacting context", `${event.tokens.toLocaleString()} / ${event.contextWindow.toLocaleString()} estimated tokens`);
      break;
    case "compaction_end":
      eventItem("", "Context compacted", `${event.tokens.toLocaleString()} estimated tokens remain`);
      break;
    case "complete":
      agentState.textContent = "Complete";
      eventItem("", "Complete", event.text || "Grok completed the task.");
      break;
    case "limit":
      agentState.textContent = "Stopped";
      eventItem("error", "Limit reached", `${event.turns} Grok turns completed.`);
      break;
  }
}

const browserServices: GrokBuildBrowserServices = {
  spawnSubagent: runBrowserSubagent,
  searchTools: mcpRuntime.services.searchTools,
  useTool: mcpRuntime.services.useTool,
  askUser: (questions, signal, context) => askGrokUserQuestions(questions, signal, context),
  webFetch: (url, signal) => webFetchClient.fetch(url, signal),
  generateImage: (input, signal) => mediaClient.generateImage(input, signal),
  editImage: (input, signal) => mediaClient.editImage(input, signal),
  imageToVideo: (input, signal) => mediaClient.imageToVideo(input, signal),
  referenceToVideo: (input, signal) => mediaClient.referenceToVideo(input, signal),
  runScheduledForeground,
  onScheduledTaskEvent(event) {
    if (event.type === "created") {
      eventItem("", "Scheduled task", `${event.taskId} · ${event.humanSchedule} · next ${event.nextFireAt}`);
    } else if (event.type === "fired") {
      eventItem("command", "Scheduled task fired", `${event.taskId} · ${event.humanSchedule}${event.subagentId ? ` · subagent ${event.subagentId}` : " · foreground"}`);
    } else {
      eventItem("", "Scheduled task removed", `${event.taskId} · ${event.reason}`);
    }
  },
  approvePlanModeEntry: (signal) => approveGrokPlanEntry(signal),
  approvePlanModeExit: (plan, signal) => approveGrokPlanExit(plan, signal),
  onMonitorEvent: (reminder) => eventItem("command", "Monitor event", reminder),
};
subagentRunner = new GrokBuildBrowserSubagentRunner({
  container,
  services: browserServices,
  endpoint: () => relayEndpoint.value.trim() || "/api/grok/responses",
  startupModel: () => liveStartupProfile?.model,
  rootRuntime: () => rootBrowserRuntime,
  rootSkillManager: () => rootSkillManager,
  parentSnapshot: () => agentSession?.snapshot(),
});

function runScheduledForeground(prompt: string, signal: AbortSignal): Promise<string> {
  let resolveResult!: (value: string) => void;
  let rejectResult!: (reason: unknown) => void;
  const result = new Promise<string>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  scheduledForegroundQueue = scheduledForegroundQueue.then(async () => {
    try {
      await waitForAgentIdle(signal);
      signal.throwIfAborted();
      if (!agentSession) throw new Error("The main Grok session is not initialized.");
      const controller = new AbortController();
      activeRun = controller;
      for (const reminder of workflowCompletionReminders.splice(0)) agentSession.enqueueSystemReminder(reminder);
      syncRunAvailability();
      stopButton.disabled = false;
      agentState.textContent = "Running scheduled task";
      try {
        const run = await agentSession.run(prompt, AbortSignal.any([signal, controller.signal]));
        resolveResult(run.text || "Scheduled task completed.");
      } finally {
        activeRun = undefined;
        stopButton.disabled = true;
        syncRunAvailability();
        notifyAgentIdle();
      }
    } catch (error) {
      rejectResult(error);
      eventItem("error", "Scheduled task failed", error instanceof Error ? error.message : String(error));
    }
  });
  return result;
}

async function waitForAgentIdle(signal: AbortSignal): Promise<void> {
  if (!activeRun) return;
  await new Promise<void>((resolve, reject) => {
    const done = (): void => {
      signal.removeEventListener("abort", aborted);
      resolve();
    };
    const aborted = (): void => {
      agentIdleWaiters.delete(done);
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    agentIdleWaiters.add(done);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function notifyAgentIdle(): void {
  for (const resolve of agentIdleWaiters) resolve();
  agentIdleWaiters.clear();
}

function runBrowserSubagent(
  input: Record<string, unknown>,
  signal: AbortSignal,
  subagentId: string,
  parentRuntime = rootBrowserRuntime,
): Promise<string> {
  return subagentRunner.run(input, signal, subagentId, parentRuntime);
}
async function runAgent(mode: "send-now" | "queue" = "send-now"): Promise<void> {
  const submitted = taskInput.value.trim();
  if (activeRun) {
    if (conformanceOrigin || !submitted) return;
    if (mode === "queue") {
      livePrompts.queue(submitted);
      eventItem("", "Follow-up queued", submitted);
    } else {
      livePrompts.sendNow(submitted);
      eventItem("", "Message sent", submitted);
    }
    return;
  }
  trajectory.replaceChildren();
  turnCount.textContent = "0";
  agentState.textContent = "Starting";
  resetButton.disabled = true;
  stopButton.disabled = false;
  activeRun = new AbortController();
  syncRunAvailability();

  try {
    const profile = conformanceProfile ?? (conformanceOrigin ? await loadConformanceProfile(conformanceOrigin) : undefined);
    if (profile) taskInput.value = profile.task;
    if (!liveStartupProfile) {
      agentState.textContent = "Loading native Grok settings";
      liveStartupProfile = await startupCoordinator.snapshot();
    }
    if (profile?.bundleArchiveRequests) await startBundleSync();
    if (!agentSession) {
      const persistenceGeneration = agentSessionPersistenceGeneration;
      const sessionId = restoredAgentSession?.sessionId ?? crypto.randomUUID();
      telemetryLifecycle = new GrokBuildTelemetryLifecycle(sessionId, {
        model: liveStartupProfile?.model ?? "grok-4.6",
        ...(profile?.periodicSignalAssistantCounts ? { signalAssistantCheckpoints: profile.periodicSignalAssistantCounts } : {}),
        ...(!profile ? { trace: { responsesEndpoint: relayEndpoint.value.trim() || "/api/grok/responses", tracer: rootOtlpTracer } } : {}),
      });
      telemetryLifecycle.start();
      const skillManager = new GrokBuildSkillManager(container.vfs, "/");
      rootSkillManager = skillManager;
      const browserRuntime = new GrokBuildBrowserRuntime(container, "/", {
        ...browserServices,
        suggestSkillPath: (path) => skillManager.suggestSkillPath(path),
      });
      rootBrowserRuntime = browserRuntime;
      const startupSkillReminder = startupExtensionReminder(skillManager);
      conformanceRuntime = profile?.initialFiles?.length || profile?.fixture === "three-pong-starter-v1"
        ? new GrokConformanceToolRuntime(browserRuntime, profile.toolResults, profile.nativeWorkspacePath, "/", profile.asynchronousReminders)
        : undefined;
      recordedRuntime = profile && !conformanceRuntime
        ? new GrokRecordedToolRuntime(profile.toolResults)
        : undefined;
      agentSession = new GrokBuildSession({
        endpoint: relayEndpoint.value.trim() || "/api/grok/responses",
        environment: {
          os: `${navigator.platform || "Browser"} (browser sandbox)`,
          shell: "/bin/sh",
          workspacePath: "/",
          today: new Date().toISOString().slice(0, 10),
          ...(profile ? { startupItems: profile.startupItems } : {}),
          ...(!profile && startupSkillReminder ? { startupReminders: [startupSkillReminder] } : {}),
          workspaceRules: [{
            path: "/AGENTS.md",
            content: "The project runs in a browser-hosted virtual filesystem. The Vite preview is already active and reflects file changes through HMR. Three.js is available through the import map in index.html.",
          }],
        },
        runtime: conformanceRuntime ?? recordedRuntime ?? browserRuntime,
        sessionId,
        tools: profile?.tools ?? liveStartupProfile?.tools ?? GROK_BUILD_TOOLS,
        maxTurns: profile?.foregroundRequests ?? 100,
        ...(!profile && liveStartupProfile ? {
          model: liveStartupProfile.model,
          contextWindow: liveStartupProfile.contextWindow,
          autoCompactThresholdPercent: liveStartupProfile.autoCompactThresholdPercent,
          reasoningEffort: liveStartupProfile.reasoningEffort,
          ...(liveStartupProfile.maxCompactions !== undefined
            ? { maxCompactions: liveStartupProfile.maxCompactions }
            : {}),
        } : {}),
        ...(profile?.autoCompactThresholdPercent !== undefined ? { autoCompactThresholdPercent: profile.autoCompactThresholdPercent } : {}),
        ...(profile?.compactionTranscriptHint ? { compactionTranscriptHint: profile.compactionTranscriptHint } : {}),
        ...(profile?.compactionSystemReminder ? { compactionSystemReminder: profile.compactionSystemReminder } : {}),
        ...(!profile ? { getCompactionSystemReminder: () => currentCompactionReminder(browserRuntime) } : {}),
        ...(!profile ? { onCompaction: () => skillManager.onCompaction() } : {}),
        ...(!profile ? { getPostToolSystemReminder: (call, result) => skillManager.afterToolCall(call, result) } : {}),
        drainSystemReminders: (phase) => profile
          ? conformanceRuntime?.drainSystemReminders(phase) ?? []
          : [
              ...browserRuntime.drainSystemReminders(),
              ...workflowCompletionReminders.splice(0),
              ...livePrompts.drainInterjections().map((entry) => entry.text),
            ],
        persistCompactionSegment(segment) {
          const directory = segment.location;
          container.vfs.mkdirSync(directory, { recursive: true });
          const markdown = renderGrokCompactionSegment(segment);
          container.vfs.writeFileSync(`${directory}/${grokCompactionSegmentFilename(segment.index)}`, markdown);
          const indexPath = `${directory}/INDEX.md`;
          const index = container.vfs.existsSync(indexPath)
            ? container.vfs.readFileSync(indexPath, "utf8")
            : GROK_COMPACTION_INDEX_HEADER;
          const row = renderGrokCompactionIndexRow(
            segment.index,
            countGrokCompactionTurns(segment.items),
            new TextEncoder().encode(markdown).length,
            extractGrokCompactionKeywords(segment.summary),
          );
          container.vfs.writeFileSync(indexPath, index + row);
          projectAutosave?.schedule();
        },
        ...(profile?.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
        enableTurnSummary: profile ? (profile.turnSummaryRequests ?? 0) > 0 : true,
        beforeTurnSummary: () => telemetryLifecycle?.flush(),
        strictSideCalls: Boolean(profile),
        onEvent: eventHandler,
        ...(!profile && restoredAgentSession ? { restore: restoredAgentSession } : {}),
        ...(!profile ? {
          onCheckpoint: (snapshot: import("./grok-build-agent.js").GrokBuildSessionSnapshot) => {
            if (persistenceGeneration !== agentSessionPersistenceGeneration) return;
            restoredAgentSession = snapshot;
            void saveBrowserAgentSession(snapshot).catch((error) => {
              eventItem("error", "Session save failed", error instanceof Error ? error.message : String(error));
            });
          },
        } : {}),
      });
      if (!profile && restoredAgentSession) {
        const resumedPlanTurn = await browserRuntime.resumePendingPlanApproval(activeRun.signal);
        if (resumedPlanTurn) agentSession.enqueueSystemReminder(resumedPlanTurn);
      }
    }
    await telemetryLifecycle?.ready();
    let nextPrompt = submitted;
    let result: Awaited<ReturnType<GrokBuildSession["run"]>>;
    while (true) {
      result = await agentSession.run(nextPrompt, activeRun.signal);
      while (profile && conformanceRuntime?.hasPendingAutoWake()) {
        await telemetryLifecycle?.flush();
        telemetryLifecycle?.ensureLongPauses(profile.nativeLongPausesCount ?? 0);
        result = await agentSession.resume(activeRun.signal);
      }
      if (profile || !livePrompts.hasQueued()) break;
      nextPrompt = livePrompts.takeQueuedPrefix() ?? "";
      if (!nextPrompt) break;
    }
    if (result.status === "limit") agentState.textContent = "Stopped";
    if (profile) {
      await telemetryLifecycle?.flush();
      await telemetryLifecycle?.sync(true).catch(() => undefined);
      await telemetryLifecycle?.shutdown({ finalSync: false });
      (conformanceRuntime ?? recordedRuntime)?.assertComplete();
      const assertion = await fetch(`${conformanceOrigin}/__conformance__/assert-control-plane-complete`);
      if (!assertion.ok) throw new Error(await assertion.text());
      agentState.textContent = "Complete";
      const sideCalls = profile.modelRequests - profile.foregroundRequests;
      eventItem("", "Conformance", `${profile.modelRequests} native model requests matched with zero drift (${profile.foregroundRequests} foreground + ${sideCalls} side calls); ${profile.toolResults.length} browser tool outputs matched native output exactly.`);
    }
  } catch (error) {
    const aborted = activeRun.signal.aborted;
    telemetryLifecycle?.end(aborted ? "cancelled" : "error", agentSession?.snapshot().requestId);
    agentState.textContent = aborted ? "Stopped" : "Failed";
    eventItem("error", aborted ? "Stopped" : "Run failed", aborted ? "The run was cancelled." : error instanceof Error ? error.message : String(error));
  } finally {
    activeRun = undefined;
    notifyAgentIdle();
    syncRunAvailability();
    resetButton.disabled = false;
    stopButton.disabled = true;
  }
}

async function loadConformanceProfile(origin: string): Promise<GrokConformanceDriverProfile> {
  const response = await fetch(`${origin.replace(/\/$/u, "")}/__conformance__/driver-profile`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load the conformance driver profile: HTTP ${response.status}`);
  return response.json() as Promise<GrokConformanceDriverProfile>;
}

async function resetProject(): Promise<void> {
  activeRun?.abort();
  agentSessionPersistenceGeneration += 1;
  await telemetryLifecycle?.shutdown();
  telemetryLifecycle = undefined;
  agentSession = undefined;
  void startupCoordinator.refreshForNewSession().then((profile) => { liveStartupProfile = profile; }).catch(() => undefined);
  restoredAgentSession = undefined;
  conformanceRuntime = undefined;
  recordedRuntime = undefined;
  rootBrowserRuntime = undefined;
  rootSkillManager = undefined;
  livePrompts.clear();
  clearVirtualFileSystem(container.vfs, "/", ["/.grok/bundled"]);
  seedProject(conformanceProfile);
  if (!conformanceOrigin) {
    await clearBrowserAgentSession();
    await clearBrowserProject();
    await saveBrowserProject(container.vfs);
    await projectAutosave?.flush();
  }
  trajectory.replaceChildren();
  turnCount.textContent = "0";
  agentState.textContent = "Idle";
  renderedRevision.textContent = "Starter project restored";
}

runButton.addEventListener("click", (event) => void runAgent(event.shiftKey ? "queue" : "send-now"));
stopButton.addEventListener("click", () => activeRun?.abort());
resetButton.addEventListener("click", () => void resetProject());
addEventListener("pagehide", () => {
  authController.destroy();
  void projectAutosave?.flush();
  if (!conformanceOrigin && agentSession) {
    void saveBrowserAgentSession(agentSession.snapshot()).catch((error) => console.warn("Final session save failed", error));
  }
  void telemetryLifecycle?.shutdown();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void projectAutosave?.flush();
});
connectGrokButton.addEventListener("click", () => void authController.startDeviceAuth());
disconnectGrokButton.addEventListener("click", () => void authController.disconnect());

server.on("hmr-update", () => {
  hmrEvents += 1;
  hmrCount.textContent = String(hmrEvents);
});

async function start(): Promise<void> {
  try {
    runtimeStatus.textContent = "Preparing browser project…";
    sandboxMode.textContent = `Isolated sandbox · ${new URL(sandboxOrigin).host}`;
    if (conformanceOrigin) {
      conformanceProfile = await loadConformanceProfile(conformanceOrigin);
      taskInput.value = conformanceProfile.task;
    }
    if (conformanceProfile) {
      seedProject(conformanceProfile);
    } else {
      const reportRecovery = (message: string): void => eventItem("", "Storage recovery", message);
      try {
        const saved = await loadBrowserProject(reportRecovery);
        if (saved) restoreBrowserProject(container.vfs, saved);
        else seedProject();
      } catch (error) {
        eventItem("error", "Project restore failed", error instanceof Error ? error.message : String(error));
        await clearBrowserProject().catch(() => undefined);
        seedProject();
      }
      try {
        restoredAgentSession = await loadBrowserAgentSession(reportRecovery);
      } catch (error) {
        eventItem("error", "Session restore failed", error instanceof Error ? error.message : String(error));
        await clearBrowserAgentSession().catch(() => undefined);
        restoredAgentSession = undefined;
      }
      projectAutosave = autosaveBrowserProject(container.vfs, (error) => {
        eventItem("error", "Project save failed", error instanceof Error ? error.message : String(error));
      });
      projectAutosave.schedule();
      void requestPersistentBrowserStorage().then((status) => {
        if (!status.persisted) console.warn("Browser project storage may be evicted under storage pressure.");
        if (status.usage !== undefined && status.quota !== undefined && status.quota > 0 && status.usage / status.quota >= 0.8) {
          eventItem("error", "Storage pressure", "Browser storage is over 80% of its available quota; project saves may fail.");
        }
      }).catch((error) => console.warn("Could not inspect browser storage persistence", error));
    }
    runtimeStatus.textContent = "Loading workflow registry…";
    const workflowHost = new GrokBuildBrowserWorkflowHost({
      vfs: container.vfs,
      workspacePath: "/",
      spawnSubagent: (input, signal, id) => subagentRunner.runAdmitted(input, signal, id),
      runCommand: (command, options) => container.run(command, options),
    });
    workflowManager = await createGrokBuildBrowserWorkflowManager(container.vfs, workflowHost, {
      workspacePath: "/",
      builtins: [{ script: deepResearchWorkflow, path: "/.grok/builtin/workflows/deep-research.rhai" }],
      onRunEvent(event) {
        workflowCompletionReminders.push(workflowCompletionReminder(event.name, event.runId, event.outcome));
        eventItem(event.outcome.status === "failed" ? "error" : "", `Workflow ${event.outcome.status}`, `${event.name} · ${event.runId}`);
        if (!activeRun && agentSession) {
          void runScheduledForeground(
            "A background workflow stopped. Review the workflow completion reminder, report the result to the user, and take any appropriate next action.",
            new AbortController().signal,
          ).catch((error) => eventItem("error", "Workflow wake failed", error instanceof Error ? error.message : String(error)));
        }
      },
    });
    browserServices.runWorkflow = (input, signal) => workflowManager!.run(input, signal);
    runtimeStatus.textContent = "Starting virtual server…";
    const httpServer = {
      listening: true,
      address: () => ({ port: VIRTUAL_PORT, address: "0.0.0.0", family: "IPv4" }),
      handleRequest: (
        method: string,
        url: string,
        headers: Record<string, string>,
        body?: unknown,
      ) => server.handleRequest(method, url, headers, body as never),
    };
    bridge.registerServer(httpServer, VIRTUAL_PORT);
    server.start();

    const url = `${sandboxOrigin}/__virtual__/${VIRTUAL_PORT}/`;
    previewUrl.textContent = url;
    preview.addEventListener("load", () => {
      if (preview.contentWindow) server.setHMRTarget(preview.contentWindow);
    });
    const bootstrap = new URL("/sandbox.html", sandboxOrigin);
    bootstrap.searchParams.set("parentOrigin", location.origin);
    bootstrap.searchParams.set("nonce", sandboxNonce);
    bootstrap.searchParams.set("port", String(VIRTUAL_PORT));
    runtimeStatus.textContent = "Connecting isolated sandbox…";
    preview.src = bootstrap.href;

    // Do not let the agent mutate files until the cross-origin bridge and the
    // starter application have both loaded. This makes the first edit a real
    // HMR update instead of racing the initial navigation on a cold browser.
    await sandboxBridge.ready;
    await sandboxBridge.initialPreviewReady;

    runtimeStatus.textContent = "Browser sandbox ready";
    runtimeDot.classList.add("ready");
    runtimeReady = true;
    if (!conformanceOrigin) void startBundleSync();
    syncRunAvailability();
    resetButton.disabled = false;
    if (conformanceOrigin) {
      runtimeStatus.textContent = "Browser sandbox ready · native replay armed";
      void runAgent();
    }
  } catch (error) {
    runtimeStatus.textContent = "Browser sandbox failed";
    runtimeDot.classList.add("failed");
    eventItem("error", "Runtime failed", error instanceof Error ? error.message : String(error));
    console.error(error);
  }
}

void authController.refreshStatus();
void start();
