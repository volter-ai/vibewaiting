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
  SANDBOX_CHANNEL,
  isSandboxEnvelope,
  resolveSandboxOrigin,
  type SandboxEnvelope,
} from "./sandbox-protocol.js";
import {
  autosaveBrowserProject,
  clearBrowserAgentSession,
  clearBrowserProject,
  clearVirtualFileSystem,
  loadBrowserProject,
  loadBrowserAgentSession,
  restoreBrowserProject,
  saveBrowserAgentSession,
  saveBrowserProject,
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
  fetchGrokBuildStartupProfile,
  type GrokBuildStartupProfile,
} from "./grok-build-bootstrap.js";
import { syncGrokBuildBundle } from "./grok-build-bundle.js";
import {
  discoverGrokBuildSkills,
  formatGrokBuildSkillListing,
} from "./grok-build-skills.js";
import { GrokBuildSkillManager } from "./grok-build-skill-manager.js";
import {
  discoverGrokBuildAgents,
  renderGrokBuildAgentPrompt,
} from "./grok-build-agents.js";
import { askGrokUserQuestions } from "./grok-build-question-dialog.js";
import { approveGrokPlanEntry, approveGrokPlanExit } from "./grok-build-plan-dialog.js";
import { createGrokBuildMcpServices } from "./grok-build-mcp.js";
import { GrokBuildSubagentAdmission } from "./grok-build-subagent-admission.js";
import {
  createGrokBuildBrowserWorkflowManager,
  GrokBuildBrowserWorkflowHost,
  mergeGrokBuildExtensionListings,
  type GrokBuildBrowserWorkflowManager,
  type GrokBuildWorkflowOutcome,
} from "./grok-build-workflows.js";
import deepResearchWorkflow from "./builtin-workflows/deep-research.rhai?raw";

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

const container = createContainer();
const server = new ViteDevServer(container.vfs, { port: VIRTUAL_PORT, root: "/" });
const bridge = container.serverBridge;
const webFetchClient = new GrokBuildWebFetchClient(container.vfs);
const mcpRuntime = createGrokBuildMcpServices([], {
  enabledNativeToolNames: new Set<string>(GROK_BUILD_TOOLS.flatMap((tool): string[] =>
    tool.type === "function" && "name" in tool && typeof tool.name === "string" ? [tool.name] : [tool.type])),
});
const subagentAdmission = new GrokBuildSubagentAdmission();
let workflowManager: GrokBuildBrowserWorkflowManager | undefined;
const workflowCompletionReminders: string[] = [];

