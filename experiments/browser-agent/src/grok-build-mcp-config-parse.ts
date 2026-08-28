import { parse as parseToml } from "smol-toml";
import type { GrokBuildAcpMcpServer } from "./grok-build-agent-mcp.js";

export interface GrokBuildMcpConfigPolicy {
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  toolTimeoutsMs?: Record<string, number>;
  exposeImageBase64?: boolean;
  disabledTools?: string[];
  oauth?: {
    clientId?: string;
    clientSecret?: string;
    scopes?: string[];
    callbackPort?: number;
  };
}

export interface GrokBuildParsedMcpEntry {
  name: string;
  config: Record<string, unknown>;
}

export interface GrokBuildMcpPreferences {
  servers: Record<string, { values: Record<string, string> }>;
}

export interface GrokBuildMaterializedMcpServer {
  server: GrokBuildAcpMcpServer;
  policy: GrokBuildMcpConfigPolicy;
}

export function parseGrokBuildMcpToml(source: string): Record<string, unknown> | undefined {
  try {
    const parsed = parseToml(source);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Invalid siblings are skipped, matching native's per-entry tolerance. */
export function parseGrokBuildMcpEntries(root: unknown, key: "mcp_servers" | "mcpServers"): GrokBuildParsedMcpEntry[] {
  if (!isRecord(root) || !isRecord(root[key])) return [];
  return Object.entries(root[key]).flatMap(([name, value]) => isRecord(value) ? [{ name, config: structuredClone(value) }] : []);
}

export function parseGrokBuildMcpPreferences(value: unknown): GrokBuildMcpPreferences {
  const result: GrokBuildMcpPreferences = { servers: {} };
  if (!isRecord(value) || !isRecord(value.servers)) return result;
  for (const [name, server] of Object.entries(value.servers)) {
    if (!isRecord(server) || !isRecord(server.values)) continue;
    const values = stringRecord(server.values);
    if (values) result.servers[name] = { values };
  }
  return result;
}

export function materializeGrokBuildMcpServer(
  entry: GrokBuildParsedMcpEntry,
  options: {
    environment?: Readonly<Record<string, string>>;
    preferences?: GrokBuildMcpPreferences;
    disabledTools?: readonly string[];
  } = {},
): GrokBuildMaterializedMcpServer | undefined {
  let config = structuredClone(entry.config);
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") return undefined;
  if (config.enabled === false) return undefined;
  if (config.setup !== undefined) {
    const resolved = resolveSetup(config, options.preferences?.servers[entry.name]?.values);
    if (!resolved) return undefined;
    config = resolved;
  }

  const environment = options.environment ?? {};
  const expand = (value: string): string => expandGrokBuildEnvironment(value, environment);
  const policy = parsePolicy(config, environment, options.disabledTools);
  const meta = policyIsEmpty(policy) ? undefined : { grokBrowserConfig: structuredClone(policy) };

  // The native untagged enum tries stdio first. Unknown sibling fields are ignored.
  if (typeof config.command === "string") {
    if (!config.command.trim()) return undefined;
    const args = config.args === undefined ? [] : stringArray(config.args);
    const env = config.env === undefined ? {} : stringRecord(config.env);
    if (!args || !env) return undefined;
    return {
      server: {
        type: "stdio",
        name: entry.name,
        command: expand(config.command),
        args: args.map(expand),
        env: Object.entries(env).map(([name, value]) => ({ name, value: expand(value) })),
        ...(meta ? { _meta: meta } : {}),
      },
      policy,
    };
  }

  const urlValue = config.url ?? config.urlTemplate ?? config.url_template;
  if (typeof urlValue !== "string" || !urlValue.trim()) return undefined;
  if (config.type !== undefined && typeof config.type !== "string") return undefined;
  const headers = config.headers === undefined ? {} : stringRecord(config.headers);
  if (!headers) return undefined;
  const expandedHeaders = Object.entries(headers).map(([name, value]) => ({ name, value: expand(value) }));
  if (typeof config.bearer_token_env_var === "string") {
    const token = environment[config.bearer_token_env_var];
    if (token !== undefined) expandedHeaders.push({ name: "Authorization", value: `Bearer ${token}` });
  } else if (config.bearer_token_env_var !== undefined) return undefined;
  const url = expand(urlValue);
  const type = typeof config.type === "string" && config.type.toLowerCase() === "sse" || url.endsWith("/sse") ? "sse" : "http";
  return {
    server: { type, name: entry.name, url, headers: expandedHeaders, ...(meta ? { _meta: meta } : {}) },
    policy,
  };
}

export function policyFromGrokBuildAcpServer(server: GrokBuildAcpMcpServer): GrokBuildMcpConfigPolicy {
  const value = server._meta?.grokBrowserConfig;
  if (!isRecord(value)) return {};
  const startupTimeoutMs = positiveInteger(value.startupTimeoutMs);
  const toolTimeoutMs = positiveInteger(value.toolTimeoutMs);
  const toolTimeoutsMs = isRecord(value.toolTimeoutsMs) ? Object.fromEntries(Object.entries(value.toolTimeoutsMs).flatMap(([name, timeout]) => {
    const parsed = positiveInteger(timeout);
    return name && parsed !== undefined ? [[name, parsed]] : [];
  })) : undefined;
  const disabledTools = stringArray(value.disabledTools);
  const rawOauth = isRecord(value.oauth) ? value.oauth : undefined;
  const oauth = rawOauth ? {
    ...(typeof rawOauth.clientId === "string" ? { clientId: rawOauth.clientId } : {}),
    ...(typeof rawOauth.clientSecret === "string" ? { clientSecret: rawOauth.clientSecret } : {}),
    ...(stringArray(rawOauth.scopes) ? { scopes: stringArray(rawOauth.scopes)! } : {}),
    ...(safeInteger(rawOauth.callbackPort) !== undefined ? { callbackPort: safeInteger(rawOauth.callbackPort)! } : {}),
  } : undefined;
  return {
    ...(startupTimeoutMs !== undefined ? { startupTimeoutMs } : {}),
    ...(toolTimeoutMs !== undefined ? { toolTimeoutMs } : {}),
    ...(toolTimeoutsMs && Object.keys(toolTimeoutsMs).length ? { toolTimeoutsMs } : {}),
    ...(typeof value.exposeImageBase64 === "boolean" ? { exposeImageBase64: value.exposeImageBase64 } : {}),
    ...(disabledTools ? { disabledTools } : {}),
    ...(oauth && Object.keys(oauth).length ? { oauth } : {}),
  };
}

export function parseDisabledGrokBuildMcpServers(root: unknown): string[] {
  if (!isRecord(root) || !Array.isArray(root.disabled_mcp_servers)) return [];
  return root.disabled_mcp_servers.filter((value): value is string => typeof value === "string");
}

export function parseDisabledGrokBuildMcpTools(root: unknown): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!isRecord(root) || !isRecord(root.disabled_mcp_tools)) return result;
  for (const [server, tools] of Object.entries(root.disabled_mcp_tools)) {
    if (!Array.isArray(tools)) continue;
    const names = tools.filter((value): value is string => typeof value === "string");
    if (names.length) result[server] = [...new Set(names)];
  }
  return result;
}

