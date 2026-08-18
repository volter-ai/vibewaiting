import { describe, expect, it } from "vitest";
import type {
  ConversationEntry,
  SupercodeClientSnapshot,
} from "@volter-ai-dev/supercode-client";
import {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_ENTRY_CHARS,
  MAX_ATTACH_ERROR_CHARS,
  MAX_PILL_LABEL_CHARS,
  derivePill,
  project,
  projectEntry,
  projectTranscript,
  timestampFromMetadata,
  toAttachError,
} from "../src/projection.js";

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────
// Shapes come from the client package's own `SupercodeClientSnapshot` / `ConversationEntry`
// declarations (node_modules/@volter-ai-dev/supercode-client/index.d.ts), so a package upgrade that
// changes them fails typecheck here rather than silently projecting the wrong thing.

function message(over: Partial<Extract<ConversationEntry, { kind: "message" }>> = {}): ConversationEntry {
  return {
    id: "m1",
    kind: "message",
    role: "assistant",
    text: "hello",
    content: "hello",
    metadata: {},
    visibility: "conversation",
    ...over,
  };
}

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

const control = {
  mode: "control",
  strategy: "start",
  follow: "inactive",
  ownsRuntime: true,
  messaging: null,
} satisfies SupercodeClientSnapshot["connection"];

// ── transcript ──────────────────────────────────────────────────────────────────────────────────

describe("projectEntry", () => {
  it("keeps a conversation message's role and text", () => {
    expect(projectEntry(message({ role: "user", text: "ship it" }), 100)).toEqual({
      id: "m1",
      role: "user",
      text: "ship it",
      ts: null,
      truncated: false,
    });
  });

  it("drops context-visibility messages — the harness's scaffolding is not the conversation", () => {
    expect(projectEntry(message({ visibility: "context" }), 100)).toBeNull();
  });

  it("renders a completed tool call as its name and result", () => {
    const row = projectEntry(
      {
        id: "t1",
        kind: "tool",
        callId: "c1",
        name: "Read",
        arguments: '{"path":"a.ts"}',
        resultText: "  42 lines  ",
        resultContent: "",
        status: "completed",
        metadata: {},
      },
      500,
    );
    expect(row).toMatchObject({
      id: "t1",
      role: "tool",
      label: "Read",
      status: "completed",
      text: "42 lines",
      arguments: '{"path":"a.ts"}',
      resultText: "42 lines",
    });
  });

  it("shows a pending tool call's arguments, since it has no result yet", () => {
    const row = projectEntry(
      {
        id: "t2",
        kind: "tool",
        callId: "c2",
        name: "Bash",
        arguments: "npm test",
        resultText: "",
        resultContent: "",
        status: "pending",
        metadata: {},
      },
      500,
    );
    expect(row).toMatchObject({ label: "Bash", status: "pending", text: "npm test" });
  });

  it("marks a failed tool call", () => {
    const row = projectEntry(
      {
        id: "t3",
        kind: "tool",
        callId: "c3",
        name: "Bash",
        arguments: "",
        resultText: "exit 1",
        resultContent: "",
        status: "error",
        metadata: {},
      },
      500,
    );
    expect(row).toMatchObject({ label: "Bash", status: "error", text: "exit 1" });
  });

  it("keeps an approval request's options visible", () => {
    const row = projectEntry(
      {
        id: "r1",
        kind: "request",
        requestId: 7,
        requestKind: "command_approval",
        payload: null,
        options: [
          { optionId: "a", name: "Allow", kind: "allow_once" },
          { optionId: "d", name: "Deny", kind: "reject_once" },
        ],
        cancellable: true,
        status: "pending",
        resolution: null,
      },
      500,
    );
    expect(row).toMatchObject({
      role: "request",
      text: "command_approval: Allow / Deny",
      request: {
        requestId: 7,
        requestKind: "command_approval",
        payloadText: "null",
        options: [
          { optionId: "a", name: "Allow", kind: "allow_once" },
          { optionId: "d", name: "Deny", kind: "reject_once" },
        ],
        cancellable: true,
        status: "pending",
        resolution: null,
      },
    });
  });

  it("projects reasoning and notices as their own roles", () => {
    expect(projectEntry({ id: "x1", kind: "reasoning", text: "hmm", streaming: true }, 500)).toMatchObject({
      role: "reasoning",
      text: "hmm",
      streaming: true,
    });
    expect(projectEntry({ id: "n1", kind: "notice", code: "reconnected", text: "" }, 500)).toMatchObject({
      role: "notice",
      text: "reconnected",
    });
  });

  it("truncates long text and says so", () => {
    const row = projectEntry(message({ text: "x".repeat(5000) }), 2000);
    expect(row?.truncated).toBe(true);
    expect(row?.text.length).toBe(2001); // 2000 chars + the ellipsis
  });

  it("reads a timestamp out of harness metadata, in every encoding that occurs", () => {
    expect(projectEntry(message({ metadata: { timestamp: "1755000000000" } }), 50)?.ts).toBe(1755000000000);
    expect(projectEntry(message({ metadata: { timestamp: "1755000000" } }), 50)?.ts).toBe(1755000000000);
    expect(projectEntry(message({ metadata: { created_at: "2026-08-16T12:00:00.000Z" } }), 50)?.ts).toBe(
      Date.parse("2026-08-16T12:00:00.000Z"),
    );
  });

  it("never invents a timestamp when the harness recorded none", () => {
    expect(projectEntry(message(), 50)?.ts).toBeNull();
    expect(timestampFromMetadata({ timestamp: "not-a-time" })).toBeNull();
    expect(timestampFromMetadata(undefined)).toBeNull();
  });
});

