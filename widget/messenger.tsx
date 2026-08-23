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
  SupercodeUiIntent,
  SupercodeUiState,
  TranscriptAttachment,
  TranscriptImage,
  UiAdapter,
} from "@volter-ai-dev/supercode-ui";
import type { TerminalUiState } from "@volter-ai-dev/supercode-terminal/ui";
import { render as renderPreact } from "preact";
import type { ComponentType, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { MessengerTransport } from "./transport.js";
import {
  terminalListPresentationSize,
  VIBEWAITING_PRESENTATION,
  type VibewaitingPresentation,
} from "../src/presentations.js";

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
  | TerminalIntent
  | { action: "resolveImage"; requestId: string; reference: string };

export type TerminalHostState = TerminalUiState;

export interface TerminalPanelProps {
  state: TerminalHostState;
  send(intent: TerminalIntent): void | Promise<void>;
  onClose(): void;
}

export interface MessengerOptions {
  TerminalPanel?: ComponentType<TerminalPanelProps>;
  requestPresentation?(name: VibewaitingPresentation): Promise<void>;
  reportContentSize?(size: { width: number; height: number }): Promise<void>;
}

function terminalHostState(value: unknown): TerminalHostState | null {
  if (!isRecord(value) || !isRecord(value.terminalHost)) return null;
  const host = value.terminalHost;
  const attachment =
    isRecord(host.attachment) &&
    typeof host.attachment.id === "string" &&
    typeof host.attachment.baseUrl === "string" &&
    (host.attachment.mode === "observe" || host.attachment.mode === "control")
      ? {
          baseUrl: host.attachment.baseUrl,
          id: host.attachment.id,
          mode: host.attachment.mode as "observe" | "control",
        }
      : null;
  const sessions = Array.isArray(host.sessions)
    ? host.sessions.flatMap((item): TerminalUiState["sessions"][number][] => {
        if (
          !isRecord(item) ||
          typeof item.id !== "string" ||
          typeof item.label !== "string"
        )
          return [];
        return [
          {
            activeCommand:
              typeof item.activeCommand === "string"
                ? item.activeCommand
                : null,
            cwd: typeof item.cwd === "string" ? item.cwd : null,
            id: item.id,
            label: item.label,
            owned: item.owned === true,
          },
        ];
      })
    : [];
  return {
    attachment,
    available: host.available === true,
    canOpenLocal: host.canOpenLocal === true,
    error: typeof host.error === "string" ? host.error : null,
    sessions,
  };
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

function pickAttachments(): Promise<TranscriptAttachment[] | null> {
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
    const [terminalPresentation, setTerminalPresentation] =
      useState<VibewaitingPresentation | null>(null);
    const [presentationPending, setPresentationPending] = useState(false);
    const [presentationError, setPresentationError] = useState<string | null>(
      null,
    );
    const presentationTransition = useRef(false);
    const lastTerminalAttachmentId = useRef<string | null>(null);
    const terminalLauncher = useRef<HTMLButtonElement>(null);
    const normalized = normalizeUiState(state);
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
      name: VibewaitingPresentation,
    ): Promise<boolean> {
      if (terminalsOpen && terminalPresentation === name) return true;
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
        setTerminalPresentation(name);
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

    async function closeTerminalPresentation(): Promise<void> {
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
        setTerminalPresentation(null);
        setTerminalsOpen(false);
        queueMicrotask(() =>
          terminalLauncher.current?.focus({ preventScroll: true }),
        );
        if (terminals?.attachment)
          void sendBridgeIntent({ action: "terminalDismiss" });
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
      const desired = terminals.attachment
        ? VIBEWAITING_PRESENTATION.terminal
        : VIBEWAITING_PRESENTATION.terminalList;
      if ((!terminalsOpen && attachmentBecameAvailable) ||
          (terminalsOpen && terminalPresentation !== desired)) {
        void requestTerminalPresentation(desired);
      }
    }, [
      terminals?.attachment?.id,
      terminalsOpen,
      terminalPresentation,
      presentationPending,
    ]);
    useEffect(() => {
      if (
        !terminalsOpen ||
        !terminals ||
        terminals.attachment ||
        terminalPresentation !== VIBEWAITING_PRESENTATION.terminalList ||
        !options.reportContentSize
      ) return;
      let active = true;
      void options
        .reportContentSize(
          terminalListPresentationSize(terminals.sessions.length),
        )
        .catch((error: unknown) => {
          if (!active) return;
          setPresentationError(
            error instanceof Error
              ? error.message
              : "The terminal surface could not be resized.",
          );
        });
      return () => {
        active = false;
      };
    }, [
      terminalsOpen,
      terminals?.attachment?.id,
      terminals?.sessions.length,
      terminalPresentation,
      options.reportContentSize,
    ]);
    return (
      <div
        class="vw-dialog"
        tabIndex={-1}
        onKeyDown={(event): void => {
          if (event.key !== "Escape" || terminalsOpen) return;
          event.preventDefault();
          event.stopPropagation();
          closeMessenger();
        }}
      >
        <div
          class="vw-messenger-layer"
          aria-hidden={terminalsOpen ? "true" : undefined}
          inert={terminalsOpen}
        >
          <SupercodeMessenger
            state={displayState}
            adapter={adapter}
            components={{ TaskPlan: () => null }}
            {...(terminals
              ? {
                  slots: {
                    headerActions: () => (
                      <button
                        ref={terminalLauncher}
                        type="button"
                        class="vw-terminal-launch"
                        aria-label={`Terminals · ${terminals.sessions.length} local sessions`}
                        aria-busy={presentationPending}
                        disabled={presentationPending}
                        onClick={() => {
                          void requestTerminalPresentation(
                            VIBEWAITING_PRESENTATION.terminalList,
                          ).then((opened) => {
                            if (opened)
                              return sendBridgeIntent({
                                action: "terminalRefresh",
                              });
                          });
                        }}
                      >
                        <span aria-hidden="true">&gt;_</span>
                        <small>{terminals.sessions.length}</small>
                      </button>
                    ),
                  },
                }
              : {})}
          />
        </div>
        {terminalsOpen && terminals && TerminalPanel ? (
          <TerminalPanel
            state={terminals}
            send={sendBridgeIntent}
            onClose={() => {
              void closeTerminalPresentation();
            }}
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
    renderPreact(null, appRoot);
    widget.destroy();
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
