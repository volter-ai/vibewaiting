import { describe, expect, it } from "vitest";
import {
  drainFormattedGrokBuildInterjections,
  formatGrokBuildInterjection,
  formatGrokBuildInterrupt,
  GrokBuildLivePromptCoordinator,
  grokBuildQueueCombinePrefixLength,
  joinGrokBuildQueuedPromptTexts,
  type GrokBuildQueueCombineGate,
} from "../experiments/browser-agent/src/grok-build-prompt-queue.js";

const plain = (id: string, text: string): GrokBuildQueueCombineGate => ({
  id, text, isPlainPrompt: true, isSynthetic: false, isExpandedSkill: false, isBash: false, hasImages: false,
});

describe("Grok Build browser prompt queue source port", () => {
  it("matches native queue prefix combination and stop gates", () => {
    expect(grokBuildQueueCombinePrefixLength([plain("a", "one"), plain("b", "two"), plain("c", "three")])).toBe(3);
    expect(joinGrokBuildQueuedPromptTexts(["one", "two", "three"])).toBe("one\n\ntwo\n\nthree");
    expect(grokBuildQueueCombinePrefixLength([
      plain("a", "one"),
      { ...plain("bash", "ls"), isBash: true },
      plain("c", "three"),
    ])).toBe(1);
    expect(grokBuildQueueCombinePrefixLength([plain("a", "one"), { ...plain("image", "see"), hasImages: true }])).toBe(1);
    expect(grokBuildQueueCombinePrefixLength([plain("a", "one"), plain("edit", "draft")], new Set(["edit"]))).toBe(1);
    expect(grokBuildQueueCombinePrefixLength([{ ...plain("image", "see"), hasImages: true }, plain("b", "two")])).toBe(2);
  });

  it("uses the exact native steer and interrupt envelopes", () => {
    expect(formatGrokBuildInterjection("fix the test first")).toBe(
      "The user sent a message while you were working:\n<user_query>\nfix the test first\n</user_query>\nMake sure to complete any unfinished tasks from previous turns.",
    );
    expect(formatGrokBuildInterrupt("do the other thing")).toBe(
      "The user interrupted the previous turn:\n<user_query>\ndo the other thing\n</user_query>\nMake sure to complete any unfinished tasks from previous turns.",
    );
  });

  it("truncates at the native UTF-8 byte boundary", () => {
    const result = formatGrokBuildInterjection("é".repeat(25_000));
    expect(result).toContain("é".repeat(12_500));
    expect(result).not.toContain("é".repeat(12_501));
    expect(result).toContain("... [truncated]");
  });

  it("drains FIFO, sanitizes, preserves attachments, and never merges entries", () => {
    const pending = [
      { text: "look at [SECRET] one", attachments: [1] },
      { text: "two", attachments: [2] },
    ];
    expect(drainFormattedGrokBuildInterjections(pending, (text) => text.replace("[SECRET] ", ""))).toEqual([
      { text: formatGrokBuildInterjection("look at one"), attachments: [1] },
      { text: formatGrokBuildInterjection("two"), attachments: [2] },
    ]);
    expect(pending).toEqual([]);
  });

  it("coordinates live interjections and native queued prefixes independently", () => {
    const coordinator = new GrokBuildLivePromptCoordinator<number>();
    coordinator.sendNow("steer", [7]);
    coordinator.queue("one");
    coordinator.queue("two");
    expect(coordinator.drainInterjections()).toEqual([{ text: formatGrokBuildInterjection("steer"), attachments: [7] }]);
    expect(coordinator.takeQueuedPrefix()).toBe("one\n\ntwo");
    expect(coordinator.hasQueued()).toBe(false);
    coordinator.queue("discard");
    coordinator.clear();
    expect(coordinator.takeQueuedPrefix()).toBeUndefined();
  });
});
