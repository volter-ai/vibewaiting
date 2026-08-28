// Copyright 2023-2026 SpaceXAI
// Modified for the Vibewaiting browser port, 2026.
//
// Browser-safe translation of Grok Build's Apache-2.0 startup model/settings
// resolution in xai-grok-shell/src/remote/client.rs and agent/models/resolution.rs.

import type { GrokClientMode, GrokTool } from "../../../src/grok-browser-protocol.js";

const DEFAULT_CONTEXT_WINDOW = 256_000;
const DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT = 80;
const SETTINGS_FETCH_MAX_ATTEMPTS = 3;
const MODELS_CACHE_TTL_MS = 300_000;
const MODELS_CACHE_VERSION = "1.0.5";
const MODELS_CACHE_KEY = "vibewaiting:grok-build:models-cache:v1";
const BUNDLED_MODELS = {
  data: [{
    id: "grok-4.6",
    model: "grok-4.6",
    name: "Grok 4.6",
    context_window: 500_000,
    auto_compact_threshold_percent: 80,
    reasoning_effort: "high",
    supports_backend_search: true,
    compactions_remaining: 1,
  }, {
    id: "grok-4.5",
    model: "grok-4.5",
    name: "Grok 4.5",
    context_window: 500_000,
    auto_compact_threshold_percent: 80,
    reasoning_effort: "high",
    supports_backend_search: false,
    compactions_remaining: 1,
  }],
} as const;

type JsonObject = Record<string, unknown>;

export interface GrokBuildRemoteModel {
  id?: string;
  model: string;
  name?: string;
  contextWindow: number;
  autoCompactThresholdPercent?: number;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  supportsBackendSearch: boolean;
  compactionsRemaining?: number;
  hidden: boolean;
  supportedInApi: boolean;
  raw: JsonObject;
}

export interface GrokBuildStartupProfile {
  model: string;
  models: readonly GrokBuildRemoteModel[];
  settings: JsonObject;
  tools: readonly GrokTool[];
  contextWindow: number;
  autoCompactThresholdPercent: number;
  reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  maxCompactions?: number;
}

export interface GrokBuildStartupOptions {
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  tools: readonly GrokTool[];
  signal?: AbortSignal;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  now?: () => number;
  remoteFetchEnabled?: boolean;
  authMethod?: string;
  clientMode?: GrokClientMode | (() => GrokClientMode);
}

interface ModelsCacheRecord {
  fetchedAt: number;
  grokVersion: string;
  authMethod: string;
  origin: string;
  etag?: string;
  payload: unknown;
}

/** Parse the aliases and defaults accepted by native `parse_remote_model_value`. */
export function parseGrokBuildRemoteModel(value: unknown): GrokBuildRemoteModel | undefined {
  if (!isObject(value)) return;
  const meta = isObject(value._meta) ? value._meta : undefined;
  const id = stringAt(value, "id");
  const model = stringAt(value, "model")
    ?? stringAt(value, "modelId")
    ?? id
    ?? stringAt(meta, "model")
    ?? stringAt(meta, "modelId");
  if (!model) return;

  const contextWindow = integerAt(value, "contextWindow")
    ?? integerAt(value, "context_window")
    ?? integerAt(meta, "contextWindow")
    ?? integerAt(meta, "totalContextTokens")
    ?? DEFAULT_CONTEXT_WINDOW;
  if (contextWindow <= 0) return;

  const effort = stringAt(value, "reasoningEffort")
    ?? stringAt(value, "reasoning_effort")
    ?? stringAt(meta, "reasoningEffort");
  const parsedEffort = isReasoningEffort(effort) ? effort : undefined;
  const compactionsRemaining = parseCompactionsRemaining(
    value.compactionsRemaining
      ?? value.compactions_remaining
      ?? meta?.compactionsRemaining,
  );
  const name = stringAt(value, "name");
  const compactThreshold = percentAt(value, "autoCompactThresholdPercent")
    ?? percentAt(value, "auto_compact_threshold_percent");
  return {
    ...(id ? { id } : {}),
    model,
    ...(name ? { name } : {}),
    contextWindow,
    ...(compactThreshold !== undefined ? { autoCompactThresholdPercent: compactThreshold } : {}),
    ...(parsedEffort ? { reasoningEffort: parsedEffort } : {}),
    supportsBackendSearch: booleanAt(value, "supportsBackendSearch")
      ?? booleanAt(value, "supports_backend_search")
      ?? booleanAt(meta, "supportsBackendSearch")
      ?? false,
    ...(compactionsRemaining !== undefined ? { compactionsRemaining } : {}),
    hidden: booleanAt(value, "hidden") ?? booleanAt(meta, "hidden") ?? false,
    supportedInApi: booleanAt(value, "supportedInApi")
      ?? booleanAt(value, "supported_in_api")
      ?? booleanAt(meta, "supportedInApi")
      ?? true,
    raw: structuredClone(value),
  };
}

