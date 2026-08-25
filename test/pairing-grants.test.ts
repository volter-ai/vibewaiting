import { describe, expect, it } from "vitest";
import { SingleUsePairingGrants } from "../src/pairing-grants.js";

describe("single-use pairing grants", () => {
  it("can be consumed exactly once before its deadline", () => {
    let now = 1_000;
    const grants = new SingleUsePairingGrants({ now: () => now, ttlMs: 50 });

    const first = grants.issue();
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(grants.consume(first.token)).toBe(true);
    expect(grants.consume(first.token)).toBe(false);

    const expired = grants.issue();
    now = expired.expiresAt;
    expect(grants.consume(expired.token)).toBe(false);
  });
});
