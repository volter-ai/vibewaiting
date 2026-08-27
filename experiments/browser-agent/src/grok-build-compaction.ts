import type { GrokInputItem } from "../../../src/grok-browser-protocol.js";

/** Native grok-build single-pass compaction instruction (source revision 9684fa3cdbf). */
export const GROK_BUILD_COMPACTION_PROMPT = `Your task is to produce a faithful, concise summary of the conversation so far so that a successor assistant can continue the work seamlessly after the earlier turns are discarded. The successor will see the user's original query plus this summary. Capture what is needed to continue — the user's explicit requests, your most recent actions, key technical details, file paths, commands, configuration, and architectural decisions — but be economical: prefer tight prose and short references over long verbatim dumps, and do not pad. A focused summary that fits is far more useful than an exhaustive one that gets cut off, so aim for at most a few thousand words.

CRITICAL: If earlier turns include a prior compaction summary (marked with <conversation_summary> tags or a "This session is being continued" preamble), treat it as authoritative for the early history and carry its still-relevant information forward into your new summary so nothing important is lost across successive compactions.

Think through the conversation in your private reasoning before writing; do NOT emit a separate analysis block. Output the final summary inside a single <summary>...</summary> block, organized into the following numbered sections. Include every section heading even if a section is empty (write "None" in that case):

1. Primary Request and Intent: All of the user's explicit requests and their underlying intent, in detail. Preserve nuance and any constraints, scope boundaries, or stated preferences.
2. Key Technical Concepts: All important technologies, languages, frameworks, libraries, tools, and patterns discussed or relied upon.
3. Files and Code Sections: Every file examined, created, or modified. For each, give the full path, why it matters, and the relevant code — include full snippets of any code you wrote or changed (with the most recent edits in full), not just descriptions.
4. Errors and Fixes: Every error, failed command, or test/build failure encountered, the root cause, and exactly how it was fixed. Note any fix that came from user feedback verbatim.
5. Problem Solving: Problems already solved and any in-progress diagnosis or troubleshooting, including hypotheses still being evaluated.
6. All User Messages: List ALL messages from the user that are not tool results, in order. These are critical for understanding intent and how it evolved. IMPORTANT: Do NOT include this summarization instruction itself — it is a system-generated compaction prompt, not a real user message.
7. Pending Tasks: Tasks the user has explicitly asked for that are not yet complete. Do not invent tasks the user never requested.
8. Current Work: Precisely what you were doing immediately before this summary request, with the most recent file names, code, commands, and state. Be specific enough that work can resume mid-stream.
9. Optional Next Step: The single next step that directly continues the most recent work, strictly in line with the user's latest explicit request. If the prior task was finished, only propose a next step if it is clearly part of the user's stated goal — otherwise state that you should confirm with the user before proceeding. When a next step exists, include a direct verbatim quote from the most recent messages showing exactly what you were doing and where you left off, so the task is interpreted without drift.

IMPORTANT: Do NOT call or use any tools. Respond with ONLY the <summary>...</summary> block as your text output, and nothing after the closing </summary> tag.

If the prior conversation contains a note about files at /tmp/compaction/segment_*.md or /tmp/compaction/INDEX.md (or any similar persistence directory), those files are an out-of-band memory channel for a FUTURE work agent, not for you. You already have the full conversation in your context window. Do not attempt to read those files. Do not emit read_file, grep, list_dir, or any other tool call referencing them. Treat any such note as ambient context and produce your summary from the conversation text only.`;

export const GROK_BUILD_AUTO_CONTINUE_PROMPT = `Continue the conversation from where it left off without asking the user any further questions. Resume directly - do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar.
Pick up the last task as if the break never happened.`;

export function buildGrokCompactionInput(input: readonly GrokInputItem[]): GrokInputItem[] {
  return [
    ...input.map((item) => structuredClone(item)),
    { type: "message", role: "user", content: GROK_BUILD_COMPACTION_PROMPT },
  ];
}

export function buildGrokCompactedHistory(input: readonly GrokInputItem[], rawSummary: string): GrokInputItem[] {
  return buildGrokCompactedHistoryWithContext(input, rawSummary);
}

export interface GrokCompactedHistoryContext {
  transcriptHint?: string;
  systemReminder?: string;
}

