import { describe, expect, it } from "vitest";
import { VirtualFS } from "almostnode";
import { discoverGrokBuildMcpServers } from "../experiments/browser-agent/src/grok-build-mcp-config-discovery.js";
import {
  expandGrokBuildEnvironment,
  materializeGrokBuildMcpServer,
  parseGrokBuildMcpEntries,
  parseGrokBuildMcpToml,
} from "../experiments/browser-agent/src/grok-build-mcp-config-parse.js";
import { projectGrokBuildMcpRuntimeConfig } from "../experiments/browser-agent/src/grok-build-mcp-config-runtime.js";

function write(vfs: VirtualFS, path: string, source: string): void {
  const boundary = path.lastIndexOf("/");
  if (boundary > 0) vfs.mkdirSync(path.slice(0, boundary), { recursive: true });
  vfs.writeFileSync(path, source);
}

describe("Grok Build MCP config translation", () => {
  it("parses TOML entries independently and preserves native transport/policy semantics", () => {
    const root = parseGrokBuildMcpToml(`
[mcp_servers.github]
url = "https://mcp.example.test/\${TENANT}/sse"
headers = { X-Key = "$TOKEN" }
bearer_token_env_var = "BEARER"
startup_timeout_sec = 10
tool_timeout_sec = 45
tool_timeouts = { create_issue = 120, search = 30 }
expose_image_base64 = true

[mcp_servers.bad]
args = [1]
`)!;
    const entries = parseGrokBuildMcpEntries(root, "mcp_servers");
    const github = materializeGrokBuildMcpServer(entries[0]!, {
      environment: { TENANT: "acme", TOKEN: "header-secret", BEARER: "bearer-secret" },
      disabledTools: ["delete_issue"],
    });
    expect(github).toMatchObject({
      server: {
        type: "sse", name: "github", url: "https://mcp.example.test/acme/sse",
        headers: [{ name: "X-Key", value: "header-secret" }, { name: "Authorization", value: "Bearer bearer-secret" }],
      },
      policy: {
        startupTimeoutMs: 10_000, toolTimeoutMs: 45_000,
        toolTimeoutsMs: { create_issue: 120_000, search: 30_000 },
        exposeImageBase64: true, disabledTools: ["delete_issue"],
      },
    });
    expect(materializeGrokBuildMcpServer(entries[1]!)).toBeUndefined();
    expect(expandGrokBuildEnvironment("$KNOWN/${MISSING}", { KNOWN: "yes" })).toBe("yes/${MISSING}");
  });

  it("resolves the native one-select setup schema from browser preferences", () => {
    const result = materializeGrokBuildMcpServer({ name: "region", config: {
      urlTemplate: "https://{{host}}/mcp",
      setup: {
        fields: [{ id: "site", label: "Site", type: "select", options: [{ label: "US", value: "us" }] }],
        values: { host: { from: "site", map: { us: "us.example.test" } } },
      },
    } }, { preferences: { servers: { region: { values: { site: "us" } } } } });
    expect(result?.server).toMatchObject({ type: "http", url: "https://us.example.test/mcp" });
    expect(materializeGrokBuildMcpServer({ name: "region", config: {
      url: "https://{{host}}/mcp", setup: { fields: [{ id: "site", type: "select", options: [{ value: "us" }] }], variables: {} },
    } })).toBeUndefined();
  });

  it("matches TOML, Claude, Cursor, and nearest .mcp.json precedence", () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync("/repo/.git", { recursive: true });
    write(vfs, "/.grok/config.toml", `
disabled_mcp_servers = ["off"]
[disabled_mcp_tools]
toml = ["hidden"]
[mcp_servers.toml]
url = "https://global.example/mcp"
[mcp_servers.off]
url = "https://off.example/mcp"
`);
    write(vfs, "/repo/packages/.grok/config.toml", `[mcp_servers.toml]\ncommand = "node"\nargs = ["project.js"]\n`);
    write(vfs, "/.claude.json", JSON.stringify({
      mcpServers: { claude: { url: "https://user-claude.example/mcp" }, lower: { command: "node", args: ["claude.js"] } },
      projects: { "/repo/packages/app": { mcpServers: { claude: { url: "https://project-claude.example/mcp" } } } },
    }));
    write(vfs, "/repo/packages/app/.cursor/mcp.json", JSON.stringify({ mcpServers: {
      cursor: { command: "node", args: ["cursor.js"] }, lower: { command: "node", args: ["cursor-loses.js"] },
    } }));
    write(vfs, "/repo/.mcp.json", JSON.stringify({ mcpServers: { nested: { command: "node", args: ["root.js"] } } }));
    write(vfs, "/repo/packages/app/.mcp.json", JSON.stringify({ mcpServers: {
      nested: { command: "node", args: ["near.js"] }, cursor: { command: "node", args: ["mcp-loses.js"] },
    } }));

    const result = discoverGrokBuildMcpServers(vfs, { cwd: "/repo/packages/app", projectTrusted: true });
    expect(result.acpServers.map((server) => server.name)).toEqual(["toml", "claude", "lower", "cursor", "nested"]);
    expect(result.acpServers.find((server) => server.name === "toml")).toMatchObject({ type: "stdio", args: ["project.js"] });
    expect(result.acpServers.find((server) => server.name === "claude")).toMatchObject({ url: "https://project-claude.example/mcp" });
    expect(result.acpServers.find((server) => server.name === "lower")).toMatchObject({ args: ["claude.js"] });
    expect(result.acpServers.find((server) => server.name === "cursor")).toMatchObject({ args: ["cursor.js"] });
    expect(result.acpServers.find((server) => server.name === "nested")).toMatchObject({ args: ["near.js"] });
    expect(result.skipped).toContainEqual({ name: "off", path: "/.grok/config.toml", reason: "disabled" });
    const toml = result.servers.find((server) => server.server.name === "toml")!;
    expect(toml.policy.disabledTools).toEqual(["hidden"]);
    expect(toml.scope).toBe("project");
  });

  it("gates project declarations while retaining user declarations", () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync("/repo/.git", { recursive: true });
    write(vfs, "/.grok/config.toml", `[mcp_servers.user]\nurl = "https://user.example/mcp"\n`);
    write(vfs, "/repo/.mcp.json", JSON.stringify({ mcpServers: { project: { command: "node", args: ["server.js"] } } }));
    const result = discoverGrokBuildMcpServers(vfs, { cwd: "/repo", projectTrusted: false });
    expect(result.acpServers.map((server) => server.name)).toEqual(["user"]);
    expect(result.skipped).toContainEqual({ name: "project", path: "/repo/.mcp.json", reason: "untrusted-project" });
  });

  it("projects out-of-band policy onto HTTP and stdio runtime configs", () => {
    const vfs = new VirtualFS();
    write(vfs, "/server.js", "process.stdin.on('data', () => {})");
    const server = materializeGrokBuildMcpServer({ name: "local", config: {
      command: "node", args: ["/server.js"], startup_timeout_sec: 8,
      tool_timeout_sec: 9, tool_timeouts: { slow: 12 }, expose_image_base64: true,
    } })!.server;
    expect(projectGrokBuildMcpRuntimeConfig(vfs, server, { cwd: "/", sessionId: "session" })).toMatchObject({
      name: "local", transportType: "stdio", startupTimeoutMs: 8_000, toolTimeoutMs: 9_000,
      toolTimeoutsMs: { slow: 12_000 }, exposeImageBase64: true,
    });
  });
});
