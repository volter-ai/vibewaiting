/// <reference path="../worker-configuration.d.ts" />

// Kept outside the Node/DOM typecheck graph because Workers and DOM both declare Element.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokSession } from "../cloudflare/worker.js";

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

function request(path: string, method = "GET"): Request {
  return new Request(`https://durable.internal${path}`, { method });
}

afterEach(() => {
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
    const credentialEnvelope = String(storage.values.get("session"));
    expect(credentialEnvelope).not.toContain("initial-access");
    expect(credentialEnvelope).not.toContain("initial-refresh");

    const first = session.fetch(request("/credential"));
    const second = session.fetch(request("/credential"));
    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    releaseRefresh();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(await firstResponse.json()).toMatchObject({ accessToken: "fresh-access", userId: "user-1" });
    expect(await secondResponse.json()).toMatchObject({ accessToken: "fresh-access", userId: "user-1" });
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
