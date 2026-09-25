/**
 * The browser tools Vibewaiting serves an agent on the person's tab: Playwright's
 * own MCP tools (the core set `@playwright/mcp` serves), answered inside the
 * extension by Playwright's MCP tool backend, less the tools that would reach
 * past the page the person shares (running code, files, other tabs, the
 * window, the headers and bodies of the page's own requests). Shared by the MCP server (`vibewaiting mcp`), the native host and
 * the extension.
 */

/** The tools served, by Playwright's names. */
export const SERVED_BROWSER_TOOLS = [
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_find",
  "browser_hover",
  "browser_wait_for",
  "browser_console_messages",
  "browser_click",
  "browser_drag",
  "browser_select_option",
  "browser_type",
  "browser_fill_form",
  "browser_press_key",
  "browser_navigate",
  "browser_navigate_back",
  "browser_handle_dialog",
] as const;

export type BrowserToolName = (typeof SERVED_BROWSER_TOOLS)[number];

export function servedBrowserTool(name: unknown): name is BrowserToolName {
  return (SERVED_BROWSER_TOOLS as readonly unknown[]).includes(name);
}

/** One `tools/call`: a served tool and its arguments. */
export interface BrowserToolCall {
  tool: BrowserToolName;
  arguments: Record<string, unknown>;
}

/** A tool's answer, in MCP's `CallToolResult` shape. */
export interface BrowserToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseBrowserToolCall(value: unknown): BrowserToolCall | null {
  const call = record(value);
  if (!call || !servedBrowserTool(call.tool)) return null;
  const args = call.arguments === undefined ? {} : record(call.arguments);
  return args ? { tool: call.tool, arguments: args } : null;
}

export function parseBrowserToolResult(value: unknown): BrowserToolResult | null {
  const result = record(value);
  if (!result || !Array.isArray(result.content)) return null;
  const content: BrowserToolResult["content"] = [];
  for (const raw of result.content) {
    const item = record(raw);
    if (!item || typeof item.type !== "string") return null;
    content.push({
      type: item.type,
      ...(typeof item.text === "string" ? { text: item.text } : {}),
      ...(typeof item.data === "string" ? { data: item.data } : {}),
      ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
    });
  }
  return { content, ...(result.isError === true ? { isError: true } : {}) };
}

/** A refusal or failure, as the agent reads it. */
export function browserToolError(message: string): BrowserToolResult {
  return { content: [{ type: "text", text: `### Error\n${message}` }], isError: true };
}
