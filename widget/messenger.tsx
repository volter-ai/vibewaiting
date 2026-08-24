// Vibewaiting is intentionally only the composition seam between a browser delivery transport and
// Supercode's reusable default UI. Agent semantics, components, transcript presentation, logos,
// continuation controls, and presentation memory live in @volter-ai-dev/supercode-ui. This file
// owns only transport intents and the host/guest adaptation required by Widget Shell.
import { SupercodeMessenger } from "@volter-ai-dev/supercode-ui/preact/messenger";
import {
  harnessLogoDataUrl,
  hasHarnessLogo,
} from "@volter-ai-dev/supercode-ui/preact/logo";
import { normalizeUiState } from "@volter-ai-dev/supercode-ui/core";
import type {
  MessengerComposerCommand,
  MessengerNavigation,
  SupercodeUiIntent,
  SupercodeUiState,
  TranscriptAttachment,
  TranscriptImage,
  UiAdapter,
} from "@volter-ai-dev/supercode-ui";
import {
  normalizeTerminalUiState,
  type TerminalUiState,
} from "@volter-ai-dev/supercode-terminal/ui";
import { render as renderPreact } from "preact";
import type { ComponentType, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { MessengerTransport } from "./transport.js";
import type { MessengerHostEvent } from "./transport.js";
import {
  VIBEWAITING_PRESENTATION,
  type VibewaitingPresentation,
} from "../src/presentations.js";
import { browserShortcutLabel } from "../src/browser-shortcuts.js";

export type TerminalIntent =
  | { action: "terminalRefresh" }
  | { action: "terminalCreate"; harness: "claude-code" | "codex" }
  | {
      action: "terminalAttach";
      sessionId: string;
      mode: "observe" | "control";
    }
  | { action: "terminalClose"; sessionId: string }
  | { action: "terminalOpenLocal"; sessionId: string }
  | { action: "terminalDismiss" };

type WidgetIntent =
  | SupercodeUiIntent
  | { action: "mounted" }
  | { action: "panelVisible" }
  | { action: "panelHidden" }
  | { action: "moveAllToTerminal" }
  | { action: "moveToTerminal" }
  | TerminalIntent
  | { action: "resolveImage"; requestId: string; reference: string };

export type TerminalHostState = Omit<TerminalUiState, "attachment"> & {
  attachment: (NonNullable<TerminalUiState["attachment"]> & {
    conversationKey: string | null;
    sessionId: string;
  }) | null;
  bindings: Array<{ conversationKey: string; sessionId: string }>;
};

export interface TerminalPanelProps {
  state: TerminalHostState;
  send(intent: TerminalIntent): void | Promise<void>;
}

export interface MessengerOptions {
  TerminalPanel?: ComponentType<TerminalPanelProps>;
  requestPresentation?(name: VibewaitingPresentation): Promise<void>;
}

function terminalHostState(value: unknown): TerminalHostState | null {
  if (!isRecord(value) || !isRecord(value.terminalHost)) return null;
  const normalized = normalizeTerminalUiState(value.terminalHost);
  const rawAttachment = value.terminalHost.attachment;
  const attachment = normalized.attachment &&
    isRecord(rawAttachment) &&
    typeof normalized.attachment.sessionId === "string"
    ? {
        ...normalized.attachment,
        conversationKey:
          typeof rawAttachment.conversationKey === "string"
            ? rawAttachment.conversationKey
            : null,
        sessionId: normalized.attachment.sessionId,
      }
    : null;
  const bindings = Array.isArray(value.terminalHost.bindings)
    ? value.terminalHost.bindings.flatMap((binding) =>
        isRecord(binding) &&
        typeof binding.conversationKey === "string" &&
        typeof binding.sessionId === "string"
          ? [{
              conversationKey: binding.conversationKey,
              sessionId: binding.sessionId,
            }]
          : [],
      )
    : [];
  return { ...normalized, attachment, bindings };
}

const INTENT_QUEUE = "agent";
// A cold native host has to establish messaging and seed its first bounded inventory before it can
// acknowledge the iframe. Keep that ordinary startup inside the messenger's connecting state;
// showing the blocking disconnected recovery surface sooner makes a healthy launch flash offline.
const BRIDGE_ACK_TIMEOUT_MS = 1_500;
const IMAGE_RESOLUTION_TIMEOUT_MS = 15_000;
const MAX_RESOLVED_IMAGE_URL_CHARS = 22_400_000;
const MAX_RESOLVED_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_PICKED_FILES = 8;
const MAX_FILE_BYTES_READ = 80_000;
const MAX_IMAGE_FILES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const TEXT_FILE_PATTERN =
  /\.(?:c|cc|cpp|css|csv|go|h|hpp|html|ini|java|js|json|jsx|md|mjs|py|rb|rs|sh|sql|toml|ts|tsx|txt|xml|ya?ml)$/i;

function readImage(file: File): Promise<TranscriptAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        id: `browser-image:${file.name}:${file.size}:${file.lastModified}`,
        label: file.name || "Attached image",
        url: String(reader.result),
      });
    reader.onerror = () =>
      reject(
        reader.error ?? new Error(`Could not read ${file.name || "image"}.`),
      );
    reader.readAsDataURL(file);
  });
}

