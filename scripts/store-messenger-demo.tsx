// Deliberately sanitized store-artwork fixture. This mounts the production messenger with a
// representative bounded inventory; it is not shipped in the extension or exercised in merge CI.
import type { SupercodeUiState } from "@volter-ai-dev/supercode-ui";
import { mountMessenger } from "../widget/messenger.js";
import type { MessengerTransport } from "../widget/transport.js";

const now = Date.now();
const state: SupercodeUiState = {
  pill: { tone: "live", label: "Local agents connected" },
  startup: "ready",
  busy: true,
  operation: "Reviewing authentication edge cases",
  needsInput: false,
  harness: "claude-code",
  mode: "none",
  strategy: null,
  canSend: false,
  canSteer: false,
  canResume: false,
  supportsResume: false,
  continuationModes: ["terminal", "headless"],
  canBranch: false,
  supportsBranch: false,
  canAttach: false,
  supportsAttach: false,
  canDetach: false,
  canOpenTerminal: true,
  canExport: false,
  canReduce: false,
  canInterrupt: false,
  canRespond: false,
  canConfigureSettings: true,
  messaging: null,
  workspace: "/demo/projects",
  transcript: [],
  taskPlan: { source: "none", items: [], residueCount: 0, observedAt: null },
  semantics: {
    fidelity: null,
    residue: [],
    residueCount: 0,
    parseErrors: 0,
    rawRecords: 0,
    subagents: [],
  },
  terminalHandoff: null,
  exportBackTarget: null,
  exportReceipt: null,
  reductionReceipt: null,
  interopSettings: null,
  interopSettingsError: null,
  harnessAuthentication: null,
  error: null,
  recoverable: false,
  harnesses: [
    {
      id: "claude-code",
      label: "Claude Code",
      installed: true,
      startable: true,
      reason: null,
    },
    {
      id: "codex",
      label: "Codex",
      installed: true,
      startable: true,
      reason: null,
    },
  ],
  history: {
    sessionLimit: 50,
    hasMoreSessions: false,
    transcriptLimit: 100,
    hasEarlier: false,
  },
  savedDraft: "",
  attention: [
    {
      key: "release",
      kind: "unseen",
      preview: "The release checks passed. Ready for your review.",
      afterMessages: 42,
      unreadCount: 2,
    },
  ],
  sessions: [
    {
      key: "auth-review",
      harness: "claude-code",
      name: "checkout",
      cwd: "/demo/apps/checkout",
      title: "Review authentication edge cases",
      preview: "Tracing the callback flow now…",
      age: "now",
      previewUpdatedAt: now,
      updatedAt: now,
      messages: 58,
      active: true,
      writable: true,
      live: true,
      runtimeStatus: "busy",
    },
    {
      key: "release",
      harness: "codex",
      name: "vibewaiting",
      cwd: "/demo/projects/vibewaiting",
      title: "Prepare Vibewaiting for public release",
      preview: "The release checks passed. Ready for your review.",
      age: "2m ago",
      previewUpdatedAt: now - 2 * 60_000,
      updatedAt: now - 2 * 60_000,
      messages: 42,
      active: false,
      writable: true,
      live: true,
      runtimeStatus: "idle",
    },
    {
      key: "mobile-navigation",
      harness: "claude-code",
      name: "dashboard",
      cwd: "/demo/apps/dashboard",
      title: "Improve mobile navigation",
      preview: "Tests pass; checking the small-screen layout.",
      age: "7m ago",
      previewUpdatedAt: now - 7 * 60_000,
      updatedAt: now - 7 * 60_000,
      messages: 27,
      active: false,
      writable: true,
      live: true,
      runtimeStatus: "running",
    },
    {
      key: "transcript-performance",
      harness: "codex",
      name: "session-viewer",
      cwd: "/demo/tools/session-viewer",
      title: "Investigate slow transcript loading",
      preview: "Indexed the recent window without replaying the archive.",
      age: "18m ago",
      previewUpdatedAt: now - 18 * 60_000,
      updatedAt: now - 18 * 60_000,
      messages: 91,
      active: false,
      writable: false,
      live: false,
      runtimeStatus: null,
    },
  ],
  subagentInspector: null,
  attached: null,
  owned: null,
  attachError: null,
};

let patchListener: ((patch: unknown) => void) | null = null;
let sequence = 0;
const transport: MessengerTransport = {
  sendIntent(_name, _payload) {
    const id = `store-demo:${++sequence}`;
    queueMicrotask(() => patchListener?.({ ...state, bridgeAck: id }));
    return id;
  },
  onPatch(listener) {
    patchListener = listener;
    queueMicrotask(() => listener(state));
    return () => {
      if (patchListener === listener) patchListener = null;
    };
  },
  onVisibility(listener) {
    queueMicrotask(() => listener(true));
    return () => undefined;
  },
  setLauncher() {},
  closeShell() {},
  destroy() {},
};

mountMessenger(transport, { closable: false });
