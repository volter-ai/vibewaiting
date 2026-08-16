import { describe, expect, it } from "vitest";
import {
  EMPTY_STATE,
  isSendKey,
  nearBottom,
  pendingResolved,
  readWidgetState,
  roleLabel,
} from "../widget/state.js";
import { project } from "../src/projection.js";
import type { SupercodeClientSnapshot } from "@volter-ai-dev/supercode-client";

describe("readWidgetState", () => {
  it("renders something sane before the first push has landed", () => {
    expect(readWidgetState(undefined)).toEqual(EMPTY_STATE);
    expect(readWidgetState({})).toMatchObject({ transcript: [], pill: { tone: "off", label: "" } });
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
      connection: { mode: "control", strategy: "start", follow: "inactive", ownsRuntime: true },
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
