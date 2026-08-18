import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DISCOVER_INTERVAL_MS,
  DEFAULT_ATTENTION_SETTLE_MS,
  DEFAULT_INTENT_POLL_MS,
  DEFAULT_PUSH_DEBOUNCE_MS,
  DEFAULT_REPUSH_INTERVAL_MS,
  INTENT_QUEUE,
  WIDGET_NS,
  bindIntentQueue,
  chooseHarness,
  parseBranchIntent,
  parseAttachIntent,
  parseAcknowledgeIntent,
  parseInterruptIntent,
  parseJoinIntent,
  parseDetachIntent,
  parseDraftIntent,
  parseExportIntent,
  parseLoadEarlierIntent,
  parseLoadSessionsIntent,
  parseTerminalIntent,
  parseMountedIntent,
  parseNewChatIntent,
  parseRefreshIntent,
  parseReleaseIntent,
  parseResumeIntent,
  parseRespondIntent,
  parseSendIntent,
  startDaemon,
  type AgentController,
  type Daemon,
  type WidgetBridge,
} from "../src/daemon.js";
import { DEFAULT_MAX_ENTRIES, DEFAULT_MAX_ENTRY_CHARS, MAX_ATTACH_ERROR_CHARS } from "../src/projection.js";
import type { WidgetState } from "../src/projection.js";
import { sessionKey } from "../src/sessions.js";
import { FakeHarnessClient, FakeWidgetHost, descriptor, localHarness, waitFor } from "./fakes.js";
import { SupercodeController, type SupercodeClientSnapshot } from "@volter-ai-dev/supercode-client";
import type { MessengerPersistence, PersistedMessengerState } from "../src/persistence.js";
import type { ExportReceipt } from "../src/projection.js";
import type { SessionArtifact } from "@volter-ai-dev/supercode-harness-sdk";

const running: Daemon[] = [];

afterEach(async () => {
  while (running.length) await running.pop()?.stop();
});

interface Rig {
  daemon: Daemon;
  host: FakeWidgetHost;
  client: FakeHarnessClient;
  attached: Array<{ sessionId: string; ns: string; html: string }>;
  lastPush: () => WidgetState;
}

async function rig(options: { client?: FakeHarnessClient; harness?: string } = {}): Promise<Rig> {
  const client = options.client ?? new FakeHarnessClient();
  const host = new FakeWidgetHost();
  const attached: Array<{ sessionId: string; ns: string; html: string }> = [];
  const daemon = await startDaemon({
    sessionId: "session-abc",
    html: "<!doctype html><html></html>",
    workspace: "/tmp/project",
    ...(options.harness ? { harness: options.harness } : {}),
    client,
    pushDebounceMs: 5,
    attachHost: async (opts) => {
      attached.push({ sessionId: opts.sessionId, ns: opts.ns, html: opts.html });
      return host;
    },
  });
  running.push(daemon);
  return {
    daemon,
    host,
    client,
    attached,
    lastPush: () => host.pushes.at(-1) as WidgetState,
  };
}

describe("chooseHarness", () => {
  const snap = (harnesses: SupercodeClientSnapshot["harnesses"]): SupercodeClientSnapshot =>
    ({ harnesses }) as SupercodeClientSnapshot;
  const frontend = (id: string, start: boolean): SupercodeClientSnapshot["harnesses"][number] =>
    ({
      ...localHarness(id),
      availableActions: { start, resume: start, attach: false, send: start, interrupt: start, respond: start },
    }) as SupercodeClientSnapshot["harnesses"][number];

  it("takes the caller's harness when it can genuinely start", () => {
    expect(chooseHarness(snap([frontend("codex", true), frontend("grok", true)]), "grok")).toBe("grok");
  });

  it("refuses to silently substitute a different harness for a named one", () => {
    expect(chooseHarness(snap([frontend("codex", true), frontend("grok", false)]), "grok")).toBeNull();
  });

  it("falls back to the preference order, then to anything startable", () => {
    expect(chooseHarness(snap([frontend("grok", true), frontend("codex", true)]))).toBe("codex");
    expect(chooseHarness(snap([frontend("mystery", true)]))).toBe("mystery");
    expect(chooseHarness(snap([frontend("codex", false)]))).toBeNull();
  });
});

describe("parseAttachIntent", () => {
  it("accepts the Sessions list's payload", () => {
    expect(parseAttachIntent({ action: "attach", key: " claude-code-1a2b3c4d " })).toBe("claude-code-1a2b3c4d");
  });

  it("rejects everything else rather than guessing", () => {
    expect(parseAttachIntent({ action: "attach", key: "" })).toBeNull();
    expect(parseAttachIntent({ action: "attach" })).toBeNull();
    expect(parseAttachIntent({ action: "send", text: "hi" })).toBeNull();
    expect(parseAttachIntent(null)).toBeNull();
  });
});

describe("parseResumeIntent", () => {
  it("accepts only the target-free Continue here action", () => {
    expect(parseResumeIntent({ action: "resume" })).toBe(true);
    expect(parseResumeIntent({ action: "resume", key: "page-must-not-pick-a-target" })).toBe(false);
    expect(parseResumeIntent({ action: "attach" })).toBe(false);
    expect(parseResumeIntent(null)).toBe(false);
  });
});

describe("continuation control intents", () => {
  it("keeps join and detach target-free", () => {
    expect(parseJoinIntent({ action: "join" })).toBe(true);
    expect(parseJoinIntent({ action: "join", endpoint: "untrusted" })).toBe(false);
    expect(parseDetachIntent({ action: "detach" })).toBe(true);
    expect(parseDetachIntent({ action: "detach", key: "untrusted" })).toBe(false);
    expect(parseTerminalIntent({ action: "terminal" })).toBe(true);
    expect(parseTerminalIntent({ action: "terminal", command: "untrusted" })).toBe(false);
  });

  it("accepts a branch harness choice but never a page-chosen session", () => {
    expect(parseBranchIntent({ action: "branch" })).toEqual({ targetHarness: null });
    expect(parseBranchIntent({ action: "branch", targetHarness: " codex " })).toEqual({ targetHarness: "codex" });
    expect(parseBranchIntent({ action: "branch", targetHarness: "" })).toBeNull();
    expect(parseBranchIntent({ action: "branch", key: "untrusted" })).toBeNull();
  });
});

describe("history intents", () => {
  it("accepts only target-free bounded window requests", () => {
    expect(parseLoadSessionsIntent({ action: "loadSessions" })).toBe(true);
    expect(parseLoadSessionsIntent({ action: "loadSessions", limit: 10000 })).toBe(false);
    expect(parseLoadEarlierIntent({ action: "loadEarlier" })).toBe(true);
    expect(parseLoadEarlierIntent({ action: "loadEarlier", path: "/tmp/private" })).toBe(false);
  });
});

describe("draft intent", () => {
  it("is bounded and target-free", () => {
    expect(parseDraftIntent({ action: "draft", text: "keep this" })).toEqual({ text: "keep this" });
    expect(parseDraftIntent({ action: "draft", text: "" })).toEqual({ text: "" });
    expect(parseDraftIntent({ action: "draft", text: "x", key: "page-target" })).toBeNull();
    expect(parseDraftIntent({ action: "draft", text: "x".repeat(50_001) })).toBeNull();
  });
});