let activeRun: AbortController | undefined;
let hmrEvents = 0;
let iframeLoadCount = 0;
let runtimeReady = false;
let authReady = false;
let cloudAuth = false;
let authPoll: number | undefined;
const conformanceOrigin = new URLSearchParams(location.search).get("conformance");
let conformanceProfile: GrokConformanceDriverProfile | undefined;
let scheduleProjectSave: (() => void) | undefined;
let restoredAgentSession: import("./grok-build-agent.js").GrokBuildSessionSnapshot | undefined;
let agentSession: GrokBuildSession | undefined;
let liveStartupProfile: GrokBuildStartupProfile | undefined;
let bundleSync: Promise<void> | undefined;
const mediaClient = new GrokBuildMediaClient(container.vfs, fetch, () => agentSession?.snapshot().sessionId);
let conformanceRuntime: GrokConformanceToolRuntime | undefined;
let recordedRuntime: GrokRecordedToolRuntime | undefined;
const agentIdleWaiters = new Set<() => void>();
let scheduledForegroundQueue: Promise<void> = Promise.resolve();
const subagentSessions = new Map<string, {
  type: string;
  snapshot: import("./grok-build-agent.js").GrokBuildSessionSnapshot;
  status: "running" | "completed";
}>();
const configuredSandboxOrigin = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_SANDBOX_ORIGIN;
const sandboxOrigin = resolveSandboxOrigin(location, configuredSandboxOrigin);
const sandboxNonce = crypto.randomUUID();
let resolveSandboxBridge!: () => void;
let rejectSandboxBridge!: (error: Error) => void;
let resolveInitialPreview!: () => void;
let rejectInitialPreview!: (error: Error) => void;
const sandboxBridgeReady = new Promise<void>((resolve, reject) => {
  resolveSandboxBridge = resolve;
  rejectSandboxBridge = reject;
});
const initialPreviewReady = new Promise<void>((resolve, reject) => {
  resolveInitialPreview = resolve;
  rejectInitialPreview = reject;
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

interface AuthStatusPayload {
  authenticated?: boolean;
  email?: string | null;
  subscriptionTier?: string | null;
  eligible?: boolean;
  error?: { message?: string } | string;
}

interface DeviceAuthPayload {
  status?: "pending" | "authenticated";
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string | null;
  intervalSeconds?: number;
  email?: string | null;
  subscriptionTier?: string | null;
  eligible?: boolean;
  error?: { message?: string } | string;
}

function syncRunAvailability(): void {
  runButton.disabled = Boolean(activeRun) || !runtimeReady || (!conformanceOrigin && !authReady);
}

function authMessage(payload: AuthStatusPayload | DeviceAuthPayload, fallback: string): string {
  if (typeof payload.error === "string") return payload.error;
  if (payload.error && typeof payload.error.message === "string") return payload.error.message;
  return fallback;
}

function showAuthenticated(payload: AuthStatusPayload | DeviceAuthPayload, local = false): void {
  authReady = local || payload.eligible !== false;
  const identity = payload.email || payload.subscriptionTier;
  authStatus.textContent = local
    ? `Local Grok Build credential${identity ? ` · ${identity}` : ""}`
    : `${payload.subscriptionTier || "Connected"}${payload.email ? ` · ${payload.email}` : ""}${payload.eligible === false ? " · subscription not eligible" : ""}`;
  connectGrokButton.hidden = true;
  disconnectGrokButton.hidden = local;
  deviceAuth.hidden = true;
  if (authPoll !== undefined) window.clearTimeout(authPoll);
  authPoll = undefined;
  syncRunAvailability();
  if (runtimeReady) startBundleSync();
}

function startBundleSync(): void {
  if (conformanceOrigin || bundleSync || !authReady) return;
  bundleSync = syncGrokBuildBundle(container.vfs)
    .then((result) => {
      if (result.updated) {
        scheduleProjectSave?.();
        eventItem("", "Grok bundle updated", `${result.source} · ${result.manifest?.version ?? "unknown version"}`);
      }
    })
    .catch((error) => {
      console.warn("Grok Build bundle sync failed", error);
    })
    .finally(() => { bundleSync = undefined; });
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

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as T;
  if (!response.ok) throw new Error(authMessage(payload as AuthStatusPayload, `HTTP ${response.status}`));
  return payload;
}

async function refreshAuthStatus(): Promise<void> {
  try {
    const cloudResponse = await fetch("/api/auth/status", { credentials: "include", cache: "no-store" });
    const cloudJson = cloudResponse.headers.get("Content-Type")?.includes("application/json") === true;
    if (cloudResponse.status !== 404 && cloudJson) {
      cloudAuth = true;
      const payload = await readJson<AuthStatusPayload>(cloudResponse);
      if (payload.authenticated) showAuthenticated(payload);
      else {
        authReady = false;
        authStatus.textContent = "Not connected";
        connectGrokButton.hidden = false;
        disconnectGrokButton.hidden = true;
        syncRunAvailability();
      }
      return;
    }
  } catch (error) {
    if (cloudAuth) {
      authReady = false;
      authStatus.textContent = error instanceof Error ? error.message : String(error);
      connectGrokButton.hidden = false;
      syncRunAvailability();
      return;
    }
  }

  try {
    const payload = await readJson<AuthStatusPayload>(await fetch("/api/grok/status", { cache: "no-store" }));
    if (payload.authenticated) showAuthenticated(payload, true);
    else throw new Error(authMessage(payload, "No local Grok Build credential"));
  } catch (error) {
    authReady = false;
    authStatus.textContent = error instanceof Error ? error.message : String(error);
    connectGrokButton.hidden = true;
    disconnectGrokButton.hidden = true;
    syncRunAvailability();
  }
}

async function pollDeviceAuth(intervalSeconds: number): Promise<void> {
  try {
    const response = await fetch("/api/auth/device/poll", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const payload = await response.json().catch(() => ({})) as DeviceAuthPayload;
    if (response.ok && payload.status === "authenticated") {
      showAuthenticated(payload);
      return;
    }
    if (response.status !== 202 && response.status !== 429) {
      throw new Error(authMessage(payload, `Sign-in polling failed with HTTP ${response.status}`));
    }
    const retryAfter = Number.parseInt(response.headers.get("Retry-After") || "", 10);
    const nextSeconds = Number.isFinite(retryAfter) ? retryAfter : payload.intervalSeconds ?? intervalSeconds;
    authPoll = window.setTimeout(() => void pollDeviceAuth(nextSeconds), Math.max(1, nextSeconds) * 1_000);
  } catch (error) {
    authStatus.textContent = error instanceof Error ? error.message : String(error);
    connectGrokButton.hidden = false;
    deviceAuth.hidden = true;
  }
}

async function startDeviceAuth(): Promise<void> {
  connectGrokButton.disabled = true;
  authStatus.textContent = "Starting xAI device sign-in…";
  try {
    const payload = await readJson<DeviceAuthPayload>(await fetch("/api/auth/device/start", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }));
    if (!payload.userCode || !payload.verificationUri) throw new Error("xAI returned an incomplete device sign-in response.");
    deviceCode.textContent = payload.userCode;
    deviceLink.href = payload.verificationUriComplete || payload.verificationUri;
    deviceAuth.hidden = false;
    authStatus.textContent = "Waiting for approval at xAI…";
    connectGrokButton.hidden = true;
    const intervalSeconds = Math.max(1, payload.intervalSeconds ?? 5);
    authPoll = window.setTimeout(() => void pollDeviceAuth(intervalSeconds), intervalSeconds * 1_000);
  } catch (error) {
    authStatus.textContent = error instanceof Error ? error.message : String(error);
    connectGrokButton.hidden = false;
  } finally {
    connectGrokButton.disabled = false;
  }
}

async function disconnectGrok(): Promise<void> {
  await readJson<AuthStatusPayload>(await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }));
  authReady = false;
  authStatus.textContent = "Not connected";
  connectGrokButton.hidden = false;
  disconnectGrokButton.hidden = true;
  syncRunAvailability();
}

