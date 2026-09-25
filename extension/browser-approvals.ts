/**
 * The approval cards in the messenger: an agent's browser action that needs
 * the person's approval (browser-policy.ts) waits here, naming the exact
 * action and page, until the person answers: Deny, Allow once, or (for an
 * action an allowance can cover) Allow on <origin> for this task. The
 * background re-runs the one approved operation.
 *
 * Against clickjacking, an Allow button works only when the card has been
 * fully visible and still for a second (IntersectionObserver v2, restarted by
 * any move or resize of the card or of the messenger frame) and the pointer
 * had rested on that button for half a second when it is pressed: the half
 * second starts when the pointer, having moved onto the button, stops moving;
 * any movement of 3 px or more, leaving or re-entering the button, and any
 * move of the frame restart it, and movement between press and release is
 * ignored. An unarmed button reads "Hold still to allow", and a press on it
 * says so, so a click that does nothing is never silent. Both are measured inside the extension's own frame, where a
 * change in `screenX - clientX` (or its Y twin) between pointer events is a
 * move of the frame itself.
 */

export interface BrowserApprovalCard {
  id: string;
  summary: string;
  reason: string;
  detail?: string;
  note?: string;
  /** The origin "Allow on <origin> for this task" allows; absent when only Allow once is offered. */
  allowOrigin?: string;
}

export type BrowserApprovalDecision = "approve" | "allow-origin" | "deny";

export interface BrowserApprovals {
  readonly node: HTMLElement;
  show(card: BrowserApprovalCard): void;
  settle(id: string, decision: string): void;
  /** The messenger frame moved or resized: every Allow waits afresh. */
  restart(): void;
}

/** An Allow button works only after the card has been visible and still this long. */
const VISIBLE_BEFORE_APPROVE_MS = 1_000;
/** ... and the pointer has rested on that button this long. */
const REST_BEFORE_APPROVE_MS = 500;
/** Pointer movement at least this far (px) restarts the rest. */
const REST_TOLERANCE_PX = 3;

interface VisibilityEntry extends IntersectionObserverEntry {
  /** Intersection Observer v2: true only when nothing covers, fades or distorts the element. */
  readonly isVisible?: boolean;
}