describe("export intent", () => {
  it("accepts a format choice but no page-chosen session or output path", () => {
    expect(parseExportIntent({ action: "export", targetHarness: " codex " })).toEqual({ targetHarness: "codex" });
    expect(parseExportIntent({ action: "export", targetHarness: "" })).toBeNull();
    expect(parseExportIntent({ action: "export", targetHarness: "codex", key: "untrusted" })).toBeNull();
    expect(parseExportIntent({ action: "export", targetHarness: "codex", path: "/tmp/untrusted" })).toBeNull();
  });
});

class MemoryPersistence implements MessengerPersistence {
  state: PersistedMessengerState = { attention: [], drafts: {} };
  saves = 0;
  async load(): Promise<PersistedMessengerState> {
    return structuredClone(this.state);
  }
  async save(state: PersistedMessengerState): Promise<void> {
    this.state = structuredClone(state);
    this.saves += 1;
  }
}

describe("parseMountedIntent", () => {
  it("accepts only the target-free iframe mount handshake", () => {
    expect(parseMountedIntent({ action: "mounted" })).toBe(true);
    expect(parseMountedIntent({ action: "mounted", state: "page-controlled" })).toBe(false);
    expect(parseMountedIntent({ action: "refresh" })).toBe(false);
    expect(parseMountedIntent(null)).toBe(false);
  });
});

describe("messenger intent cadence", () => {
  it("uses Lucarne's safe context drain at the app's 100ms cadence and deduplicates", async () => {
    let tick: (() => unknown) | null = null;
    let fallbackRegistered = false;
    let stopped = false;
    let drains = 0;
    const host: WidgetBridge = {
      push: async () => undefined,
      onIntent: () => {
        fallbackRegistered = true;
      },
      every: (ms, fn) => {
        expect(ms).toBe(DEFAULT_INTENT_POLL_MS);
        tick = fn;
        return () => {
          stopped = true;
        };
      },
      drainIntentsWithContext: async () => {
        drains += 1;
        return [{ items: [{ id: "one", payload: { action: "send", text: "hello" } }] }];
      },
      remove: async () => undefined,
    };
    const received: unknown[] = [];
    const stop = bindIntentQueue(host, INTENT_QUEUE, (intent) => {
      received.push(intent.payload);
    });

    expect(fallbackRegistered).toBe(false);
    expect(tick).not.toBeNull();
    await tick!();
    await tick!();
    expect(drains).toBe(2);
    expect(received).toEqual([{ action: "send", text: "hello" }]);
    stop();
    expect(stopped).toBe(true);
  });
});

describe("parseSendIntent", () => {
  it("accepts the panel's send payload and trims it", () => {
    expect(parseSendIntent({ action: "send", text: "  build it  " })).toBe("build it");
  });

  it("rejects everything else rather than guessing", () => {
    expect(parseSendIntent({ action: "send", text: "   " })).toBeNull();
    expect(parseSendIntent({ action: "interrupt" })).toBeNull();
    expect(parseSendIntent({ text: "no action" })).toBeNull();
    expect(parseSendIntent("send")).toBeNull();
    expect(parseSendIntent(null)).toBeNull();
  });
});

describe("parseInterruptIntent", () => {
  it("accepts only the Stop button payload", () => {
    expect(parseInterruptIntent({ action: "interrupt" })).toBe(true);
    expect(parseInterruptIntent({ action: "interrupt", target: "somebody-else" })).toBe(true);
    expect(parseInterruptIntent({ action: "send", text: "stop" })).toBe(false);
    expect(parseInterruptIntent("interrupt")).toBe(false);
    expect(parseInterruptIntent(null)).toBe(false);
  });
});

describe("parseRespondIntent", () => {
  it("accepts structured request ids and an option or cancellation", () => {
    expect(parseRespondIntent({ action: "respond", requestId: { id: 7 }, optionId: "allow" })).toEqual({
      requestId: { id: 7 },
      optionId: "allow",
    });
    expect(parseRespondIntent({ action: "respond", requestId: 7, optionId: null })).toEqual({
      requestId: 7,
      optionId: null,
    });
  });

  it("rejects malformed response payloads", () => {
    expect(parseRespondIntent({ action: "respond", requestId: undefined, optionId: "allow" })).toBeNull();
    expect(parseRespondIntent({ action: "respond", requestId: 7 })).toBeNull();
    expect(parseRespondIntent({ action: "send", requestId: 7, optionId: null })).toBeNull();
  });
});

describe("parseReleaseIntent", () => {
  it("accepts only the target-free return-to-owned-runtime action", () => {
    expect(parseReleaseIntent({ action: "release" })).toBe(true);
    expect(parseReleaseIntent({ action: "attach", key: "release" })).toBe(false);
    expect(parseReleaseIntent(null)).toBe(false);
  });
});

describe("messenger lifecycle intents", () => {
  it("accepts a lazy new-chat payload only when both harness and first message are present", () => {
    expect(parseNewChatIntent({ action: "new", harness: " codex ", text: "  fix the tests  " })).toEqual({
      harness: "codex",
      text: "fix the tests",
    });
    expect(parseNewChatIntent({ action: "new", harness: "codex", text: "   " })).toBeNull();
    expect(parseNewChatIntent({ action: "new", harness: "", text: "hello" })).toBeNull();
    expect(parseNewChatIntent({ action: "send", harness: "codex", text: "hello" })).toBeNull();
  });

  it("accepts explicit acknowledgement and refresh without guessing at malformed payloads", () => {
    expect(parseAcknowledgeIntent({ action: "ack", key: " session-key " })).toBe("session-key");
    expect(parseAcknowledgeIntent({ action: "ack", key: "" })).toBeNull();
    expect(parseAcknowledgeIntent({ action: "attach", key: "session-key" })).toBeNull();
    expect(parseRefreshIntent({ action: "refresh" })).toBe(true);
    expect(parseRefreshIntent({ action: "send", text: "refresh" })).toBe(false);
  });
});

