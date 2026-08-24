export type LauncherBadgeTone = "attention" | "neutral";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Keeps count urgency tied to local actionability, not merely to observed message volume. */
export function launcherBadgeFromState(stateValue: unknown): {
  count: number;
  tone: LauncherBadgeTone;
} {
  const state = record(stateValue);
  const sessions = (Array.isArray(state?.sessions) ? state.sessions : [])
    .map(record)
    .filter((session): session is Record<string, unknown> => typeof session?.key === "string");
  const sessionsByKey = new Map(sessions.map((session) => [session.key as string, session]));
  const attention = (Array.isArray(state?.attention) ? state.attention : [])
    .map(record)
    .filter((item): item is Record<string, unknown> => typeof item?.key === "string");
  const attentionKeys = new Set(attention.map((item) => item.key as string));
  let count = attention.reduce(
    (total, item) => total + (
      Number.isSafeInteger(item.unreadCount)
        ? Math.max(1, item.unreadCount as number)
        : 1
    ),
    0,
  );
  let actionable = attention.length > 0 && attention.every(
    (item) => sessionsByKey.get(item.key as string)?.writable === true,
  );
  let observed = attention.some(
    (item) => sessionsByKey.get(item.key as string)?.writable !== true,
  );

  if (state?.needsInput === true) {
    const attached = record(state.attached);
    const owned = record(state.owned);
    const key = typeof attached?.key === "string"
      ? attached.key
      : typeof owned?.key === "string"
        ? owned.key
        : "@needs-input";
    if (!attentionKeys.has(key)) count += 1;
    const inputIsActionable = state.canRespond === true || state.canSend === true ||
      sessionsByKey.get(key)?.writable === true;
    actionable ||= inputIsActionable;
    observed ||= !inputIsActionable;
  }

  return { count, tone: actionable && !observed ? "attention" : "neutral" };
}
