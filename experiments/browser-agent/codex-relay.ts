import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

const CODEX_CLIENT_VERSION = "0.150.1";
const CODEX_SOURCE_REVISION = "e4d0ba4e927363f695bb8d0fef187fd229700657";
const CODEX_BACKEND = "https://chatgpt.com/backend-api/codex";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const REQUESTS_PER_MINUTE = 30;
const MAX_CONCURRENT_REQUESTS = 3;

interface StoredCodexAuth {
  auth_mode?: unknown;
  tokens?: {
    access_token?: unknown;
    account_id?: unknown;
  };
}

interface StoredModel {
  slug?: unknown;
  display_name?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
  model_messages?: { instructions_template?: unknown };
}

interface StoredModelsCache {
  client_version?: unknown;
  fetched_at?: unknown;
  models?: unknown;
}

export interface CodexCredential {
  accessToken: string;
  accountId: string;
  authMode: string;
}

export interface CodexRelayOptions {
  authFile?: string;
  modelsFile?: string;
  fetch?: typeof globalThis.fetch;
  upstreamBaseUrl?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function credentialFromCodexAuthJson(value: unknown): CodexCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex auth.json must contain an object.");
  }
  const auth = value as StoredCodexAuth;
  const accessToken = nonEmptyString(auth.tokens?.access_token);
  const accountId = nonEmptyString(auth.tokens?.account_id);
  if (!accessToken || !accountId) {
    throw new Error("No ChatGPT subscription credential was found in Codex auth.json.");
  }
  return {
    accessToken,
    accountId,
    authMode: nonEmptyString(auth.auth_mode) ?? "chatgpt",
  };
}

async function readCredential(path: string): Promise<CodexCredential> {
  return credentialFromCodexAuthJson(JSON.parse(await readFile(path, "utf8")) as unknown);
}

function authFile(options: CodexRelayOptions): string {
  return options.authFile ?? resolve(process.env.CODEX_HOME ?? resolve(homedir(), ".codex"), "auth.json");
}

