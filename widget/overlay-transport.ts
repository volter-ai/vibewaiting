// The messenger's transport inside Widget Shell's window when vibewaiting delivers it over CDP
// (src/widget-delivery.ts): patches arrive by long-polling the host's patch capability, and intents go
// out through its intent capability. Intents wait for the first poll, so the state the host pushes in
// answer to `mounted` is never older than the point this guest starts reading from.
import { connectOverlayApp } from "@volter/widget-shell/frame";
import { INTENT_CAPABILITY, PATCHES_CAPABILITY } from "../src/widget-capabilities.js";
import type { MessengerTransport } from "./transport.js";

/** Longer than the host's long poll, so an idle wait always ends with the host's empty answer. */
const REQUEST_TIMEOUT_MS = 60_000;
/** The pause before asking again after a failed request (the page may be reloading or detached). */
const RETRY_MS = 1_000;
const INTENT_QUEUE = "agent";

interface PatchAnswer {
  readonly seq: number;
  readonly patches: readonly unknown[];
  readonly resync?: true;
}

export function createOverlayTransport(): MessengerTransport {
  const shell = connectOverlayApp({ requestTimeoutMs: REQUEST_TIMEOUT_MS });
  const patchListeners = new Set<(patch: unknown) => void>();
  let destroyed = false;
  let since = -1;
  let started = false;
  const held: Array<{ name: string; id: string; payload: unknown }> = [];

  const deliver = (name: string, id: string, payload: unknown): void => {
    void shell.request(INTENT_CAPABILITY, { name, id, payload }).catch(() => undefined);
  };

  const poll = async (): Promise<void> => {
    while (!destroyed) {
      try {
        const answer = await shell.request<PatchAnswer>(PATCHES_CAPABILITY, { since });
        since = answer.seq;
        if (!started) {
          started = true;
          for (const intent of held.splice(0)) deliver(intent.name, intent.id, intent.payload);
        } else if (answer.resync) {
          // Fell behind the host's log: ask for the whole state again, as a fresh mount does.
          deliver(INTENT_QUEUE, crypto.randomUUID(), { action: "mounted" });
        }
        for (const patch of answer.patches) for (const listener of patchListeners) listener(patch);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
    }
  };
  void poll();

  return {
    sendIntent(name, payload) {
      const id = crypto.randomUUID();
      if (started) deliver(name, id, payload);
      else held.push({ name, id, payload });
      return id;
    },
    onPatch(listener) {
      patchListeners.add(listener);
      return () => patchListeners.delete(listener);
    },
    onVisibility(listener) {
      return shell.onVisibility(listener);
    },
    setLauncher(value) {
      shell.setLauncher(value);
    },
    closeShell() {
      shell.close();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      patchListeners.clear();
      shell.destroy();
    },
  };
}
