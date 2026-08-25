import { describe, expect, it } from "vitest";
import { RemoteSessionTokens } from "../src/remote-sessions.js";

describe("remote device sessions", () => {
  it("bounds, expires, and revokes independently issued device credentials", () => {
    let now = 1_000;
    const sessions = new RemoteSessionTokens({
      capacity: 2,
      now: () => now,
      ttlMs: 50,
    });
    const first = sessions.issue();
    const second = sessions.issue();
    expect(first.token).not.toBe(second.token);
    expect(sessions.authenticate(first.token).id).toBe(first.id);

    const third = sessions.issue();
    expect(third.revokedIds).toEqual([first.id]);
    expect(sessions.authenticate(first.token).id).toBeNull();
    expect(sessions.authenticate(second.token).id).toBe(second.id);

    now = third.expiresAt;
    expect(sessions.authenticate(third.token)).toEqual({
      id: null,
      revokedIds: [second.id, third.id],
    });
    const replacement = sessions.issue();
    expect(sessions.revokeAll()).toEqual([replacement.id]);
    expect(sessions.authenticate(replacement.token).id).toBeNull();
  });
});