export function parseGrokBuildModelsResponse(value: unknown): GrokBuildRemoteModel[] {
  if (!isObject(value) || !Array.isArray(value.data)) {
    throw new Error("Grok models response must contain a data array.");
  }
  return value.data.flatMap((entry) => {
    const parsed = parseGrokBuildRemoteModel(entry);
    return parsed ? [parsed] : [];
  });
}

export function resolveGrokBuildStartupProfile(
  modelsPayload: unknown,
  settingsPayload: unknown,
  tools: readonly GrokTool[],
): GrokBuildStartupProfile {
  const models = parseGrokBuildModelsResponse(modelsPayload);
  if (models.length === 0) throw new Error("Grok returned no usable models.");
  if (!isObject(settingsPayload)) throw new Error("Grok settings response must be an object.");
  const settings = structuredClone(settingsPayload);
  const visible = models.filter((model) => !model.hidden);
  const candidates = visible.length > 0 ? visible : models;
  const preferred = stringAt(settings, "default_model");
  const selected = candidates.find((entry) => entry.id === preferred || entry.model === preferred)
    ?? candidates[0]!;
  const settingThreshold = percentAt(settings, "auto_compact_threshold_percent");

  return {
    model: selected.model,
    models,
    settings,
    tools: applyGrokBuildRemoteToolGates(tools, settings, selected),
    contextWindow: selected.contextWindow,
    autoCompactThresholdPercent: selected.autoCompactThresholdPercent
      ?? settingThreshold
      ?? DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
    reasoningEffort: selected.reasoningEffort ?? "high",
    ...(selected.compactionsRemaining !== undefined
      ? { maxCompactions: selected.compactionsRemaining }
      : {}),
  };
}

/** Apply only native remote kill-switches; absent flags retain client defaults. */
export function applyGrokBuildRemoteToolGates(
  tools: readonly GrokTool[],
  settings: JsonObject,
  model: GrokBuildRemoteModel,
): GrokTool[] {
  const disabled = new Set<string>();
  if (settings.image_gen_enabled === false) disabled.add("image_gen");
  if (settings.video_gen_enabled === false) {
    disabled.add("image_to_video");
    disabled.add("reference_to_video");
  }
  if (settings.web_fetch_enabled === false) disabled.add("web_fetch");
  if (settings.ask_user_question_enabled === false) disabled.add("ask_user_question");
  if (settings.subagents_enabled === false) disabled.add("spawn_subagent");
  if (settings.workflows_enabled === false) disabled.add("workflow");
  if (settings.write_file_enabled === false) disabled.add("write");
  if (!model.supportsBackendSearch) {
    disabled.add("web_search");
    disabled.add("x_search");
  }
  return tools.filter((tool) => typeof tool.name !== "string" || !disabled.has(tool.name))
    .map((tool) => structuredClone(tool));
}