function pickLocalFiles(): Promise<TranscriptAttachment[] | null> {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept =
    "image/png,image/jpeg,image/gif,image/webp,text/*,.json,.md,.mjs,.toml,.tsx,.ts,.yaml,.yml";
  input.hidden = true;
  document.body.append(input);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      value: TranscriptAttachment[] | null,
      error?: Error,
    ): void => {
      if (settled) return;
      settled = true;
      input.remove();
      if (error) reject(error);
      else resolve(value);
    };
    input.addEventListener("cancel", () => finish(null), { once: true });
    input.addEventListener(
      "change",
      () => {
        const files = [...(input.files ?? [])];
        if (!files.length) return finish(null);
        if (files.length > MAX_PICKED_FILES)
          return finish(
            null,
            new Error(`Attach at most ${MAX_PICKED_FILES} files at a time.`),
          );
        const images = files.filter((file) => file.type.startsWith("image/"));
        if (images.length > MAX_IMAGE_FILES)
          return finish(
            null,
            new Error(`Attach at most ${MAX_IMAGE_FILES} images at a time.`),
          );
        const unsupported = files.find(
          (file) =>
            !(
              IMAGE_TYPES.has(file.type) ||
              file.type.startsWith("text/") ||
              TEXT_FILE_PATTERN.test(file.name)
            ),
        );
        if (unsupported)
          return finish(
            null,
            new Error(
              `${unsupported.name} is not a supported text or image file.`,
            ),
          );
        const oversized = images.find((file) => file.size > MAX_IMAGE_BYTES);
        if (oversized)
          return finish(
            null,
            new Error(`${oversized.name} is larger than 5 MB.`),
          );
        void Promise.all(
          files.map(async (file): Promise<TranscriptAttachment> => {
            if (IMAGE_TYPES.has(file.type)) return readImage(file);
            const source = await file.slice(0, MAX_FILE_BYTES_READ).text();
            const truncated =
              file.size > MAX_FILE_BYTES_READ || source.length > 20_000;
            const suffix = truncated
              ? "\n\n[…file truncated to the messenger context limit]"
              : "";
            return {
              id: `browser-file:${file.name}:${file.size}:${file.lastModified}`,
              kind: "file",
              label: file.name,
              detail: `${source.slice(0, Math.max(0, 20_000 - suffix.length)) || "[Empty file]"}${suffix}`,
            };
          }),
        ).then(
          (items) => finish(items),
          (error: unknown) =>
            finish(
              null,
              error instanceof Error
                ? error
                : new Error("Could not read the selected files."),
            ),
        );
      },
      { once: true },
    );
    input.click();
  });
}

