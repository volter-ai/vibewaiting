import { describe, expect, it } from "vitest";
import {
  LIVENESS_WINDOW_MS,
  MAX_SESSION_ROWS,
  attachmentFor,
  isLive,
  matchesActive,
  projectSession,
  projectSessions,
  relativeAge,
  sessionKey,
  shortCwd,
  workspaceName,
} from "../src/sessions.js";
import type { SessionDescriptor } from "@volter-ai-dev/supercode-harness-sdk";

const NOW = 1_700_000_000_000;
const HOME = "/home/dev";

function descriptor(over: Partial<SessionDescriptor> & { sessionId?: string } = {}): SessionDescriptor {
  const sessionId = over.sessionId ?? "abc123def456";
  return {
    locator: {
      harness: "claude-code",
      session_id: sessionId,
      storage: { kind: "file", path: `/home/dev/.claude/${sessionId}.jsonl` },
      ...(over.locator ?? {}),
    },
    cwd: over.cwd === undefined ? "/home/dev/volter/atlas" : over.cwd,
    title: over.title === undefined ? "Rewrite the parser" : over.title,
    updated_at_ms: over.updated_at_ms === undefined ? NOW - 3 * 60_000 : over.updated_at_ms,
    message_count: over.message_count === undefined ? 42 : over.message_count,
    model: over.model === undefined ? "claude-opus-5" : over.model,
  };
}

describe("relativeAge", () => {
  it("reads the injected now, never a clock of its own", () => {
    expect(relativeAge(NOW - 5_000, NOW)).toBe("now");
    expect(relativeAge(NOW - 3 * 60_000, NOW)).toBe("3m ago");
    expect(relativeAge(NOW - 5 * 3_600_000, NOW)).toBe("5h ago");
    expect(relativeAge(NOW - 3 * 86_400_000, NOW)).toBe("3d ago");
    expect(relativeAge(NOW - 30 * 86_400_000, NOW)).toBe("4w ago");
    // Same descriptor, later clock: the row ages without anything being re-fetched.
    expect(relativeAge(NOW - 60_000, NOW + 3_600_000)).toBe("1h ago");
  });

  it("says nothing rather than inventing a time the store never recorded", () => {
    expect(relativeAge(null, NOW)).toBe("");
    expect(relativeAge(undefined, NOW)).toBe("");
    expect(relativeAge(0, NOW)).toBe("");
    expect(relativeAge(Number.NaN, NOW)).toBe("");
    // Clock skew between two stores must not print "in 4 minutes".
    expect(relativeAge(NOW + 240_000, NOW)).toBe("now");
  });
});

describe("isLive", () => {
  it("reads recency of the store against the injected now", () => {
    expect(LIVENESS_WINDOW_MS).toBe(5 * 60_000);
    expect(isLive(NOW - 1_000, NOW)).toBe(true);
    // Just inside, exactly on, and just outside the window.
    expect(isLive(NOW - (LIVENESS_WINDOW_MS - 1), NOW)).toBe(true);
    expect(isLive(NOW - LIVENESS_WINDOW_MS, NOW)).toBe(true);
    expect(isLive(NOW - (LIVENESS_WINDOW_MS + 1), NOW)).toBe(false);
    expect(isLive(NOW - 86_400_000, NOW)).toBe(false);
    // The same descriptor read later goes quiet without anything being re-fetched.
    expect(isLive(NOW, NOW + LIVENESS_WINDOW_MS + 1)).toBe(false);
    // Clock skew between two stores reads as live, the way `relativeAge` reads it as "now".
    expect(isLive(NOW + 60_000, NOW)).toBe(true);
  });

  it("is not live when the store recorded no time at all", () => {
    expect(isLive(null, NOW)).toBe(false);
    expect(isLive(undefined, NOW)).toBe(false);
    expect(isLive(0, NOW)).toBe(false);
    expect(isLive(Number.NaN, NOW)).toBe(false);
  });

  it("is what the row carries, so the panel never re-derives it", () => {
    const fresh = projectSession(descriptor({ updated_at_ms: NOW - 60_000 }), { now: NOW, home: HOME });
    const stale = projectSession(descriptor({ updated_at_ms: NOW - 86_400_000 }), { now: NOW, home: HOME });
    const timeless = projectSession(descriptor({ updated_at_ms: null }), { now: NOW, home: HOME });
    expect([fresh.live, stale.live, timeless.live]).toEqual([true, false, false]);
    // Liveness is independent of which session the panel happens to be following.
    expect([fresh.active, stale.active]).toEqual([false, false]);
  });
});

describe("shortCwd / workspaceName", () => {
  it("folds the home directory and nothing else", () => {
    expect(shortCwd("/home/dev/volter/atlas", HOME)).toBe("~/volter/atlas");
    expect(shortCwd("/home/dev", HOME)).toBe("~");
    expect(shortCwd("/home/dev/", "/home/dev/")).toBe("~/");
    // A different user's tree, and a path that merely starts with the same letters, stay whole.
    expect(shortCwd("/home/developer/x", HOME)).toBe("/home/developer/x");
    expect(shortCwd("/srv/build", HOME)).toBe("/srv/build");
    expect(shortCwd(null, HOME)).toBe("");
  });

  it("names a workspace by its own folder", () => {
    expect(workspaceName("/home/dev/volter/atlas")).toBe("atlas");
    expect(workspaceName("/")).toBe("/");
    expect(workspaceName(null)).toBe("");
  });
});

