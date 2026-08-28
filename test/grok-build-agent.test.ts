import { describe, expect, it, vi } from "vitest";
import {
  GROK_BUILD_TOOLS,
  GrokBuildSession,
  createInitialConversation,
  createTurnSummaryAnchor,
  createTurnSummaryInstruction,
  createUserMessagePrefix,
  executeGrokToolBatch,
} from "../experiments/browser-agent/src/grok-build-agent.js";
import type { GrokCompletedResponse } from "../src/grok-browser-protocol.js";

function stream(response: GrokCompletedResponse, text = ""): Response {
  const encoder = new TextEncoder();
  const events = [
    ...(text ? [{ type: "response.output_text.delta", delta: text }] : []),
    { type: "response.completed", response },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(events)); controller.close(); } }), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("browser-native Grok Build session", () => {
  it("uses the native prompt and complete native tool registry", () => {
    const conversation = createInitialConversation("Build Pong", {
      os: "Browser",
      shell: "/bin/sh",
      workspacePath: "/",
      today: "2026-08-27",
    });
    expect(String(conversation[0]?.content)).toContain("You are Grok 4.6 released by xAI");
    expect(GROK_BUILD_TOOLS).toHaveLength(27);
    expect(GROK_BUILD_TOOLS.map((tool) => tool.type === "function" ? tool.name : tool.type)).toEqual(expect.arrayContaining([
      "run_terminal_command", "read_file", "search_replace", "list_dir", "grep", "todo_write", "web_fetch", "write", "web_search", "x_search",
    ]));
  });

  it("ports user info, rule neutralization, title sampling, output replay, and completion-order tool results", async () => {
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    const responses = [
      stream({ output: [{ type: "function_call", call_id: "title", name: "session_title", arguments: "{}" }] }),
      stream({ output: [
        { type: "reasoning", encrypted_content: "cipher", status: "completed", content: [{}] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Working" }] },
        { type: "function_call", call_id: "call-a", name: "read_file", arguments: "{}" },
        { type: "function_call", call_id: "call-b", name: "list_dir", arguments: "{}" },
      ] }, "Working"),
      stream({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] }] }, "Done"),
    ];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    let releaseA!: () => void;
    const waitA = new Promise<void>((resolve) => { releaseA = resolve; });
    const session = new GrokBuildSession({
      endpoint: "/api/grok/responses",
      environment: { os: "Browser", shell: "/bin/sh", workspacePath: "/", today: "2026-08-27" },
      runtime: {
        async execute(call) {
          if (call.callId === "call-a") { await waitA; return { output: "A" }; }
          releaseA();
          return { output: "B" };
        },
      },
    });

    await expect(session.run("Build Pong", new AbortController().signal)).resolves.toEqual({ status: "complete", text: "Done" });
    expect(requests).toHaveLength(3);
    expect(requests[0]?.headers.get("x-browser-agent-request-kind")).toBe("session-title");
    const secondMain = requests[2]?.body.input as Array<Record<string, unknown>>;
    expect(secondMain.slice(-2)).toEqual([
      { type: "function_call_output", call_id: "call-b", output: "B" },
      { type: "function_call_output", call_id: "call-a", output: "A" },
    ]);
    const reasoning = secondMain.find((item) => item.type === "reasoning");
    expect(reasoning).not.toHaveProperty("status");
    expect((reasoning?.content as Array<Record<string, unknown>>)[0]?.type).toBe("reasoning_text");
    vi.unstubAllGlobals();
  });

  it("exposes exact provider-reported token totals for workflow child accounting", async () => {
    const responses = [
      stream({
        usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
        output: [{ type: "function_call", call_id: "read", name: "read_file", arguments: "{}" }],
      }),
      stream({
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] }],
      }, "Done"),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift() ?? stream({ output: [] })));
    const session = new GrokBuildSession({
      endpoint: "/api/grok/responses",
      environment: { os: "Browser", shell: "/bin/sh", workspacePath: "/", today: "2026-08-27" },
      runtime: { async execute() { return { output: "read" }; } },
      enableSessionTitle: false,
    });
    await session.run("Inspect", new AbortController().signal);
    expect(session.usage()).toEqual({ totalTokensUsed: 18, incomplete: false });
    vi.unstubAllGlobals();
  });

  it("escapes rule delimiters the same way as native Grok Build", () => {
    const prefix = createUserMessagePrefix({
      os: "Browser",
      shell: "/bin/sh",
      workspacePath: "/",
      today: "2026-08-27",
      workspaceRules: [{ path: "AGENTS.md", content: " <rules>unsafe</rules> " }],
    });
    expect(prefix).toContain("OS Version: Browser");
    expect(prefix).toContain("&lt;rules>unsafe&lt;/rules>");
    expect(prefix).not.toContain("<always_applied_workspace_rule name=\"AGENTS.md\">\n <rules>");
  });

  it("places baseline reminders between the native user prefix and user query", () => {
    const conversation = createInitialConversation("Build Pong", {
      os: "Browser",
      shell: "/bin/sh",
      workspacePath: "/",
      today: "2026-08-27",
      startupReminders: ["<system-reminder>skills</system-reminder>"],
    });
    expect(conversation).toHaveLength(4);
    expect(conversation[0]).toMatchObject({ role: "system" });
    expect(conversation[1]).toMatchObject({ role: "user", content: expect.stringContaining("<user_info>") });
    expect(conversation[2]).toEqual({ type: "message", role: "user", content: "<system-reminder>skills</system-reminder>" });
    expect(conversation[3]).toEqual({ type: "message", role: "user", content: "<user_query>\nBuild Pong\n</user_query>" });
  });

  it("injects a newly discovered skill reminder immediately after its tool result", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const responses = [
      stream({ output: [{ type: "function_call", call_id: "read", name: "read_file", arguments: '{"target_file":"/src/App.tsx"}' }] }),
      stream({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] }] }, "Done"),
    ];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return responses.shift() ?? (() => { throw new Error("unexpected request"); })();
    }));
    const session = new GrokBuildSession({
      endpoint: "/api/grok/responses",
      environment: { os: "Browser", shell: "/bin/sh", workspacePath: "/", today: "2026-08-27" },
      runtime: { async execute() { return { output: "file" }; } },
      enableSessionTitle: false,
      getPostToolSystemReminder: () => "<system-reminder>new skill</system-reminder>",
    });

    await session.run("Inspect", new AbortController().signal);
    const secondInput = requests[1]?.input as Array<Record<string, unknown>>;
    expect(secondInput.slice(-2)).toEqual([
      { type: "function_call_output", call_id: "read", output: "file" },
      { type: "message", role: "user", content: "<system-reminder>new skill</system-reminder>" },
    ]);
    vi.unstubAllGlobals();
  });

  it("frames text-extracted images as deferred native reminder messages", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const responses = [
      stream({ output: [{ type: "function_call", call_id: "read", name: "read_file", arguments: "{}" }] }),
      stream({ output: [{ type: "message", content: [{ type: "output_text", text: "Done" }] }] }, "Done"),
    ];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return responses.shift() ?? (() => { throw new Error("unexpected request"); })();
    }));
    const session = new GrokBuildSession({
      endpoint: "/api/grok/responses",
      environment: { os: "Browser", shell: "/bin/sh", workspacePath: "/", today: "2026-08-27" },
      runtime: { async execute() { return { output: "1→image [image content will be provided separately]", deferredImages: ["data:image/png;base64,AAAA"] }; } },
      enableSessionTitle: false,
    });
    await session.run("Inspect", new AbortController().signal);
    expect((requests[1]?.input as Array<Record<string, unknown>>).slice(-2)).toEqual([
      { type: "function_call_output", call_id: "read", output: "1→image [image content will be provided separately]" },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "[Image extracted from tool result above]" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" },
        ],
      },
    ]);
    vi.unstubAllGlobals();
  });

  it("continues the run when a monitor reminder arrives during an otherwise final sample", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const responses = [
      stream({ output: [{ type: "message", content: [{ type: "output_text", text: "Waiting" }] }] }, "Waiting"),
      stream({ output: [{ type: "message", content: [{ type: "output_text", text: "Handled" }] }] }, "Handled"),
    ];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return responses.shift() ?? (() => { throw new Error("unexpected request"); })();
    }));
    let drains = 0;
    const session = new GrokBuildSession({
      endpoint: "/api/grok/responses",
      environment: { os: "Browser", shell: "/bin/sh", workspacePath: "/", today: "2026-08-27" },
      runtime: { async execute() { return { output: "unused" }; } },
      enableSessionTitle: false,
      drainSystemReminders: () => ++drains === 2 ? ["<monitor-event>DONE</monitor-event>"] : [],
    });
    await expect(session.run("Wait", new AbortController().signal)).resolves.toEqual({ status: "complete", text: "Handled" });
    expect(requests).toHaveLength(2);
    expect((requests[1]?.input as Array<Record<string, unknown>>).at(-1)).toEqual({
      type: "message", role: "user", content: "<monitor-event>DONE</monitor-event>",
    });
    vi.unstubAllGlobals();
  });

  it("runs a native synthetic completion prompt as a full multi-step agent turn", async () => {
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    const responses = [
      stream({ output: [{ type: "message", content: [{ type: "output_text", text: "Started" }] }] }, "Started"),
      stream({ output: [{ type: "function_call", call_id: "inspect", name: "read_file", arguments: "{}" }] }),
      stream({ output: [{ type: "message", content: [{ type: "output_text", text: "Handled" }] }] }, "Handled"),
    ];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return responses.shift() ?? (() => { throw new Error("unexpected request"); })();
    }));
    const execute = vi.fn(async () => ({ output: "background output" }));
    const events: Array<{ type: string; synthetic?: boolean }> = [];
    const session = new GrokBuildSession({
      endpoint: "/api/grok/responses",
      environment: { os: "Browser", shell: "/bin/sh", workspacePath: "/", today: "2026-08-27" },
      runtime: { execute },
      enableSessionTitle: false,
      enableTurnSummary: false,
      onEvent: (event) => events.push(event),
    });
    await session.run("Start", new AbortController().signal);
    session.enqueueSystemReminder("<system-reminder>done</system-reminder>");
    const requestId = "task-completed-33333333-3333-4333-8333-333333333333";
    await expect(session.resume(new AbortController().signal, { requestId })).resolves.toEqual({ status: "complete", text: "Handled" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests.slice(1).map((request) => request.headers.get("x-browser-agent-request"))).toEqual([requestId, requestId]);
    expect(events.filter((event) => event.type === "assistant").slice(-2)).toEqual([
      expect.objectContaining({ synthetic: true }),
      expect.objectContaining({ synthetic: true }),
    ]);
    expect(requests).toHaveLength(3);
    vi.unstubAllGlobals();
  });

  it("uses a full agent-definition prompt when a child overrides the system prompt", () => {
    const conversation = createInitialConversation("Inspect auth", {
      systemPrompt: "You are the read-only explore child.",
      os: "Browser",
      shell: "/bin/sh",
      workspacePath: "/",
      today: "2026-08-27",
    });
    expect(conversation[0]).toEqual({ type: "message", role: "system", content: "You are the read-only explore child." });
  });

  it("ports the native post-turn dashboard-summary anchor and reminder", () => {
    const anchor = createTurnSummaryAnchor(`<user_query>\n${"Build the complete browser game ".repeat(8)}\n</user_query>`);
    expect(anchor.startsWith("user_query Build the complete browser game")).toBe(true);
    expect(new TextEncoder().encode(anchor.slice(0, -1)).length).toBeLessThanOrEqual(120);
    expect(anchor.endsWith("…")).toBe(true);
    expect(createTurnSummaryInstruction(anchor)).toContain("Output ONLY the fragment: 5-12 words");
  });

  it("samples the native turn-summary side call after normal completion", async () => {
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    let completionBookkeepingFinished = false;
    const responses = [
      stream({ output: [] }),
      stream({ output: [{ type: "message", content: [{ type: "output_text", text: "Done" }] }] }, "Done"),
      stream({ output: [{ type: "message", content: [{ type: "output_text", text: "Game shipped" }] }] }, "Game shipped"),
    ];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (headers.get("x-browser-agent-request-kind") === "turn-summary") expect(completionBookkeepingFinished).toBe(true);
      requests.push({ headers, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    }));
    const session = new GrokBuildSession({
      endpoint: "/api/grok/responses",
      environment: { os: "Browser", shell: "/bin/sh", workspacePath: "/", today: "2026-08-27" },
      runtime: { async execute() { return { output: "unused" }; } },
      enableTurnSummary: true,
      strictSideCalls: true,
      beforeTurnSummary: async () => { await Promise.resolve(); completionBookkeepingFinished = true; },
    });
    await expect(session.run("Build Pong", new AbortController().signal)).resolves.toMatchObject({ status: "complete" });
    expect(requests).toHaveLength(3);
    expect(requests[2]?.headers.get("x-browser-agent-request-kind")).toBe("turn-summary");
    expect(requests[2]?.headers.has("x-browser-agent-turn")).toBe(false);
    const last = (requests[2]?.body.input as Array<Record<string, unknown>>).at(-1);
    expect(last?.content).toContain("beginning: \"user_query Build Pong /user_query\"");
    vi.unstubAllGlobals();
  });

  it("does not dispatch tool calls emitted at the configured native turn boundary", async () => {
    const responses = [
      stream({ output: [] }),
      stream({ output: [{ type: "function_call", call_id: "too-late", name: "read_file", arguments: "{}" }] }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift() ?? (() => { throw new Error("unexpected request"); })()));
    const execute = vi.fn();
    const session = new GrokBuildSession({
      endpoint: "/api/grok/responses",
      environment: { os: "Browser", shell: "/bin/sh", workspacePath: "/", today: "2026-08-27" },
      runtime: { execute },
      maxTurns: 1,
    });
    await expect(session.run("Task", new AbortController().signal)).resolves.toMatchObject({ status: "limit" });
    expect(execute).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("checkpoints and resumes a multi-prompt subscription session without replaying the title call", async () => {
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    const responses = [
      stream({ output: [] }),
      stream({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "First done" }] }] }, "First done"),
      stream({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Second done" }] }] }, "Second done"),
    ];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    }));
    const options = {
      endpoint: "/api/grok/responses",
      environment: { os: "Browser", shell: "/bin/sh", workspacePath: "/", today: "2026-08-27" },
      runtime: { async execute() { return { output: "unused" }; } },
    };
    const first = new GrokBuildSession(options);
    await first.run("Create the game", new AbortController().signal);
    const restored = new GrokBuildSession({ ...options, restore: first.snapshot() });
    await restored.run("Now add sound", new AbortController().signal);

    expect(requests).toHaveLength(3);
    expect(requests[2]?.headers.get("x-browser-agent-request-kind")).toBeNull();
    expect(requests[2]?.headers.get("x-browser-agent-turn")).toBe("2");
    const input = requests[2]?.body.input as Array<Record<string, unknown>>;
    expect(input.some((item) => item.role === "assistant")).toBe(true);
    expect(input.at(-1)).toEqual({ type: "message", role: "user", content: "Now add sound" });
    expect(restored.snapshot().sessionId).toBe(first.snapshot().sessionId);
    vi.unstubAllGlobals();
  });

  it("retries transient model failures with the native sampler budget without changing the request", async () => {
    const requests: string[] = [];
    const sleeps: number[] = [];
    const retryEvents: Array<Record<string, unknown>> = [];
    const responses = [
      stream({ output: [] }),
      new Response("temporarily unavailable", { status: 503, headers: { "Retry-After": "9" } }),
      stream({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Recovered" }] }] }, "Recovered"),
    ];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(String(init?.body));
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    }));
    const session = new GrokBuildSession({
      endpoint: "/api/grok/responses",
      environment: { os: "Browser", shell: "/bin/sh", workspacePath: "/", today: "2026-08-27" },
      runtime: { async execute() { return { output: "unused" }; } },
      retrySleep: async (delay) => { sleeps.push(delay); },
      retryJitter: (delay) => delay,
      onEvent(event) { if (event.type === "retry") retryEvents.push(event); },
    });
    await expect(session.run("Recover", new AbortController().signal)).resolves.toMatchObject({ text: "Recovered" });
    expect(sleeps).toEqual([9_000]);
    expect(requests[1]).toBe(requests[2]);
    expect(retryEvents).toEqual([expect.objectContaining({ kind: "foreground", attempt: 1, maxRetries: 14, status: 503 })]);
    vi.unstubAllGlobals();
  });

  it("retries 429 only once and fails deterministic statuses and retry vetoes immediately", async () => {
    for (const responses of [
      [new Response("rate limited", { status: 429 }), new Response("still limited", { status: 429 })],
      [new Response("bad request", { status: 400 })],
      [new Response("do not retry", { status: 503, headers: { "x-should-retry": "false" } })],
      [new Response("bad origin TLS", { status: 525 })],
    ]) {
      const fetchMock = vi.fn(async () => responses.shift() ?? (() => { throw new Error("unexpected request"); })());
      vi.stubGlobal("fetch", fetchMock);
      const sleeps: number[] = [];
      const session = new GrokBuildSession({
        endpoint: "/api/grok/responses",
        environment: { os: "Browser", shell: "/bin/sh", workspacePath: "/", today: "2026-08-27" },
        runtime: { async execute() { return { output: "unused" }; } },
        retrySleep: async (delay) => { sleeps.push(delay); },
        retryJitter: (delay) => delay,
      });
      await expect(session.run("Fail", new AbortController().signal)).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(sleeps.length + 1);
      expect(sleeps.length).toBe(fetchMock.mock.calls.length === 2 ? 1 : 0);
      vi.unstubAllGlobals();
    }
  });

  it("cancels retry backoff immediately through the run abort signal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("transient", { status: 503 })));
    const controller = new AbortController();
    const session = new GrokBuildSession({
      endpoint: "/api/grok/responses",
      environment: { os: "Browser", shell: "/bin/sh", workspacePath: "/", today: "2026-08-27" },
      runtime: { async execute() { return { output: "unused" }; } },
      retrySleep: async (_delay, signal) => {
        controller.abort(new DOMException("cancelled", "AbortError"));
        signal.throwIfAborted();
      },
      retryJitter: (delay) => delay,
    });
    await expect(session.run("Cancel", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    vi.unstubAllGlobals();
  });

  it("auto-compacts at the native context threshold, carries state forward, and resumes the interrupted turn", async () => {
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    const rawSummary = `<summary>\n${"1. Primary Request and Intent: keep building the browser game faithfully.\n".repeat(12)}</summary>`;
    const responses = [
      stream({ output: [] }),
      stream({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: rawSummary }] }] }, rawSummary),
      stream({
        usage: { input_tokens: 120, output_tokens: 10, total_tokens: 130 },
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Continued" }] }],
      }, "Continued"),
    ];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    }));
    const events: string[] = [];
    const onCompaction = vi.fn();
    const session = new GrokBuildSession({
      endpoint: "/api/grok/responses",
      environment: { os: "Browser", shell: "/bin/sh", workspacePath: "/", today: "2026-08-27" },
      runtime: { async execute() { return { output: "unused" }; } },
      contextWindow: 100,
      autoCompactThresholdPercent: 1,
      onCompaction,
      onEvent(event) { events.push(event.type); },
    });
    await expect(session.run("Keep building", new AbortController().signal)).resolves.toMatchObject({ text: "Continued" });
    expect(requests).toHaveLength(3);
    expect(requests[1]?.headers.get("x-browser-agent-request-kind")).toBe("compaction");
    expect(requests[1]?.headers.get("x-browser-agent-compaction-at")).toBe("1");
    const compactInput = requests[1]?.body.input as Array<Record<string, unknown>>;
    expect(compactInput.at(-1)?.content).toContain("Your task is to produce a faithful, concise summary");
    expect(requests[1]?.body).toMatchObject({ temperature: 1, tool_choice: "auto" });
    const resumedInput = requests[2]?.body.input as Array<Record<string, unknown>>;
    expect(resumedInput.some((item) => String(item.content).startsWith("This session is being continued"))).toBe(true);
    expect(String(resumedInput.at(-1)?.content)).toContain("Full verbatim rollouts of previous segments");
    expect(resumedInput.some((item) => String(item.content).includes("Pick up the last task as if the break never happened."))).toBe(false);
    expect(events).toEqual(expect.arrayContaining(["compaction_start", "compaction_end"]));
    expect(onCompaction).toHaveBeenCalledOnce();
    expect(session.snapshot()).toMatchObject({ compactionCount: 1, estimatedTokens: 130 });
    vi.unstubAllGlobals();
  });

  it("serializes same-file read/edit calls while independent paths stay parallel", async () => {
    const events: string[] = [];
    let releaseIndependent!: () => void;
    const independent = new Promise<void>((resolve) => { releaseIndependent = resolve; });
    let markEditStarted!: () => void;
    const editStarted = new Promise<void>((resolve) => { markEditStarted = resolve; });
    const calls = [
      { callId: "read-a", name: "read_file", arguments: JSON.stringify({ target_file: "src/a.ts" }) },
      { callId: "edit-a", name: "search_replace", arguments: JSON.stringify({ file_path: "./src/a.ts" }) },
      { callId: "read-b", name: "read_file", arguments: JSON.stringify({ target_file: "src/b.ts" }) },
    ];
    const batch = executeGrokToolBatch(calls, {
      async execute(call) {
        events.push(`start:${call.callId}`);
        if (call.callId === "edit-a") markEditStarted();
        if (call.callId === "read-b") await independent;
        events.push(`end:${call.callId}`);
        return { output: call.callId };
      },
    }, new AbortController().signal);
    await editStarted;
    expect(events).toContain("start:read-b");
    expect(events.indexOf("end:read-a")).toBeLessThan(events.indexOf("start:edit-a"));
    releaseIndependent();
    await batch;
  });
});