describe("projectTranscript", () => {
  it("keeps only the trailing window, in order", () => {
    const long: ConversationEntry[] = Array.from({ length: DEFAULT_MAX_ENTRIES + 70 }, (_, i) =>
      message({ id: `m${i}`, text: `line ${i}` }),
    );
    const rows = projectTranscript(long);
    expect(rows.length).toBe(DEFAULT_MAX_ENTRIES);
    expect(rows[0]?.id).toBe("m70");
    expect(rows.at(-1)?.id).toBe(`m${DEFAULT_MAX_ENTRIES + 69}`);
  });

  it("counts the window in RENDERED rows — hidden context messages do not eat it", () => {
    const mixed: ConversationEntry[] = Array.from({ length: 40 }, (_, i) =>
      message({ id: `m${i}`, visibility: i % 2 === 0 ? "context" : "conversation" }),
    );
    const rows = projectTranscript(mixed, { maxEntries: 10 });
    expect(rows.length).toBe(10);
    expect(rows.every((r) => r.id.startsWith("m"))).toBe(true);
  });

  it("honors explicit caps", () => {
    const rows = projectTranscript([message({ text: "abcdefghij" })], { maxEntries: 1, maxEntryChars: 4 });
    expect(rows[0]).toMatchObject({ text: "abcd…", truncated: true });
  });
});

// ── pill ────────────────────────────────────────────────────────────────────────────────────────

describe("derivePill", () => {
  it("reports the transport being down before anything else", () => {
    expect(derivePill(snapshot({ availability: "loading" }))).toEqual({ tone: "off", label: "connecting…" });
    expect(
      derivePill(
        snapshot({
          availability: "unavailable",
          error: { code: "spawn", message: "supercode not found", operation: "refresh", recoverable: false },
        }),
      ),
    ).toEqual({ tone: "dead", label: "supercode not found" });
  });

  it("surfaces a structured error over the connection state", () => {
    expect(
      derivePill(
        snapshot({
          connection: control,
          activeHarness: "codex",
          error: { code: "send_failed", message: "runtime closed", operation: "send", recoverable: true },
        }),
      ),
    ).toEqual({ tone: "warn", label: "runtime closed" });
  });

  it("goes live while a turn runs and names the harness", () => {
    expect(
      derivePill(
        snapshot({
          activeHarness: "claude-code",
          connection: control,
          turn: { state: "running", id: "t1", startedAt: 1 },
        }),
      ),
    ).toEqual({ tone: "live", label: "claude-code working…" });
  });

  it("distinguishes idle control from a read-only mirror and from nothing at all", () => {
    expect(derivePill(snapshot({ activeHarness: "grok", connection: control }))).toEqual({
      tone: "live",
      label: "grok ready",
    });
    expect(
      derivePill(
        snapshot({
          activeHarness: "grok",
          connection: { mode: "mirror", strategy: null, follow: "following", ownsRuntime: false, messaging: null },
        }),
      ),
    ).toEqual({ tone: "warn", label: "grok (read-only)" });
    expect(derivePill(snapshot())).toEqual({ tone: "off", label: "no session" });
  });

  it("reports a messageable live peer without calling it read-only", () => {
    expect(
      derivePill(
        snapshot({
          activeHarness: "claude-code",
          connection: {
            mode: "mirror",
            strategy: null,
            follow: "following",
            ownsRuntime: false,
            messaging: "live_peer",
          },
        }),
      ),
    ).toEqual({ tone: "live", label: "claude-code live" });
  });

  it("marks an interrupt and a reconcile distinctly", () => {
    expect(derivePill(snapshot({ turn: { state: "interrupting", id: null, startedAt: null } }))).toMatchObject({
      tone: "warn",
    });
    expect(derivePill(snapshot({ turn: { state: "reconciling", id: null, startedAt: null } }))).toMatchObject({
      tone: "live",
      label: "syncing…",
    });
  });

  it("cuts a pill label to one line of chrome", () => {
    const pill = derivePill(
      snapshot({
        availability: "error",
        error: { code: "x", message: "y".repeat(400), operation: "refresh", recoverable: false },
      }),
    );
    expect(pill.label.length).toBe(MAX_PILL_LABEL_CHARS + 1);
  });
});

describe("toAttachError", () => {
  it("keeps the harness's own words, cut to one row's worth", () => {
    const real =
      "SDK execution failed for Load: cannot reconstruct lossless Claude continuation: missing parentUuid";
    expect(toAttachError("k1", `  ${real}  `)).toEqual({ key: "k1", message: real });
    const long = toAttachError("k1", "x".repeat(5000));
    expect(long.message.length).toBe(MAX_ATTACH_ERROR_CHARS + 1); // + the ellipsis that marks the cut
    expect(long.message.endsWith("…")).toBe(true);
  });
});

