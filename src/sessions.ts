// Trusted machine-wide inventory adaptation. Supercode owns every generic row semantic; this file
// retains only Vibewaiting's stable opaque key and its active-header fallback.
import { sessionReconnectIdentitySync } from "@volter-ai-dev/supercode-client/node";
import type { SessionDescriptor, SessionLocator } from "@volter-ai-dev/supercode-harness-sdk";
import type { AttachedSessionModel } from "@volter-ai-dev/supercode-ui";
import {
  projectSessionInventory,
  sessionConversationUpdatedAt,
  sessionDescriptorRuntimeStatus,
  type ProjectedSessionRowModel,
} from "@volter-ai-dev/supercode-ui/controller";

export const MAX_SESSION_ROWS = 30;
export type SessionRow = ProjectedSessionRowModel;

export interface ActiveSessionRef {
  harness: string;
  sessionId: string | null;
}

/** Stable opaque key; the daemon alone keeps its reversible descriptor map. */
export function sessionKey(locator: SessionLocator): string {
  return sessionReconnectIdentitySync(locator);
}

export function matchesActive(
  descriptor: SessionDescriptor,
  active: ActiveSessionRef | null | undefined,
): boolean {
  return Boolean(
    active?.sessionId !== null &&
      active?.sessionId !== undefined &&
      descriptor.locator.harness === active.harness &&
      descriptor.locator.session_id === active.sessionId,
  );
}

export function shortCwd(cwd: string | null | undefined, home: string): string {
  if (!cwd) return "";
  const root = home.endsWith("/") ? home.slice(0, -1) : home;
  return root && (cwd === root || cwd.startsWith(`${root}/`))
    ? `~${cwd.slice(root.length)}`
    : cwd;
}

function workspaceName(cwd: string | null | undefined): string {
  if (!cwd) return "";
  return cwd.split("/").filter(Boolean).at(-1) ?? "/";
}

export const conversationUpdatedAt = sessionConversationUpdatedAt;
export const sessionRuntimeStatus = sessionDescriptorRuntimeStatus;

export function projectSessions(
  descriptors: readonly SessionDescriptor[],
  options: {
    now: number;
    home?: string;
    active?: ActiveSessionRef | null;
    isWritable?: (descriptor: SessionDescriptor) => boolean;
    max?: number;
    preserveOrder?: boolean;
  },
): SessionRow[] {
  return projectSessionInventory(descriptors, {
    keyFor: (descriptor) => sessionKey(descriptor.locator),
    now: options.now,
    ...(options.home !== undefined ? { home: options.home } : {}),
    ...(options.active !== undefined ? { active: options.active } : {}),
    ...(options.isWritable !== undefined
      ? { isWritable: options.isWritable }
      : {}),
    maxSessions: options.max ?? MAX_SESSION_ROWS,
    ...(options.preserveOrder !== undefined
      ? { preserveOrder: options.preserveOrder }
      : {}),
  });
}

export function attachmentFor(
  active: ActiveSessionRef | null | undefined,
  rows: readonly SessionRow[],
  fallbackWorkspace: string,
  home: string,
): AttachedSessionModel | null {
  if (!active?.harness) return null;
  const row = rows.find((candidate) => candidate.active);
  if (row) {
    return {
      key: row.key,
      harness: row.harness,
      name: row.name,
      cwd: row.cwd,
      title: row.title,
    };
  }
  return {
    key: "",
    harness: active.harness,
    name: workspaceName(fallbackWorkspace) || "no workspace",
    cwd: shortCwd(fallbackWorkspace, home),
    title: workspaceName(fallbackWorkspace) || "Untitled chat",
  };
}