function seedProject(profile?: GrokConformanceDriverProfile): void {
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

async function runBrowserSubagent(input: Record<string, unknown>, signal: AbortSignal, subagentId: string): Promise<string> {
  return subagentAdmission.run(signal, () => runAdmittedBrowserSubagent(input, signal, subagentId));
}

async function runAdmittedBrowserSubagent(input: Record<string, unknown>, signal: AbortSignal, subagentId: string): Promise<string> {
  const type = typeof input.subagent_type === "string" ? input.subagent_type : "general-purpose";
  const definition = discoverGrokBuildAgents(container.vfs).find((candidate) => candidate.name === type);
  if (!definition) throw new Error(`Unknown subagent type: ${type}`);
  const requestedModel = typeof input.model === "string" ? input.model : undefined;
  if (requestedModel && !["grok-4.5", "grok-4.6"].includes(requestedModel)) {
    throw new Error(`Unsupported subagent model: ${requestedModel}`);
  }
  const resumeFrom = typeof input.resume_from === "string" ? input.resume_from : undefined;
  const prior = resumeFrom ? subagentSessions.get(resumeFrom) : undefined;
  if (resumeFrom && !prior) throw new Error(`Unknown completed subagent: ${resumeFrom}`);
  if (prior?.status !== undefined && prior.status !== "completed") throw new Error(`Subagent ${resumeFrom} is still running.`);
  if (prior && prior.type !== type) throw new Error(`Resumed subagent type must remain ${prior.type}.`);
  const cwd = typeof input.cwd === "string" ? normalizeBrowserPath(input.cwd) : "/";
  if (!container.vfs.existsSync(cwd) || !container.vfs.statSync(cwd).isDirectory()) throw new Error(`Subagent cwd is not a directory: ${cwd}`);
  if (input.isolation === "worktree") throw new Error("Browser projects do not have a host Git worktree; use isolation=none.");

  const allowed = subagentToolNames(type, typeof input.capability_mode === "string" ? input.capability_mode : undefined);
  const tools = GROK_BUILD_TOOLS.filter((tool) => tool.type === "function"
    ? typeof tool.name === "string" && allowed.has(tool.name)
    : allowed.has(tool.type));
  const runtime = new GrokBuildBrowserRuntime(container, cwd, browserServices, allowed);
  const skillManager = new GrokBuildSkillManager(container.vfs, cwd);
  const startupSkillReminder = startupExtensionReminder(skillManager);
  let latest = prior?.snapshot;
  const session = new GrokBuildSession({
    endpoint: relayEndpoint.value.trim() || "/api/grok/responses",
    environment: {
      ...(definition.promptMode === "full" && renderGrokBuildAgentPrompt(definition)
        ? { systemPrompt: renderGrokBuildAgentPrompt(definition)! }
        : {}),
      os: `${navigator.platform || "Browser"} (browser sandbox subagent)`,
      shell: "/bin/sh",
      workspacePath: cwd,
      today: new Date().toISOString().slice(0, 10),
      ...(startupSkillReminder ? { startupReminders: [startupSkillReminder] } : {}),
    },
    runtime,
    tools,
    sessionId: subagentId,
    enableSessionTitle: false,
    getPostToolSystemReminder: (call, result) => skillManager.afterToolCall(call, result),
    drainSystemReminders: () => runtime.drainSystemReminders(),
    ...(requestedModel ?? liveStartupProfile?.model ? { model: requestedModel ?? liveStartupProfile!.model } : {}),
    ...(prior ? { restore: prior.snapshot } : {}),
    onCheckpoint(snapshot) {
      latest = snapshot;
      subagentSessions.set(subagentId, { type, snapshot, status: "running" });
    },
  });
  if (!latest) latest = session.snapshot();
  subagentSessions.set(subagentId, { type, snapshot: latest, status: "running" });
  const result = await session.run(String(input.prompt ?? ""), signal);
  subagentSessions.set(subagentId, { type, snapshot: session.snapshot(), status: "completed" });
  return result.text || `Subagent ${subagentId} completed.`;
}

function subagentToolNames(type: string, capabilityMode?: string): Set<string> {
  const read = ["read_file", "list_dir", "grep", "search_tool", "use_tool"];
  const write = ["search_replace", "write", "todo_write"];
  const execute = ["run_terminal_command", "monitor", "get_command_or_subagent_output", "kill_command_or_subagent"];
  if (capabilityMode === "read-only") return new Set(read);
  if (capabilityMode === "read-write") return new Set([...read, ...write]);
  if (capabilityMode === "execute") return new Set([...read, ...execute]);
  if (capabilityMode === "all") return new Set([...read, ...write, ...execute, "web_search", "x_search"]);
  if (type === "explore") return new Set(["read_file", "list_dir", "grep"]);
  if (type === "plan") return new Set(["read_file", "list_dir", "grep", "todo_write", "web_search"]);
  return new Set([...read, ...write, ...execute, "web_search", "x_search"]);
}

function normalizeBrowserPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

async function runAgent(): Promise<void> {
  if (activeRun) return;
  trajectory.replaceChildren();
  turnCount.textContent = "0";
  agentState.textContent = "Starting";
  runButton.disabled = true;
  resetButton.disabled = true;
  stopButton.disabled = false;
  activeRun = new AbortController();

  try {
    const profile = conformanceProfile ?? (conformanceOrigin ? await loadConformanceProfile(conformanceOrigin) : undefined);
    if (profile) taskInput.value = profile.task;
    if (!profile && !liveStartupProfile) {
      agentState.textContent = "Loading native Grok settings";
      liveStartupProfile = await fetchGrokBuildStartupProfile({
        tools: GROK_BUILD_TOOLS,
        signal: activeRun.signal,
      });
    }
    if (!agentSession) {
      const browserRuntime = new GrokBuildBrowserRuntime(container, "/", browserServices);
      const skillManager = new GrokBuildSkillManager(container.vfs, "/");
      const startupSkillReminder = startupExtensionReminder(skillManager);
      conformanceRuntime = profile?.fixture === "three-pong-starter-v1"
        ? new GrokConformanceToolRuntime(browserRuntime, profile.toolResults, profile.nativeWorkspacePath, "/")
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
        ...(!profile ? { getPostToolSystemReminder: (call, result) => skillManager.afterToolCall(call, result) } : {}),
        ...(!profile ? { drainSystemReminders: () => [...browserRuntime.drainSystemReminders(), ...workflowCompletionReminders.splice(0)] } : {}),
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
          scheduleProjectSave?.();
        },
        ...(profile?.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
        enableTurnSummary: profile ? (profile.turnSummaryRequests ?? 0) > 0 : true,
        strictSideCalls: Boolean(profile),
        onEvent: eventHandler,
        ...(!profile && restoredAgentSession ? { restore: restoredAgentSession } : {}),
        ...(!profile ? {
          onCheckpoint: (snapshot: import("./grok-build-agent.js").GrokBuildSessionSnapshot) => {
            restoredAgentSession = snapshot;
            void saveBrowserAgentSession(snapshot).catch((error) => {
              eventItem("error", "Session save failed", error instanceof Error ? error.message : String(error));
            });
          },
        } : {}),
      });
    }
    const result = await agentSession.run(taskInput.value.trim(), activeRun.signal);
    if (result.status === "limit") agentState.textContent = "Stopped";
    if (profile) {
      (conformanceRuntime ?? recordedRuntime)?.assertComplete();
      const assertion = await fetch(`${conformanceOrigin}/__conformance__/assert-model-complete`);
      if (!assertion.ok) throw new Error(await assertion.text());
      const sideCalls = profile.modelRequests - profile.foregroundRequests;
      eventItem("", "Conformance", `${profile.modelRequests} native model requests matched with zero drift (${profile.foregroundRequests} foreground + ${sideCalls} side calls).`);
    }
  } catch (error) {
    const aborted = activeRun.signal.aborted;
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
  agentSession = undefined;
  restoredAgentSession = undefined;
  conformanceRuntime = undefined;
  recordedRuntime = undefined;
  clearVirtualFileSystem(container.vfs, "/", ["/.grok/bundled"]);
  seedProject(conformanceProfile);
  if (!conformanceOrigin) {
    await clearBrowserAgentSession();
    await clearBrowserProject();
    await saveBrowserProject(container.vfs);
  }
  trajectory.replaceChildren();
  turnCount.textContent = "0";
  agentState.textContent = "Idle";
  renderedRevision.textContent = "Starter project restored";
}

