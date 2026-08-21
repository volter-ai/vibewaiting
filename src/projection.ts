// Vibewaiting owns the trusted host lifecycle; Supercode UI owns how controller state becomes UI.
// Keep this seam deliberately thin so every consumer gets the same bounded transcript, request,
// fidelity, reduction, and harness semantics.
import {
  createClientProjection,
  projectClientSnapshot,
  type ClientProjectionOptions,
} from "@volter-ai-dev/supercode-ui/controller";
import type {
  SessionAttention as SupercodeSessionAttention,
  StartupPhase as SupercodeStartupPhase,
  SupercodeUiState,
} from "@volter-ai-dev/supercode-ui";
import type { SupercodeClientSnapshot } from "@volter-ai-dev/supercode-client";

export type WidgetState = SupercodeUiState;
export type SessionAttention = SupercodeSessionAttention;
export type SessionAttentionKind = SessionAttention["kind"];
export type StartupPhase = SupercodeStartupPhase;
export type AttachError = NonNullable<SupercodeUiState["attachError"]>;
export type ExportReceipt = NonNullable<SupercodeUiState["exportReceipt"]>;

export type ProjectionOptions = Pick<
  ClientProjectionOptions,
  "maxEntries" | "maxScanEntries" | "maxEntryChars"
>;

export const DEFAULT_MAX_ENTRIES = 120;
export const DEFAULT_MAX_ENTRY_CHARS = 16_000;
/** An attach failure is one line under a compact session row. */
export const MAX_ATTACH_ERROR_CHARS = 200;

function boundedText(value: string, maxChars: number): string {
  const chars = Array.from(value.trim());
  return chars.length <= maxChars ? chars.join("") : `${chars.slice(0, maxChars).join("")}…`;
}

/** Attach is a host operation, so its row-scoped failure remains a Vibewaiting concern. */
export function toAttachError(key: string, message: string): AttachError {
  return { key, message: boundedText(message, MAX_ATTACH_ERROR_CHARS) };
}

/** Delegate all controller semantics to the reusable Supercode UI package. */
export function project(
  snapshot: SupercodeClientSnapshot,
  options: ProjectionOptions = {},
): WidgetState {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  return projectClientSnapshot(snapshot, {
    maxEntries,
    maxScanEntries: options.maxScanEntries ?? maxEntries * 4,
    maxEntryChars: options.maxEntryChars ?? DEFAULT_MAX_ENTRY_CHARS,
  });
}

/**
 * The same bounded projection plus its host-only historical-image registry. The browser receives
 * `state`; the daemon retains `resolveImage` and serves one admitted image only after an explicit
 * viewer request.
 */
export function projectWithImages(
  snapshot: SupercodeClientSnapshot,
  options: ProjectionOptions = {},
): ReturnType<typeof createClientProjection> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  return createClientProjection(snapshot, {
    maxEntries,
    maxScanEntries: options.maxScanEntries ?? maxEntries * 4,
    maxEntryChars: options.maxEntryChars ?? DEFAULT_MAX_ENTRY_CHARS,
  });
}