describe("startDaemon", () => {
  it("mounts the widget under the shared namespace and starts a session", async () => {
    const { attached, client, host, lastPush } = await rig();
    expect(attached).toEqual([
      { sessionId: "session-abc", ns: WIDGET_NS, html: "<!doctype html><html></html>" },
    ]);
    // The controller's own default policy — the daemon invents no gate of its own.
    expect(client.startedWith).toEqual([{ harness: "claude-code", cwd: "/tmp/project", policy: "default" }]);
    expect(lastPush()).toMatchObject({
      pill: { tone: "live", label: "claude-code ready" },
      startup: "ready",
      harness: "claude-code",
      canSend: true,
      busy: false,
      transcript: [],
    });
    const phases = host.pushes.map((push) => (push as WidgetState).startup);
    expect(phases.indexOf("connecting")).toBeLessThan(phases.indexOf("starting"));
    expect(phases.indexOf("starting")).toBeLessThan(phases.indexOf("discovering"));
    expect(phases.indexOf("discovering")).toBeLessThan(phases.indexOf("ready"));
    expect(host.pushes).toContainEqual(expect.objectContaining({
      startup: "connecting",
      pill: { tone: "off", label: "Connecting to coding agents…" },
    }));
  });

  it("starts the harness the caller named", async () => {
    const { client } = await rig({ harness: "codex" });
    expect(client.startedWith[0]?.harness).toBe("codex");
  });

  it("still mounts (and says so) when no harness can start", async () => {
    const logs: string[] = [];
    const client = new FakeHarnessClient({ harnesses: [localHarness("codex", { installed: false })] });
    const host = new FakeWidgetHost();
    const daemon = await startDaemon({
      sessionId: "s",
      html: "<html></html>",
      workspace: "/w",
      client,
      pushDebounceMs: 5,
      attachHost: async () => host,
      log: (m) => logs.push(m),
    });
    running.push(daemon);
    expect(client.startedWith).toEqual([]);
    expect(logs.some((l) => l.includes("no startable harness"))).toBe(true);
    expect(host.pushes.at(-1)).toMatchObject({ pill: { tone: "off", label: "no session" }, canSend: false });
  });

  it("pushes a projection of every controller revision, debounced", async () => {
    const { host, client, lastPush } = await rig();
    const before = host.pushes.length;
    client.runtime.assistantMessage("first");
    client.runtime.assistantMessage("second");
    await waitFor(() => host.pushes.length > before);
    await new Promise((r) => setTimeout(r, 30));
    // Two revisions arriving inside one debounce window cost ONE push, not two.
    expect(host.pushes.length - before).toBeLessThanOrEqual(2);
    expect(lastPush().transcript.map((e) => e.text)).toEqual(["first", "second"]);
  });

  it("pushes projected state — never the controller's raw snapshot", async () => {
    const { host, client } = await rig();
    client.runtime.assistantMessage("x");
    await waitFor(() => (host.pushes.at(-1) as WidgetState).transcript.length === 1);
    const push = host.pushes.at(-1) as Record<string, unknown>;
    expect(Object.keys(push).sort()).toEqual([
      "attachError",
      "attached",
      "attention",
      "busy",
      "canAttach",
      "canBranch",
      "canDetach",
      "canExport",
      "canInterrupt",
      "canOpenTerminal",
      "canReduce",
      "canRespond",
      "canResume",
      "canSend",
      "error",
      "exportBackTarget",
      "exportReceipt",
      "harness",
      "harnesses",
      "history",
      "messaging",
      "mode",
      "needsInput",
      "operation",
      "owned",
      "pill",
      "recoverable",
      "savedDraft",
      "semantics",
      "sessions",
      "startup",
      "strategy",
      "taskPlan",
      "terminalHandoff",
      "transcript",
      "workspace",
    ]);
    expect(push["conversation"]).toBeUndefined();
    expect(push["harnesses"]).toEqual(expect.any(Array));
  });

  it("caps what crosses the wire, however long the session runs", async () => {
    const { host, client, daemon } = await rig();
    for (let i = 0; i < DEFAULT_MAX_ENTRIES + 5; i += 1) {
      client.runtime.assistantMessage(`${i}:${"y".repeat(DEFAULT_MAX_ENTRY_CHARS + 50)}`);
    }
    await waitFor(() => (host.pushes.at(-1) as WidgetState).transcript.length > 0);
    await daemon.flush();
    const state = host.pushes.at(-1) as WidgetState;
    expect(state.transcript.length).toBe(DEFAULT_MAX_ENTRIES);
    expect(state.transcript[0]?.text.startsWith("5:")).toBe(true);
    for (const entry of state.transcript) {
      expect(entry.truncated).toBe(true);
      expect(entry.text.length).toBeLessThanOrEqual(DEFAULT_MAX_ENTRY_CHARS + 1);
    }
  });

  it("routes a send intent from the panel into the real controller dispatch", async () => {
    const { host, client, lastPush } = await rig();
    await host.fireIntent(INTENT_QUEUE, { action: "send", text: "  refactor the parser  " });
    expect(client.runtime.sent).toEqual(["refactor the parser"]);
    // The controller echoes the prompt into the conversation and marks the turn running…
    expect(lastPush()).toMatchObject({ busy: true, pill: { tone: "live", label: "claude-code working…" } });
    expect(lastPush().transcript.at(-1)).toMatchObject({ role: "user", text: "refactor the parser" });

    // …and the answer streams back through the same push path.
    client.runtime.assistantMessage("done");
    client.runtime.turnCompleted();
    await waitFor(() => lastPush().busy === false, 2000);
    expect(lastPush().transcript.at(-1)).toMatchObject({ role: "assistant", text: "done" });
  });

  it("routes Stop through the active controller native interrupt action", async () => {
    const { host, client, lastPush } = await rig();
    await host.fireIntent(INTENT_QUEUE, { action: "send", text: "take your time" });
    expect(lastPush()).toMatchObject({ busy: true, canInterrupt: true });

    await host.fireIntent(INTENT_QUEUE, { action: "interrupt" });
    expect(client.runtime.interrupts).toBe(1);
    expect(lastPush()).toMatchObject({ busy: true, pill: { tone: "warn", label: "interrupting…" } });

    client.runtime.turnCompleted();
    await waitFor(() => lastPush().busy === false, 2000);
    expect(lastPush().canInterrupt).toBe(false);
  });

  it("projects a native terminal handoff without exposing its environment", async () => {
    const { host, lastPush } = await rig();
    expect(lastPush().canOpenTerminal).toBe(true);
    await host.fireIntent(INTENT_QUEUE, { action: "terminal" });
    expect(lastPush().terminalHandoff).toEqual({
      program: "supercode",
      arguments: ["attach", "runtime-1"],
      cwd: "/tmp/project",
    });
    expect(JSON.stringify(lastPush())).not.toContain("SUPER_CODE_PRIVATE_TOKEN");
  });

  it("ignores an unrecognized intent payload instead of dispatching it", async () => {
    const logs: string[] = [];
    const client = new FakeHarnessClient();
    const host = new FakeWidgetHost();
    const daemon = await startDaemon({
      sessionId: "s",
      html: "<html></html>",
      workspace: "/w",
      client,
      pushDebounceMs: 5,
      attachHost: async () => host,
      log: (m) => logs.push(m),
    });
    running.push(daemon);
    await host.fireIntent(INTENT_QUEUE, { action: "explode" });
    expect(client.runtime.sent).toEqual([]);
    expect(logs.some((l) => l.includes("unrecognized intent"))).toBe(true);
  });

  it("survives a failing send without taking the bridge down", async () => {
    const logs: string[] = [];
    const client = new FakeHarnessClient();
    const host = new FakeWidgetHost();
    const daemon = await startDaemon({
      sessionId: "s",
      html: "<html></html>",
      workspace: "/w",
      client,
      pushDebounceMs: 5,
      attachHost: async () => host,
      log: (m) => logs.push(m),
    });
    running.push(daemon);
    await client.runtime.close();
    await host.fireIntent(INTENT_QUEUE, { action: "send", text: "hi" });
    expect(logs.some((l) => l.startsWith("send failed"))).toBe(true);
    // still pushing, and the failure is visible in the pill
    expect((host.pushes.at(-1) as WidgetState).error).toBeTruthy();
  });

  it("keeps pushing when a push fails — a navigated-away tab is not a fatal error", async () => {
    const logs: string[] = [];
    const client = new FakeHarnessClient();
    const host = new FakeWidgetHost();
    let fail = true;
    const flaky = {
      ...host,
      push: async (patch: unknown): Promise<void> => {
        if (fail) {
          fail = false;
          throw new Error("page navigated");
        }
        await host.push(patch);
      },
      onIntent: host.onIntent.bind(host),
      every: host.every.bind(host),
      remove: host.remove.bind(host),
    };
    const daemon = await startDaemon({
      sessionId: "s",
      html: "<html></html>",
      workspace: "/w",
      client,
      pushDebounceMs: 5,
      attachHost: async () => flaky,
      log: (m) => logs.push(m),
    });
    running.push(daemon);
    expect(logs.some((l) => l.includes("push failed"))).toBe(true);
    client.runtime.assistantMessage("still here");
    await waitFor(() => ((host.pushes.at(-1) as WidgetState | undefined)?.transcript.length ?? 0) > 0);
    expect((host.pushes.at(-1) as WidgetState).transcript.at(-1)?.text).toBe("still here");
  });

  it("tears down the widget and the controller's own client on stop", async () => {
    const { daemon, host, client } = await rig();
    await daemon.stop();
    running.length = 0;
    expect(host.removed).toBe(1);
    expect(client.closeCalls).toBe(1);
    expect(client.runtime.closed).toBe(true);
    // A revision after teardown must not resurrect the push loop.
    const pushes = host.pushes.length;
    await new Promise((r) => setTimeout(r, DEFAULT_PUSH_DEBOUNCE_MS + 20));
    expect(host.pushes.length).toBe(pushes);
    await daemon.stop(); // idempotent
    expect(host.removed).toBe(1);
  });
});