function showShortcutHelp(): void {
  if (document.querySelector(".vw-shortcut-help")) return;
  const dialog = document.createElement("dialog");
  dialog.className = "vw-shortcut-help";
  dialog.setAttribute("aria-label", "Keyboard shortcuts");
  const title = document.createElement("strong");
  title.textContent = "Keyboard shortcuts";
  const detail = document.createElement("small");
  detail.textContent = "Call Vibewaiting while staying on the current page.";
  const list = document.createElement("dl");
  for (const [label, shortcut] of [
    ["Focus message box", "focus"],
    ["Attach selection, pointed target, or page", "attach"],
    ["Previous conversation", "previous"],
    ["Next conversation", "next"],
  ] as const) {
    const row = document.createElement("div");
    const name = document.createElement("dt");
    const value = document.createElement("dd");
    const key = document.createElement("kbd");
    name.textContent = label;
    key.textContent = browserShortcutLabel(shortcut);
    value.append(key);
    row.append(name, value);
    list.append(row);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  const finish = (): void => {
    dialog.close();
    dialog.remove();
  };
  close.addEventListener("click", finish, { once: true });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finish();
  });
  dialog.append(title, detail, list, close);
  (document.querySelector(".vw-dialog") ?? document.body).append(dialog);
  dialog.showModal();
  close.focus();
}

