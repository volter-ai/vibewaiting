/// <reference path="../worker-configuration.d.ts" />

// Kept outside the Node/DOM typecheck graph because Workers and DOM both declare Element.
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { GrokSession, RateGate, SECURITY_LIMITS, grokResponseHeaders } from "../cloudflare/worker.js";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarm: number | undefined;

  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
  async setAlarm(value: number): Promise<void> { this.alarm = value; }
  async deleteAll(): Promise<void> { this.values.clear(); this.alarm = undefined; }
}

function state(storage = new MemoryStorage(), id = "session-object-1"): DurableObjectState {
  return { id: { toString: () => id }, storage } as unknown as DurableObjectState;
}

function encryptionKey(fill: number): string {
  let binary = "";
  for (const byte of new Uint8Array(32).fill(fill)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function env(current: string, previous?: string): never {
  return {
    XAI_CLIENT_VERSION: "1.0.5",
    XAI_OAUTH_CLIENT_ID: "browser-client",
    SESSION_ENCRYPTION_KEY: current,
    ...(previous ? { SESSION_ENCRYPTION_KEY_PREVIOUS: previous } : {}),
  } as never;
}

function serviceEnv(overrides: Record<string, unknown> = {}): never {
  const namespace = {
    get: () => ({ fetch: () => Response.json({}) }),
    idFromName: (name: string) => name,
  };
  const limiter = { limit: async () => ({ success: true }) };
  return {
    ASSETS: { fetch: async () => new Response("asset") },
    SESSIONS: namespace,
    RATE_GATE: namespace,
    AUTH_RATE_LIMITER: limiter,
    CHAT_IP_RATE_LIMITER: limiter,
    CHAT_USER_RATE_LIMITER: limiter,
    RELAY_ENABLED: "true",
    INFERENCE_ENABLED: "false",
    MEDIA_ENABLED: "true",
    WEB_FETCH_ENABLED: "true",
    XAI_CLIENT_VERSION: "1.0.5",
    XAI_OAUTH_CLIENT_ID: "browser-client",
    SESSION_ENCRYPTION_KEY: encryptionKey(6),
    CF_VERSION_METADATA: { id: "version-1", tag: "test", timestamp: "2026-08-28T00:00:00Z" },
    ...overrides,
  } as never;
}

describe("Cloudflare native Grok header boundary", () => {
  it("preserves fixed, omitted, and post-compaction model header policies", () => {
    const fixedRequest = new Request("https://agent.example/api/grok/responses", { headers: {
      "x-browser-agent-conversation": "11111111-1111-4111-8111-111111111111",
      "x-browser-agent-request": "33333333-3333-4333-8333-333333333333",
      "x-browser-agent-session": "22222222-2222-4222-8222-222222222222",
      "x-browser-agent-turn": "2",
      "x-browser-agent-compaction-at": "321000",
      "x-browser-agent-compactions-remaining": "7",
    } });
    const fixed = grokResponseHeaders(fixedRequest, serviceEnv(), "token", "user", "main", "grok-4.6");
    expect(fixed.get("x-compaction-at")).toBe("321000");
    expect(fixed.get("x-compactions-remaining")).toBe("7");

    const compactedRequest = new Request(fixedRequest, { headers: {
      ...Object.fromEntries(fixedRequest.headers),
      "x-browser-agent-compacted": "1",
      "x-browser-agent-compactions-remaining": "0",
    } });
    const compacted = grokResponseHeaders(compactedRequest, serviceEnv(), "token", "user", "main", "grok-4.6");
    expect(compacted.has("x-compaction-at")).toBe(false);
    expect(compacted.get("x-compactions-remaining")).toBe("0");

    const omittedRequest = new Request(fixedRequest, { headers: {
      ...Object.fromEntries(fixedRequest.headers),
      "x-browser-agent-compaction-at": "omit",
      "x-browser-agent-compactions-remaining": "omit",
    } });
    const omitted = grokResponseHeaders(omittedRequest, serviceEnv(), "token", "user", "turn-summary", "grok-4.6");
    expect(omitted.has("x-compaction-at")).toBe(false);
    expect(omitted.has("x-compactions-remaining")).toBe(false);
  });

  it("rejects untrusted compaction policy values", () => {
    const request = new Request("https://agent.example/api/grok/responses", { headers: {
      "x-browser-agent-compaction-at": "not-a-number",
    } });
    expect(() => grokResponseHeaders(request, serviceEnv(), "token", "user", "main", "grok-4.6"))
      .toThrow(/compaction-at/u);
  });
});

function request(path: string, method = "GET"): Request {
  return new Request(`https://durable.internal${path}`, { method });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Grok encrypted device-auth sessions", () => {
  it("encrypts credentials, coalesces rotating refresh tokens, and survives key rotation", async () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let refreshCalls = 0;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/oauth2/device/code")) return Response.json({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://x.ai/device",
        expires_in: 600,
        interval: 1,
      });
      if (url.endsWith("/v1/user?include=subscription")) return Response.json({
        userId: "user-1",
        email: "person@example.test",
        subscriptionTier: "SuperGrok",
      });
      if (url.endsWith("/oauth2/token")) {
        const body = new URLSearchParams(String(init?.body));
        if (body.get("grant_type") === "refresh_token") {
          refreshCalls += 1;
          await refreshGate;
          return Response.json({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 });
        }
        return Response.json({ access_token: "initial-access", refresh_token: "initial-refresh", expires_in: 30 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));

    const storage = new MemoryStorage();
    const oldKey = encryptionKey(7);
    const session = new GrokSession(state(storage), env(oldKey));
    expect((await session.fetch(request("/device/start", "POST"))).status).toBe(200);
    const pendingEnvelope = String(storage.values.get("session"));
    expect(pendingEnvelope).toMatch(/^v2\.[A-Za-z0-9_-]{11}\./u);
    expect(pendingEnvelope).not.toContain("device-secret");

    now += 1_000;
    expect((await session.fetch(request("/poll", "POST"))).status).toBe(200);
    expect((await session.fetch(new Request("https://durable.internal/settings/remote", {
      method: "POST",
      body: JSON.stringify({
        image_gen_model_override: "grok-imagine-image",
        image_edit_model_override: "grok-imagine-image-edit",
        web_fetch_allowed_domains: ["docs.rs"],
      }),
    }))).status).toBe(200);
    const credentialEnvelope = String(storage.values.get("session"));
    expect(credentialEnvelope).not.toContain("initial-access");
    expect(credentialEnvelope).not.toContain("initial-refresh");

    expect((await session.fetch(new Request("https://durable.internal/video/register", {
      method: "POST",
      body: JSON.stringify({ requestId: "video-1" }),
    }))).status).toBe(200);
    expect((await session.fetch(new Request("https://durable.internal/video/check", {
      method: "POST",
      body: JSON.stringify({ requestId: "video-1" }),
    }))).status).toBe(200);
    expect((await session.fetch(new Request("https://durable.internal/video/claim", {
      method: "POST",
      body: JSON.stringify({ requestId: "video-1" }),
    }))).status).toBe(200);
    expect((await session.fetch(new Request("https://durable.internal/video/check", {
      method: "POST",
      body: JSON.stringify({ requestId: "video-1" }),
    }))).status).toBe(409);
    expect((await session.fetch(new Request("https://durable.internal/video/complete", {
      method: "POST",
      body: JSON.stringify({ requestId: "video-1" }),
    }))).status).toBe(200);
    expect((await session.fetch(new Request("https://durable.internal/video/check", {
      method: "POST",
      body: JSON.stringify({ requestId: "video-1" }),
    }))).status).toBe(410);

    const first = session.fetch(request("/credential"));
    const second = session.fetch(request("/credential"));
    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    releaseRefresh();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(await firstResponse.json()).toMatchObject({
      accessToken: "fresh-access",
      userId: "user-1",
      remoteSettings: {
        mediaModels: { imageGen: "grok-imagine-image", imageEdit: "grok-imagine-image-edit" },
        webFetch: { allowedDomains: ["docs.rs"] },
      },
    });
    expect(await secondResponse.json()).toMatchObject({
      accessToken: "fresh-access",
      userId: "user-1",
      remoteSettings: {
        mediaModels: { imageGen: "grok-imagine-image", imageEdit: "grok-imagine-image-edit" },
        webFetch: { allowedDomains: ["docs.rs"] },
      },
    });
    expect(refreshCalls).toBe(1);

    const beforeRotation = String(storage.values.get("session"));
    const rotated = new GrokSession(state(storage), env(encryptionKey(9), oldKey));
    const status = await rotated.fetch(request("/status"));
    expect(await status.json()).toMatchObject({ authenticated: true, subscriptionTier: "SuperGrok" });
    expect(String(storage.values.get("session"))).not.toBe(beforeRotation);
  });

  it("cannot resurrect credentials when logout overlaps token refresh", async () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let refreshCalls = 0;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/oauth2/device/code")) return Response.json({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://x.ai/device",
        expires_in: 600,
        interval: 1,
      });
      if (url.endsWith("/v1/user?include=subscription")) return Response.json({ userId: "user-1" });
      if (url.endsWith("/oauth2/token")) {
        const body = new URLSearchParams(String(init?.body));
        if (body.get("grant_type") === "refresh_token") {
          refreshCalls += 1;
          await refreshGate;
          return Response.json({ access_token: "resurrected", refresh_token: "rotated", expires_in: 3600 });
        }
        return Response.json({ access_token: "initial", refresh_token: "refresh", expires_in: 30 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));

    const storage = new MemoryStorage();
    const session = new GrokSession(state(storage), env(encryptionKey(5)));
    expect((await session.fetch(request("/device/start", "POST"))).status).toBe(200);
    now += 1_000;
    expect((await session.fetch(request("/poll", "POST"))).status).toBe(200);
    const refreshing = session.fetch(request("/credential"));
    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    expect((await session.fetch(request("/logout", "POST"))).status).toBe(200);
    releaseRefresh();
    expect((await refreshing).status).toBe(401);
    expect(await (await session.fetch(request("/status"))).json()).toEqual({ authenticated: false });
    expect(storage.values.has("session")).toBe(false);
  });

  it("clears corrupt ciphertext and terminal device denials", async () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const storage = new MemoryStorage();
    const session = new GrokSession(state(storage), env(encryptionKey(3)));

    storage.values.set("session", "v2.unknown.invalid.invalid");
    const recovered = await session.fetch(request("/status"));
    expect(await recovered.json()).toEqual({ authenticated: false });
    expect(storage.values.has("session")).toBe(false);

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/oauth2/device/code")) return Response.json({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://x.ai/device",
        expires_in: 600,
        interval: 1,
      });
      if (url.endsWith("/oauth2/token")) return Response.json({ error: "access_denied" }, { status: 400 });
      throw new Error(`unexpected fetch ${url}`);
    }));
    expect((await session.fetch(request("/device/start", "POST"))).status).toBe(200);
    now += 1_000;
    expect((await session.fetch(request("/poll", "POST"))).status).toBe(403);
    expect((await session.fetch(request("/poll", "POST"))).status).toBe(409);
  });
});