describe("event-driven state delivery", () => {
  it("does not register a full-state heartbeat by default and forces one snapshot for a fresh mount", async () => {
    const { daemon, host } = await rig();
    expect(DEFAULT_REPUSH_INTERVAL_MS).toBe(0);
    expect(host.ticks.map((t) => t.ms)).toEqual([DEFAULT_DISCOVER_INTERVAL_MS]);
    const before = host.pushes.length;
    await host.fireIntent(INTENT_QUEUE, { action: "mounted" });
    expect(host.pushes.length).toBe(before + 1);
    expect(host.pushes.at(-1)).toEqual(host.pushes.at(-2));
    await daemon.stop();
    expect(host.ticks.every((t) => t.stopped)).toBe(true);
  });

  it("suppresses an unchanged full snapshot outside an explicit mount", async () => {
    const { daemon, host } = await rig();
    const before = host.pushes.length;
    await daemon.flush();
    expect(host.pushes.length).toBe(before);
  });

  it("repushIntervalMs: 0 / discoverIntervalMs: 0 disable their ticks", async () => {
    const client = new FakeHarnessClient();
    const host = new FakeWidgetHost();
    const daemon = await startDaemon({
      sessionId: "s",
      html: "<html></html>",
      workspace: "/tmp/p",
      client,
      pushDebounceMs: 5,
      repushIntervalMs: 0,
      discoverIntervalMs: 0,
      attachHost: async () => host,
    });
    expect(host.ticks.length).toBe(0);
    await daemon.stop();
  });
});

// ── the Sessions list, and attaching to one ─────────────────────────────────────────────────────

const OWN = descriptor({ sessionId: "runtime-1", cwd: "/tmp/project", title: "This window" });
const ATLAS = descriptor({
  sessionId: "atlas-1",
  cwd: "/home/dev/volter/atlas",
  title: "Rewrite the parser",
  text: "another window said this",
  updatedAtMs: 2_000_000,
});
const LIVE_ATLAS = descriptor({
  sessionId: "atlas-live",
  cwd: "/home/dev/volter/atlas",
  title: "Rewrite the parser live",
  text: "another window is working",
  updatedAtMs: 2_000_000,
  liveEndpoint: "cc-peer:v1:4242:atlas-live:%2Ftmp%2Fcc-socks%2F4242.sock",
  liveStatus: "busy",
});
const BRIDGE = descriptor({
  harness: "codex",
  sessionId: "bridge-1",
  cwd: "/home/dev/volter/bridge",
  title: "Bridge deploy",
  text: "codex over here",
  updatedAtMs: 1_500_000,
});

async function sessionRig(
  sessions: FakeHarnessClient["sessions"] = [OWN, ATLAS, BRIDGE],
  suppliedClient?: FakeHarnessClient,
  persistence?: MessengerPersistence,
  materializeArtifact?: (artifact: SessionArtifact) => Promise<ExportReceipt>,
): Promise<Rig & { logs: string[] }> {
  const client = suppliedClient ?? new FakeHarnessClient({ sessions });
  const logs: string[] = [];
  const host = new FakeWidgetHost();
  const daemon = await startDaemon({
    sessionId: "session-abc",
    html: "<html></html>",
    workspace: "/tmp/project",
    client,
    pushDebounceMs: 5,
    home: "/home/dev",
    now: () => 2_000_000,
    attachHost: async () => host,
    log: (m) => logs.push(m),
    ...(persistence ? { persistence } : {}),
    ...(materializeArtifact ? { materializeArtifact } : {}),
  });
  running.push(daemon);
  return { daemon, host, client, logs, attached: [], lastPush: () => host.pushes.at(-1) as WidgetState };
}