runButton.addEventListener("click", () => void runAgent());
stopButton.addEventListener("click", () => activeRun?.abort());
resetButton.addEventListener("click", () => void resetProject());
connectGrokButton.addEventListener("click", () => void startDeviceAuth());
disconnectGrokButton.addEventListener("click", () => void disconnectGrok());

server.on("hmr-update", () => {
  hmrEvents += 1;
  hmrCount.textContent = String(hmrEvents);
});

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function sendSandboxResponse(message: unknown): void {
  preview.contentWindow?.postMessage({
    channel: SANDBOX_CHANNEL,
    nonce: sandboxNonce,
    type: "response",
    payload: message,
  } satisfies SandboxEnvelope, sandboxOrigin);
}

async function handleSandboxRequest(message: unknown): Promise<void> {
  if (!message || typeof message !== "object") throw new Error("Malformed sandbox service-worker message.");
  const request = message as {
    type?: string;
    id?: number;
    data?: {
      port?: number;
      method?: string;
      url?: string;
      headers?: Record<string, string>;
      body?: ArrayBuffer;
      streaming?: boolean;
    };
  };
  if (request.type !== "request" || !Number.isSafeInteger(request.id) || request.data?.port !== VIRTUAL_PORT) {
    throw new Error("Rejected an invalid virtual-server request.");
  }
  const { method, url, headers, body, streaming } = request.data;
  if (!method || !url || !url.startsWith("/") || !headers) throw new Error("Rejected an incomplete virtual-server request.");
  if (body && body.byteLength > 16 * 1024 * 1024) throw new Error("Virtual-server request body exceeds 16 MiB.");

  const response = await bridge.handleRequest(VIRTUAL_PORT, method, url, headers, body);
  const responseBody = response.body instanceof Uint8Array ? response.body : new Uint8Array();
  if (streaming) {
    sendSandboxResponse({
      type: "stream-start",
      id: request.id,
      data: { statusCode: response.statusCode, statusMessage: response.statusMessage, headers: response.headers },
    });
    if (responseBody.length > 0) {
      sendSandboxResponse({ type: "stream-chunk", id: request.id, data: { chunkBase64: bytesToBase64(responseBody) } });
    }
    sendSandboxResponse({ type: "stream-end", id: request.id });
    return;
  }

  sendSandboxResponse({
    type: "response",
    id: request.id,
    data: {
      statusCode: response.statusCode,
      statusMessage: response.statusMessage,
      headers: response.headers,
      bodyBase64: bytesToBase64(responseBody),
    },
  });
}

