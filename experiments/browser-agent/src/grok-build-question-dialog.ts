export interface GrokQuestionOption {
  label: string;
  description: string;
  preview?: string;
  id?: string;
}

export interface GrokQuestion {
  question: string;
  options: GrokQuestionOption[];
  multi_select?: boolean;
  multiSelect?: boolean;
  id?: string;
}

export interface GrokQuestionAnswer {
  question: GrokQuestion;
  labels: string[];
  preview?: string;
  notes?: string;
}

export type GrokQuestionOutcome =
  | { type: "accepted"; answers: GrokQuestionAnswer[] }
  | { type: "chat"; answers: GrokQuestionAnswer[] }
  | { type: "skip"; answers: GrokQuestionAnswer[] }
  | { type: "cancelled" };

export interface GrokQuestionDialogOptions {
  planMode?: boolean;
  timeoutMs?: number;
  document?: Document;
}

export const GROK_QUESTION_CANCEL_TEXT = "User declined to answer the questions. Continue with the task using your best judgment, or ask different questions.";
export const GROK_QUESTION_EMPTY_TEXT = "No questions provided. Continue with the task.";

const activeDialogs = new WeakMap<Document, () => void>();

/** Native structured AskUserQuestion interaction rendered entirely in-browser. */
export async function askGrokUserQuestions(
  rawQuestions: unknown[],
  signal: AbortSignal,
  options: GrokQuestionDialogOptions = {},
): Promise<string> {
  if (rawQuestions.length === 0) return GROK_QUESTION_EMPTY_TEXT;
  const questions = parseQuestions(rawQuestions);
  const outcome = await showQuestionDialog(questions, signal, options);
  return formatGrokQuestionOutcome(questions, outcome);
}

export function parseQuestions(rawQuestions: unknown[]): GrokQuestion[] {
  const seen = new Set<string>();
  return rawQuestions.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Each question must be an object.");
    const value = raw as Record<string, unknown>;
    if (typeof value.question !== "string") throw new Error("Question text is required.");
    if (seen.has(value.question)) throw new Error(`Duplicate question text: "${value.question}"`);
    seen.add(value.question);
    if (!Array.isArray(value.options)) throw new Error("Question options are required.");
    const question: GrokQuestion = {
      question: value.question,
      options: value.options.map((rawOption) => {
        if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) throw new Error("Each question option must be an object.");
        const option = rawOption as Record<string, unknown>;
        if (typeof option.label !== "string" || typeof option.description !== "string") {
          throw new Error("Every option requires a label and description.");
        }
        return {
          label: option.label,
          description: option.description,
          ...(typeof option.preview === "string" ? { preview: option.preview } : {}),
          ...(typeof option.id === "string" ? { id: option.id } : {}),
        };
      }),
      ...(lenientBoolean(value.multi_select ?? value.multiSelect) ? { multi_select: true } : {}),
      ...(typeof value.id === "string" ? { id: value.id } : {}),
    };
    return question;
  });
}

export function formatGrokQuestionOutcome(questions: readonly GrokQuestion[], outcome: GrokQuestionOutcome): string {
  if (outcome.type === "cancelled") return GROK_QUESTION_CANCEL_TEXT;
  if (outcome.type === "accepted") {
    const entries = outcome.answers.filter((answer) => answer.labels.length > 0).map((answer) => {
      const parts = [`"${answer.question.question}"="${answer.labels.join(", ")}"`];
      if (answer.preview !== undefined) parts.push(`selected preview:\n${answer.preview}`);
      if (answer.notes !== undefined) parts.push(`user notes: ${answer.notes}`);
      return parts.join(" ");
    });
    return `User has answered your questions: ${entries.join(", ")}. You can now continue with the user's answers in mind.`;
  }
  const answers = new Map(outcome.answers.filter((answer) => answer.labels.length > 0)
    .map((answer) => [answer.question.question, answer.labels.join(", ")]));
  const lines = questions.map((question) => answers.has(question.question)
    ? `- "${question.question}"\n  Answer: ${answers.get(question.question)}`
    : `- "${question.question}"\n  (No answer provided)`).join("\n");
  if (outcome.type === "chat") {
    return `The user wants to clarify these questions.\n    This means they may have additional information, context or questions for you.\n    Take their response into account and then reformulate the questions if appropriate.\n    Start by asking them what they would like to clarify.\n\n    Questions asked:\n${lines}`;
  }
  return `The user has indicated they have provided enough answers for the plan interview.\nStop asking clarifying questions and proceed to finish the plan with the information you have.\n\nQuestions asked and answers provided:\n${lines}`;
}

