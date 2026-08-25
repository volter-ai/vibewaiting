import { createHash, randomBytes } from "node:crypto";

const DEFAULT_CAPACITY = 8;
export const DEFAULT_PAIRING_GRANT_TTL_MS = 5 * 60 * 1_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface PairingGrant {
  expiresAt: number;
  token: string;
}

/**
 * Stores only grant digests. A successful consume removes the digest before the caller creates a
 * session, so concurrent replays cannot both authorize.
 */
export class SingleUsePairingGrants {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly options: {
      capacity?: number;
      now?: () => number;
      ttlMs?: number;
    } = {},
  ) {}

  issue(): PairingGrant {
    const now = this.now();
    this.prune(now);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + (this.options.ttlMs ?? DEFAULT_PAIRING_GRANT_TTL_MS);
    this.entries.set(digest(token), expiresAt);
    const capacity = this.options.capacity ?? DEFAULT_CAPACITY;
    while (this.entries.size > capacity)
      this.entries.delete(this.entries.keys().next().value!);
    return { expiresAt, token };
  }

  consume(token: string): boolean {
    if (!TOKEN_PATTERN.test(token)) return false;
    const now = this.now();
    this.prune(now);
    const key = digest(token);
    const expiresAt = this.entries.get(key);
    if (expiresAt === undefined || expiresAt <= now) return false;
    this.entries.delete(key);
    return true;
  }

  clear(): void {
    this.entries.clear();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private prune(now: number): void {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(key);
    }
  }
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
