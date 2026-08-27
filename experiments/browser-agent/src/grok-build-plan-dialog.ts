export type GrokPlanApproval =
  | { outcome: "approved" }
  | { outcome: "cancelled"; feedback?: string }
  | { outcome: "abandoned" };

/** Browser permission prompt for agent-initiated entry into plan mode. */
export function approveGrokPlanEntry(signal: AbortSignal, doc: Document = document): Promise<boolean> {
  return showDialog<boolean>(signal, doc, (dialog, finish) => {
    const form = shell(doc, "Enter plan mode?", "Grok wants to explore the project and write a read-only implementation plan before making changes.");
    const actions = doc.createElement("footer");
    actions.append(action(doc, "Keep working", () => finish(false), "secondary"));
    actions.append(action(doc, "Enter plan mode", () => finish(true)));
    form.append(actions);
    dialog.append(form);
  });
}

/** Native three-way plan approval flow: approve, request changes, or abandon. */
export function approveGrokPlanExit(plan: string, signal: AbortSignal, doc: Document = document): Promise<GrokPlanApproval> {
  return showDialog<GrokPlanApproval>(signal, doc, (dialog, finish) => {
    const form = shell(doc, "Review implementation plan", "Approve the plan, request changes, or abandon it entirely.");
    const preview = doc.createElement("pre");
    preview.className = "grok-plan-preview";
    preview.textContent = plan || "No plan content was written.";
    const feedback = doc.createElement("textarea");
    feedback.rows = 3;
    feedback.placeholder = "Optional feedback for requested changes";
    feedback.setAttribute("aria-label", "Plan revision feedback");
    form.append(preview, feedback);
    const actions = doc.createElement("footer");
    actions.append(action(doc, "Abandon plan", () => finish({ outcome: "abandoned" }), "danger"));
    actions.append(action(doc, "Request changes", () => finish({
      outcome: "cancelled",
      ...(feedback.value.trim() ? { feedback: feedback.value.trim() } : {}),
    }), "secondary"));
    actions.append(action(doc, "Approve and implement", () => finish({ outcome: "approved" })));
    form.append(actions);
    dialog.append(form);
  });
}

function showDialog<T>(
  signal: AbortSignal,
  doc: Document,
  render: (dialog: HTMLDialogElement, finish: (value: T) => void) => void,
): Promise<T> {
  signal.throwIfAborted();
  const dialog = doc.createElement("dialog");
  dialog.className = "grok-plan-dialog";
  doc.body.append(dialog);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      signal.removeEventListener("abort", aborted);
      dialog.remove();
    };
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const aborted = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    render(dialog, finish);
    dialog.addEventListener("cancel", (event) => event.preventDefault());
    signal.addEventListener("abort", aborted, { once: true });
    dialog.showModal();
  });
}

function shell(doc: Document, title: string, description: string): HTMLFormElement {
  const form = doc.createElement("form");
  form.method = "dialog";
  form.addEventListener("submit", (event) => event.preventDefault());
  const header = doc.createElement("header");
  const heading = doc.createElement("h2");
  heading.textContent = title;
  const copy = doc.createElement("p");
  copy.textContent = description;
  header.append(heading, copy);
  form.append(header);
  return form;
}

function action(doc: Document, label: string, run: () => void, className = ""): HTMLButtonElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.className = className;
  button.addEventListener("click", run);
  return button;
}