export function expandGrokBuildEnvironment(input: string, environment: Readonly<Record<string, string>>): string {
  return input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu, (match, braced: string | undefined, plain: string | undefined) => {
    const name = braced ?? plain;
    return name !== undefined && environment[name] !== undefined ? environment[name] : match;
  });
}

function parsePolicy(config: Record<string, unknown>, environment: Readonly<Record<string, string>>, disabledTools: readonly string[] | undefined): GrokBuildMcpConfigPolicy {
  const startupTimeoutMs = secondsToMs(config.startup_timeout_sec);
  const toolTimeoutMs = secondsToMs(config.tool_timeout_sec);
  const toolTimeouts = isRecord(config.tool_timeouts) ? Object.fromEntries(Object.entries(config.tool_timeouts).flatMap(([name, value]) => {
    const milliseconds = secondsToMs(value);
    return milliseconds === undefined ? [] : [[name, milliseconds]];
  })) : undefined;
  const exposeImageBase64 = typeof config.expose_image_base64 === "boolean" ? config.expose_image_base64 : undefined;
  const oauthBlock = isRecord(config.oauth) ? config.oauth : undefined;
  const clientId = stringValue(config.oauth_client_id) ?? stringValue(oauthBlock?.clientId);
  const secretEnv = stringValue(config.oauth_client_secret_env_var) ?? stringValue(oauthBlock?.clientSecretEnvVar);
  const scopes = stringArray(config.oauth_scopes) ?? stringArray(oauthBlock?.scopes);
  const callbackPort = safeInteger(oauthBlock?.callbackPort);
  const oauth = clientId ? {
    clientId,
    ...(secretEnv && environment[secretEnv] !== undefined ? { clientSecret: environment[secretEnv] } : {}),
    ...(scopes ? { scopes } : {}),
    ...(callbackPort !== undefined && callbackPort >= 0 && callbackPort <= 65_535 ? { callbackPort } : {}),
  } : undefined;
  return {
    ...(startupTimeoutMs !== undefined ? { startupTimeoutMs } : {}),
    ...(toolTimeoutMs !== undefined ? { toolTimeoutMs } : {}),
    ...(toolTimeouts && Object.keys(toolTimeouts).length ? { toolTimeoutsMs: toolTimeouts } : {}),
    ...(exposeImageBase64 !== undefined ? { exposeImageBase64 } : {}),
    ...(disabledTools?.length ? { disabledTools: [...new Set(disabledTools)] } : {}),
    ...(oauth ? { oauth } : {}),
  };
}

