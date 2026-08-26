// Deliberately sanitized store-artwork fixture. This mounts the production messenger and terminal
// components; it is not shipped in the extension or exercised in merge CI.
import { TerminalViewer } from "@volter-ai-dev/supercode-terminal/ui";
import type { JSX } from "preact";
import {
  mountMessenger,
  type TerminalPanelProps,
} from "../widget/messenger.js";
import type { MessengerTransport } from "../widget/transport.js";

function DemoTerminal({ state }: TerminalPanelProps): JSX.Element {
  if (!state.attachment) throw new Error("The store fixture requires a terminal attachment.");
  return (
    <section class="vw-terminal-surface" aria-label="Terminal view">
      <TerminalViewer active attachment={state.attachment} />
    </section>
  );
}

const now = Date.now();
const state = {
  pill: { tone: "live", label: "Terminal ready" },
  startup: "ready",
  busy: true,
  operation: "Running release checks",
  needsInput: false,
  harness: "codex",
  mode: "control",
  strategy: null,
  canSend: true,
  canSteer: true,
  canResume: false,
  supportsResume: true,
  continuationModes: ["terminal", "headless"],
  canBranch: false,
  supportsBranch: true,
  canAttach: false,
  supportsAttach: true,
  canDetach: true,
  canOpenTerminal: true,
  canExport: false,
  canReduce: false,
  canInterrupt: true,
  canRespond: false,
  canConfigureSettings: true,
  messaging: null,
  workspace: "/demo/projects/vibewaiting",
  transcript: [],
  harnesses: [{ id: "codex", label: "Codex", installed: true, startable: true, reason: null }],
  history: { sessionLimit: 50, hasMoreSessions: false, transcriptLimit: 100, hasEarlier: false },
  savedDraft: "",
  attention: [],
  sessions: [{
    key: "release",
    harness: "codex",
    name: "vibewaiting",
    cwd: "/demo/projects/vibewaiting",
    title: "Prepare Vibewaiting for public release",
    preview: "Running release checks…",
    age: "now",
    previewUpdatedAt: now,
    updatedAt: now,
    messages: 34,
    active: true,
    writable: true,
    live: true,
    runtimeStatus: "busy",
  }],
  subagentInspector: null,
  attached: null,
  owned: null,
  attachError: null,
  terminalHost: {
    available: true,
    canOpenLocal: true,
    error: null,
    sessions: [{
      id: "demo-terminal",
      label: "Vibewaiting release",
      cwd: "/demo/projects/vibewaiting",
      activeCommand: "codex",
      owned: true,
      size: { columns: 96, rows: 28 },
    }],
    bindings: [],
    attachment: {
      id: "demo-grant",
      baseUrl: "http://127.0.0.1:49200",
      mode: "control",
      conversationKey: null,
      sessionId: "demo-terminal",
    },
  },
};

const conversation = {
  key: "release",
  harness: "codex",
  name: "vibewaiting",
  cwd: "/demo/projects/vibewaiting",
  title: "Prepare Vibewaiting for public release",
};
const conversationState = {
  ...state,
  attached: conversation,
  owned: conversation,
  terminalHost: {
    ...state.terminalHost,
    bindings: [{ conversationKey: "release", sessionId: "demo-terminal" }],
    attachment: {
      ...state.terminalHost.attachment,
      conversationKey: "release",
    },
  },
};

let patchListener: ((patch: unknown) => void) | null = null;
let sequence = 0;
let currentState: object = state;
const transport: MessengerTransport = {
  sendIntent(_name, _payload) {
    const id = `store-demo:${++sequence}`;
    queueMicrotask(() => patchListener?.({ ...currentState, bridgeAck: id }));
    return id;
  },
  onPatch(listener) {
    patchListener = listener;
    queueMicrotask(() => listener(state));
    window.setTimeout(() => {
      currentState = conversationState;
      listener(conversationState);
    }, 100);
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

mountMessenger(transport, {
  TerminalPanel: DemoTerminal,
  requestPresentation: async () => undefined,
});
