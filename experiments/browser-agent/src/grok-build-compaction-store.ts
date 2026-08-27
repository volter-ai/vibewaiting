import type { GrokInputItem } from "../../../src/grok-browser-protocol.js";

export const GROK_COMPACTION_INDEX_HEADER = "# Compaction Segment Index\n\n| Segment | File | Turns | Approx bytes | Keywords |\n|---|---|---|---|---|\n";

const SEGMENT_MAX_BYTES = 512 * 1024;
const PER_TURN_OVERHEAD_BYTES = 64;
const FILE_ARG_KEYS = ["target_file", "file_path", "path", "target_directory"] as const;
const KEYWORD_STOPWORDS = new Set([
  "section", "summary", "current", "work", "errors", "analysis", "primary", "request", "intent",
  "technical", "concepts", "pending", "problem", "solving", "include", "outline", "describe", "specific",
  "messages", "feedback", "snippet", "snippets", "session", "explicit", "thorough", "language", "important",
  "convention",
]);

interface SegmentToolCall {
  name: string;
  arguments: string;
}

interface SegmentTurn {
  role: "Assistant" | "Function" | "Human" | "System";
  content: string;
  toolCalls: SegmentToolCall[];
  toolResult: boolean;
}

export interface GrokCompactionSegment {
  index: number;
  items: readonly GrokInputItem[];
  summary: string;
  timestamp: string;
}

export function grokCompactionSegmentFilename(index: number): string {
  return `segment_${segmentLabel(index)}.md`;
}

export function renderGrokCompactionSegment(segment: GrokCompactionSegment): string {
  const turns = prepareSegmentTurns(segment.items);
  const stats = computeTurnStats(turns);
  const label = segmentLabel(segment.index);
  const preamble = `# HISTORICAL -- DO NOT EDIT\n# Record of compaction segment ${label} (detail=verbose) from this same task.\n# Use read_file or grep to look up details, but do not modify.\n\n## Segment metadata\n- Index: ${label}\n- Turn count: ${turns.length}\n- Timestamp: ${segment.timestamp}\n\n${renderStats(stats)}\n## Summary (curated by compaction step)\n\n${segment.summary.trim() || "(empty)"}\n\n## Verbatim turns\n\n`;
  const encoder = new TextEncoder();
  const budget = Math.max(0, SEGMENT_MAX_BYTES - encoder.encode(preamble).length - 128);
  const blocks: string[] = [];
  let bytes = 0;
  let truncatedAt = -1;
  for (let index = 0; index < turns.length; index += 1) {
    const block = renderVerboseTurn(turns[index]!, index);
    const blockBytes = encoder.encode(block).length;
    if (bytes + blockBytes > budget) {
      truncatedAt = index;
      break;
    }
    bytes += blockBytes;
    blocks.push(block);
  }
  let body = blocks.join("\n");
  if (truncatedAt >= 0) {
    body += `\n\n[... TRUNCATED at ${SEGMENT_MAX_BYTES} bytes, ${turns.length - truncatedAt} turns omitted ...]\n`;
  }
  return preamble + body;
}

export function renderGrokCompactionIndexRow(
  index: number,
  turnCount: number,
  approxBytes: number,
  keywords: readonly string[],
): string {
  return `| ${segmentLabel(index)} | ${grokCompactionSegmentFilename(index)} | ${turnCount} | ${approxBytes} | ${keywords.map((word) => `"${word}"`).join(", ")} |\n`;
}

export function extractGrokCompactionKeywords(summary: string): string[] {
  const section = /^#{0,6}\s*8\.\s+Current Work/mu.exec(summary);
  let text = summary;
  if (section?.index !== undefined) {
    const tail = summary.slice(section.index + section[0].length);
    const next = /^#{0,6}\s*\d+\.\s+[A-Z]/mu.exec(tail);
    text = summary.slice(section.index, next ? section.index + section[0].length + next.index : undefined);
  }
  const result: string[] = [];
  for (const match of text.matchAll(/[A-Z][A-Za-z0-9_]{3,}|[a-z][a-z0-9_]{5,}/gu)) {
    const word = match[0];
    if (KEYWORD_STOPWORDS.has(word.toLowerCase()) || result.includes(word)) continue;
    result.push(word);
    if (result.length === 8) break;
  }
  return result;
}

export function countGrokCompactionTurns(items: readonly GrokInputItem[]): number {
  return prepareSegmentTurns(items).length;
}

