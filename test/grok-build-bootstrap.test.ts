import { describe, expect, it, vi } from "vitest";
import {
  fetchGrokBuildStartupProfile,
  GrokBuildStartupCoordinator,
  parseGrokBuildRemoteModel,
  resolveGrokBuildStartupProfile,
} from "../experiments/browser-agent/src/grok-build-bootstrap.js";

const tools = [
  { type: "function", name: "read_file", parameters: {} },
  { type: "function", name: "web_fetch", parameters: {} },
  { type: "function", name: "web_search", parameters: {} },
  { type: "function", name: "image_gen", parameters: {} },
  { type: "function", name: "image_edit", parameters: {} },
  { type: "function", name: "image_to_video", parameters: {} },
  { type: "function", name: "reference_to_video", parameters: {} },
] as const;

describe("native Grok Build startup port", () => {
  it("accepts native model aliases, metadata fallbacks, and the 256k source default", () => {
    expect(parseGrokBuildRemoteModel({
      id: "catalog-id",
      modelId: "routing-model",
      _meta: { totalContextTokens: 123_456, supportsBackendSearch: true },
      reasoning_effort: "xhigh",
    })).toMatchObject({
      id: "catalog-id",
      model: "routing-model",
      contextWindow: 123_456,
      reasoningEffort: "xhigh",
      supportsBackendSearch: true,
    });
    expect(parseGrokBuildRemoteModel({ id: "fallback-model" })?.contextWindow).toBe(256_000);
    expect(parseGrokBuildRemoteModel({ model: "invalid", context_window: 0 })).toBeUndefined();
  });

  it("selects the remote default and applies per-model settings and native kill switches", () => {
    const profile = resolveGrokBuildStartupProfile({
      object: "list",
      data: [{
        id: "grok-next",
        model: "grok-next-routing",
        context_window: 500_000,
        auto_compact_threshold_percent: 77,
        reasoning_effort: "medium",
        supports_backend_search: true,
        compactions_remaining: 2,
      }, {
        id: "grok-old",
        model: "grok-old",
        context_window: 200_000,
      }],
    }, {
      default_model: "grok-next",
      web_fetch_enabled: false,
      image_gen_enabled: false,
      video_gen_enabled: false,
    }, tools);

    expect(profile).toMatchObject({
      model: "grok-next-routing",
      contextWindow: 500_000,
      autoCompactThresholdPercent: 77,
      reasoningEffort: "medium",
      maxCompactions: 2,
    });
    expect(profile.tools.map((tool) => tool.name)).toEqual(["read_file", "web_search", "image_edit"]);
  });

  it("matches native startup order and settings retry backoff", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ model: "grok-4.6", context_window: 500_000, supports_backend_search: true }] })))
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ default_model: "grok-4.6" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ default_model: "grok-4.6" })));
    const sleep = vi.fn(async () => undefined);

    const profile = await fetchGrokBuildStartupProfile({ fetch: fetchMock, tools, sleep });

    expect(profile.model).toBe("grok-4.6");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/grok/models",
      "/api/grok/settings",
      "/api/grok/settings",
      "/api/grok/settings",
    ]);
    expect(sleep).toHaveBeenCalledWith(500, undefined);
  });

  it("keeps embedded models and early settings when optional startup refreshes fail", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("models offline"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ default_model: "grok-4.5" })))
      .mockResolvedValue(new Response("offline", { status: 403 }));

    const profile = await fetchGrokBuildStartupProfile({ fetch: fetchMock, tools });

    expect(profile.model).toBe("grok-4.5");
    expect(profile.contextWindow).toBe(500_000);
  });

  it("uses only a fresh version/auth/origin-matched five-minute model cache", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    let now = 1_000;
    const firstFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [{ model: "cached-model", context_window: 321_000 }] }, { headers: { ETag: "catalog-v1" } }))
      .mockResolvedValue(Response.json({ default_model: "cached-model" }));
    await fetchGrokBuildStartupProfile({ fetch: firstFetch, tools, storage, now: () => now });
    expect(firstFetch).toHaveBeenCalledTimes(3);

    const cachedFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ default_model: "cached-model" }));
    now += 299_999;
    const cached = await fetchGrokBuildStartupProfile({ fetch: cachedFetch, tools, storage, now: () => now });
    expect(cached.model).toBe("cached-model");
    expect(cachedFetch).toHaveBeenCalledTimes(2);

    const staleFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [{ model: "renewed-model" }] }))
      .mockResolvedValue(Response.json({ default_model: "renewed-model" }));
    now += 1;
    expect((await fetchGrokBuildStartupProfile({ fetch: staleFetch, tools, storage, now: () => now })).model).toBe("renewed-model");
    expect(staleFetch).toHaveBeenCalledTimes(3);
  });

  it("coalesces new-session refreshes and keeps previously returned snapshots stable", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [{ model: "grok-4.6", context_window: 500_000 }] }))
      .mockResolvedValueOnce(Response.json({ default_model: "grok-4.6", web_fetch_enabled: true }))
      .mockResolvedValueOnce(Response.json({ default_model: "grok-4.6", web_fetch_enabled: true }))
      .mockResolvedValueOnce(Response.json({ default_model: "grok-4.6", web_fetch_enabled: false }));
    const coordinator = new GrokBuildStartupCoordinator({ fetch: fetchMock, tools });
    const original = await coordinator.snapshot();
    const [left, right] = await Promise.all([coordinator.refreshForNewSession(), coordinator.refreshForNewSession()]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(original.tools.some((tool) => tool.name === "web_fetch")).toBe(true);
    expect(left.tools.some((tool) => tool.name === "web_fetch")).toBe(false);
    expect(right).toEqual(left);
  });
});