/** Native startup ordering: models, early settings, then settings re-apply. */
export async function fetchGrokBuildStartupProfile(options: GrokBuildStartupOptions): Promise<GrokBuildStartupProfile> {
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const base = (options.baseUrl ?? "/api/grok").replace(/\/$/u, "");
  const modelsUrl = `${base}/models`;
  const cache = readModelsCache(options, modelsUrl);
  let models: unknown = cache?.payload ?? BUNDLED_MODELS;
  if (!cache && options.remoteFetchEnabled !== false) {
    try {
      const modelsResponse = await fetchWithTimeout(fetchImpl, modelsUrl, options.signal, 5_000, resolveClientMode(options));
      if (modelsResponse.ok) {
        models = await modelsResponse.json() as unknown;
        writeModelsCache(options, modelsUrl, models, modelsResponse.headers.get("ETag") ?? undefined);
      }
    } catch {
      options.signal?.throwIfAborted();
      // Native keeps its embedded catalog when the optional remote prefetch misses.
    }
  }
  let settings: unknown = {};
  if (options.remoteFetchEnabled !== false) {
    try {
      settings = await fetchSettings(fetchImpl, `${base}/settings`, options);
    } catch {
      options.signal?.throwIfAborted();
      // Native starts with client defaults when early remote settings are absent.
    }
    try {
      settings = await fetchSettings(fetchImpl, `${base}/settings`, options);
    } catch {
      options.signal?.throwIfAborted();
      // A failed later re-apply leaves the already-resolved settings untouched.
    }
  }
  return resolveGrokBuildStartupProfile(models, settings, options.tools);
}

/**
 * Source-shaped startup owner: one early prefetch, a separate post-auth guard,
 * and a coalesced refresh for later sessions. Returned profiles are immutable
 * snapshots, so an in-flight session never observes a settings replacement.
 */
export class GrokBuildStartupCoordinator {
  private profile: GrokBuildStartupProfile | undefined;
  private prefetching: Promise<GrokBuildStartupProfile> | undefined;
  private reapplying: Promise<GrokBuildStartupProfile> | undefined;
  private postAuthRefreshing: Promise<GrokBuildStartupProfile> | undefined;

  constructor(private readonly options: GrokBuildStartupOptions) {}

  prefetch(): Promise<GrokBuildStartupProfile> {
    this.prefetching ??= fetchGrokBuildStartupProfile(this.options)
      .then((profile) => (this.profile = cloneProfile(profile)))
      .finally(() => { this.prefetching = undefined; });
    return this.prefetching.then(cloneProfile);
  }

  async snapshot(): Promise<GrokBuildStartupProfile> {
    if (this.profile) return cloneProfile(this.profile);
    return this.prefetch();
  }

  refreshForNewSession(): Promise<GrokBuildStartupProfile> {
    if (this.postAuthRefreshing) return this.postAuthRefreshing.then(cloneProfile);
    this.reapplying ??= this.refreshSettings().finally(() => { this.reapplying = undefined; });
    return this.reapplying.then(cloneProfile);
  }

  refreshAfterAuth(): Promise<GrokBuildStartupProfile> {
    if (!this.profile) return this.prefetch();
    this.postAuthRefreshing ??= this.refreshSettings().finally(() => { this.postAuthRefreshing = undefined; });
    return this.postAuthRefreshing.then(cloneProfile);
  }

  current(): GrokBuildStartupProfile | undefined {
    return this.profile ? cloneProfile(this.profile) : undefined;
  }

  private async refreshSettings(): Promise<GrokBuildStartupProfile> {
    const current = this.profile ?? await this.prefetch();
    if (this.options.remoteFetchEnabled === false) return cloneProfile(current);
    const fetchImpl = this.options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    const base = (this.options.baseUrl ?? "/api/grok").replace(/\/$/u, "");
    let settings: unknown;
    try {
      settings = await fetchSettings(fetchImpl, `${base}/settings`, this.options);
    } catch {
      this.options.signal?.throwIfAborted();
      return cloneProfile(current);
    }
    this.profile = resolveGrokBuildStartupProfile({ data: current.models.map((model) => model.raw) }, settings, this.options.tools);
    return cloneProfile(this.profile);
  }
}

function cloneProfile(profile: GrokBuildStartupProfile): GrokBuildStartupProfile {
  return structuredClone(profile);
}

function modelsCacheStorage(options: GrokBuildStartupOptions): Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined {
  if (options.storage) return options.storage;
  try {
    return globalThis.localStorage;
  } catch {
    return;
  }
}

