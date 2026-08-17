import { describe, expect, it } from "vitest";
import {
  EMPTY_STATE,
  attachOutcome,
  attachSettled,
  isSendKey,
  listRows,
  nearBottom,
  openingMessage,
  pendingResolved,
  pillFor,
  readWidgetState,
  roleLabel,
  startupMessage,
} from "../widget/state.js";
import { project } from "../src/projection.js";
import type { SupercodeClientSnapshot } from "@volter-ai-dev/supercode-client";

describe("readWidgetState", () => {
  it("renders something sane before the first push has landed", () => {
    expect(readWidgetState(undefined)).toEqual(EMPTY_STATE);
    expect(readWidgetState({})).toMatchObject({ startup: "connecting", transcript: [], pill: { tone: "off", label: "" } });
  });

  it("round-trips exactly what the projection pushes", () => {
    const snapshot = {
      schema: "supercode.client-state.v1",
      revision: 1,
      workspace: "/w",
      availability: "ready",
      operation: null,
      harnesses: [],
      sessions: [],
      activeSessionKey: null,
      activeHarness: "codex",
      activeSessionId: null,
      activeSession: null,
      taskPlan: { source: "none", items: [], residue: [], observedAt: null },
      connection: { mode: "control", strategy: "start", follow: "inactive", ownsRuntime: true, messaging: null },
      turn: { state: "idle", id: null, startedAt: null },
      conversation: [
        {
          id: "a",
          kind: "message",
          role: "user",
          text: "hi",
          content: "hi",
          metadata: {},
          visibility: "conversation",
        },
      ],
      requests: [],
      availableActions: {
        refresh: true,
        observe: false,
        start: true,
        resume: false,
        attach: false,
        branch: false,
        detach: false,
        openTerminal: false,
        send: true,
        interrupt: false,
        respond: false,
      },
      error: null,
      terminalLaunch: null,
      delivery: null,
    } as SupercodeClientSnapshot;
    const pushed = JSON.parse(JSON.stringify(project(snapshot))) as unknown;
    expect(readWidgetState(pushed)).toEqual(project(snapshot));
  });

  it("drops malformed rows instead of rendering undefined", () => {
    const state = readWidgetState({
      pill: { tone: "chartreuse", label: 7 },
      transcript: [
        { id: "ok", role: "user", text: "fine", ts: null, truncated: false },
        { id: "bad-role", role: "wizard", text: "x" },
        { role: "user", text: "no id" },
        "not an object",
      ],
      busy: "yes",
      harness: null,
    });
    expect(state.pill).toEqual({ tone: "off", label: "" });
    expect(state.transcript).toEqual([{ id: "ok", role: "user", text: "fine", ts: null, truncated: false }]);
    expect(state.busy).toBe(false);
    expect(state.harness).toBe("");
    expect(state.startup).toBe("connecting");
  });
});

describe("startupMessage", () => {
  it("makes every bootstrap wait specific and visibly progressive", () => {
    expect(startupMessage("connecting", "")).toMatchObject({ title: "Connecting to coding agents", step: 0 });
    expect(startupMessage("starting", "claude-code")).toMatchObject({ title: "Starting Claude Code", step: 1 });
    expect(startupMessage("discovering", "claude-code")).toMatchObject({ title: "Loading recent sessions", step: 2 });
    expect(startupMessage("ready", "claude-code")).toMatchObject({ title: "Ready", step: 3 });
  });
});