describe("distributed relay budgets", () => {
  it("caches trusted remote media model settings inside the encrypted session boundary", async () => {
    let stored: unknown;
    const session = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname === "/credential") return Response.json({
          accessToken: "token", userId: "user-1", eligible: true, subscriptionTier: "SuperGrok",
        });
        if (pathname === "/settings/remote") {
          stored = JSON.parse(String(init?.body));
          return Response.json({ stored: true });
        }
        throw new Error(`unexpected session request ${pathname}`);
      },
    };
    const gate = { fetch: async () => Response.json({ allowed: true }) };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      image_gen_model_override: "grok-imagine-image",
      image_edit_model_override: "grok-imagine-image-edit",
    })));
    const response = await worker.fetch(new Request("https://agent.example/api/grok/settings", {
      headers: { Cookie: `__Host-vw_session=${"a".repeat(43)}` },
    }), serviceEnv({
      SESSIONS: { get: () => session, idFromName: (name: string) => name },
      RATE_GATE: { get: () => gate, idFromName: (name: string) => name },
    }));

    expect(response.status).toBe(200);
    expect(stored).toEqual({
      image_gen_model_override: "grok-imagine-image",
      image_edit_model_override: "grok-imagine-image-edit",
    });
  });

  it("uses only server-cached remote settings for image generation and edit model overrides", async () => {
    const upstreamPayloads: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamPayloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ data: [{ b64_json: "/9j/" }] });
    }));
    const session = {
      fetch: async (input: RequestInfo | URL) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname === "/credential") return Response.json({
          accessToken: "token",
          userId: "user-1",
          eligible: true,
          subscriptionTier: "SuperGrok",
          remoteSettings: {
            mediaModels: { imageGen: "grok-imagine-image", imageEdit: "grok-imagine-image-edit" },
            webFetch: {},
          },
        });
        throw new Error(`unexpected session request ${pathname}`);
      },
    };
    const gate = { fetch: async () => Response.json({ allowed: true }) };
    const sessionNamespace = {
      get: () => session,
      idFromName: (name: string) => name,
    };
    const gateNamespace = {
      get: () => gate,
      idFromName: (name: string) => name,
    };
    const mediaEnv = serviceEnv({
      INFERENCE_ENABLED: "true",
      SESSIONS: sessionNamespace,
      RATE_GATE: gateNamespace,
    });
    const headers = {
      "Content-Type": "application/json",
      Cookie: `__Host-vw_session=${"a".repeat(43)}`,
      Origin: "https://agent.example",
      "Sec-Fetch-Site": "same-origin",
      "x-browser-agent-session": "11111111-1111-4111-8111-111111111111",
    };
    const send = (body: Record<string, unknown>) => worker.fetch(new Request("https://agent.example/api/grok/media/image", {
      method: "POST", headers, body: JSON.stringify(body),
    }), mediaEnv);

    expect((await send({ kind: "generate", prompt: "moon", aspectRatio: "1:1" })).status).toBe(200);
    expect((await send({ kind: "edit", prompt: "blue", aspectRatio: "auto", images: ["data:image/jpeg;base64,/9j/"] })).status).toBe(200);
    expect(upstreamPayloads.map((payload) => payload.model)).toEqual([
      "grok-imagine-image",
      "grok-imagine-image-edit",
    ]);
  });

  it("enforces cached remote web_fetch domains and fails closed on unsupported egress proxies", async () => {
    let policy: Record<string, unknown> = { allowedDomains: ["example.com"] };
    const session = { fetch: async () => Response.json({
      accessToken: "token", userId: "user-1", eligible: true, subscriptionTier: "SuperGrok",
      remoteSettings: { mediaModels: {}, webFetch: policy },
    }) };
    const gate = { fetch: async () => Response.json({ allowed: true }) };
    const relayEnv = serviceEnv({
      SESSIONS: { get: () => session, idFromName: (name: string) => name },
      RATE_GATE: { get: () => gate, idFromName: (name: string) => name },
    });
    const fetchMock = vi.fn(async () => new Response("ok", { headers: { "Content-Type": "text/plain" } }));
    vi.stubGlobal("fetch", fetchMock);
    const send = (url: string) => worker.fetch(new Request("https://agent.example/api/grok/web-fetch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `__Host-vw_session=${"a".repeat(43)}`,
        Origin: "https://agent.example",
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ url }),
    }), relayEnv);

    expect((await send("https://docs.rs/")).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await send("https://example.com/docs")).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    policy = { allowedDomains: ["example.com"], proxyEndpoint: "https://proxy.example.com" };
    expect((await send("https://example.com/docs")).status).toBe(501);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("enforces concurrency globally and releases reservations", async () => {
    const storage = new MemoryStorage();
    const gate = new RateGate(state(storage));
    const acquire = (userKey: string, reservationId: string) => gate.fetch(new Request("https://durable.internal/acquire-chat", {
      method: "POST",
      body: JSON.stringify({ userKey, reservationId }),
    }));
    const release = (reservationId: string) => gate.fetch(new Request("https://durable.internal/release-chat", {
      method: "POST",
      body: JSON.stringify({ reservationId }),
    }));

    for (let index = 0; index < SECURITY_LIMITS.globalConcurrency; index += 1) {
      expect((await acquire(`user-${index}`, `reservation-${index}`)).status).toBe(200);
    }
    expect((await acquire("overflow", "overflow-reservation")).status).toBe(429);
    expect((await acquire("user-0", "duplicate-user")).status).toBe(429);
    expect((await release("reservation-0")).status).toBe(200);
    expect((await acquire("replacement", "replacement-reservation")).status).toBe(200);
  });

  it("enforces per-user and global daily web_fetch budgets and resets on a new UTC day", async () => {
    let now = 1_800_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const storage = new MemoryStorage();
    const gate = new RateGate(state(storage));
    const acquire = (userKey: string) => gate.fetch(new Request("https://durable.internal/acquire-web-fetch", {
      method: "POST",
      body: JSON.stringify({ userKey }),
    }));

    for (let index = 0; index < SECURITY_LIMITS.userDailyWebFetches; index += 1) {
      expect((await acquire("single-user")).status).toBe(200);
    }
    expect((await acquire("single-user")).status).toBe(429);

    const remainingGlobal = SECURITY_LIMITS.globalDailyWebFetches - SECURITY_LIMITS.userDailyWebFetches;
    for (let index = 0; index < remainingGlobal; index += 1) {
      expect((await acquire(`distributed-${index}`)).status).toBe(200);
    }
    expect((await acquire("global-overflow")).status).toBe(429);

    now += 24 * 60 * 60 * 1_000;
    vi.setSystemTime(now);
    expect((await acquire("single-user")).status).toBe(200);
  });

  it("fails closed when the global relay kill switch is off", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = await worker.fetch(
      new Request("https://agent.example/api/grok/models"),
      serviceEnv({ RELAY_ENABLED: "false" }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { message: "The Grok relay is temporarily disabled." } });
  });

  it("reports deployment health and fails readiness on an invalid secret", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));
    const healthy = await worker.fetch(new Request("https://agent.example/api/health"), serviceEnv());
    expect(await healthy.json()).toEqual({ ok: true, version: "version-1" });
    expect(healthy.headers.get("X-Vibewaiting-Version")).toBe("version-1");
    expect(healthy.headers.get("Server-Timing")).toMatch(/^worker;dur=/u);

    const ready = await worker.fetch(new Request("https://agent.example/api/ready"), serviceEnv());
    expect(await ready.json()).toMatchObject({
      ready: true,
      checks: "passed",
      capabilities: { relay: true, inference: false, media: true, webFetch: true },
    });
    const notReady = await worker.fetch(new Request("https://agent.example/api/ready"), serviceEnv({
      SESSION_ENCRYPTION_KEY: "invalid",
    }));
    expect(notReady.status).toBe(503);
    expect(await notReady.json()).toMatchObject({ ready: false, checks: ["session_encryption"] });
    expect(logs.map((line) => JSON.parse(line))).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "api_request", route: "health", status: 200, version: "version-1" }),
      expect.objectContaining({ event: "api_request", route: "ready", status: 503, version: "version-1" }),
    ]));
  });
});
