import { describe, expect, it } from "vitest";
import {
  GROK_QUESTION_CANCEL_TEXT,
  GROK_QUESTION_EMPTY_TEXT,
  askGrokUserQuestions,
  formatGrokQuestionOutcome,
  parseQuestions,
  type GrokQuestion,
} from "../experiments/browser-agent/src/grok-build-question-dialog.js";

const questions: GrokQuestion[] = [
  {
    question: "Which database?",
    options: [
      { label: "Redis", description: "In-memory", preview: "redis preview" },
      { label: "Postgres", description: "Relational" },
    ],
  },
  {
    question: "Which checks?",
    options: [
      { label: "Tests", description: "Unit tests" },
      { label: "Types", description: "Type checking" },
    ],
    multi_select: true,
  },
];

describe("Grok Build structured question UI", () => {
  it("validates and normalizes native question input", () => {
    expect(parseQuestions([{ question: "Pick", options: [{ label: "A", description: "First" }], multiSelect: "yes" }]))
      .toEqual([{ question: "Pick", options: [{ label: "A", description: "First" }], multi_select: true }]);
    expect(parseQuestions([{ question: "Freeform", options: [] }])).toEqual([{ question: "Freeform", options: [] }]);
    expect(() => parseQuestions([
      { question: "Same", options: [] },
      { question: "Same", options: [] },
    ])).toThrow('Duplicate question text: "Same"');
    expect(() => parseQuestions([{ question: "Pick", options: [{ label: "A" }] }])).toThrow("label and description");
  });

  it("returns the native empty-batch result without opening a dialog", async () => {
    await expect(askGrokUserQuestions([], new AbortController().signal)).resolves.toBe(GROK_QUESTION_EMPTY_TEXT);
  });

  it("matches native accepted formatting with previews, multiselect, and Other notes", () => {
    expect(formatGrokQuestionOutcome(questions, { type: "accepted", answers: [
      { question: questions[0]!, labels: ["Redis"], preview: "redis preview" },
      { question: questions[1]!, labels: ["Tests", "Other"], notes: "Also run lint" },
    ] })).toBe('User has answered your questions: "Which database?"="Redis" selected preview:\nredis preview, "Which checks?"="Tests, Other" user notes: Also run lint. You can now continue with the user\'s answers in mind.');
  });

  it("matches native cancel and both plan-interview action formats", () => {
    expect(formatGrokQuestionOutcome(questions, { type: "cancelled" })).toBe(GROK_QUESTION_CANCEL_TEXT);
    expect(formatGrokQuestionOutcome(questions, { type: "chat", answers: [
      { question: questions[0]!, labels: ["Redis"] },
    ] })).toBe('The user wants to clarify these questions.\n    This means they may have additional information, context or questions for you.\n    Take their response into account and then reformulate the questions if appropriate.\n    Start by asking them what they would like to clarify.\n\n    Questions asked:\n- "Which database?"\n  Answer: Redis\n- "Which checks?"\n  (No answer provided)');
    expect(formatGrokQuestionOutcome(questions, { type: "skip", answers: [] })).toBe('The user has indicated they have provided enough answers for the plan interview.\nStop asking clarifying questions and proceed to finish the plan with the information you have.\n\nQuestions asked and answers provided:\n- "Which database?"\n  (No answer provided)\n- "Which checks?"\n  (No answer provided)');
  });
});