describe("composer key handling", () => {
  it("sends on Enter, newlines on Shift+Enter, never mid-composition", () => {
    expect(isSendKey({ key: "Enter", shiftKey: false })).toBe(true);
    expect(isSendKey({ key: "Enter", shiftKey: true })).toBe(false);
    expect(isSendKey({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(isSendKey({ key: "a", shiftKey: false })).toBe(false);
  });
});

describe("transcript scrolling", () => {
  it("sticks to the bottom only while the reader is already there", () => {
    expect(nearBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
    expect(nearBottom({ scrollTop: 870, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
    expect(nearBottom({ scrollTop: 200, scrollHeight: 1000, clientHeight: 100 })).toBe(false);
  });
});

describe("rich transcript details", () => {
  it("keeps only role-appropriate tool and reasoning presentation fields", () => {
    const state = readWidgetState({
      transcript: [
        {
          id: "tool",
          role: "tool",
          text: "42 lines",
          ts: null,
          truncated: false,
          label: "Read",
          arguments: '{"path":"a.ts"}',
          resultText: "42 lines",
          status: "completed",
          streaming: true,
        },
        {
          id: "thought",
          role: "reasoning",
          text: "checking",
          ts: null,
          truncated: false,
          label: "not a tool",
          status: "error",
          streaming: true,
        },
      ],
    });

    expect(state.transcript).toEqual([
      {
        id: "tool",
        role: "tool",
        text: "42 lines",
        ts: null,
        truncated: false,
        label: "Read",
        arguments: '{"path":"a.ts"}',
        resultText: "42 lines",
        status: "completed",
      },
      {
        id: "thought",
        role: "reasoning",
        text: "checking",
        ts: null,
        truncated: false,
        streaming: true,
      },
    ]);
  });
});

describe("pending prompt echo", () => {
  const row = (role: "user" | "assistant", text: string) =>
    ({ id: text, role, text, ts: null, truncated: false }) as const;

  it("clears once the real transcript carries the prompt", () => {
    expect(pendingResolved("build it", [row("user", "build it")])).toBe(true);
    expect(pendingResolved("build it", [row("assistant", "build it")])).toBe(false);
    expect(pendingResolved("build it", [row("user", "something else")])).toBe(false);
    expect(pendingResolved(null, [])).toBe(true);
  });
});

describe("roleLabel", () => {
  it("names the non-obvious roles in human words", () => {
    expect(roleLabel("assistant")).toBe("agent");
    expect(roleLabel("reasoning")).toBe("thinking");
    expect(roleLabel("request")).toBe("asks");
    expect(roleLabel("user")).toBe("user");
    expect(roleLabel("tool")).toBe("tool");
  });
});

// ── the messenger: which view, and what the pill says ───────────────────────────────────────────

describe("session rows in a patch", () => {
  it("keeps the rows the host pushed and drops malformed ones", () => {
    const state = readWidgetState({
      sessions: [
        {
          key: "claude-code-1a2b3c4d",
          harness: "claude-code",
          name: "atlas",
          cwd: "~/volter/atlas",
          title: "Rewrite the parser",
          age: "3m ago",
          updatedAt: 1700,
          messages: 42,
          active: true,
          live: true,
        },
        { harness: "codex", name: "no key" },
        "not an object",
      ],
      attached: { key: "claude-code-1a2b3c4d", harness: "claude-code", name: "atlas", cwd: "~/volter/atlas", title: "" },
    });
    expect(state.sessions.map((s) => s.key)).toEqual(["claude-code-1a2b3c4d"]);
    expect(state.sessions[0]?.active).toBe(true);
    expect(state.sessions[0]?.live).toBe(true);
    expect(state.attached?.name).toBe("atlas");
  });

  it("reads liveness as its own fact, never inferred from the followed row", () => {
    const row = (over: Record<string, unknown>): Record<string, unknown> => ({
      key: "k",
      harness: "codex",
      name: "atlas",
      cwd: "~/a",
      title: "t",
      age: "now",
      updatedAt: 1,
      messages: 1,
      active: false,
      ...over,
    });
    const state = readWidgetState({
      sessions: [row({ key: "k1", live: true }), row({ key: "k2", active: true }), row({ key: "k3" })],
    });
    // The followed row is not automatically live, and a live row is not automatically followed.
    expect(state.sessions.map((s) => [s.live, s.active])).toEqual([
      [true, false],
      [false, true],
      [false, false],
    ]);
  });

  it("carries a failed attach through, and drops a malformed one", () => {
    expect(readWidgetState({ attachError: { key: "k2", message: "missing parentUuid" } }).attachError).toEqual({
      key: "k2",
      message: "missing parentUuid",
    });
    expect(readWidgetState({ attachError: { key: "k2", message: "" } }).attachError).toBeNull();
    expect(readWidgetState({ attachError: { message: "no key" } }).attachError).toBeNull();
    expect(readWidgetState({ attachError: "boom" }).attachError).toBeNull();
    expect(readWidgetState({}).attachError).toBeNull();
  });

  it("has no sessions and no attachment before the first push", () => {
    expect(readWidgetState(undefined).sessions).toEqual([]);
    expect(readWidgetState({ attached: { name: "atlas" } }).attached).toBeNull();
  });
});

describe("attachSettled", () => {
  const attached = { key: "k2", harness: "codex", name: "bridge", cwd: "~/b", title: "" };

  it("opens the chat only once the host confirms the session the row asked for", () => {
    expect(attachSettled("k2", attached)).toBe(true);
    // Still showing the previous session — switching now would put the old transcript under the new name.
    expect(attachSettled("k2", { ...attached, key: "k1" })).toBe(false);
    expect(attachSettled("k2", null)).toBe(false);
    expect(attachSettled(null, attached)).toBe(false);
  });
});

describe("attachOutcome", () => {
  const attached = { key: "k2", harness: "codex", name: "bridge", cwd: "~/b", title: "" };
  const failed = { key: "k2", message: "cannot reconstruct lossless Claude continuation" };

  it("ends the wait on a failure, not only on a success", () => {
    // The black hole: before the host reported failures this row said "opening…" forever.
    expect(attachOutcome("k2", null, failed)).toBe("failed");
    expect(attachOutcome("k2", { ...attached, key: "k1" }, failed)).toBe("failed");
    expect(attachOutcome("k2", attached, null)).toBe("attached");
    expect(attachOutcome("k2", null, null)).toBe("waiting");
  });

  it("is not moved by a failure belonging to another row", () => {
    expect(attachOutcome("k2", null, { ...failed, key: "k9" })).toBe("waiting");
    // Nothing was asked for, so nothing settles — a stale error must not open or close anything.
    expect(attachOutcome(null, attached, failed)).toBe("waiting");
  });

  it("prefers the attach that landed over an error carrying the same key", () => {
    expect(attachOutcome("k2", attached, failed)).toBe("attached");
  });
});

describe("openingMessage", () => {
  it("keeps a slow transcript attach visibly progressing", () => {
    expect(openingMessage(0)).toBe("Opening");
    expect(openingMessage(5_000)).toBe("Loading transcript");
    expect(openingMessage(20_000)).toBe("Still loading");
  });
});

describe("pillFor", () => {
  const base = { ...EMPTY_STATE, pill: { tone: "live" as const, label: "claude-code ready" } };

  it("reports the attached session's own status", () => {
    const state = { ...base, attached: { key: "k", harness: "claude-code", name: "atlas", cwd: "~/a", title: "" } };
    expect(pillFor(state)).toEqual({ tone: "live", label: "claude-code ready" });
  });

  it("counts what is waiting when nothing is attached", () => {
    const row = {
      key: "k",
      harness: "codex",
      name: "atlas",
      cwd: "~/a",
      title: "t",
      age: "now",
      updatedAt: 1,
      messages: 1,
      active: false,
      live: true,
    };
    expect(pillFor({ ...base, sessions: [row] })).toEqual({ tone: "live", label: "1 session" });
    expect(pillFor({ ...base, sessions: [row, { ...row, key: "k2" }] })).toEqual({ tone: "live", label: "2 sessions" });
    // Nothing attached and nothing found: the host's own words stand.
    expect(pillFor(base)).toEqual({ tone: "live", label: "claude-code ready" });
  });
});

describe("listRows", () => {
  const row = {
    key: "k1",
    harness: "codex",
    name: "bridge",
    cwd: "~/b",
    title: "t",
    age: "now",
    updatedAt: 1,
    messages: 3,
    active: false,
    live: false,
  };

  it("is just what discovery found, once the attached session is among it", () => {
    const state = { ...EMPTY_STATE, sessions: [row], attached: { key: "k1", harness: "codex", name: "bridge", cwd: "~/b", title: "t" } };
    expect(listRows(state)).toEqual([row]);
    expect(listRows({ ...EMPTY_STATE, sessions: [row] })).toEqual([row]);
  });

  it("still lists a just-started session discovery has not persisted yet", () => {
    const state = {
      ...EMPTY_STATE,
      sessions: [row],
      attached: { key: "", harness: "claude-code", name: "atlas", cwd: "~/volter/atlas", title: "" },
      owned: { key: "", harness: "claude-code", name: "atlas", cwd: "~/volter/atlas", title: "" },
    };
    const rows = listRows(state);
    expect(rows.length).toBe(2);
    // It is the session the panel is attached to right now — live by definition, with no descriptor
    // timestamp to read it from.
    expect(rows[0]).toMatchObject({ key: "", name: "atlas", harness: "claude-code", active: true, age: "", live: true });
  });

  it("keeps a fresh owned runtime reachable while viewing a foreign mirror", () => {
    const rows = listRows({
      ...EMPTY_STATE,
      sessions: [row],
      attached: { key: "k1", harness: "codex", name: "bridge", cwd: "~/b", title: "t" },
      owned: { key: "", harness: "claude-code", name: "vibewaiting", cwd: "~/vibewaiting", title: "" },
    });
    expect(rows[0]).toMatchObject({ key: "", name: "vibewaiting", active: false, live: true });
    expect(rows[1]).toEqual(row);
  });
});
