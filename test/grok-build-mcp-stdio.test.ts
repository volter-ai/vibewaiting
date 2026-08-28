import { VirtualFS } from "almostnode";
import { describe, expect, it, vi } from "vitest";
import { createGrokBuildMcpServices } from "../experiments/browser-agent/src/grok-build-mcp.js";
import { GrokBuildMcpHttpClient } from "../experiments/browser-agent/src/grok-build-mcp-protocol.js";
import {
  createGrokBuildAlmostNodeStdioConfig,
  GrokBuildMcpStdioFetchAdapter,
  type GrokBuildMcpStdioProcessCallbacks,
} from "../experiments/browser-agent/src/grok-build-mcp-stdio.js";

describe("Grok Build browser stdio MCP transport", () => {
  it("correlates concurrent newline responses and keeps running after malformed stdout", async () => {
    let callbacks!: GrokBuildMcpStdioProcessCallbacks;
    const decodeErrors: Array<{ error: string; sample: string }> = [];
    const writes: Array<Record<string, unknown>> = [];
    const adapter = new GrokBuildMcpStdioFetchAdapter({
      name: "fixture",
      spawn(nextCallbacks) {
        callbacks = nextCallbacks;
        return {
          write(data) { writes.push(JSON.parse(data) as Record<string, unknown>); },
          close() { /* test process has no resources */ },
        };
      },
      onDecodeError: ({ error, sample }) => decodeErrors.push({ error, sample }),
    });

    const first = adapter.fetch("https://stdio.mcp.invalid", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }),
    });
    const second = adapter.fetch("https://stdio.mcp.invalid", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list", params: {} }),
    });
    callbacks.stdout("not-json\n");
    callbacks.stdout('{"jsonrpc":"2.0","id":8,"result":{"tools":[]}}\n{"jsonrpc":"2.0","id":');
    callbacks.stdout('7,"result":{"tools":[]}}\r\n');

    await expect((await first).text()).resolves.toContain('"id":7');
    await expect((await second).text()).resolves.toContain('"id":8');
    expect(writes.map((request) => request.id)).toEqual([7, 8]);
    expect(decodeErrors).toEqual([{ error: expect.any(String), sample: "not-json" }]);
  });

  it("runs a persistent JavaScript MCP server inside AlmostNode with native handshake, env, argv, tools, and diagnostics", async () => {
    const vfs = new VirtualFS();
    const decodeErrors: string[] = [];
    const stderr: string[] = [];
    vfs.writeFileSync("/workspace/server.cjs", `
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += String(chunk);
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      process.stdout.write("server boot noise\\n");
      send(request.id, {
        protocolVersion: "2025-11-25",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "fixture", version: "1" },
        instructions: "Browser fixture",
      });
    } else if (request.method === "tools/list") {
      send(request.id, { tools: [{
        name: "inspect_runtime",
        description: "Return browser process state",
        inputSchema: { type: "object", properties: { value: { type: "string" } } },
      }] });
    } else if (request.method === "tools/call") {
      process.stderr.write("fixture diagnostic\\n");
      send(request.id, { content: [{ type: "text", text: JSON.stringify({
        session: process.env.GROK_SESSION_ID,
        mode: process.env.MODE,
        argv: process.argv.slice(2),
        input: request.params.arguments,
      }) }] });
    }
  }
});
function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
`);
    const config = createGrokBuildAlmostNodeStdioConfig(vfs, {
      type: "stdio",
      name: "fixture",
      command: "node",
      args: ["server.cjs", "--fixture-arg"],
      env: [{ name: "MODE", value: "browser" }],
    }, {
      cwd: "/workspace",
      sessionId: "session-stdio-1",
      onDecodeError: (event) => decodeErrors.push(event.sample),
      onStderr: (event) => stderr.push(event.data),
    });
    const connectionEvents: Array<Record<string, unknown>> = [];
    const { registry, services } = createGrokBuildMcpServices([config], {
      traceSink: {
        recordConnection: (event) => connectionEvents.push(event),
        startToolCall: () => undefined,
      },
    });
    const signal = new AbortController().signal;

    await registry.connectAll(signal);
    const result = JSON.parse(await services.useTool("fixture__inspect_runtime", { value: "pong" }, signal)) as Record<string, unknown>;
    expect(result).toEqual({
      session: "session-stdio-1",
      mode: "browser",
      argv: ["--fixture-arg"],
      input: { value: "pong" },
    });
    expect(decodeErrors).toEqual(["server boot noise"]);
    expect(stderr.join("")).toContain("fixture diagnostic");
    expect(vfs.readFileSync("/.grok/logs/mcp/fixture.stderr.log", "utf8")).toBe("fixture diagnostic\n");
    expect(registry.serverSummaries()).toEqual([expect.objectContaining({
      name: "fixture", status: "ready", toolNames: ["inspect_runtime"],
    })]);
    expect(connectionEvents).toEqual([expect.objectContaining({
      status: "connected", serverName: "fixture", transportType: "stdio", toolCount: 1,
    })]);
    await registry.closeAll(signal);
    await expect(services.useTool("fixture__inspect_runtime", {}, signal)).rejects.toThrow("closed");
  });

  it("resolves AlmostNode package bins through the native npx-shaped configuration", async () => {
    const vfs = new VirtualFS();
    vfs.writeFileSync("/workspace/node_modules/@fixture/mcp/package.json", JSON.stringify({
      name: "@fixture/mcp",
      bin: { mcp: "dist/server.cjs" },
    }));
    vfs.writeFileSync("/workspace/node_modules/@fixture/mcp/dist/server.cjs", `
process.stdin.on("data", (line) => {
  const request = JSON.parse(String(line));
  const result = request.method === "initialize"
    ? { protocolVersion: "2025-11-25", capabilities: {} }
    : request.method === "tools/list"
      ? { tools: [{ name: "args", inputSchema: {} }] }
      : { content: [{ type: "text", text: JSON.stringify(process.argv.slice(2)) }] };
  if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`);
    const config = createGrokBuildAlmostNodeStdioConfig(vfs, {
      type: "stdio", name: "package", command: "npx",
      args: ["-y", "@fixture/mcp@1.2.3", "--root", "/workspace"], env: [],
    }, { cwd: "/workspace" });
    const { services } = createGrokBuildMcpServices([config]);
    await expect(services.useTool("package__args", {}, new AbortController().signal)).resolves.toBe(
      JSON.stringify(["--root", "/workspace"]),
    );
  });

  it("delivers idle server notifications over the projected event stream", async () => {
    let callbacks!: GrokBuildMcpStdioProcessCallbacks;
    const adapter = new GrokBuildMcpStdioFetchAdapter({
      name: "events",
      spawn(nextCallbacks) {
        callbacks = nextCallbacks;
        return {
          write(data) {
            const request = JSON.parse(data) as { id?: number; method?: string };
            if (request.id !== undefined) callbacks.stdout(JSON.stringify({
              jsonrpc: "2.0", id: request.id, result: request.method === "initialize"
                ? { protocolVersion: "2025-11-25", capabilities: {} }
                : { tools: [] },
            }) + "\n");
          },
          close() { /* no-op */ },
        };
      },
    });
    const client = new GrokBuildMcpHttpClient({
      name: "events",
      url: "https://stdio.mcp.invalid/rpc",
      fetchImpl: adapter.fetch,
      enableEventStream: true,
    });
    const notification = vi.fn();
    client.onNotification(notification);
    await client.initialize(new AbortController().signal);
    await Promise.resolve();
    callbacks.stdout('{"jsonrpc":"2.0","method":"notifications/tools/list_changed","params":{}}\n');
    await vi.waitFor(() => expect(notification).toHaveBeenCalledWith("notifications/tools/list_changed", {}));
    adapter.close();
  });
});