function showQuestionDialog(
  questions: GrokQuestion[],
  signal: AbortSignal,
  options: GrokQuestionDialogOptions,
): Promise<GrokQuestionOutcome> {
  signal.throwIfAborted();
  const doc = options.document ?? document;
  activeDialogs.get(doc)?.();
  const dialog = doc.createElement("dialog");
  dialog.className = "grok-question-dialog";
  dialog.setAttribute("aria-labelledby", "grok-question-title");
  const form = doc.createElement("form");
  form.method = "dialog";
  const header = doc.createElement("header");
  const title = doc.createElement("h2");
  title.id = "grok-question-title";
  title.textContent = questions.length === 1 ? "Grok has a question" : `Grok has ${questions.length} questions`;
  const subtitle = doc.createElement("p");
  subtitle.textContent = "Choose an option or add your own answer.";
  header.append(title, subtitle);
  form.append(header);

  const fields: Array<{ question: GrokQuestion; inputs: HTMLInputElement[]; other: HTMLInputElement; previews: Map<HTMLInputElement, string> }> = [];
  questions.forEach((question, questionIndex) => {
    const fieldset = doc.createElement("fieldset");
    const legend = doc.createElement("legend");
    legend.textContent = question.question;
    fieldset.append(legend);
    const inputs: HTMLInputElement[] = [];
    const previews = new Map<HTMLInputElement, string>();
    for (const option of question.options) {
      const label = doc.createElement("label");
      label.className = "grok-question-option";
      const input = doc.createElement("input");
      input.type = question.multi_select ? "checkbox" : "radio";
      input.name = `grok-question-${questionIndex}`;
      input.value = option.label;
      const copy = doc.createElement("span");
      const strong = doc.createElement("strong");
      strong.textContent = option.label;
      const description = doc.createElement("small");
      description.textContent = option.description;
      copy.append(strong, description);
      label.append(input, copy);
      fieldset.append(label);
      inputs.push(input);
      if (option.preview !== undefined) previews.set(input, option.preview);
    }
    const otherLabel = doc.createElement("label");
    otherLabel.className = "grok-question-option grok-question-other";
    const otherChoice = doc.createElement("input");
    otherChoice.type = question.multi_select ? "checkbox" : "radio";
    otherChoice.name = `grok-question-${questionIndex}`;
    otherChoice.value = "Other";
    const otherCopy = doc.createElement("span");
    const otherTitle = doc.createElement("strong");
    otherTitle.textContent = "Other";
    const other = doc.createElement("input");
    other.type = "text";
    other.placeholder = "Type your answer";
    other.setAttribute("aria-label", `Other answer for ${question.question}`);
    other.addEventListener("focus", () => { otherChoice.checked = true; });
    otherCopy.append(otherTitle, other);
    otherLabel.append(otherChoice, otherCopy);
    fieldset.append(otherLabel);
    inputs.push(otherChoice);
    const preview = doc.createElement("pre");
    preview.className = "grok-question-preview";
    preview.hidden = true;
    for (const input of inputs) input.addEventListener("change", () => {
      const selectedPreview = [...previews].find(([candidate]) => candidate.checked)?.[1];
      preview.hidden = selectedPreview === undefined;
      preview.textContent = selectedPreview ?? "";
    });
    fieldset.append(preview);
    form.append(fieldset);
    fields.push({ question, inputs, other, previews });
  });

  const actions = doc.createElement("footer");
  const cancel = button(doc, "Cancel", "cancel", "secondary");
  actions.append(cancel);
  if (options.planMode) {
    actions.append(button(doc, "Chat about this", "chat", "secondary"));
    actions.append(button(doc, "Finish plan interview", "skip", "secondary"));
  }
  const submit = button(doc, "Submit answers", "accepted");
  actions.append(submit);
  form.append(actions);
  dialog.append(form);
  doc.body.append(dialog);

  return new Promise((resolve, reject) => {
    let settled = false;
    let cancelForReplacement: () => void;
    const timeoutMs = options.timeoutMs ?? 30 * 60_000;
    const timer = globalThis.setTimeout(() => finish({ type: "cancelled" }), timeoutMs);
    const cleanup = (): void => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      if (activeDialogs.get(doc) === cancelForReplacement) activeDialogs.delete(doc);
      dialog.remove();
    };
    const finish = (outcome: GrokQuestionOutcome): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };
    cancelForReplacement = (): void => finish({ type: "cancelled" });
    activeDialogs.set(doc, cancelForReplacement);
    const aborted = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    const answers = (): GrokQuestionAnswer[] => fields.map(({ question, inputs, other, previews }) => {
      const checked = inputs.filter((input) => input.checked);
      const labels = checked.map((input) => input.value);
      const selectedPreview = checked.map((input) => previews.get(input)).find((value) => value !== undefined);
      const otherSelected = checked.some((input) => input.value === "Other");
      return {
        question,
        labels,
        ...(selectedPreview !== undefined ? { preview: selectedPreview } : {}),
        ...(otherSelected && other.value.trim() ? { notes: other.value.trim() } : {}),
      };
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null;
      const action = submitter?.value ?? "accepted";
      if (action === "cancel") finish({ type: "cancelled" });
      else if (action === "chat") finish({ type: "chat", answers: answers() });
      else if (action === "skip") finish({ type: "skip", answers: answers() });
      else finish({ type: "accepted", answers: answers() });
    });
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish({ type: "cancelled" }); });
    signal.addEventListener("abort", aborted, { once: true });
    dialog.showModal();
  });
}

function lenientBoolean(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0) return false;
  if (value === true || value === 1) return true;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "1"].includes(normalized)) return true;
    if (["false", "no", "0", ""].includes(normalized)) return false;
  }
  return false;
}

function button(doc: Document, label: string, value: string, className = ""): HTMLButtonElement {
  const element = doc.createElement("button");
  element.type = "submit";
  element.value = value;
  element.textContent = label;
  if (className) element.className = className;
  return element;
}