describe("the Sessions list", () => {
  it("shows every session on the machine, not just this workspace's", async () => {
    const { client, lastPush } = await sessionRig();
    // The scan that fills the panel carries NO workspace — that is what makes it global.
    // One sentinel descriptor tells the UI whether another bounded page exists.
    expect(client.discoverQueries.some((q) => q.workspace === undefined && q.limit === 31)).toBe(true);
    expect(lastPush().sessions.map((s) => s.name)).toEqual(["atlas", "bridge", "project"]);
    expect(lastPush().sessions.map((s) => s.harness)).toEqual(["claude-code", "codex", "claude-code"]);
  });

  it("marks the session this daemon started, and names it in the header", async () => {
    const { lastPush } = await sessionRig();
    const own = lastPush().sessions.find((s) => s.name === "project");
    expect(own?.active).toBe(true);
    expect(lastPush().sessions.filter((s) => s.active).length).toBe(1);
    expect(lastPush().attached).toMatchObject({ harness: "claude-code", name: "project" });
  });

  it("re-scans on the discovery tick", async () => {
    const { client, host, lastPush } = await sessionRig([OWN]);
    expect(lastPush().sessions.length).toBe(1);
    client.sessions = [OWN, ATLAS];
    const discoveryTick = host.ticks.find((t) => t.ms === DEFAULT_DISCOVER_INTERVAL_MS);
    await discoveryTick?.fn();
    expect(lastPush().sessions.map((s) => s.name)).toEqual(["atlas", "project"]);
  });

  it("loads older session rows in explicit 30-chat pages", async () => {
    const sessions = Array.from({ length: 65 }, (_, index) => descriptor({
      sessionId: `history-${index}`,
      cwd: `/home/dev/history/project-${index}`,
      title: `History ${index}`,
      updatedAtMs: 2_000_000 - index,
    }));
    const { host, client, lastPush } = await sessionRig(sessions);
    expect(lastPush().sessions).toHaveLength(30);
    expect(lastPush().history).toMatchObject({ sessionLimit: 30, hasMoreSessions: true });

    await host.fireIntent(INTENT_QUEUE, { action: "loadSessions" });
    expect(lastPush().sessions).toHaveLength(60);
    expect(lastPush().history).toMatchObject({ sessionLimit: 60, hasMoreSessions: true });
    expect(client.discoverQueries.at(-1)).toEqual({ limit: 61 });

    await host.fireIntent(INTENT_QUEUE, { action: "loadSessions" });
    expect(lastPush().sessions).toHaveLength(65);
    expect(lastPush().history).toMatchObject({ sessionLimit: 90, hasMoreSessions: false });
  });

  it("keeps the last list when a scan fails", async () => {
    const { client, host, lastPush, logs } = await sessionRig();
    const before = lastPush().sessions.length;
    client.discover = async (): Promise<never> => {
      throw new Error("harness went away");
    };
    await host.ticks.find((t) => t.ms === DEFAULT_DISCOVER_INTERVAL_MS)?.fn();
    expect(lastPush().sessions.length).toBe(before);
    expect(logs.some((l) => l.includes("session discovery failed"))).toBe(true);
  });

  it("marks only a later unseen transcript change as attention, then clears it when read", async () => {
    const { client, host, lastPush } = await sessionRig();
    // Live peers can touch their descriptor timestamp on heartbeat. That is not a new message.
    client.sessions = [OWN, { ...ATLAS, updated_at_ms: 2_000_050 }, BRIDGE];
    await host.ticks.find((tick) => tick.ms === DEFAULT_DISCOVER_INTERVAL_MS)?.fn();
    expect(lastPush().attention).toEqual([]);

    const changedAtlas = { ...ATLAS, updated_at_ms: 2_000_100, message_count: (ATLAS.message_count ?? 0) + 1 };
    client.sessions = [OWN, changedAtlas, BRIDGE];
    await host.ticks.find((tick) => tick.ms === DEFAULT_DISCOVER_INTERVAL_MS)?.fn();
    expect(lastPush().attention).toEqual([]);

    // The same grown transcript becomes unread only after it has been quiet long enough to be a
    // useful notification rather than a badge increment for each streaming tool event.
    client.sessions = [
      OWN,
      { ...changedAtlas, updated_at_ms: 2_000_000 - DEFAULT_ATTENTION_SETTLE_MS },
      BRIDGE,
    ];
    await host.ticks.find((tick) => tick.ms === DEFAULT_DISCOVER_INTERVAL_MS)?.fn();

    const key = sessionKey(ATLAS.locator);
    expect(lastPush().attention).toContainEqual({ key, kind: "unseen" });
    await host.fireIntent(INTENT_QUEUE, { action: "ack", key });
    expect(lastPush().attention).not.toContainEqual(expect.objectContaining({ key }));
  });

  it("marks a completed owned turn until that conversation is acknowledged", async () => {
    const { client, host, lastPush } = await sessionRig();
    await host.fireIntent(INTENT_QUEUE, { action: "send", text: "do the work" });
    client.runtime.assistantMessage("done");
    client.runtime.turnCompleted();
    await waitFor(() => lastPush().busy === false);

    const key = sessionKey(OWN.locator);
    expect(lastPush().attention).toContainEqual(expect.objectContaining({ key, kind: "finished" }));
    await host.fireIntent(INTENT_QUEUE, { action: "ack", key });
    expect(lastPush().attention).toEqual([]);
  });

  it("restores durable completion attention with a last-assistant preview", async () => {
    const store = new MemoryPersistence();
    const first = await sessionRig([OWN], undefined, store);
    await first.host.fireIntent(INTENT_QUEUE, { action: "send", text: "do the durable work" });
    first.client.runtime.assistantMessage("Finished the durable parser migration.");
    // Completion reconciliation reloads the harness-native store; make the fake store reflect the
    // runtime event exactly as a real harness does before it announces turn completion.
    first.client.sessions[0]!.text = "Finished the durable parser migration.";
    first.client.runtime.turnCompleted();
    await waitFor(() => first.lastPush().busy === false);
    expect(first.lastPush().transcript.at(-1)?.text).toBe("Finished the durable parser migration.");
    expect(first.lastPush().attention[0]).toMatchObject({
      key: sessionKey(OWN.locator),
      kind: "finished",
      preview: "Finished the durable parser migration.",
    });
    await first.daemon.stop();

    const second = await sessionRig([OWN], undefined, store);
    expect(second.lastPush().attention[0]).toMatchObject({
      key: sessionKey(OWN.locator),
      kind: "finished",
      preview: "Finished the durable parser migration.",
    });
    await second.host.fireIntent(INTENT_QUEUE, { action: "ack", key: sessionKey(OWN.locator) });
    await second.daemon.stop();
    expect(store.state.attention).toEqual([]);
  });

  it("uses an explicit foreign busy-to-idle transition as immediate completion", async () => {
    const { client, host, lastPush } = await sessionRig([OWN, LIVE_ATLAS]);
    client.sessions = [{ ...LIVE_ATLAS, live_status: "idle" }, OWN];
    await host.ticks.find((tick) => tick.ms === DEFAULT_DISCOVER_INTERVAL_MS)?.fn();
    expect(lastPush().attention).toContainEqual({ key: sessionKey(LIVE_ATLAS.locator), kind: "finished" });
  });
});