function readModelsCache(options: GrokBuildStartupOptions, origin: string): ModelsCacheRecord | undefined {
  const storage = modelsCacheStorage(options);
  if (!storage) return;
  try {
    const raw = storage.getItem(MODELS_CACHE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) return;
    const record = parsed as unknown as ModelsCacheRecord;
    const now = (options.now ?? Date.now)();
    const valid = record.grokVersion === MODELS_CACHE_VERSION
      && record.authMethod === (options.authMethod ?? "session")
      && record.origin === origin
      && Number.isFinite(record.fetchedAt)
      && now >= record.fetchedAt
      && now - record.fetchedAt < MODELS_CACHE_TTL_MS;
    if (valid) return record;
    storage.removeItem(MODELS_CACHE_KEY);
  } catch {
    return;
  }
}

function writeModelsCache(options: GrokBuildStartupOptions, origin: string, payload: unknown, etag?: string): void {
  const storage = modelsCacheStorage(options);
  if (!storage) return;
  const record: ModelsCacheRecord = {
    fetchedAt: (options.now ?? Date.now)(),
    grokVersion: MODELS_CACHE_VERSION,
    authMethod: options.authMethod ?? "session",
    origin,
    ...(etag ? { etag } : {}),
    payload,
  };
  try {
    storage.setItem(MODELS_CACHE_KEY, JSON.stringify(record));
  } catch {
    // Native cache persistence is best-effort and never blocks readiness.
  }
}

async function fetchSettings(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  options: GrokBuildStartupOptions,
): Promise<unknown> {
  for (let attempt = 0; attempt < SETTINGS_FETCH_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await (options.sleep ?? abortableSleep)(500 * attempt, options.signal);
    let response: Response;
    try {
      response = await fetchWithTimeout(fetchImpl, url, options.signal, 5_000, resolveClientMode(options));
    } catch (error) {
      if (attempt + 1 === SETTINGS_FETCH_MAX_ATTEMPTS) throw error;
      continue;
    }
    if (response.ok) return response.json() as Promise<unknown>;
    if (response.status === 401) throw new Error("Grok settings fetch was rejected (HTTP 401).");
    if (response.status >= 500 && attempt + 1 < SETTINGS_FETCH_MAX_ATTEMPTS) continue;
    throw new Error(`Grok settings fetch returned HTTP ${response.status}.`);
  }
  throw new Error("Grok settings fetch failed.");
}

async function fetchWithTimeout(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  clientMode: GrokClientMode = "headless",
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
  return fetchImpl(url, {
    credentials: "include",
    cache: "no-store",
    signal,
    headers: { "x-browser-agent-client-mode": clientMode },
  });
}

function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = globalThis.setTimeout(done, delayMs);
    signal?.addEventListener("abort", aborted, { once: true });
    function done(): void {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted(): void {
      globalThis.clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    }
  });
}

function resolveClientMode(options: GrokBuildStartupOptions): GrokClientMode {
  return typeof options.clientMode === "function" ? options.clientMode() : options.clientMode ?? "headless";
}

function parseCompactionsRemaining(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  return;
}

function isReasoningEffort(value: unknown): value is GrokBuildStartupProfile["reasoningEffort"] {
  return ["none", "minimal", "low", "medium", "high", "xhigh"].includes(String(value));
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringAt(value: JsonObject | undefined, key: string): string | undefined {
  const item = value?.[key];
  return typeof item === "string" && item.length > 0 ? item : undefined;
}

function integerAt(value: JsonObject | undefined, key: string): number | undefined {
  const item = value?.[key];
  return typeof item === "number" && Number.isSafeInteger(item) && item >= 0 ? item : undefined;
}

function percentAt(value: JsonObject | undefined, key: string): number | undefined {
  const item = integerAt(value, key);
  return item !== undefined && item <= 100 ? item : undefined;
}

function booleanAt(value: JsonObject | undefined, key: string): boolean | undefined {
  const item = value?.[key];
  return typeof item === "boolean" ? item : undefined;
}