function modelsFile(options: CodexRelayOptions): string {
  return options.modelsFile ?? resolve(process.env.CODEX_HOME ?? resolve(homedir(), ".codex"), "models_cache.json");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new Error("The Codex request is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function trustedLocalMutation(request: IncomingMessage): boolean {
  const host = request.headers.host;
  const origin = request.headers.origin;
  if (!host || !origin) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function uuid(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ? value
    : undefined;
}

export function normalizeCodexRequest(value: unknown, threadId: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The Codex relay request must be a JSON object.");
  }
  const body = value as Record<string, unknown>;
  const allowed = new Set([
    "model", "instructions", "input", "tools", "tool_choice", "parallel_tool_calls",
    "reasoning", "store", "stream", "stream_options", "include", "service_tier",
    "prompt_cache_key", "text", "client_metadata",
  ]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Unsupported Codex Responses fields: ${unknown.join(", ")}.`);
  if (typeof body.model !== "string" || !/^[a-zA-Z0-9._-]{1,96}$/u.test(body.model)) {
    throw new Error("The Codex model identifier is invalid.");
  }
  if (typeof body.instructions !== "string" || body.instructions.length > 250_000) {
    throw new Error("The Codex instructions are invalid.");
  }
  if (!Array.isArray(body.input) || body.input.length === 0 || body.input.length > 4_000) {
    throw new Error("The Codex input transcript is invalid.");
  }
  if (!Array.isArray(body.tools) || body.tools.length > 64) throw new Error("The Codex tool list is invalid.");
  if (body.store !== false || body.stream !== true || body.tool_choice !== "auto" || body.parallel_tool_calls !== true) {
    throw new Error("The relay permits only Codex's pinned streaming Responses profile.");
  }
  if (!Array.isArray(body.include) || body.include.length !== 1 || body.include[0] !== "reasoning.encrypted_content") {
    throw new Error("Codex encrypted reasoning replay is required.");
  }
  if (body.prompt_cache_key !== threadId) throw new Error("Codex prompt_cache_key must match the thread ID.");
  return body;
}

function publicModels(cache: StoredModelsCache): unknown {
  const models = Array.isArray(cache.models) ? cache.models as StoredModel[] : [];
  return {
    clientVersion: nonEmptyString(cache.client_version) ?? CODEX_CLIENT_VERSION,
    fetchedAt: nonEmptyString(cache.fetched_at) ?? null,
    sourceRevision: CODEX_SOURCE_REVISION,
    models: models.flatMap((model) => {
      const slug = nonEmptyString(model.slug);
      const instructions = nonEmptyString(model.model_messages?.instructions_template);
      if (!slug || !instructions) return [];
      return [{
        slug,
        displayName: nonEmptyString(model.display_name) ?? slug,
        defaultReasoningEffort: nonEmptyString(model.default_reasoning_level) ?? "medium",
        supportedReasoningLevels: Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [],
        instructions,
      }];
    }),
  };
}

export function createCodexRelay(options: CodexRelayOptions = {}): Plugin {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const recentRequests: number[] = [];
  let inFlight = 0;
  return {
    name: "browser-agent-codex-relay",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const path = request.url?.split("?", 1)[0];
        if (path === "/api/codex/status" && request.method === "GET") {
          try {
            const credential = await readCredential(authFile(options));
            json(response, 200, { authenticated: true, authMode: credential.authMode, sourceRevision: CODEX_SOURCE_REVISION });
          } catch (error) {
            json(response, 503, { authenticated: false, error: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        if (path === "/api/codex/models" && request.method === "GET") {
          try {
            await readCredential(authFile(options));
            json(response, 200, publicModels(JSON.parse(await readFile(modelsFile(options), "utf8")) as StoredModelsCache));
          } catch (error) {
            json(response, 503, { error: { message: error instanceof Error ? error.message : String(error) } });
          }
          return;
        }
        if (path !== "/api/codex/responses") return next();
        if (request.method !== "POST") return json(response, 405, { error: { message: "Method not allowed." } });
        if (!trustedLocalMutation(request)) return json(response, 403, { error: { message: "Cross-origin Codex relay requests are not allowed." } });

        const now = Date.now();
        while (recentRequests[0] !== undefined && recentRequests[0] < now - 60_000) recentRequests.shift();
        if (recentRequests.length >= REQUESTS_PER_MINUTE || inFlight >= MAX_CONCURRENT_REQUESTS) {
          return json(response, 429, { error: { message: "Local Codex relay rate limit reached." } });
        }
        recentRequests.push(now);
        inFlight += 1;
        const startedAt = Date.now();
        try {
          const sessionId = uuid(request.headers["x-browser-agent-codex-session"]);
          const threadId = uuid(request.headers["x-browser-agent-codex-thread"]);
          if (!sessionId || !threadId) throw new Error("Valid Codex session and thread IDs are required.");
          const credential = await readCredential(authFile(options));
          const body = normalizeCodexRequest(JSON.parse((await readBody(request)).toString("utf8")) as unknown, threadId);
          const upstream = await fetchImpl(`${(options.upstreamBaseUrl ?? CODEX_BACKEND).replace(/\/$/u, "")}/responses`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${credential.accessToken}`,
              "ChatGPT-Account-ID": credential.accountId,
              "Content-Type": "application/json",
              "Accept": "text/event-stream",
              "originator": "codex_cli_rs",
              "session-id": sessionId,
              "thread-id": threadId,
              "x-client-request-id": threadId,
              "User-Agent": `codex_cli_rs/${CODEX_CLIENT_VERSION} (browser-wasm; vibewaiting)`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(180_000),
          });
          response.statusCode = upstream.status;
          for (const name of ["content-type", "cache-control", "x-request-id", "openai-processing-ms", "x-codex-turn-state"]) {
            const header = upstream.headers.get(name);
            if (header) response.setHeader(name, header);
          }
          if (upstream.body) Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0]).pipe(response);
          else response.end();
          console.info("[codex-relay]", JSON.stringify({ threadId, status: upstream.status, durationMs: Date.now() - startedAt }));
        } catch (error) {
          console.error("[codex-relay]", error instanceof Error ? error.message : String(error));
          json(response, 502, { error: { message: error instanceof Error ? error.message : String(error) } });
        } finally {
          inFlight -= 1;
        }
      });
    },
  };
}