function prepareSegmentTurns(items: readonly GrokInputItem[]): SegmentTurn[] {
  const turns: SegmentTurn[] = [];
  for (const item of items) {
    if (item.type === "reasoning") continue;
    if (item.type === "function_call") {
      let assistant = turns.at(-1);
      if (!assistant || assistant.role !== "Assistant" || assistant.toolResult) {
        assistant = { role: "Assistant", content: "", toolCalls: [], toolResult: false };
        turns.push(assistant);
      }
      assistant.toolCalls.push({
        name: typeof item.name === "string" ? item.name : "unknown",
        arguments: typeof item.arguments === "string" ? item.arguments : "{}",
      });
      continue;
    }
    if (item.type === "function_call_output") {
      turns.push({
        role: "Function",
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
        toolCalls: [],
        toolResult: true,
      });
      continue;
    }
    if (item.type === "message") {
      const role = item.role === "system" ? "System" : item.role === "assistant" ? "Assistant" : "Human";
      turns.push({ role, content: textContent(item.content), toolCalls: [], toolResult: false });
      continue;
    }
    if (item.type.endsWith("_call")) {
      turns.push({ role: "Assistant", content: textContent(item), toolCalls: [], toolResult: false });
    }
  }
  return turns;
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const record = part as Record<string, unknown>;
    return typeof record.text === "string" ? [record.text] : [];
  }).join("");
}

function toolArguments(argumentsJson: string): Record<string, unknown> {
  try {
    const value = JSON.parse(argumentsJson) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function argPlain(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function computeTurnStats(turns: readonly SegmentTurn[]) {
  const roleCounts = new Map<string, number>();
  const toolCounts = new Map<string, number>();
  const files = new Set<string>();
  let errors = 0;
  let verboseBytes = 0;
  let lastAssistant = "";
  for (const turn of turns) {
    roleCounts.set(turn.role, (roleCounts.get(turn.role) ?? 0) + 1);
    verboseBytes += PER_TURN_OVERHEAD_BYTES;
    if (turn.role === "Assistant") {
      verboseBytes += utf8Length(turn.content);
      if (turn.content) lastAssistant = turn.content;
      for (const call of turn.toolCalls) {
        toolCounts.set(call.name, (toolCounts.get(call.name) ?? 0) + 1);
        const args = toolArguments(call.arguments);
        for (const key of FILE_ARG_KEYS) {
          if (typeof args[key] === "string" && args[key]) {
            files.add(args[key] as string);
            break;
          }
        }
        for (const [key, value] of Object.entries(args)) verboseBytes += 32 + utf8Length(key) + utf8Length(argPlain(value));
      }
    } else {
      verboseBytes += utf8Length(turn.content);
      if (turn.toolResult && (turn.content.startsWith("Error") || turn.content.includes("Failed tool validation"))) errors += 1;
    }
  }
  return { turns, roleCounts, toolCounts, files: [...files].sort(), errors, verboseBytes, lastAssistant };
}

function renderStats(stats: ReturnType<typeof computeTurnStats>): string {
  const roles = [...stats.roleCounts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([role, count]) => `${role}=${count}`).join(", ");
  const tools = [...stats.toolCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => `${name} (${count})`).join(", ") || "(none)";
  const files = stats.files.length === 0 ? "(none)" : stats.files.length <= 8 ? stats.files.join(", ") : `${stats.files.slice(0, 5).join(", ")}, ... and ${stats.files.length - 5} more`;
  const excerpt = [...stats.lastAssistant].slice(-500).join("").trim().replaceAll("\n", " ").slice(0, 300);
  return `## Turn statistics\n\n- Turns: ${stats.turns.length} (${roles})\n- Tools used: ${tools}\n- Unique target files (${stats.files.length}): ${files}\n- Tool errors: ${stats.errors}\n- Verbose-render size estimate: ${stats.verboseBytes.toLocaleString("en-US")} B\n${excerpt ? `- Last assistant response excerpt: "${excerpt}"\n` : ""}\n`;
}

function renderVerboseTurn(turn: SegmentTurn, index: number): string {
  const parts = [`### Turn ${index} (${turn.role})`];
  if (turn.toolResult) parts.push("[tool_response]");
  if (turn.content) parts.push(turn.content);
  for (const call of turn.toolCalls) {
    parts.push(`[tool_request: ${call.name}]`);
    for (const [key, value] of Object.entries(toolArguments(call.arguments))) parts.push(`- ${key}: ${argPlain(value)}`);
  }
  return `${parts.join("\n")}\n`;
}

function segmentLabel(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Compaction segment index must be a non-negative integer.");
  return String(index).padStart(3, "0");
}