// ── the whole projection ────────────────────────────────────────────────────────────────────────

describe("project", () => {
  it("produces the compact widget state", () => {
    const state = project(
      snapshot({
        activeHarness: "codex",
        connection: control,
        conversation: [message({ id: "a", role: "user", text: "hi" }), message({ id: "b", text: "hey" })],
        availableActions: { ...snapshot().availableActions, send: true },
      }),
    );
    expect(state).toEqual({
      pill: { tone: "live", label: "codex ready" },
      startup: "ready",
      transcript: [
        { id: "a", role: "user", text: "hi", ts: null, truncated: false },
        { id: "b", role: "assistant", text: "hey", ts: null, truncated: false },
      ],
      busy: false,
      operation: null,
      needsInput: false,
      harness: "codex",
      mode: "control",
      canSend: true,
      canResume: false,
      canBranch: false,
      canAttach: false,
      canDetach: false,
      canOpenTerminal: false,
      strategy: "start",
      terminalHandoff: null,
      canExport: false,
      canReduce: false,
      exportBackTarget: null,
      exportReceipt: null,
      reductionReceipt: null,
      messaging: null,
      canInterrupt: false,
      canRespond: false,
      workspace: "/w",
      taskPlan: { source: "none", items: [], residueCount: 0, observedAt: null },
      semantics: { fidelity: null, residue: [], residueCount: 0, parseErrors: 0, rawRecords: 0, subagents: [] },
      error: null,
      recoverable: false,
      harnesses: [],
      history: { sessionLimit: 0, hasMoreSessions: false, transcriptLimit: 120, hasEarlier: false },
      savedDraft: "",
      attention: [],
      // Machine-wide facts the snapshot cannot know: the daemon merges them over this result.
      sessions: [],
      attached: null,
      owned: null,
      attachError: null,
    });
  });

  it("is busy for every non-idle turn state", () => {
    for (const state of ["running", "interrupting", "reconciling"] as const) {
      expect(project(snapshot({ turn: { state, id: null, startedAt: null } })).busy).toBe(true);
    }
    expect(project(snapshot()).busy).toBe(false);
  });

  it("retains the normalized cross-harness task plan", () => {
    const state = project(snapshot({
      taskPlan: {
        source: "codex-update-plan",
        items: [{ id: "one", title: "Render Markdown", status: "in_progress" }],
        residue: [{ native: "kept upstream" }],
        observedAt: 123,
      },
    }));
    expect(state.taskPlan).toEqual({
      source: "codex-update-plan",
      items: [{ id: "one", title: "Render Markdown", status: "in_progress" }],
      residueCount: 1,
      observedAt: 123,
    });
  });

  it("projects fidelity residue and subagent summaries without copying child transcripts", () => {
    const state = project(snapshot({
      activeSession: {
        source: "claude_code",
        session_id: "parent",
        model: "opus",
        cwd: "/w",
        system_prompt: null,
        agent_id: null,
        parent_tool_use_id: null,
        lineage: {},
        messages: [],
        subagents: [{
          source: "codex",
          session_id: "child",
          model: "gpt-5",
          cwd: "/w",
          system_prompt: null,
          agent_id: "worker",
          parent_tool_use_id: null,
          lineage: {},
          messages: [
            { role: "user", content: "large child prompt", metadata: {} },
            { role: "assistant", content: "large child answer", metadata: {} },
          ],
          subagents: [],
          raw_record_count: 2,
          parse_error_lines: 0,
          fidelity: "value_lossless",
          residue: [],
        }],
        raw_record_count: 42,
        parse_error_lines: 2,
        fidelity: "semantic",
        residue: ["missing native parent link"],
      },
    }));
    expect(state.semantics).toEqual({
      fidelity: "semantic",
      residue: ["missing native parent link"],
      residueCount: 1,
      parseErrors: 2,
      rawRecords: 42,
      subagents: [{ id: "child", source: "codex", model: "gpt-5", messages: 2, fidelity: "value_lossless" }],
    });
    expect(JSON.stringify(state.semantics)).not.toContain("large child answer");
  });

  it("stays bounded no matter how long the session got", () => {
    const huge: ConversationEntry[] = Array.from({ length: 4000 }, (_, i) =>
      message({ id: `m${i}`, text: "z".repeat(20000) }),
    );
    const state = project(snapshot({ conversation: huge }));
    expect(state.transcript.length).toBe(DEFAULT_MAX_ENTRIES);
    const bytes = JSON.stringify(state).length;
    expect(bytes).toBeLessThan(DEFAULT_MAX_ENTRIES * (DEFAULT_MAX_ENTRY_CHARS + 200));
  });

  it("holds no reference into the snapshot's own objects", () => {
    const entry = message({ id: "a", text: "hi" });
    const state = project(snapshot({ conversation: [entry] }));
    expect(state.transcript[0]).not.toBe(entry);
  });
});
