import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DISCOVER_INTERVAL_MS,
  DEFAULT_PUSH_DEBOUNCE_MS,
  DEFAULT_REPUSH_INTERVAL_MS,
  INTENT_QUEUE,
  WIDGET_NS,
  chooseHarness,
  parseAttachIntent,
  parseSendIntent,
  startDaemon,
  type Daemon,
} from "../src/daemon.js";
import { DEFAULT_MAX_ENTRIES } from "../src/projection.js";
import type { WidgetState } from "../src/projection.js";
import { sessionKey } from "../src/sessions.js";
import { FakeHarnessClient, FakeWidgetHost, descriptor, localHarness, waitFor } from "./fakes.js";
import type { SupercodeClientSnapshot } from "@volter-ai-dev/supercode-client";

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

describe("startDaemon", () => {
  it("mounts the widget under the shared namespace and starts a session", async () => {
    const { attached, client, lastPush } = await rig();
    expect(attached).toEqual([
      { sessionId: "session-abc", ns: WIDGET_NS, html: "<!doctype html><html></html>" },
    ]);
    // The controller's own default policy — the daemon invents no gate of its own.
    expect(client.startedWith).toEqual([{ harness: "claude-code", cwd: "/tmp/project", policy: "default" }]);
    expect(lastPush()).toMatchObject({
      pill: { tone: "live", label: "claude-code ready" },
      harness: "claude-code",
      canSend: true,
      busy: false,
      transcript: [],
    });
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
      "attached",
      "busy",
      "canSend",
      "error",
      "harness",
      "pill",
      "sessions",
      "transcript",
    ]);
    expect(push["conversation"]).toBeUndefined();
    expect(push["harnesses"]).toBeUndefined();
  });

  it("caps what crosses the wire, however long the session runs", async () => {
    const { host, client, daemon } = await rig();
    for (let i = 0; i < 120; i += 1) client.runtime.assistantMessage(`${i}:${"y".repeat(5000)}`);
    await waitFor(() => (host.pushes.at(-1) as WidgetState).transcript.length > 0);
    await daemon.flush();
    const state = host.pushes.at(-1) as WidgetState;
    expect(state.transcript.length).toBe(DEFAULT_MAX_ENTRIES);
    expect(state.transcript[0]?.text.startsWith("70:")).toBe(true);
    for (const entry of state.transcript) {
      expect(entry.truncated).toBe(true);
      expect(entry.text.length).toBeLessThanOrEqual(2001);
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

describe("re-push heartbeat", () => {
  // The bug this guards: a shell mounted on a page navigated AFTER the last revision-driven push
  // (agent idle) starts empty and stays empty. The heartbeat re-pushes current state on a steady
  // tick so a fresh mount populates without an agent event.
  it("registers a heartbeat that re-pushes the current state, and stop() ends it", async () => {
    const { daemon, host } = await rig();
    // Two timers: the re-push heartbeat, then the session-discovery scan.
    expect(host.ticks.map((t) => t.ms)).toEqual([DEFAULT_REPUSH_INTERVAL_MS, DEFAULT_DISCOVER_INTERVAL_MS]);
    const before = host.pushes.length;
    await host.ticks[0]!.fn();
    expect(host.pushes.length).toBe(before + 1);
    expect(host.pushes.at(-1)).toEqual(host.pushes.at(-2)); // same state, re-delivered for fresh mounts
    await daemon.stop();
    expect(host.ticks.every((t) => t.stopped)).toBe(true);
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
const BRIDGE = descriptor({
  harness: "codex",
  sessionId: "bridge-1",
  cwd: "/home/dev/volter/bridge",
  title: "Bridge deploy",
  text: "codex over here",
  updatedAtMs: 1_500_000,
});

async function sessionRig(sessions = [OWN, ATLAS, BRIDGE]): Promise<Rig & { logs: string[] }> {
  const client = new FakeHarnessClient({ sessions });
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
  });
  running.push(daemon);
  return { daemon, host, client, logs, attached: [], lastPush: () => host.pushes.at(-1) as WidgetState };
}

describe("the Sessions list", () => {
  it("shows every session on the machine, not just this workspace's", async () => {
    const { client, lastPush } = await sessionRig();
    // The scan that fills the panel carries NO workspace — that is what makes it global.
    expect(client.discoverQueries.some((q) => q.workspace === undefined && q.limit === 30)).toBe(true);
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
});