const SHIELD_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>`;

export function parseBrowserApprovalCard(value: unknown): BrowserApprovalCard | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { id, summary, reason, detail, note, allowOrigin } = value as Record<string, unknown>;
  if (typeof id !== "string" || typeof summary !== "string" || typeof reason !== "string") return null;
  return {
    id, summary, reason,
    ...(typeof detail === "string" ? { detail } : {}),
    ...(typeof note === "string" ? { note } : {}),
    ...(typeof allowOrigin === "string" ? { allowOrigin } : {}),
  };
}

export function createBrowserApprovals(
  decide: (id: string, decision: BrowserApprovalDecision) => void,
): BrowserApprovals {
  const node = document.createElement("div");
  node.className = "vw-approvals";
  node.setAttribute("role", "region");
  node.setAttribute("aria-label", "Browser actions waiting for your approval");
  const cards = new Map<string, { element: HTMLElement; stop(): void; restart(): void }>();

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
    element.append(head, summary);
    if (card.note) {
      const note = document.createElement("p");
      note.textContent = card.note;
      element.append(note);
    }
    if (card.detail) {
      const detail = document.createElement("pre");
      detail.textContent = card.detail;
      element.append(detail);
    }
    const scope = document.createElement("p");
    scope.textContent = card.allowOrigin
      ? `Allow once runs only this action. Allowing ${card.allowOrigin} lets the agent act on that site in this tab without asking until 15 minutes pass unused, the tab closes or the agent's session ends (except passwords, codes, card numbers, files and scripts).`
      : "Allow once runs only this action. The agent asks again next time.";
    element.append(scope);

    const actions = document.createElement("div");
    actions.className = "vw-approval-actions";
    const deny = document.createElement("button");
    deny.type = "button";
    deny.className = "vw-approval-deny";
    deny.textContent = "Deny";
    const button = (text: string, decision: BrowserApprovalDecision): HTMLButtonElement => {
      const allow = document.createElement("button");
      allow.type = "button";
      allow.className = "vw-approval-approve";
      allow.dataset.decision = decision;
      allow.dataset.label = text;
      allow.setAttribute("aria-label", text);
      allow.textContent = text;
      return allow;
    };
    const allows = [button("Allow once", "approve")];
    if (card.allowOrigin) allows.push(button(`Allow on ${card.allowOrigin} for this task`, "allow-origin"));

    let answered = false;
    // The visibility gate: shared by the card's buttons.
    let visibleTimer: ReturnType<typeof setTimeout> | undefined;
    let visible = false;
    let still = false;
    // The rest gate: per button.
    const rested = new Map<HTMLButtonElement, boolean>();
    const restTimers = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>();
    const hovered = new Set<HTMLButtonElement>();
    const render = (): void => {
      for (const allow of allows) {
        const armed = !answered && still && rested.get(allow) === true;
        allow.setAttribute("aria-disabled", String(!armed));
        allow.dataset.armed = String(armed);
        if (!answered) allow.textContent = !armed && hovered.has(allow) ? "Hold still to allow" : allow.dataset.label ?? "";
      }
    };
    // The rest starts where the pointer, having moved on the button, is; a
    // button that appears (or is moved) under a pointer that is not moving
    // never arms, and moving 3 px or more starts it again.
    const anchors = new Map<HTMLButtonElement, { x: number; y: number; at: number }>();
    const rest = (allow: HTMLButtonElement): void => {
      clearTimeout(restTimers.get(allow));
      restTimers.delete(allow);
      anchors.delete(allow);
      rested.set(allow, false);
      render();
    };
    const moved = (allow: HTMLButtonElement, event: PointerEvent): void => {
      // Movement while pressed belongs to the click, not to the rest.
      if (!hovered.has(allow) || (event.buttons & 1) === 1) return;
      const anchor = anchors.get(allow);
      if (anchor && Math.hypot(event.clientX - anchor.x, event.clientY - anchor.y) < REST_TOLERANCE_PX) return;
      rest(allow);
      anchors.set(allow, { x: event.clientX, y: event.clientY, at: performance.now() });
      restTimers.set(allow, setTimeout(() => { restTimers.delete(allow); rested.set(allow, true); render(); }, REST_BEFORE_APPROVE_MS));
    };
    // The frame's place on the screen, as pointer events report it.
    let frameAt: string | null = null;
    const frameMoved = (event: PointerEvent): boolean => {
      const now = `${event.screenX - event.clientX},${event.screenY - event.clientY}`;
      const changed = frameAt !== null && now !== frameAt;
      frameAt = now;
      return changed;
    };
    const restart = (): void => {
      clearTimeout(visibleTimer);
      still = false;
      if (!answered && visible)
        visibleTimer = setTimeout(() => { still = true; render(); }, VISIBLE_BEFORE_APPROVE_MS);
      for (const allow of allows) rest(allow);
    };
    for (const allow of allows) {
      allow.addEventListener("pointerenter", (event) => { hovered.add(allow); if (frameMoved(event)) restart(); rest(allow); });
      allow.addEventListener("pointerleave", (event) => { hovered.delete(allow); frameMoved(event); rest(allow); });
      allow.addEventListener("pointermove", (event) => {
        hovered.add(allow);
        if (frameMoved(event)) {
          restart();
          return;
        }
        moved(allow, event);
      });
    }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1] as VisibilityEntry | undefined;
      visible = entry?.isIntersecting === true && entry.isVisible === true;
      restart();
    }, { threshold: [1], trackVisibility: true, delay: 100 } as IntersectionObserverInit);
    let place = "";
    let tracking = 0;
    const track = (): void => {
      const rect = element.getBoundingClientRect();
      const now = `${rect.x},${rect.y},${rect.width},${rect.height}`;
      if (place && now !== place) restart();
      place = now;
      tracking = requestAnimationFrame(track);
    };
    tracking = requestAnimationFrame(track);
    const stop = (): void => {
      clearTimeout(visibleTimer);
      for (const timer of restTimers.values()) clearTimeout(timer);
      cancelAnimationFrame(tracking);
      observer.disconnect();
    };
    const answer = (decision: BrowserApprovalDecision, pressed: HTMLButtonElement): void => {
      answered = true;
      stop();
      render();
      deny.disabled = true;
      for (const allow of allows) allow.disabled = true;
      pressed.textContent = decision === "deny" ? "Denying…" : "Allowing…";
      decide(card.id, decision);
    };
    deny.addEventListener("click", () => { if (!answered) answer("deny", deny); });
    // Arming is decided when the button is pressed: the card has been visible
    // and still for a second, and the pointer has rested on this button for
    // half a second.
    const pressedArmed = new Map<HTMLButtonElement, boolean>();
    const hint = document.createElement("p");
    hint.className = "vw-approval-status";
    hint.setAttribute("role", "status");
    for (const allow of allows) {
      allow.addEventListener("pointerdown", (event) => {
        const anchor = anchors.get(allow);
        pressedArmed.set(allow, event.isTrusted && !answered && still && hovered.has(allow) &&
          anchor !== undefined && performance.now() - anchor.at >= REST_BEFORE_APPROVE_MS);
      });
      allow.addEventListener("click", (event) => {
        if (answered) return;
        // A trusted keyboard press (no pointer) needs only the visibility gate.
        const armed = pressedArmed.get(allow) === true || (event.isTrusted && event.detail === 0 && still);
        pressedArmed.delete(allow);
        if (!armed) {
          hint.textContent = "Hold the pointer still on the button for half a second, then click.";
          if (!hint.isConnected) actions.before(hint);
          allow.textContent = "Hold still to allow";
          return;
        }
        answer(allow.dataset.decision as BrowserApprovalDecision, allow);
      });
    }
    actions.append(deny, ...allows);
    element.append(actions);
    render();
    cards.set(card.id, { element, stop, restart });
    // No focus move: a keystroke meant for the page never answers the card.
    node.append(element);
    observer.observe(element);
  };

  const settle = (id: string, decision: string): void => {
    const card = cards.get(id);
    if (!card) return;
    cards.delete(id);
    card.stop();
    const { element } = card;
    for (const button of Array.from(element.querySelectorAll("button"))) button.disabled = true;
    // The outcome narrates itself before the card leaves.
    const status = document.createElement("p");
    status.className = "vw-approval-status";
    status.setAttribute("role", "status");
    status.textContent =
      decision === "approve" ? "Allowed once. The agent's action is running."
        : decision === "allow-origin" ? "Allowed on this site for this task. The agent's action is running."
          : decision === "deny" ? "Denied. The agent was told."
            : decision === "expired" ? "No answer in time. Nothing ran."
              : decision === "abandoned" ? "The agent stopped waiting. Nothing ran."
                : "The tab closed. Nothing ran.";
    element.querySelector(".vw-approval-actions")?.replaceWith(status);
    // A card the agent walked away from stays until the person has read it.
    if (decision === "abandoned") {
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "vw-approval-deny";
      dismiss.textContent = "Dismiss";
      dismiss.addEventListener("click", () => element.remove());
      const actions = document.createElement("div");
      actions.className = "vw-approval-actions";
      actions.append(dismiss);
      status.after(actions);
      return;
    }
    setTimeout(() => element.remove(), 2_500);
  };

  const restart = (): void => {
    for (const card of cards.values()) card.restart();
  };

  return { node, show, settle, restart };
}
