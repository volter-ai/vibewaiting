import { describe, expect, it } from "vitest";
import { formatGrokBuildMcpStatus } from "../experiments/browser-agent/src/grok-build-mcp-dialog.js";

describe("Grok Build browser MCP status surface", () => {
  it("uses native-equivalent connection labels and exact tool plurals", () => {
    expect(formatGrokBuildMcpStatus({ status: "idle", toolCount: 0 })).toBe("Not connected");
    expect(formatGrokBuildMcpStatus({ status: "connecting", toolCount: 0 })).toBe("Connecting…");
    expect(formatGrokBuildMcpStatus({ status: "failed", toolCount: 0 })).toBe("Connection failed");
    expect(formatGrokBuildMcpStatus({ status: "ready", toolCount: 1 })).toBe("1 tool");
    expect(formatGrokBuildMcpStatus({ status: "ready", toolCount: 2 })).toBe("2 tools");
  });
});