describe("attaching", () => {
  it("follows another workspace's session without touching the one it started", async () => {
    const { daemon, client, lastPush, host } = await sessionRig();
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(ATLAS.locator) });
    await daemon.flush();

    // The panel is now showing THAT session's transcript…
    expect(lastPush().transcript.map((e) => e.text)).toEqual(["another window said this"]);
    expect(lastPush().attached).toMatchObject({ name: "atlas", harness: "claude-code" });
    expect(lastPush().sessions.find((s) => s.name === "atlas")?.active).toBe(true);
    expect(lastPush().sessions.find((s) => s.name === "project")?.active).toBe(false);
    // …read-only, because a persisted mirror is not a control channel and we do not pretend it is.
    expect(lastPush().canSend).toBe(false);
    expect(lastPush().pill).toEqual({ tone: "warn", label: "claude-code (read-only)" });
    // …and the runtime this daemon started is untouched.
    expect(client.runtime.closed).toBe(false);
    expect(client.activeFollows).toBe(1);
    // The global inbox already supplied ATLAS's exact locator. Opening it must not rescan every
    // transcript in that workspace just so the mirror controller can rediscover the same locator.
    expect(client.discoverQueries.some((query) => query.workspace === ATLAS.cwd)).toBe(false);
  });

  it("exports the daemon-selected session through the lossless native artifact API", async () => {
    const receipt: ExportReceipt = {
      targetHarness: "codex",
      fidelity: "value_lossless",
      path: "/tmp/export-bundle",
      files: 1,
      residueCount: 0,
    };
    const materialized: SessionArtifact[] = [];
    const { daemon, client, host, lastPush } = await sessionRig(
      [OWN, ATLAS],
      undefined,
      undefined,
      async (artifact) => {
        materialized.push(artifact);
        return receipt;
      },
    );
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(ATLAS.locator) });
    expect(lastPush().canExport).toBe(true);
    await host.fireIntent(INTENT_QUEUE, { action: "export", targetHarness: "codex" });
    await daemon.flush();

    expect(client.exportedWith).toEqual([{ locator: ATLAS.locator, target_harness: "codex" }]);
    expect(materialized).toHaveLength(1);
    expect(lastPush().exportReceipt).toEqual(receipt);
    expect(lastPush().error).toBeNull();
  });

  it("refuses to materialize an export with semantic residue", async () => {
    const client = new FakeHarnessClient({ sessions: [OWN, ATLAS] });
    client.exportSession = async (params): Promise<never> => ({
      artifact: {
        source_harness: params.locator.harness,
        target_harness: params.target_harness,
        session_id: params.locator.session_id,
        content: "lossy",
        suggested_filename: "lossy.jsonl",
        files: [],
        fidelity: "semantic",
        residue: ["native tool result could not be represented"],
      },
    }) as never;
    let materialized = false;
    const { daemon, host, lastPush } = await sessionRig(
      client.sessions,
      client,
      undefined,
      async () => {
        materialized = true;
        throw new Error("must not materialize");
      },
    );
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(ATLAS.locator) });
    await host.fireIntent(INTENT_QUEUE, { action: "export", targetHarness: "codex" });
    await daemon.flush();
    expect(materialized).toBe(false);
    expect(lastPush().exportReceipt).toBeNull();
    expect(lastPush().error).toContain("refusing a lossy codex export");
  });

  it("restores a per-conversation draft after the daemon and iframe are replaced", async () => {
    const store = new MemoryPersistence();
    const first = await sessionRig([OWN, ATLAS], undefined, store);
    await first.host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(ATLAS.locator) });
    await first.host.fireIntent(INTENT_QUEUE, { action: "draft", text: "Remember this unfinished thought" });
    await first.daemon.stop();

    const second = await sessionRig([OWN, ATLAS], undefined, store);
    await second.host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(ATLAS.locator) });
    expect(second.lastPush().savedDraft).toBe("Remember this unfinished thought");
    await second.host.fireIntent(INTENT_QUEUE, { action: "draft", text: "" });
    await second.daemon.stop();
    expect(store.state.drafts).toEqual({});
  });

  it("expands a passive transcript in bounded windows while preserving one follower", async () => {
    const messages = Array.from({ length: 260 }, (_, index) => `message-${index}`);
    const long = descriptor({
      sessionId: "long-session",
      cwd: "/home/dev/volter/long",
      title: "Long conversation",
      messages,
      messageCount: messages.length,
      updatedAtMs: 2_000_000,
    });
    const { daemon, client, host, lastPush } = await sessionRig([OWN, long]);
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(long.locator) });
    expect(lastPush().transcript).toHaveLength(120);
    expect(lastPush().transcript[0]?.text).toBe("message-140");
    expect(lastPush().history).toMatchObject({ transcriptLimit: 120, hasEarlier: true });

    await host.fireIntent(INTENT_QUEUE, { action: "loadEarlier" });
    await daemon.flush();
    expect(lastPush().transcript).toHaveLength(240);
    expect(lastPush().transcript[0]?.text).toBe("message-20");
    expect(lastPush().history).toMatchObject({ transcriptLimit: 240, hasEarlier: true });
    expect(client.activeFollows).toBe(1);

    await host.fireIntent(INTENT_QUEUE, { action: "loadEarlier" });
    await daemon.flush();
    expect(lastPush().transcript).toHaveLength(260);
    expect(lastPush().transcript[0]?.text).toBe("message-0");
    expect(lastPush().history).toMatchObject({ transcriptLimit: 360, hasEarlier: false });
    expect(client.activeFollows).toBe(1);
  });

  it("returns to the daemon's own session, which can still send", async () => {
    const { daemon, client, host, lastPush } = await sessionRig();
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(ATLAS.locator) });
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(OWN.locator) });
    await daemon.flush();

    expect(client.activeFollows).toBe(0);
    expect(daemon.activeController()).toBe(daemon.controller);
    expect(lastPush()).toMatchObject({ canSend: true, attached: { name: "project" } });
    await host.fireIntent(INTENT_QUEUE, { action: "send", text: "carry on" });
    expect(client.runtime.sent).toEqual(["carry on"]);
  });

  it("retains and releases back to a brand-new owned runtime before it has persisted", async () => {
    const { daemon, client, host, lastPush } = await sessionRig([ATLAS]);
    expect(lastPush().owned).toMatchObject({ key: "", name: "project", harness: "claude-code" });

    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(ATLAS.locator) });
    await daemon.flush();
    expect(lastPush()).toMatchObject({ attached: { name: "atlas" }, owned: { key: "", name: "project" } });

    await host.fireIntent(INTENT_QUEUE, { action: "release" });
    await daemon.flush();
    expect(client.activeFollows).toBe(0);
    expect(daemon.activeController()).toBe(daemon.controller);
    expect(lastPush()).toMatchObject({ canSend: true, attached: { key: "", name: "project" } });
  });

  it("makes a discovered live Claude row sendable without taking over its runtime", async () => {
    const { daemon, client, host, lastPush } = await sessionRig([OWN, LIVE_ATLAS]);
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(LIVE_ATLAS.locator) });
    await daemon.flush();

    expect(lastPush()).toMatchObject({
      canSend: true,
      canInterrupt: false,
      attached: { name: "atlas", harness: "claude-code" },
      pill: { tone: "live", label: "claude-code live" },
    });
    expect(daemon.activeController().getSnapshot().connection).toMatchObject({
      mode: "mirror",
      messaging: "live_peer",
    });

    await host.fireIntent(INTENT_QUEUE, { action: "send", text: "  please wrap up  " });
    expect(client.messages).toEqual([{ locator: LIVE_ATLAS.locator, text: "please wrap up" }]);
    // The follower, not the sender, owns the real transcript entry.
    expect(lastPush().transcript.some((entry) => entry.text === "please wrap up")).toBe(false);
  });

  it("continues an inactive persisted session under local control", async () => {
    const { daemon, client, host, lastPush } = await sessionRig();
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(ATLAS.locator) });
    await daemon.flush();

    expect(lastPush()).toMatchObject({ mode: "mirror", canResume: true, canSend: false });
    await host.fireIntent(INTENT_QUEUE, { action: "resume" });
    await daemon.flush();

    expect(client.resumedWith).toEqual([
      expect.objectContaining({ harness: "claude-code", runtime_id: ATLAS.locator.session_id, cwd: ATLAS.cwd }),
    ]);
    expect(client.activeFollows).toBe(0);
    expect(lastPush()).toMatchObject({
      mode: "control",
      canResume: false,
      canSend: true,
      attached: { name: "atlas", harness: "claude-code" },
    });
    // The daemon's original runtime remains another healthy conversation, not collateral damage.
    expect(client.runtime.closed).toBe(false);
  });

  it("forks a read-only conversation into a separately controlled target harness", async () => {
    const { daemon, client, host, lastPush } = await sessionRig();
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(ATLAS.locator) });
    expect(lastPush()).toMatchObject({ mode: "mirror", canBranch: true });

    await host.fireIntent(INTENT_QUEUE, { action: "branch", targetHarness: "codex" });
    await daemon.flush();

    expect(client.branchedWith).toEqual([{ locator: ATLAS.locator, target_harness: "codex" }]);
    expect(client.startedWith.at(-1)?.harness).toBe("codex");
    expect(client.startedRuntimes.at(-1)?.sent).toEqual(["Continue this imported conversation without losing context."]);
    expect(lastPush()).toMatchObject({
      mode: "control",
      strategy: "branch",
      harness: "codex",
      canExport: true,
      exportBackTarget: "claude-code",
    });
    expect(lastPush().transcript.some((entry) => entry.role === "notice" && entry.code === "branched")).toBe(true);
    expect(client.runtime.closed).toBe(false);
  });

  it("rekeys a retained branch when its new native session appears in discovery", async () => {
    const { daemon, client, host, lastPush } = await sessionRig();
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(ATLAS.locator) });
    await host.fireIntent(INTENT_QUEUE, { action: "branch", targetHarness: "codex" });
    const branchedController = daemon.activeController();
    const persistedBranch = descriptor({
      harness: "codex",
      sessionId: "started-2",
      cwd: ATLAS.cwd,
      title: "Continued parser work",
      updatedAtMs: 2_000_001,
    });
    client.sessions.push(persistedBranch);
    await daemon.refreshSessions();

    expect(lastPush().attached).toMatchObject({ key: sessionKey(persistedBranch.locator), harness: "codex" });
    await host.fireIntent(INTENT_QUEUE, { action: "release" });
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(persistedBranch.locator) });
    expect(daemon.activeController()).toBe(branchedController);
    expect(client.startedRuntimes.at(-1)?.closed).toBe(false);
  });

  it("rejects a cross-harness continuation the live inventory cannot start", async () => {
    const { daemon, client, host, lastPush } = await sessionRig();
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(ATLAS.locator) });
    await host.fireIntent(INTENT_QUEUE, { action: "branch", targetHarness: "grok" });
    await daemon.flush();

    expect(client.branchedWith).toEqual([]);
    expect(lastPush().error).toContain("not currently available");
    expect(lastPush().mode).toBe("mirror");
  });

  it("joins a controller-proven live endpoint and detaches back to its follower", async () => {
    const shared = descriptor({
      sessionId: "shared-1",
      cwd: "/home/dev/volter/shared",
      liveEndpoint: "supercode-live://fake/shared-1",
      liveStatus: "idle",
    });
    const { daemon, client, host, lastPush } = await sessionRig([OWN, shared]);
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(shared.locator) });
    expect(lastPush()).toMatchObject({ mode: "mirror", canAttach: true });

    await host.fireIntent(INTENT_QUEUE, { action: "join" });
    await daemon.flush();
    expect(client.attachedWith).toEqual([expect.objectContaining({
      harness: "claude-code",
      runtime_id: "shared-1",
      base_url: "supercode-live://fake/shared-1",
    })]);
    expect(lastPush()).toMatchObject({ mode: "control", strategy: "attach", canDetach: true });

    await host.fireIntent(INTENT_QUEUE, { action: "detach" });
    await daemon.flush();
    expect(client.attachedRuntimes[0]?.closed).toBe(true);
    expect(lastPush()).toMatchObject({ mode: "mirror", strategy: null, canAttach: true });
  });

  it("keeps a continued conversation alive while another chat is viewed", async () => {
    const { daemon, client, host, lastPush } = await sessionRig();
    const atlasKey = sessionKey(ATLAS.locator);
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: atlasKey });
    await host.fireIntent(INTENT_QUEUE, { action: "resume" });
    const continued = daemon.activeController();
    await host.fireIntent(INTENT_QUEUE, { action: "send", text: "continue the work" });
    expect(client.resumedRuntimes[0]?.sent).toEqual(["continue the work"]);

    await host.fireIntent(INTENT_QUEUE, { action: "release" });
    expect(daemon.activeController()).toBe(daemon.controller);
    expect(client.resumedRuntimes[0]?.closed).toBe(false);
    client.resumedRuntimes[0]?.assistantMessage("background result");
    await waitFor(() => continued.getSnapshot().conversation.some(
      (entry) => entry.kind === "message" && entry.text === "background result",
    ));

    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: atlasKey });
    await daemon.flush();
    expect(daemon.activeController()).toBe(continued);
    expect(lastPush()).toMatchObject({ mode: "control", attached: { name: "atlas" } });
    expect(lastPush().transcript.some((entry) => entry.text === "background result")).toBe(true);
  });

  it("closes every retained continued runtime when the daemon stops", async () => {
    const { daemon, client, host } = await sessionRig();
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(ATLAS.locator) });
    await host.fireIntent(INTENT_QUEUE, { action: "resume" });
    await host.fireIntent(INTENT_QUEUE, { action: "release" });

    await daemon.stop();
    running.length = 0;
    expect(client.resumedRuntimes[0]?.closed).toBe(true);
  });

  it("refuses to native-resume a process-reported live session", async () => {
    const liveGrok = descriptor({
      harness: "grok",
      sessionId: "grok-live",
      cwd: "/home/dev/volter/grok-live",
      liveStatus: "busy",
      text: "still running elsewhere",
    });
    const client = new FakeHarnessClient({
      harnesses: [localHarness("claude-code"), localHarness("grok")],
      sessions: [OWN, liveGrok],
    });
    const { daemon, host, lastPush } = await sessionRig(client.sessions, client);
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(liveGrok.locator) });
    await host.fireIntent(INTENT_QUEUE, { action: "resume" });
    await daemon.flush();

    expect(client.resumedWith).toEqual([]);
    expect(lastPush()).toMatchObject({ mode: "mirror", canSend: false });
    expect(lastPush().error).toContain("active in another agent window");
  });

  it("never leaves a follower behind when two rows are tapped in a row", async () => {
    const { daemon, client, lastPush } = await sessionRig();
    await Promise.all([daemon.attach(sessionKey(ATLAS.locator)), daemon.attach(sessionKey(BRIDGE.locator))]);
    await daemon.flush();
    expect(client.activeFollows).toBe(1);
    expect(lastPush().attached).toMatchObject({ name: "bridge", harness: "codex" });
    expect(lastPush().transcript.map((e) => e.text)).toEqual(["codex over here"]);
    // And teardown ends the survivor too.
    await daemon.stop();
    running.length = 0;
    expect(client.activeFollows).toBe(0);
  });

  it("says so instead of guessing when the key names nothing", async () => {
    const { daemon, host, logs, lastPush } = await sessionRig();
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: "claude-code-deadbeef" });
    await daemon.flush();
    expect(logs.some((l) => l.includes("no discovered session"))).toBe(true);
    expect(lastPush().attached).toMatchObject({ name: "project" });
  });

  it("tells the panel about a key it could not resolve, rather than only the log", async () => {
    const { daemon, host, lastPush } = await sessionRig();
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: "claude-code-deadbeef" });
    await daemon.flush();
    expect(lastPush().attachError).toEqual({
      key: "claude-code-deadbeef",
      message: "that session is no longer in the list",
    });
  });
});