window.addEventListener("message", (event) => {
  if (event.source !== preview.contentWindow || event.origin !== sandboxOrigin || !isSandboxEnvelope(event.data, sandboxNonce)) return;
  const envelope = event.data;
  if (envelope.type === "request") {
    void handleSandboxRequest(envelope.payload).catch((error) => {
      const requestId = (envelope.payload as { id?: number } | undefined)?.id;
      sendSandboxResponse({ type: "response", id: requestId, error: error instanceof Error ? error.message : String(error) });
    });
  } else if (envelope.type === "ready") {
    resolveSandboxBridge();
  } else if (envelope.type === "preview-load") {
    iframeLoadCount += 1;
    iframeLoads.textContent = String(iframeLoadCount);
    resolveInitialPreview();
  } else if (envelope.type === "rendered") {
    const revision = (envelope.payload as { revision?: string } | undefined)?.revision;
    renderedRevision.textContent = `Rendered: ${String(revision || "unknown")}`;
  } else if (envelope.type === "error") {
    const message = (envelope.payload as { message?: string } | undefined)?.message || "Sandbox bridge failed.";
    const error = new Error(message);
    rejectSandboxBridge(error);
    rejectInitialPreview(error);
    runtimeStatus.textContent = "Browser sandbox failed";
    runtimeDot.classList.add("failed");
    eventItem("error", "Runtime failed", message);
  }
});