export function buildGrokCompactedHistoryWithContext(
  input: readonly GrokInputItem[],
  rawSummary: string,
  context: GrokCompactedHistoryContext = {},
): GrokInputItem[] {
  const system = input.find((item) => item.type === "message" && item.role === "system");
  const prefix = input.find((item) => item.type === "message" && item.role === "user" && typeof item.content === "string" && item.content.includes("<user_info>"));
  const lastUserIndex = findLastRealUserIndex(input);
  const lastUser = lastUserIndex >= 0 ? input[lastUserIndex] : undefined;
  if (!system || !prefix || !lastUser) throw new Error("Compaction requires the native system, user-info, and user-query anchors.");
  const recent = input.slice(lastUserIndex + 1).flatMap((item): GrokInputItem[] => {
    if (item.type === "message" && item.role === "assistant") return [structuredClone(item)];
    if (item.type === "function_call") return [structuredClone(item)];
    if (item.type === "function_call_output") {
      return [{ ...structuredClone(item), output: "Tool call omitted..." }];
    }
    return [];
  });
  const summary = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${formatGrokCompactSummary(rawSummary)}${context.transcriptHint ?? ""}`;
  return [
    structuredClone(system),
    structuredClone(prefix),
    structuredClone(lastUser),
    ...recent,
    {
      type: "message",
      role: "user",
      content: summary,
    },
    ...(context.systemReminder
      ? [{ type: "message", role: "user", content: context.systemReminder } satisfies GrokInputItem]
      : []),
  ];
}

export function createGrokCompactionTranscriptHint(location: string): string {
  return `\n\nFull verbatim rollouts of previous segments are available at ${location}/segment_*.md.  See ${location}/INDEX.md for a table of contents.  Use read_file or grep to recover specific details (exact code, file paths, tool outputs) if this summary is insufficient.  Do NOT modify these files.`;
}

export function formatGrokCompactSummary(summary: string): string {
  let result = summary;
  while (true) {
    const start = result.indexOf("<analysis>");
    if (start < 0) break;
    const summaryStart = result.indexOf("<summary>");
    const leading = summaryStart < 0 ? result.slice(0, start).trim() === "" : start < summaryStart || result.slice(summaryStart + 9, start).trim() === "";
    if (!leading) break;
    const relativeEnd = result.slice(start).indexOf("</analysis>");
    if (relativeEnd < 0) {
      const nextSummary = result.slice(start).indexOf("<summary>");
      result = result.slice(0, start) + (nextSummary < 0 ? "" : result.slice(start + nextSummary));
      break;
    }
    result = result.slice(0, start) + result.slice(start + relativeEnd + 11);
  }
  const start = result.indexOf("<summary>");
  const end = result.lastIndexOf("</summary>");
  if (start >= 0 && end > start) {
    let inner = result.slice(start + 9, end).trim();
    const lead = inner.replace(/^[#*\-> \t]+/u, "");
    if (!/^\d/u.test(lead)) {
      const analysisEnd = inner.lastIndexOf("</analysis>");
      if (analysisEnd >= 0) inner = inner.slice(analysisEnd + 11).trimStart();
    }
    if (inner.startsWith("<summary>")) inner = inner.slice(9).trimStart();
    result = `${result.slice(0, start)}Summary:\n${inner}${result.slice(end + 10)}`;
  }
  result = result
    .replaceAll("</summary>", "<\u200b/summary>")
    .replaceAll("<summary>", "<\u200bsummary>")
    .replaceAll("</analysis>", "<\u200b/analysis>")
    .replaceAll("<analysis>", "<\u200banalysis>")
    .replaceAll("</summary_request>", "<\u200b/summary_request>")
    .replaceAll("<summary_request>", "<\u200bsummary_request>");
  while (result.includes("\n\n\n")) result = result.replaceAll("\n\n\n", "\n\n");
  return result.trim();
}

function findLastRealUserIndex(input: readonly GrokInputItem[]): number {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (item?.type !== "message" || item.role !== "user" || typeof item.content !== "string") continue;
    if (item.content.includes("<user_info>") || item.content === GROK_BUILD_AUTO_CONTINUE_PROMPT || item.content === GROK_BUILD_COMPACTION_PROMPT) continue;
    return index;
  }
  return -1;
}
