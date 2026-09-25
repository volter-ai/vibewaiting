/**
 * The approval cards in the messenger: an agent's browser action that needs
 * the person's approval (browser-policy.ts) waits here, naming the exact
 * action and page, until the person approves it once or denies it. The
 * background re-runs the one approved operation; nothing is approved standing.
 */

export interface BrowserApprovalCard {
  id: string;
  summary: string;
  reason: string;
  detail?: string;
}

export interface BrowserApprovals {
  readonly node: HTMLElement;
  show(card: BrowserApprovalCard): void;
  settle(id: string, decision: string): void;
}

const SHIELD_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>`;

export function parseBrowserApprovalCard(value: unknown): BrowserApprovalCard | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { id, summary, reason, detail } = value as Record<string, unknown>;
  if (typeof id !== "string" || typeof summary !== "string" || typeof reason !== "string") return null;
  return { id, summary, reason, ...(typeof detail === "string" ? { detail } : {}) };
}

export function createBrowserApprovals(
  decide: (id: string, decision: "approve" | "deny") => void,
): BrowserApprovals {
  const node = document.createElement("div");
  node.className = "vw-approvals";
  node.setAttribute("role", "region");
  node.setAttribute("aria-label", "Browser actions waiting for your approval");
  const cards = new Map<string, HTMLElement>();

  const show = (card: BrowserApprovalCard): void => {
    if (cards.has(card.id)) return;
    const element = document.createElement("section");
    element.className = "vw-approval";
    element.setAttribute("role", "alertdialog");
    element.setAttribute("aria-label", card.summary);
    const head = document.createElement("div");
    head.className = "vw-approval-head";
    head.innerHTML = SHIELD_ICON;
    const label = document.createElement("small");
    label.textContent = "The agent is asking to";
    head.append(label);
    const summary = document.createElement("strong");
    summary.textContent = card.summary;
    const scope = document.createElement("p");
    scope.textContent = "Approve once lets only this action run. The agent asks again next time.";
    element.append(head, summary, scope);
    if (card.detail) {
      const detail = document.createElement("pre");
      detail.textContent = card.detail;
      element.append(detail);
    }
    const actions = document.createElement("div");
    actions.className = "vw-approval-actions";
    const deny = document.createElement("button");
    deny.type = "button";
    deny.className = "vw-approval-deny";
    deny.textContent = "Deny";
    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "vw-approval-approve";
    approve.textContent = "Approve once";
    const answer = (decision: "approve" | "deny"): void => {
      deny.disabled = true;
      approve.disabled = true;
      (decision === "approve" ? approve : deny).textContent = decision === "approve" ? "Approving…" : "Denying…";
      decide(card.id, decision);
    };
    deny.addEventListener("click", () => answer("deny"));
    approve.addEventListener("click", () => answer("approve"));
    actions.append(deny, approve);
    element.append(actions);
    cards.set(card.id, element);
    // No focus move: a keystroke meant for the page never answers the card.
    node.append(element);
  };

  const settle = (id: string, decision: string): void => {
    const element = cards.get(id);
    if (!element) return;
    cards.delete(id);
    // The outcome narrates itself before the card leaves.
    const status = document.createElement("p");
    status.className = "vw-approval-status";
    status.setAttribute("role", "status");
    status.textContent =
      decision === "approve" ? "Approved once. The agent's action is running."
        : decision === "deny" ? "Denied. The agent was told."
          : decision === "expired" ? "No answer in time. Nothing ran."
            : "The tab closed. Nothing ran.";
    element.querySelector(".vw-approval-actions")?.replaceWith(status);
    setTimeout(() => element.remove(), 2_500);
  };

  return { node, show, settle };
}
