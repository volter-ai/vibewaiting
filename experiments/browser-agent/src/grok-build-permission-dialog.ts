import type {
  GrokBuildPermissionPromptOutcome,
  GrokBuildPermissionRequest,
} from "./grok-build-permissions.js";

/** Pager-shaped reverse permission request rendered in the browser. */
export function requestGrokBuildToolPermission(
  request: GrokBuildPermissionRequest,
  signal: AbortSignal,
  doc: Document = document,
): Promise<GrokBuildPermissionPromptOutcome> {
  signal.throwIfAborted();
  const dialog = doc.createElement("dialog");
  dialog.className = "grok-permission-dialog";
  const form = doc.createElement("form");
  form.method = "dialog";
  const header = doc.createElement("header");
  const title = doc.createElement("h2");
  title.textContent = permissionTitle(request);
  const description = doc.createElement("p");
  description.textContent = `Grok wants to use ${request.toolName}.`;
  header.append(title, description);
  const detail = doc.createElement("pre");
  detail.className = "grok-permission-preview";
  detail.textContent = request.detail || JSON.stringify(request.input, null, 2);
  const actions = doc.createElement("footer");
  form.append(header, detail, actions);
  dialog.append(form);
  doc.body.append(dialog);

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      signal.removeEventListener("abort", aborted);
      dialog.remove();
    };
    const finish = (outcome: GrokBuildPermissionPromptOutcome): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };
    const aborted = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    actions.append(action(doc, "No", "reject-once", finish, "danger"));
    if (request.kind === "bash" || request.kind === "mcp" || request.kind === "web_fetch") {
      actions.append(action(doc, rejectAlwaysLabel(request), "reject-always", finish, "danger secondary"));
    }
    actions.append(action(doc, allowAlwaysLabel(request), request.kind === "edit" ? "allow-edits-session" : "allow-always", finish, "secondary"));
    actions.append(action(doc, "Enable always approve", "enable-always-approve", finish, "secondary"));
    actions.append(action(doc, request.kind === "bash" ? "Yes, proceed" : "Yes", "allow-once", finish));
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish("cancelled"); });
    signal.addEventListener("abort", aborted, { once: true });
    dialog.showModal();
  });
}

function permissionTitle(request: GrokBuildPermissionRequest): string {
  if (request.kind === "edit") return `Allow edit to ${request.detail || "the project"}?`;
  if (request.kind === "bash") return "Run this command?";
  if (request.kind === "mcp") return `Use MCP tool ${request.detail || request.toolName}?`;
  if (request.kind === "web_fetch") return "Fetch this URL?";
  return `Allow ${request.toolName}?`;
}

function allowAlwaysLabel(request: GrokBuildPermissionRequest): string {
  if (request.kind === "edit") return "Yes, allow all edits during this session";
  if (request.kind === "bash") return "Always allow this command";
  if (request.kind === "mcp") return `Always allow ${request.detail || request.toolName}`;
  if (request.kind === "web_fetch") {
    try { return `Always allow ${new URL(request.detail ?? "").hostname} for this project`; }
    catch { return "Always allow this URL"; }
  }
  return "Always allow";
}

function rejectAlwaysLabel(request: GrokBuildPermissionRequest): string {
  if (request.kind === "bash") return "Never allow this command";
  if (request.kind === "mcp") return `Never allow ${request.detail || request.toolName}`;
  if (request.kind === "web_fetch") return "Never allow this domain";
  return "Never allow";
}

function action(
  doc: Document,
  label: string,
  outcome: GrokBuildPermissionPromptOutcome,
  finish: (outcome: GrokBuildPermissionPromptOutcome) => void,
  className = "",
): HTMLButtonElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.className = className;
  button.dataset.permissionOutcome = outcome;
  button.addEventListener("click", () => finish(outcome));
  return button;
}