export function mountMessenger(
  widget: MessengerTransport,
  options: MessengerOptions = {},
): () => void {
  const appRoot = document.getElementById("app") ?? document.body;
  let lastPanelState: unknown = {};
  let bridgeDisconnected = false;
  let bridgeReconnecting = false;
  let bridgeAckTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingBridgeIntent: {
    id: string;
    attachKey: string | null;
    acceptsSnapshot: boolean;
  } | null = null;
  const bridgeCompletions = new Map<string, () => void>();
  let imageRequestSequence = 0;
  const imageResolutions = new Map<
    string,
    {
      resolve: (blob: Blob) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let messengerNavigation: MessengerNavigation | null = null;
  let composerCommand: MessengerComposerCommand | null = null;
  let terminalSurfaceOpen = false;

  function resolveBridgeCompletion(id: string): void {
    const resolve = bridgeCompletions.get(id);
    if (!resolve) return;
    bridgeCompletions.delete(id);
    resolve();
  }

  function clearBridgeWatch(): void {
    if (bridgeAckTimer !== null) clearTimeout(bridgeAckTimer);
    bridgeAckTimer = null;
    pendingBridgeIntent = null;
  }

  function renderCurrentPanel(): void {
    renderMessengerPanel(appRoot, lastPanelState);
  }

  function watchBridge(id: string, intent: WidgetIntent): void {
    clearBridgeWatch();
    pendingBridgeIntent = {
      id,
      attachKey: intent.action === "attach" ? intent.key : null,
      acceptsSnapshot:
        intent.action === "mounted" || intent.action === "panelVisible",
    };
    bridgeAckTimer = setTimeout(() => {
      bridgeAckTimer = null;
      resolveBridgeCompletion(id);
      bridgeReconnecting = false;
      bridgeDisconnected = true;
      renderCurrentPanel();
      widget.setLauncher({ label: "Open agent chats · bridge disconnected" });
    }, BRIDGE_ACK_TIMEOUT_MS);
  }

  function sendBridgeIntent(intent: WidgetIntent): void | Promise<void> {
    const id = widget.sendIntent(INTENT_QUEUE, intent);
    if (intent.action !== "draft" && intent.action !== "ack")
      watchBridge(id, intent);
    if (
      intent.action === "draft" ||
      intent.action === "ack" ||
      intent.action === "mounted" ||
      intent.action === "panelVisible" ||
      intent.action === "panelHidden"
    )
      return;
    return new Promise<void>((resolve) => bridgeCompletions.set(id, resolve));
  }

  function imageBlobFromDataUrl(dataUrl: string): Blob {
    if (
      !dataUrl.startsWith("data:image/") ||
      dataUrl.length > MAX_RESOLVED_IMAGE_URL_CHARS
    ) {
      throw new Error("The host returned an invalid or oversized image.");
    }
    const comma = dataUrl.indexOf(",");
    if (comma < 0 || comma > 200)
      throw new Error("The host returned an invalid image.");
    const declaration = dataUrl.slice(5, comma);
    const mediaType = declaration.split(";", 1)[0]?.toLowerCase() ?? "";
    if (!mediaType.startsWith("image/"))
      throw new Error("The host returned an invalid image.");
    const encoded = dataUrl.slice(comma + 1);
    let blob: Blob;
    if (declaration.toLowerCase().endsWith(";base64")) {
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1)
        bytes[index] = binary.charCodeAt(index);
      blob = new Blob([bytes], { type: mediaType });
    } else {
      blob = new Blob([decodeURIComponent(encoded)], { type: mediaType });
    }
    if (blob.size > MAX_RESOLVED_IMAGE_BYTES)
      throw new Error("This image is too large to preview safely.");
    return blob;
  }

  function resolveHistoricalImage(image: TranscriptImage): Promise<Blob> {
    if (!image.reference)
      return Promise.reject(
        new Error("This image has no host retrieval reference."),
      );
    const reference = image.reference;
    imageRequestSequence += 1;
    const requestId = `image-${Date.now().toString(36)}-${imageRequestSequence.toString(36)}`;
    return new Promise<Blob>((resolve, reject) => {
      const timer = setTimeout(() => {
        imageResolutions.delete(requestId);
        reject(new Error("Loading this image timed out. Try again."));
      }, IMAGE_RESOLUTION_TIMEOUT_MS);
      imageResolutions.set(requestId, { resolve, reject, timer });
      Promise.resolve(
        sendBridgeIntent({ action: "resolveImage", requestId, reference }),
      ).catch((error: unknown) => {
        clearTimeout(timer);
        imageResolutions.delete(requestId);
        reject(
          error instanceof Error
            ? error
            : new Error("Could not request this image."),
        );
      });
    });
  }

  async function pickAttachments(): Promise<TranscriptAttachment[] | null> {
    if (!widget.requestBrowserContext) return pickLocalFiles();
    return await widget.requestBrowserContext("candidates");
  }

  function composerNavigation(
    state: SupercodeUiState,
    id: string,
  ): MessengerNavigation {
    if (state.attached?.key && (state.mode === "control" || state.canSend))
      return { id, view: "chat", sessionKey: state.attached.key };
    return {
      id,
      view: "new",
      ...(state.harness ? { harness: state.harness } : {}),
    };
  }

  function applyHostEvent(event: MessengerHostEvent): void {
    const state = normalizeUiState(lastPanelState);
    if (
      event.command === "previous-conversation" ||
      event.command === "next-conversation"
    ) {
      if (!state.sessions.length) return;
      const current = state.attached?.key
        ? state.sessions.findIndex((row) => row.key === state.attached?.key)
        : -1;
      const step = event.command === "next-conversation" ? 1 : -1;
      const index =
        current < 0
          ? step > 0
            ? 0
            : state.sessions.length - 1
          : (current + step + state.sessions.length) % state.sessions.length;
      const row = state.sessions[index];
      if (!row) return;
      composerCommand = null;
      messengerNavigation = {
        id: event.id,
        view: "chat",
        sessionKey: row.key,
      };
      renderCurrentPanel();
      return;
    }
    messengerNavigation = composerNavigation(state, event.id);
    composerCommand =
      event.command === "attach-browser-context" && event.attachments?.length
        ? { id: event.id, action: "attach", attachments: event.attachments }
        : { id: event.id, action: "focus" };
    renderCurrentPanel();
  }

  function reconnectBridge(): void {
    if (bridgeReconnecting) return;
    bridgeReconnecting = true;
    renderCurrentPanel();
    widget.setLauncher({ label: "Open agent chats · reconnecting" });
    sendBridgeIntent({ action: "mounted" });
  }

  function closeMessenger(): void {
    widget.closeShell();
  }

  const adapter: UiAdapter = {
    onIntent(intent: SupercodeUiIntent): void | Promise<void> {
      return sendBridgeIntent(intent);
    },
    onClose: closeMessenger,
    pickContext: pickAttachments,
    resolveImage: resolveHistoricalImage,
    copyText(value: string): Promise<void> | void {
      return navigator.clipboard?.writeText(value);
    },
  };

  function MessengerDialog({ state }: { state: unknown }): JSX.Element {
    const [terminalsOpen, setTerminalsOpen] = useState(false);
    const [presentationPending, setPresentationPending] = useState(false);
    const [presentationError, setPresentationError] = useState<string | null>(
      null,
    );
    const presentationTransition = useRef(false);
    const lastTerminalAttachmentId = useRef<string | null>(null);
    const requestedTerminalConversation = useRef<string | null>(null);
    const normalized = normalizeUiState(state);
    const canMoveToTerminal = isRecord(state) && state.canMoveToTerminal === true;
    const terminalMoveStatus = isRecord(state) &&
      (state.terminalMoveStatus === "waiting" || state.terminalMoveStatus === "moving")
      ? state.terminalMoveStatus
      : null;
    const movableNativeSessionCount = isRecord(state) &&
      typeof state.movableNativeSessionCount === "number"
      ? Math.max(0, Math.floor(state.movableNativeSessionCount))
      : 0;
    const terminalMoveQueuedCount = isRecord(state) &&
      typeof state.terminalMoveQueuedCount === "number"
      ? Math.max(0, Math.floor(state.terminalMoveQueuedCount))
      : 0;
    const terminalMoveWaitingCount = isRecord(state) &&
      typeof state.terminalMoveWaitingCount === "number"
      ? Math.max(0, Math.floor(state.terminalMoveWaitingCount))
      : 0;
    const terminals = options.TerminalPanel ? terminalHostState(state) : null;
    const TerminalPanel = options.TerminalPanel;
    const message =
      "Vibewaiting is no longer connected to its local agent bridge.";
    const displayState = bridgeDisconnected
      ? {
          ...normalized,
          pill: { tone: "dead" as const, label: "Agent bridge disconnected" },
          operation: null,
          error: message,
          recoverable: false,
          attachError: pendingBridgeIntent?.attachKey
            ? { key: pendingBridgeIntent.attachKey, message }
            : normalized.attachError,
        }
      : normalized;
    async function requestTerminalPresentation(
      name: typeof VIBEWAITING_PRESENTATION.terminal,
    ): Promise<boolean> {
      if (terminalsOpen) return true;
      if (presentationTransition.current) return false;
      if (!options.requestPresentation) {
        setPresentationError(
          "The terminal surface is unavailable because its presentation bridge is missing.",
        );
        return false;
      }
      presentationTransition.current = true;
      setPresentationPending(true);
      setPresentationError(null);
      try {
        await options.requestPresentation(name);
        terminalSurfaceOpen = true;
        setTerminalsOpen(true);
        return true;
      } catch (error) {
        setPresentationError(
          error instanceof Error
            ? error.message
            : "The terminal surface could not be opened.",
        );
        return false;
      } finally {
        presentationTransition.current = false;
        setPresentationPending(false);
      }
    }

    async function showChat(): Promise<void> {
      if (presentationTransition.current) return;
      if (!options.requestPresentation) {
        setPresentationError(
          "The messenger surface is unavailable because its presentation bridge is missing.",
        );
        return;
      }
      presentationTransition.current = true;
      setPresentationPending(true);
      setPresentationError(null);
      try {
        await options.requestPresentation("messenger");
        terminalSurfaceOpen = false;
        setTerminalsOpen(false);
      } catch (error) {
        setPresentationError(
          error instanceof Error
            ? error.message
            : "The messenger surface could not be restored.",
        );
      } finally {
        presentationTransition.current = false;
        setPresentationPending(false);
      }
    }

    useEffect(() => {
      if (!terminals || presentationPending) return;
      const attachmentId = terminals.attachment?.id ?? null;
      const attachmentBecameAvailable =
        attachmentId !== null &&
        attachmentId !== lastTerminalAttachmentId.current;
      lastTerminalAttachmentId.current = attachmentId;
      if (!attachmentBecameAvailable || terminalsOpen) return;
      const conversationKey = terminals.attachment?.conversationKey ?? null;
      const requestedKey = requestedTerminalConversation.current;
      const requestedAttachment = requestedKey !== null && requestedKey === conversationKey;
      const unboundNewTerminal = conversationKey === null && requestedKey === null;
      if (!requestedAttachment && !unboundNewTerminal) return;
      requestedTerminalConversation.current = null;
      void requestTerminalPresentation(VIBEWAITING_PRESENTATION.terminal);
    }, [
      terminals?.attachment?.id,
      terminalsOpen,
      presentationPending,
    ]);

    const activeConversationKey = displayState.attached?.key || null;
    const activeBinding = activeConversationKey
      ? terminals?.bindings.find(
          (binding) => binding.conversationKey === activeConversationKey,
        )
      : null;
    const visibleAttachment = terminals?.attachment && (
      terminals.attachment.conversationKey === activeConversationKey ||
      (activeConversationKey === null && terminals.attachment.conversationKey === null)
    )
      ? terminals.attachment
      : null;

    useEffect(() => {
      if (terminalsOpen && !visibleAttachment) void showChat();
    }, [
      activeConversationKey,
      terminalsOpen,
      visibleAttachment?.id,
    ]);

    async function showTerminal(): Promise<void> {
      if (!terminals || presentationPending) return;
      setPresentationError(null);
      if (terminalMoveStatus === "waiting") {
        requestedTerminalConversation.current = null;
        await sendBridgeIntent({ action: "moveToTerminal" });
        return;
      }
      if (activeBinding) {
        requestedTerminalConversation.current = activeConversationKey;
        await sendBridgeIntent({
          action: "terminalAttach",
          mode: "control",
          sessionId: activeBinding.sessionId,
        });
        return;
      }
      if (activeConversationKey && canMoveToTerminal) {
        requestedTerminalConversation.current = activeConversationKey;
        await sendBridgeIntent({ action: "moveToTerminal" });
        return;
      }
      if (
        activeConversationKey &&
        displayState.canResume &&
        displayState.continuationModes.includes("terminal")
      ) {
        requestedTerminalConversation.current = activeConversationKey;
        await sendBridgeIntent({ action: "resume", mode: "terminal" });
        return;
      }
    }

    function HeaderModeToggle({ value }: { value: unknown }): JSX.Element | null {
      const inConversation = value === "chat" && activeConversationKey !== null;
      if (!inConversation && !terminalsOpen) return null;
      const canEnterTerminal = Boolean(
        activeBinding ||
        canMoveToTerminal ||
        (inConversation &&
          displayState.canResume &&
          displayState.continuationModes.includes("terminal")),
      );
      return (
        <nav class="vw-mode-toggle" aria-label="Conversation view">
          <button
            type="button"
            aria-pressed={!terminalsOpen}
            disabled={presentationPending}
            onClick={() => void showChat()}
          >
            Chat
          </button>
          <button
            type="button"
            aria-label={
              terminalMoveStatus === "waiting"
                ? "Cancel move to tmux"
                : activeBinding
                  ? "Show terminal"
                  : canMoveToTerminal
                    ? "Move to tmux"
                    : "Open in tmux"
            }
            aria-pressed={terminalsOpen}
            disabled={presentationPending || terminalMoveStatus === "moving" || (!terminalsOpen && !canEnterTerminal)}
            title={
              terminalMoveStatus === "waiting"
                ? "Cancel pending move"
                : !activeBinding && canEnterTerminal
                  ? canMoveToTerminal
                    ? "Move here when idle"
                    : "Open this chat in tmux"
                  : undefined
            }
            onClick={() => void showTerminal()}
          >
            {terminalMoveStatus === "waiting" ? "Waiting…" : terminalMoveStatus === "moving" ? "Moving…" : "Terminal"}
          </button>
        </nav>
      );
    }

    function NativeTerminalMoveBanner({ value }: { value: unknown }): JSX.Element | null {
      const query = isRecord(value) && typeof value.query === "string" ? value.query : "";
      if (query || (movableNativeSessionCount < 2 && terminalMoveQueuedCount === 0)) return null;
      const moving = terminalMoveQueuedCount - terminalMoveWaitingCount;
      const headline = terminalMoveQueuedCount > 0
        ? moving > 0
          ? terminalMoveWaitingCount > 0
            ? `Moving one · ${terminalMoveWaitingCount} waiting`
            : "Moving terminal session…"
          : `${terminalMoveWaitingCount} waiting for idle`
        : `${movableNativeSessionCount} live terminal sessions`;
      return (
        <aside class="vw-native-move" aria-live="polite">
          <span>
            <strong>{headline}</strong>
            <small>Each moves here after its current turn.</small>
          </span>
          <button
            type="button"
            disabled={terminalMoveQueuedCount > 0 && terminalMoveWaitingCount === 0}
            onClick={() => void sendBridgeIntent({ action: "moveAllToTerminal" })}
          >
            {terminalMoveWaitingCount > 0 ? "Cancel" : "Bring all here"}
          </button>
        </aside>
      );
    }
    return (
      <div
        class="vw-dialog"
        data-terminal={String(terminalsOpen)}
        tabIndex={-1}
        onKeyDown={(event): void => {
          if (event.key !== "Escape" || terminalsOpen) return;
          event.preventDefault();
          event.stopPropagation();
          closeMessenger();
        }}
      >
        <div class="vw-messenger-layer">
          <SupercodeMessenger
            state={displayState}
            adapter={adapter}
            navigation={messengerNavigation}
            composerCommand={composerCommand}
            labels={{ attachContext: "Attach from this page" }}
            components={{ TaskPlan: () => null }}
            slots={{
              beforeSessions: NativeTerminalMoveBanner,
              headerActions: (header) => (
                <>
                  <HeaderModeToggle value={header.value} />
                  {widget.requestBrowserContext ? (
                    <button
                      type="button"
                      class="vw-shortcut-launch"
                      aria-label="Keyboard shortcuts"
                      title="Keyboard shortcuts"
                      onClick={showShortcutHelp}
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        width="16"
                        height="16"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.8"
                      >
                        <rect x="3" y="6" width="18" height="12" rx="2" />
                        <path d="M7 10h.01M11 10h.01M15 10h.01M18 10h.01M7 14h2M11 14h6" />
                      </svg>
                    </button>
                  ) : null}
                </>
              ),
            }}
          />
        </div>
        {terminalsOpen && terminals && visibleAttachment && TerminalPanel ? (
          <TerminalPanel
            state={{ ...terminals, attachment: visibleAttachment }}
            send={sendBridgeIntent}
          />
        ) : null}
        {presentationError ? (
          <div class="vw-presentation-error" role="alert">
            {presentationError}
          </div>
        ) : null}
        {bridgeDisconnected ? (
          <section class="vw-bridge-disconnected" role="alert">
            <strong>
              {bridgeReconnecting
                ? "Reconnecting…"
                : "Agent bridge disconnected"}
            </strong>
            <small>
              {bridgeReconnecting
                ? "Checking the local agent bridge."
                : "The local controller stopped responding."}
            </small>
            <span>
              <button
                type="button"
                disabled={bridgeReconnecting}
                onClick={reconnectBridge}
              >
                {bridgeReconnecting ? "Reconnecting…" : "Reconnect"}
              </button>
              <button
                type="button"
                class="vw-secondary"
                onClick={closeMessenger}
              >
                Close
              </button>
            </span>
          </section>
        ) : null}
      </div>
    );
  }

  function renderMessengerPanel(element: HTMLElement, state: unknown): void {
    lastPanelState = state;
    renderPreact(<MessengerDialog state={state} />, element);
  }

  const accumulatedState: Record<string, unknown> = {};
  let launcherHarness = "";
  const stopHostEvents = widget.onHostEvent?.(applyHostEvent) ?? (() => {});

  function syncLauncher(state: SupercodeUiState): void {
    const harness =
      state.attached?.harness ||
      state.harness ||
      state.sessions.find((session) => session.active)?.harness ||
      "";
    const unreadKeys = new Set(state.attention.map((item) => item.key));
    let unreadCount = state.attention.reduce((total, item) => total + (item.unreadCount ?? 1), 0);
    if (state.needsInput) {
      const key = state.attached?.key || state.owned?.key || "@needs-input";
      if (!unreadKeys.has(key)) unreadCount += 1;
      unreadKeys.add(key);
    }
    const label = state.pill.label
      ? `Open agent chats · ${state.pill.label}`
      : "Open agent chats";
    if (!hasHarnessLogo(harness)) {
      widget.setLauncher({
        hidden: true,
        icon: null,
        label,
        badge: unreadCount,
      });
      return;
    }
    const icon =
      harness === launcherHarness ? undefined : harnessLogoDataUrl(harness);
    launcherHarness = harness;
    widget.setLauncher({
      hidden: false,
      label,
      badge: unreadCount,
      ...(icon ? { icon } : {}),
    });
  }

  widget.onPatch((patch) => {
    if (!isRecord(patch)) return;
    const acknowledged =
      typeof patch.bridgeAck === "string" &&
      patch.bridgeAck === pendingBridgeIntent?.id;
    const includesSnapshot = Object.keys(patch).some(
      (key) => key !== "bridgeAck" && key !== "bridgeDone",
    );
    if (typeof patch.bridgeDone === "string")
      resolveBridgeCompletion(patch.bridgeDone);
    if (
      acknowledged ||
      (pendingBridgeIntent?.acceptsSnapshot && includesSnapshot)
    )
      clearBridgeWatch();
    if (bridgeReconnecting) bridgeReconnecting = false;
    if (bridgeDisconnected) bridgeDisconnected = false;
    const resolution = isRecord(patch.imageResolution)
      ? patch.imageResolution
      : null;
    if (resolution && typeof resolution.requestId === "string") {
      const pending = imageResolutions.get(resolution.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        imageResolutions.delete(resolution.requestId);
        if (
          resolution.status === "resolved" &&
          typeof resolution.dataUrl === "string"
        ) {
          try {
            pending.resolve(imageBlobFromDataUrl(resolution.dataUrl));
          } catch (error) {
            pending.reject(
              error instanceof Error
                ? error
                : new Error("Could not decode this image."),
            );
          }
        } else {
          pending.reject(
            new Error(
              typeof resolution.message === "string" && resolution.message
                ? resolution.message
                : "Could not load this image.",
            ),
          );
        }
      }
    }
    for (const [key, value] of Object.entries(patch)) {
      if (key !== "imageResolution") accumulatedState[key] = value;
    }
    const state = normalizeUiState(accumulatedState);
    const terminalState = terminalHostState(accumulatedState);
    const boundConversationKey = terminalState?.attachment?.conversationKey ?? null;
    if (
      terminalSurfaceOpen &&
      boundConversationKey !== null &&
      state.attached?.key === boundConversationKey
    ) {
      messengerNavigation = {
        id: `terminal-bound:${boundConversationKey}`,
        view: "chat",
        sessionKey: boundConversationKey,
      };
    }
    lastPanelState = accumulatedState;
    renderCurrentPanel();
    syncLauncher(state);
  });

  widget.onVisibility((visible) => {
    sendBridgeIntent({ action: visible ? "panelVisible" : "panelHidden" });
    if (visible) {
      queueMicrotask(() => {
        const focusTarget = appRoot.querySelector<HTMLElement>(
          "textarea:not(:disabled), input:not(:disabled), button:not(:disabled), [tabindex='0']",
        );
        focusTarget?.focus({ preventScroll: true });
      });
    }
  });

  window.addEventListener(
    "pagehide",
    () => {
      clearBridgeWatch();
      for (const [requestId, pending] of imageResolutions) {
        clearTimeout(pending.timer);
        pending.reject(new Error("The page closed before this image loaded."));
        imageResolutions.delete(requestId);
      }
      renderPreact(null, appRoot);
      stopHostEvents();
      widget.destroy();
    },
    { once: true },
  );

  // A sticky injection gets a fresh iframe on every navigation. Register the patch listener first,
  // then ask the trusted daemon for exactly one current snapshot so a fast reply cannot be lost.
  renderCurrentPanel();
  sendBridgeIntent({ action: "mounted" });

  return (): void => {
    clearBridgeWatch();
    stopHostEvents();
    renderPreact(null, appRoot);
    widget.destroy();
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
