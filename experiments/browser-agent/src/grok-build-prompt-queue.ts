// Copyright 2023-2026 SpaceXAI
// SPDX-License-Identifier: Apache-2.0
// Modified for the Vibewaiting browser port, 2026.

export const GROK_BUILD_QUEUE_TEXT_SEPARATOR = "\n\n";
export const GROK_BUILD_INTERJECTION_NOTE = "The user sent a message while you were working:";
export const GROK_BUILD_INTERRUPT_NOTE = "The user interrupted the previous turn:";
export const GROK_BUILD_UNFINISHED_TASKS_REMINDER = "Make sure to complete any unfinished tasks from previous turns.";
export const GROK_BUILD_LARGE_PROMPT_BYTES = 25_000;

export interface GrokBuildQueueCombineGate {
  id: string;
  isPlainPrompt: boolean;
  isSynthetic: boolean;
  isExpandedSkill: boolean;
  isBash: boolean;
  hasImages: boolean;
  text: string;
}

export interface GrokBuildPendingInterjection<Attachment> {
  text: string;
  attachments: Attachment[];
}

export interface GrokBuildFormattedInterjection<Attachment> extends GrokBuildPendingInterjection<Attachment> {}

/** Stateful browser coordinator for native send-now and queued-followup rules. */
export class GrokBuildLivePromptCoordinator<Attachment = never> {
  private readonly interjections: GrokBuildPendingInterjection<Attachment>[] = [];
  private readonly queued: GrokBuildQueueCombineGate[] = [];

  sendNow(text: string, attachments: Attachment[] = []): void {
    this.interjections.push({ text, attachments });
  }

  queue(text: string, hasImages = false): void {
    this.queued.push({
      id: crypto.randomUUID(), text, isPlainPrompt: true, isSynthetic: false,
      isExpandedSkill: false, isBash: false, hasImages,
    });
  }

  drainInterjections(): GrokBuildFormattedInterjection<Attachment>[] {
    return drainFormattedGrokBuildInterjections(this.interjections);
  }

  takeQueuedPrefix(skipIds: ReadonlySet<string> = new Set()): string | undefined {
    const count = grokBuildQueueCombinePrefixLength(this.queued, skipIds);
    if (count === 0) return undefined;
    const text = joinGrokBuildQueuedPromptTexts(this.queued.splice(0, count).map((entry) => entry.text));
    return text || undefined;
  }

  hasQueued(): boolean {
    return this.queued.length > 0;
  }

  clear(): void {
    this.interjections.splice(0);
    this.queued.splice(0);
  }
}

export function canMergeGrokBuildQueueFront(gate: GrokBuildQueueCombineGate): boolean {
  return gate.isPlainPrompt && !gate.isSynthetic && !gate.isExpandedSkill && !gate.isBash && gate.text.length > 0;
}

export function canMergeGrokBuildQueueFollower(gate: GrokBuildQueueCombineGate, skipIds: ReadonlySet<string>): boolean {
  return canMergeGrokBuildQueueFront(gate) && !gate.hasImages && !skipIds.has(gate.id);
}

/** Native prefix rule: an ineligible front is still consumed alone. */
export function grokBuildQueueCombinePrefixLength(
  gates: readonly GrokBuildQueueCombineGate[],
  skipIds: ReadonlySet<string> = new Set(),
): number {
  const front = gates[0];
  if (!front) return 0;
  if (!canMergeGrokBuildQueueFront(front)) return 1;
  let length = 1;
  while (length < gates.length && canMergeGrokBuildQueueFollower(gates[length]!, skipIds)) length += 1;
  return length;
}

export function joinGrokBuildQueuedPromptTexts(texts: readonly string[]): string {
  return texts.filter((text) => text.length > 0).join(GROK_BUILD_QUEUE_TEXT_SEPARATOR);
}

export function grokBuildUserQuery(text: string): string {
  return `<user_query>\n${text}\n</user_query>`;
}

export function frameGrokBuildUserTurn(note: string, assembled: string): string {
  return `${note}\n${assembled}\n${GROK_BUILD_UNFINISHED_TASKS_REMINDER}`;
}

export function formatGrokBuildInterjection(text: string): string {
  return formatSteeredQuery(GROK_BUILD_INTERJECTION_NOTE, text);
}

export function formatGrokBuildInterrupt(text: string): string {
  return formatSteeredQuery(GROK_BUILD_INTERRUPT_NOTE, text);
}

/** FIFO, one synthetic user message per entry; native never merges interjections. */
export function drainFormattedGrokBuildInterjections<Attachment>(
  entries: GrokBuildPendingInterjection<Attachment>[],
  sanitizeText: (text: string) => string = (text) => text,
): GrokBuildFormattedInterjection<Attachment>[] {
  return entries.splice(0).map((entry) => ({
    text: formatGrokBuildInterjection(sanitizeText(entry.text)),
    attachments: entry.attachments,
  }));
}

function formatSteeredQuery(note: string, text: string): string {
  return frameGrokBuildUserTurn(note, grokBuildUserQuery(utf8TruncatePrompt(text)));
}

function utf8TruncatePrompt(text: string): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= GROK_BUILD_LARGE_PROMPT_BYTES) return text;
  let end = GROK_BUILD_LARGE_PROMPT_BYTES;
  while (end > 0) {
    try {
      return `${new TextDecoder("utf-8", { fatal: true }).decode(encoded.slice(0, end))}... [truncated]`;
    } catch {
      end -= 1;
    }
  }
  return "... [truncated]";
}