// ── an attach that FAILS ────────────────────────────────────────────────────────────────────────
// The defect this closes: the daemon logged `attach failed: … cannot reconstruct lossless Claude
// continuation … missing parentUuid` and pushed nothing, so the tapped row said "opening…" for as
// long as the panel stayed open. The failure is state now, and it crosses the wire.

const REAL_FAILURE =
  "SDK execution failed for Load: cannot reconstruct lossless Claude continuation: missing parentUuid";

/** A controller that cannot come up — the shape every real attach failure reaches the daemon as. */
function brokenController(reason: string): AgentController {
  return {
    getSnapshot: () => ({}) as SupercodeClientSnapshot,
    subscribe: () => (): void => undefined,
    initialize: async () => {
      throw new Error(reason);
    },
    dispatch: async () => {
      throw new Error(reason);
    },
    close: async (): Promise<void> => undefined,
  };
}

function hangingController(): AgentController {
  return {
    ...brokenController("unused"),
    initialize: () => new Promise<SupercodeClientSnapshot>(() => undefined),
  };
}

/** Like `sessionRig`, but attaching to ONE named workspace fails; every other attach is the real thing. */
async function failingAttachRig(
  reason: string,
  failWorkspace = "/home/dev/volter/atlas",
  attachTimeoutMs?: number,
  hang = false,
): Promise<Rig & { logs: string[] }> {
  const client = new FakeHarnessClient({ sessions: [OWN, ATLAS, BRIDGE] });
  const logs: string[] = [];
  const host = new FakeWidgetHost();
  const daemon = await startDaemon({
    sessionId: "session-abc",
    html: "<html></html>",
    workspace: "/tmp/project",
    client,
    pushDebounceMs: 5,
    home: "/home/dev",
    now: () => 2_000_000,
    attachHost: async () => host,
    log: (m) => logs.push(m),
    ...(attachTimeoutMs === undefined ? {} : { attachTimeoutMs }),
    createController: ({ workspace }) =>
      workspace === failWorkspace
        ? hang ? hangingController() : brokenController(reason)
        : (new SupercodeController({ client, workspace, ownsClient: false }) as unknown as AgentController),
  });
  running.push(daemon);
  return { daemon, host, client, logs, attached: [], lastPush: () => host.pushes.at(-1) as WidgetState };
}