describe("sessionKey", () => {
  it("is stable for the same locator and distinct across stores", () => {
    const a = descriptor();
    expect(sessionKey(a.locator)).toBe(sessionKey({ ...a.locator }));
    expect(sessionKey(a.locator).startsWith("claude-code-")).toBe(true);
    // Same native id in another harness/store is a DIFFERENT session — keys must not collide.
    expect(sessionKey(a.locator)).not.toBe(sessionKey({ ...a.locator, harness: "codex" }));
    expect(sessionKey(a.locator)).not.toBe(
      sessionKey({ ...a.locator, storage: { kind: "file", path: "/elsewhere.jsonl" } }),
    );
  });

  it("does not carry the storage path into the page", () => {
    expect(sessionKey(descriptor().locator)).not.toContain("/home/dev");
  });
});

describe("projectSession", () => {
  it("projects one descriptor into a row a 300px panel can render", () => {
    expect(projectSession(descriptor(), { now: NOW, home: HOME })).toEqual({
      key: sessionKey(descriptor().locator),
      harness: "claude-code",
      name: "atlas",
      cwd: "~/volter/atlas",
      title: "Rewrite the parser",
      age: "3m ago",
      updatedAt: NOW - 3 * 60_000,
      messages: 42,
      active: false,
      live: true,
    });
  });

  it("falls back title → model → short session id, and never renders empty", () => {
    const model = projectSession(descriptor({ title: null }), { now: NOW, home: HOME });
    expect(model.title).toBe("claude-opus-5");
    const id = projectSession(descriptor({ title: "  ", model: null }), { now: NOW, home: HOME });
    expect(id.title).toBe("abc123de");
    const homeless = projectSession(descriptor({ cwd: null }), { now: NOW, home: HOME });
    expect(homeless).toMatchObject({ name: "no workspace", cwd: "" });
  });

  it("marks the session the panel is showing", () => {
    const active = { harness: "claude-code", sessionId: "abc123def456" };
    expect(projectSession(descriptor(), { now: NOW, home: HOME, active }).active).toBe(true);
    expect(projectSession(descriptor({ sessionId: "other" }), { now: NOW, home: HOME, active }).active).toBe(
      false,
    );
    // A controller with no session selected marks nothing.
    expect(matchesActive(descriptor(), { harness: "claude-code", sessionId: null })).toBe(false);
    expect(matchesActive(descriptor(), null)).toBe(false);
  });
});

describe("projectSessions", () => {
  it("orders freshest first regardless of what the transport handed over", () => {
    const rows = projectSessions(
      [
        descriptor({ sessionId: "old", updated_at_ms: NOW - 86_400_000 }),
        descriptor({ sessionId: "new", updated_at_ms: NOW - 1_000 }),
        descriptor({ sessionId: "mid", updated_at_ms: NOW - 3_600_000 }),
        descriptor({ sessionId: "unknown", updated_at_ms: null }),
      ],
      { now: NOW, home: HOME },
    );
    expect(rows.map((r) => r.age)).toEqual(["now", "1h ago", "1d ago", ""]);
  });

  it("caps the list at 30 rows however many sessions the box has", () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      descriptor({ sessionId: `s${i}`, updated_at_ms: NOW - i * 60_000 }),
    );
    const rows = projectSessions(many, { now: NOW, home: HOME });
    expect(MAX_SESSION_ROWS).toBe(30);
    expect(rows.length).toBe(30);
    // The cap keeps the FRESHEST, not the first 30 the store happened to return.
    expect(rows[0]?.age).toBe("now");
    expect(rows.at(-1)?.age).toBe("29m ago");
    expect(projectSessions(many, { now: NOW, home: HOME, max: 3 }).length).toBe(3);
  });

  it("drops a duplicate locator instead of rendering the same session twice", () => {
    const rows = projectSessions([descriptor(), descriptor()], { now: NOW, home: HOME });
    expect(rows.length).toBe(1);
  });
});

describe("attachmentFor", () => {
  const rows = (active: { harness: string; sessionId: string | null } | null): ReturnType<typeof projectSessions> =>
    projectSessions([descriptor()], { now: NOW, home: HOME, active });

  it("names the row the panel is following", () => {
    const active = { harness: "claude-code", sessionId: "abc123def456" };
    expect(attachmentFor(active, rows(active), "/home/dev/volter/atlas", HOME)).toEqual({
      key: sessionKey(descriptor().locator),
      harness: "claude-code",
      name: "atlas",
      cwd: "~/volter/atlas",
      title: "Rewrite the parser",
    });
  });

  it("still names a just-started session that discovery has not seen yet", () => {
    const active = { harness: "codex", sessionId: null };
    expect(attachmentFor(active, rows(null), "/home/dev/volter/fresh", HOME)).toEqual({
      key: "",
      harness: "codex",
      name: "fresh",
      cwd: "~/volter/fresh",
      title: "",
    });
  });

  it("is null when nothing is selected at all", () => {
    expect(attachmentFor(null, [], "/w", HOME)).toBeNull();
  });
});