async function start(): Promise<void> {
  try {
    sandboxMode.textContent = `Isolated sandbox · ${new URL(sandboxOrigin).host}`;
    if (conformanceOrigin) {
      conformanceProfile = await loadConformanceProfile(conformanceOrigin);
      taskInput.value = conformanceProfile.task;
    }
    if (conformanceProfile) {
      seedProject(conformanceProfile);
    } else {
      const saved = await loadBrowserProject();
      if (saved) restoreBrowserProject(container.vfs, saved);
      else seedProject();
      restoredAgentSession = await loadBrowserAgentSession();
      scheduleProjectSave = autosaveBrowserProject(container.vfs, (error) => {
        eventItem("error", "Project save failed", error instanceof Error ? error.message : String(error));
      });
      scheduleProjectSave();
    }
    const workflowHost = new GrokBuildBrowserWorkflowHost({
      vfs: container.vfs,
      workspacePath: "/",
      spawnSubagent: (input, signal, id) => runAdmittedBrowserSubagent(input, signal, id),
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
    preview.src = bootstrap.href;

    // Do not let the agent mutate files until the cross-origin bridge and the
    // starter application have both loaded. This makes the first edit a real
    // HMR update instead of racing the initial navigation on a cold browser.
    await sandboxBridgeReady;
    await initialPreviewReady;

    runtimeStatus.textContent = "Browser sandbox ready";
    runtimeDot.classList.add("ready");
    runtimeReady = true;
    startBundleSync();
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

void refreshAuthStatus();
void start();
