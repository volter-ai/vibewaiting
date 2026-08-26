import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  normalizeNativeMessengerState,
  type NativeMessengerStateSnapshot,
} from "@volter-ai-dev/supercode-ui/host";

export type PersistedMessengerState = NativeMessengerStateSnapshot;

export interface MessengerPersistence {
  load(): Promise<PersistedMessengerState>;
  save(state: PersistedMessengerState): Promise<void>;
}

/** Supercode owns validation and bounds; Vibewaiting owns only the private atomic file. */
export function readPersistedMessengerState(raw: unknown): PersistedMessengerState {
  return normalizeNativeMessengerState(raw);
}

/** Atomic, private local storage for messenger chrome only—never transcript contents or locators. */
export class FileMessengerPersistence implements MessengerPersistence {
  readonly path: string;

  constructor(path = join(homedir(), ".vibewaiting", "messenger-state-v2.json")) {
    this.path = path;
  }

  async load(): Promise<PersistedMessengerState> {
    try {
      return readPersistedMessengerState(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
        return normalizeNativeMessengerState(null);
      }
      throw error;
    }
  }

  async save(state: PersistedMessengerState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }
}
