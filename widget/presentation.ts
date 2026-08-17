import type { TranscriptContext, TranscriptEntry } from "../src/projection.js";

export type ToolCategory = "read" | "search" | "edit" | "command" | "test" | "web" | "agent" | "other";

export function toolCategory(tool: Pick<TranscriptEntry, "label" | "arguments">): ToolCategory {
  const value = tool.label?.toLowerCase() ?? "";
  if (/read|view|open_file|list_dir/.test(value)) return "read";
  if (/search|find|grep|glob/.test(value)) return "search";
  if (/edit|write|patch|replace|create_file/.test(value)) return "edit";
  if (/test|typecheck|lint|build/.test(value)) return "test";
  if (/terminal|bash|shell|command|exec/.test(value)) {
    return /(?:^|\s)(?:npm|pnpm|yarn|bun|cargo|go|pytest|vitest|jest|tsc).*?(?:test|typecheck|lint|build)|\b(?:test|typecheck|lint|build)\b/i.test(
      tool.arguments ?? "",
    )
      ? "test"
      : "command";
  }
  if (/browser|web|fetch|url/.test(value)) return "web";
  if (/subagent|spawn|task/.test(value)) return "agent";
  return "other";
}

export function toolLabel(name: string | undefined): string {
  if (!name) return "Tool";
  const simple = name.split(/__|\//).at(-1) ?? name;
  return simple.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function toolTarget(argumentsText: string | undefined): string {
  if (!argumentsText) return "";
  try {
    const args = JSON.parse(argumentsText) as Record<string, unknown>;
    for (const key of ["file_path", "target_file", "path", "command", "cmd", "query", "pattern", "url"]) {
      const candidate = args[key];
      if (typeof candidate === "string") return candidate;
    }
  } catch {
    return argumentsText.length > 120 ? `${argumentsText.slice(0, 117)}…` : argumentsText;
  }
  return "";
}

export function compactToolTarget(target: string, workspace: string): string {
  if (!target || !workspace) return target;
  const prefix = workspace.endsWith("/") ? workspace : `${workspace}/`;
  return target.startsWith(prefix) ? target.slice(prefix.length) : target;
}

export function toolGroupSummary(tools: readonly TranscriptEntry[]): string {
  const counts = new Map<ToolCategory, number>();
  for (const tool of tools) {
    const category = toolCategory(tool);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const onlyRoutine = [...counts.keys()].every((category) => category === "read" || category === "search");
  if (onlyRoutine) {
    const files = (counts.get("read") ?? 0) + (counts.get("search") ?? 0);
    return `Explored ${files} ${files === 1 ? "item" : "items"}`;
  }
  const parts: string[] = [];
  const labels: Array<[ToolCategory, string]> = [
    ["edit", "changed"],
    ["test", "tests/builds"],
    ["command", "commands"],
    ["read", "reads"],
    ["search", "searches"],
    ["web", "web"],
    ["agent", "agents"],
    ["other", "other"],
  ];
  for (const [category, label] of labels) {
    const count = counts.get(category);
    if (count) parts.push(`${count} ${label}`);
  }
  return parts.length ? `Activity · ${parts.join(" · ")}` : `Activity · ${tools.length} steps`;
}

export type ConversationBlock =
  | { kind: "entry"; id: string; entry: TranscriptEntry }
  | { kind: "tool-group"; id: string; tools: TranscriptEntry[] };

export function conversationBlocks(entries: readonly TranscriptEntry[]): ConversationBlock[] {
  const blocks: ConversationBlock[] = [];
  for (const entry of entries) {
    if (entry.role !== "tool") {
      blocks.push({ kind: "entry", id: entry.id, entry });
      continue;
    }
    const previous = blocks.at(-1);
    if (previous?.kind === "tool-group") previous.tools.push(entry);
    else blocks.push({ kind: "tool-group", id: `tools:${entry.id}`, tools: [entry] });
  }
  return blocks;
}

export function activeWorkContext(entries: readonly TranscriptEntry[]): TranscriptContext | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || (entry.role !== "user" && entry.role !== "assistant")) continue;
    const work = [...(entry.context ?? [])].reverse().find((candidate) => candidate.kind === "work-item");
    if (work) return work;
  }
  return null;
}

