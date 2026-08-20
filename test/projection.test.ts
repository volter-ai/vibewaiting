import { describe, expect, it } from "vitest";
import type { SupercodeClientSnapshot } from "@volter-ai-dev/supercode-client";
import { projectClientSnapshot } from "@volter-ai-dev/supercode-ui/controller";
import {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_ENTRY_CHARS,
  MAX_ATTACH_ERROR_CHARS,
  project,
  toAttachError,
} from "../src/projection.js";

function snapshot(over: Partial<SupercodeClientSnapshot> = {}): SupercodeClientSnapshot {
  return {
    schema: "supercode.client-state.v1",
    revision: 1,
    workspace: "/w",
    availability: "ready",
    operation: null,
    harnesses: [],
    sessions: [],
    activeSessionKey: null,
    activeHarness: null,
    activeSessionId: null,
    activeSession: null,
    taskPlan: { source: "none", items: [], residue: [], observedAt: null },
    connection: { mode: "none", strategy: null, follow: "inactive", ownsRuntime: false, messaging: null },
    turn: { state: "idle", id: null, startedAt: null },
    conversation: [],
    requests: [],
    availableActions: {
      refresh: true,
      observe: false,
      start: true,
      resume: false,
      attach: false,
      branch: false,
      reduce: false,
      detach: false,
      openTerminal: false,
      send: false,
      interrupt: false,
      respond: false,
    },
    error: null,
    terminalLaunch: null,
    delivery: null,
    reductionReceipt: null,
    ...over,
  };
}

describe("project", () => {
  it("is the canonical bounded Supercode UI projection", () => {
    const input = snapshot({
      activeHarness: "codex",
      conversation: [{
        id: "m1",
        kind: "message",
        role: "assistant",
        text: "hello",
        content: "hello",
        metadata: {},
        visibility: "conversation",
      }],
    });

    expect(project(input)).toEqual(projectClientSnapshot(input, {
      maxEntries: DEFAULT_MAX_ENTRIES,
      maxScanEntries: DEFAULT_MAX_ENTRIES * 4,
      maxEntryChars: DEFAULT_MAX_ENTRY_CHARS,
    }));
  });

  it("passes consumer bounds through without recreating projection semantics", () => {
    const input = snapshot({
      conversation: Array.from({ length: 8 }, (_, index) => ({
        id: `m${index}`,
        kind: "message" as const,
        role: "assistant" as const,
        text: "abcdefghij",
        content: "abcdefghij",
        metadata: {},
        visibility: "conversation" as const,
      })),
    });
    const bounds = { maxEntries: 2, maxScanEntries: 3, maxEntryChars: 4 };

    expect(project(input, bounds)).toEqual(projectClientSnapshot(input, bounds));
  });
});

describe("toAttachError", () => {
  it("keeps the host failure row-scoped and bounded", () => {
    expect(toAttachError("session-1", "  cannot attach  ")).toEqual({
      key: "session-1",
      message: "cannot attach",
    });
    const long = toAttachError("session-1", "x".repeat(5_000));
    expect(Array.from(long.message)).toHaveLength(MAX_ATTACH_ERROR_CHARS + 1);
    expect(long.message.endsWith("…")).toBe(true);
  });
});
