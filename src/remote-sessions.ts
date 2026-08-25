import { createHash, randomBytes } from "node:crypto";

const DEFAULT_CAPACITY = 16;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface RemoteSessionAuthentication {
  id: string | null;
  revokedIds: string[];
}

export interface IssuedRemoteSession {
  expiresAt: number;
  id: string;
  revokedIds: string[];
  token: string;
}

export class RemoteSessionTokens {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly options: {
      capacity?: number;
      now?: () => number;
      ttlMs: number;
    },
  ) {}

  issue(): IssuedRemoteSession {
    const now = this.now();
    const revokedIds = this.expire(now);
    const token = randomBytes(32).toString("base64url");
    const id = digest(token);
    const expiresAt = now + this.options.ttlMs;
    this.entries.set(id, expiresAt);
    const capacity = this.options.capacity ?? DEFAULT_CAPACITY;
    while (this.entries.size > capacity) {
      const oldest = this.entries.keys().next().value!;
      this.entries.delete(oldest);
      revokedIds.push(oldest);
    }
    return { expiresAt, id, revokedIds, token };
  }

  authenticate(token: string): RemoteSessionAuthentication {
    const revokedIds = this.expire(this.now());
    if (!TOKEN_PATTERN.test(token)) return { id: null, revokedIds };
    const id = digest(token);
    return { id: this.entries.has(id) ? id : null, revokedIds };
  }

  expire(now = this.now()): string[] {
    const revokedIds: string[] = [];
    for (const [id, expiresAt] of this.entries) {
      if (expiresAt > now) continue;
      this.entries.delete(id);
      revokedIds.push(id);
    }
    return revokedIds;
  }

  revokeAll(): string[] {
    const revokedIds = [...this.entries.keys()];
    this.entries.clear();
    return revokedIds;
  }

  get size(): number {
    return this.entries.size;
  }

  nextExpiry(): number | null {
    let earliest = Infinity;
    for (const expiresAt of this.entries.values())
      earliest = Math.min(earliest, expiresAt);
    return Number.isFinite(earliest) ? earliest : null;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
