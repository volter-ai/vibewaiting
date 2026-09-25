/**
 * `vibewaiting mcp`: a stdio MCP server an agent's harness registers like any
 * other (`claude mcp add vibewaiting -- vibewaiting mcp`). It lists
 * Playwright's own browser tools (SERVED_BROWSER_TOOLS, with the schemas
 * @playwright/mcp publishes) and forwards each call to the running native
 * host's broker, which the extension answers on the person's active tab. A
 * call that needs the person's approval stays open while they decide.
 *
 * Each server is one agent task: its random id, never reused, is what an
 * "Allow on <origin> for this task" covers, so the allowance ends with it.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { BROWSER_BROKER_PROTOCOL, findBrowserBroker } from "./browser-broker.js";
import { browserToolError, parseBrowserToolCall, parseBrowserToolResult, type BrowserToolResult } from "./browser-tools.js";

const MCP_PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function serverInfo(): Promise<{ name: string; version: string }> {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return { name: "vibewaiting", version: manifest.version };
}

async function listedTools(): Promise<unknown[]> {
  const file = await readFile(new URL("./browser-tools.json", import.meta.url), "utf8");
  return (JSON.parse(file) as { tools: unknown[] }).tools;
}

/** One tool call through the broker; `progress` hears each "waiting for the person" line. */
function callThroughBroker(
  task: string,
  call: unknown,
  signal: AbortSignal,
  progress: (message: string) => void,
): Promise<BrowserToolResult> {
  const parsed = parseBrowserToolCall(call);
  if (!parsed) return Promise.resolve(browserToolError("Vibewaiting does not serve that tool, or its arguments are not an object."));
  return findBrowserBroker(process.cwd()).then((broker) => new Promise<BrowserToolResult>((resolve) => {
    if (!broker) {
      resolve(browserToolError("Vibewaiting is not running: open the browser with the Vibewaiting extension and its companion, then try again."));
      return;
    }
    const id = randomUUID();
    const socket = connect(broker.port, broker.host);
    let buffer = "";
    let settled = false;
    const finish = (result: BrowserToolResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    signal.addEventListener("abort", () => finish(browserToolError("The call was cancelled.")), { once: true });
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({
      protocol: BROWSER_BROKER_PROTOCOL,
      id,
      token: broker.token,
      call: parsed,
      accepts: ["pending"],
      task,
    })}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = record(JSON.parse(buffer.slice(0, newline)) as unknown);
        buffer = buffer.slice(newline + 1);
        const pending = record(line?.pending);
        if (typeof pending?.message === "string") {
          progress(pending.message);
          continue;
        }
        const result = parseBrowserToolResult(line?.result);
        finish(result ?? browserToolError(typeof line?.error === "string" ? line.error : "Vibewaiting answered with an invalid result."));
      }
    });
    socket.on("error", (error) => finish(browserToolError(`Vibewaiting's companion is not reachable: ${error.message}`)));
    socket.on("close", () => finish(browserToolError("Vibewaiting's companion closed the call without an answer.")));
  }));
}

export async function serveMcp(): Promise<void> {
  const task = randomBytes(16).toString("hex");
  const inFlight = new Map<string | number, AbortController>();
  const write = (message: unknown): void => { process.stdout.write(`${JSON.stringify(message)}\n`); };
  const reply = (id: string | number, result: unknown): void => write({ jsonrpc: "2.0", id, result });
  const fail = (id: string | number | null, code: number, message: string): void =>
    write({ jsonrpc: "2.0", id, error: { code, message } });

  const handle = async (message: JsonRpcMessage): Promise<void> => {
    const { id, method } = message;
    const params = record(message.params) ?? {};
    if (method === "notifications/cancelled") {
      const requestId = params.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") inFlight.get(requestId)?.abort();
      return;
    }
    if (id === undefined || id === null) return;
    if (method === "initialize") {
      reply(id, {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: await serverInfo(),
        instructions: "Drives the tab the person is looking at in their own browser, through Vibewaiting. Actions that change the page ask the person first; the call waits for their answer.",
      });
      return;
    }
    if (method === "ping") {
      reply(id, {});
      return;
    }
    if (method === "tools/list") {
      reply(id, { tools: await listedTools() });
      return;
    }
    if (method === "tools/call") {
      const controller = new AbortController();
      inFlight.set(id, controller);
      const progressToken = record(params._meta)?.progressToken;
      let progress = 0;
      try {
        const result = await callThroughBroker(task, { tool: params.name, arguments: params.arguments ?? {} }, controller.signal, (text) => {
          if (typeof progressToken === "string" || typeof progressToken === "number")
            write({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: ++progress, message: text } });
        });
        reply(id, result);
      } finally {
        inFlight.delete(id);
      }
      return;
    }
    fail(id, -32601, `Method not found: ${String(method)}`);
  };

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        fail(null, -32700, "Parse error");
        continue;
      }
      void handle(message).catch((error: unknown) => {
        if (message.id !== undefined && message.id !== null)
          fail(message.id, -32603, error instanceof Error ? error.message : String(error));
      });
    }
  });
  await new Promise<void>((resolve) => process.stdin.on("end", resolve));
}