function resolveSetup(config: Record<string, unknown>, preferences: Record<string, string> | undefined): Record<string, unknown> | undefined {
  if (!isRecord(config.setup)) return undefined;
  const setup = config.setup;
  if (!Array.isArray(setup.fields) || setup.fields.length !== 1) return undefined;
  const field = setup.fields[0];
  if (!isRecord(field) || typeof field.id !== "string" || field.type !== "select" || !Array.isArray(field.options) || field.options.length === 0) return undefined;
  const value = preferences?.[field.id];
  if (value === undefined || !field.options.some((option) => isRecord(option) && option.value === value)) return undefined;
  const variablesRoot = isRecord(setup.variables) ? setup.variables : isRecord(setup.values) ? setup.values : {};
  const variables: Record<string, string> = {};
  for (const [name, derived] of Object.entries(variablesRoot)) {
    if (!isRecord(derived) || derived.from !== field.id || !isRecord(derived.map) || typeof derived.map[value] !== "string") return undefined;
    variables[name] = derived.map[value];
  }
  const render = (input: string): string | undefined => {
    let valid = true;
    const output = input.replace(/\{\{(.*?)\}\}/gu, (_match, raw: string) => {
      const replacement = variables[raw.trim()];
      if (replacement === undefined) { valid = false; return ""; }
      return replacement;
    });
    return valid && !output.includes("{{") ? output : undefined;
  };
  const resolved = structuredClone(config);
  delete resolved.setup;
  for (const key of ["command", "url", "urlTemplate", "url_template", "cwd"] as const) {
    if (typeof resolved[key] === "string") {
      const rendered = render(resolved[key]);
      if (rendered === undefined) return undefined;
      resolved[key] = rendered;
    }
  }
  for (const key of ["args"] as const) {
    if (Array.isArray(resolved[key])) {
      const rendered = resolved[key].map((item) => typeof item === "string" ? render(item) : undefined);
      if (rendered.some((item) => item === undefined)) return undefined;
      resolved[key] = rendered;
    }
  }
  for (const key of ["env", "headers"] as const) {
    if (isRecord(resolved[key])) {
      for (const [name, item] of Object.entries(resolved[key])) {
        if (typeof item !== "string") return undefined;
        const rendered = render(item);
        if (rendered === undefined) return undefined;
        resolved[key][name] = rendered;
      }
    }
  }
  return resolved;
}

function secondsToMs(value: unknown): number | undefined {
  const seconds = safeInteger(value);
  if (seconds === undefined || seconds <= 0 || seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) return undefined;
  return seconds * 1_000;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const integer = safeInteger(value);
  return integer !== undefined && integer > 0 ? integer : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value) || !Object.values(value).every((item) => typeof item === "string")) return undefined;
  return { ...value } as Record<string, string>;
}

function policyIsEmpty(policy: GrokBuildMcpConfigPolicy): boolean {
  return Object.keys(policy).length === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
