import type {
  BrowserContextAction,
  BrowserContextAttachment,
} from "../src/browser-context.js";
import type { LauncherBadgeTone } from "../src/launcher.js";

export type MessengerHostEvent =
  | {
      type: "shortcut";
      id: string;
      command:
        | "focus-composer"
        | "attach-browser-context"
        | "previous-conversation"
        | "next-conversation";
      attachments?: BrowserContextAttachment[];
    };

export interface MessengerTransport {
  sendIntent(name: string, payload: unknown): string;
  onPatch(listener: (patch: unknown) => void): () => void;
  onVisibility(listener: (visible: boolean) => void): () => void;
  requestBrowserContext?(
    action: BrowserContextAction,
  ): Promise<BrowserContextAttachment[] | null>;
  onHostEvent?(listener: (event: MessengerHostEvent) => void): () => void;
  setLauncher(value: {
    readonly label?: string;
    readonly icon?: string | null;
    readonly hidden?: boolean;
    readonly badge?: string | number | null;
    readonly badgeTone?: LauncherBadgeTone;
  }): void;
  closeShell(): void;
  destroy(): void;
}