describe("an attach that fails", () => {
  it("turns a hung harness attach into a visible row error", async () => {
    const { host, lastPush } = await failingAttachRig("unused", "/home/dev/volter/atlas", 5, true);
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(ATLAS.locator) });
    expect(lastPush().attachError).toEqual({
      key: sessionKey(ATLAS.locator),
      message: "could not open this session within 1 second",
    });
  });

  it("pushes the reason, keyed to the row that was tapped", async () => {
    const { daemon, host, logs, lastPush } = await failingAttachRig(REAL_FAILURE);
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(ATLAS.locator) });
    await daemon.flush();
    expect(lastPush().attachError).toEqual({ key: sessionKey(ATLAS.locator), message: REAL_FAILURE });
    expect(logs.some((l) => l.startsWith("attach failed"))).toBe(true);
    // The panel is still on the session it was on — a failed attach moves nothing.
    expect(lastPush().attached).toMatchObject({ name: "project" });
    expect(lastPush().canSend).toBe(true);
  });

  it("cuts a stack-trace-length message to one row's worth", async () => {
    const { daemon, host, lastPush } = await failingAttachRig("z".repeat(5000));
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(ATLAS.locator) });
    await daemon.flush();
    expect(lastPush().attachError?.message.length).toBe(MAX_ATTACH_ERROR_CHARS + 1);
  });

  it("clears on the next attempt, and that attempt still lands cleanly", async () => {
    const { daemon, client, host, lastPush } = await failingAttachRig(REAL_FAILURE);
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(ATLAS.locator) });
    expect(lastPush().attachError).not.toBeNull();
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(BRIDGE.locator) });
    await daemon.flush();
    expect(lastPush().attachError).toBeNull();
    expect(lastPush().attached).toMatchObject({ name: "bridge", harness: "codex" });
    // The failed candidate left nothing streaming behind it.
    expect(client.activeFollows).toBe(1);
  });

  it("leaves no follower and no stale error when two rows are tapped after a failure", async () => {
    const { daemon, client, lastPush } = await failingAttachRig(REAL_FAILURE);
    await daemon.attach(sessionKey(ATLAS.locator));
    expect(lastPush().attachError).not.toBeNull();
    await Promise.all([daemon.attach(sessionKey(ATLAS.locator)), daemon.attach(sessionKey(BRIDGE.locator))]);
    await daemon.flush();
    expect(client.activeFollows).toBe(1);
    expect(lastPush().attached).toMatchObject({ name: "bridge" });
    expect(lastPush().attachError).toBeNull();
  });

  it("clears when the panel goes back to the session this daemon started", async () => {
    const { daemon, host, lastPush } = await failingAttachRig(REAL_FAILURE);
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(ATLAS.locator) });
    expect(lastPush().attachError).not.toBeNull();
    await host.fireIntent(INTENT_QUEUE, { action: "attach", key: sessionKey(OWN.locator) });
    await daemon.flush();
    expect(lastPush().attachError).toBeNull();
    expect(lastPush()).toMatchObject({ canSend: true, attached: { name: "project" } });
  });
});

describe("liveness on the pushed rows", () => {
  it("is recency of each session's own store, not which one the panel follows", async () => {
    // `sessionRig` pins now to 2_000_000: ATLAS's store was written at that instant, BRIDGE's 500s
    // earlier and OWN's 1000s earlier — both outside the five-minute liveness window.
    const { lastPush } = await sessionRig();
    const rows = lastPush().sessions;
    expect(rows.map((r) => [r.name, r.live])).toEqual([
      ["atlas", true],
      ["bridge", false],
      ["project", false],
    ]);
    // The two facts are independent in both directions: the live row is not the followed one, and
    // the followed one is not live. That is the whole point — the dot was reading as "everything is
    // dead" precisely because it was drawing attachment instead of liveness.
    expect(rows.filter((r) => r.active).map((r) => r.name)).toEqual(["project"]);
    expect(rows.find((r) => r.name === "atlas")?.active).toBe(false);
  });
});
