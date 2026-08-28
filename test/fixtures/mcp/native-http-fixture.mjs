import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number.parseInt(process.env.MCP_FIXTURE_PORT ?? "39123", 10);
const logPath = process.env.MCP_FIXTURE_LOG;
let sequence = 0;

const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  let body;
  try { body = raw === "" ? undefined : JSON.parse(raw); } catch { body = raw; }
  record({
    sequence: ++sequence,
    method: request.method,
    path: request.url,
    headers: selectedHeaders(request.headers),
    body,
  });

  if (request.method !== "POST" || typeof body !== "object" || body === null) {
    response.writeHead(405).end();
    return;
  }
  if (body.method === "notifications/initialized") {
    response.writeHead(202).end();
    return;
  }
  if (body.method === "initialize") {
    send(response, {
      jsonrpc: "2.0",
      id: body.id,
      result: {
        protocolVersion: body.params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "grok-parity-fixture", version: "1.0.0" },
        instructions: "Deterministic native MCP parity fixture",
      },
    });
    return;
  }
  if (body.method === "tools/list") {
    send(response, {
      jsonrpc: "2.0",
      id: body.id,
      result: {
        tools: [
          {
            name: "fixture_echo",
            description: "Echo a deterministic message for browser parity verification",
            inputSchema: {
              type: "object",
              properties: { message: { type: "string", description: "Message to echo" } },
              required: ["message"],
            },
          },
          {
            name: "fixture_sum",
            description: "Add two integers for deterministic verification",
            inputSchema: {
              type: "object",
              properties: { a: { type: "integer" }, b: { type: "integer" } },
              required: ["a", "b"],
            },
          },
        ],
      },
    });
    return;
  }
  if (body.method === "tools/call") {
    const name = body.params?.name;
    const args = body.params?.arguments ?? {};
    const text = name === "fixture_echo"
      ? `fixture:${String(args.message ?? "")}`
      : name === "fixture_sum"
        ? `sum:${Number(args.a) + Number(args.b)}`
        : `unknown:${String(name)}`;
    send(response, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text }] } });
    return;
  }
  send(response, { jsonrpc: "2.0", id: body.id ?? null, error: { code: -32601, message: "Method not found" } });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ ready: true, port })}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));

function selectedHeaders(headers) {
  return Object.fromEntries([
    "accept", "content-type", "mcp-protocol-version", "user-agent", "x-grok-client-version",
  ].flatMap((name) => headers[name] === undefined ? [] : [[name, headers[name]]]));
}

function send(response, value) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function record(value) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(value)}\n`);
}
