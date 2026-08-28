/**
 * Custom-agent MCP resolution ported from Grok Build's `xai-grok-agent`
 * config and subagent spawn path (source revision 9684fa3c).
 *
 * This module deliberately has no runtime imports: workflow runtimes can use
 * the same snapshot/filter/precedence semantics with any browser MCP client.
 */

export type GrokBuildMcpInheritance =
  | "all"
  | "none"
  | { named: string[] }
  | { except: string[] };

export type GrokBuildAgentMcpServerRef =
  | { kind: "named"; name: string }
  | { kind: "inline"; name: string; config: Record<string, unknown> };

export interface GrokBuildAcpHeader {
  name: string;
  value: string;
}

export interface GrokBuildAcpEnvVariable {
  name: string;
  value: string;
}

export type GrokBuildAcpMcpServer =
  | {
    type: "http" | "sse";
    name: string;
    url: string;
    headers: GrokBuildAcpHeader[];
    _meta?: Record<string, unknown>;
  }
  | {
    /** ACP's stdio variant is untagged; a supplied `type: "stdio"` is ignored. */
    type: "stdio";
    name: string;
    command: string;
    args: string[];
    env: GrokBuildAcpEnvVariable[];
    _meta?: Record<string, unknown>;
  };

export interface GrokBuildAgentMcpDefinition {
  mcpServers?: unknown;
  mcpInheritance?: unknown;
  /** Plugin-owned declarations are blocked, while inheritance remains allowed. */
  pluginName?: string;
  scope?: "project" | "user" | "bundled" | "built-in";
}

export interface GrokBuildAgentMcpResolution {
  owned: GrokBuildAcpMcpServer[];
  /** `undefined` is native None/no-parent-pool; [] is a present, empty pool. */
  inherited: GrokBuildAcpMcpServer[] | undefined;
  skipped: Array<{
    name: string;
    reason: "plugin-owned" | "untrusted-project" | "named-not-found" | "invalid-inline";
  }>;
}

export function parseGrokBuildMcpInheritance(value: unknown): GrokBuildMcpInheritance {
  if (value === undefined || value === null) return "all";
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized === "all" || normalized === "none") return normalized;
    throw new TypeError(`unknown mcpInheritance variant '${normalized}'`);
  }
  if (!isRecord(value)) {
    throw new TypeError('mcpInheritance must be "all", "none", {named: [...]}, or {except: [...]}');
  }
  const entries = Object.entries(value);
  if (entries.length !== 1) {
    throw new TypeError("mcpInheritance map must have exactly one key");
  }
  const entry = entries[0];
  if (!entry) throw new TypeError("mcpInheritance map must have exactly one key");
  const [key, names] = entry;
  if (key !== "named" && key !== "except") {
    throw new TypeError(`unknown mcpInheritance variant '${key}'`);
  }
  if (!Array.isArray(names) || !names.every((name) => typeof name === "string")) {
    throw new TypeError(`mcpInheritance.${key} must be an array of strings`);
  }
  return key === "named" ? { named: [...names] } : { except: [...names] };
}

export function parseGrokBuildAgentMcpServerRef(value: unknown): GrokBuildAgentMcpServerRef {
  if (typeof value === "string") return { kind: "named", name: value };
  if (!isRecord(value)) {
    throw new TypeError("mcpServers entry must be a string or object");
  }
  const entries = Object.entries(value);
  if (entries.length === 1) {
    const entry = entries[0];
    if (!entry) throw new TypeError("mcpServers entry must be a string or object");
    const [name, config] = entry;
    if (!isRecord(config)) {
      throw new TypeError(`mcpServers inline config for '${name}' must be an object`);
    }
    return { kind: "inline", name, config: { ...config } };
  }
  if (typeof value.name === "string") {
    return { kind: "inline", name: value.name, config: { ...value } };
  }
  throw new TypeError(
    "mcpServers entry must be a string, a {name: config} map, or an object with a 'name' field",
  );
}

export function parseGrokBuildAgentMcpServerRefs(value: unknown): GrokBuildAgentMcpServerRef[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError("mcpServers must be an array");
  return value.map(parseGrokBuildAgentMcpServerRef);
}

/** Parse the exact ACP MCP JSON shape used at native subagent spawn. */
export function parseGrokBuildAcpMcpServer(value: unknown): GrokBuildAcpMcpServer | undefined {
  if (!isRecord(value) || typeof value.name !== "string") return undefined;
  const meta = value._meta === undefined ? undefined : isRecord(value._meta) ? cloneJsonRecord(value._meta) : null;
  if (meta === null) return undefined;

  if (value.type === "http" || value.type === "sse") {
    if (typeof value.url !== "string" || !isNamedValues(value.headers)) return undefined;
    return {
      type: value.type,
      name: value.name,
      url: value.url,
      headers: cloneNamedValues(value.headers),
      ...(meta === undefined ? {} : { _meta: meta }),
    };
  }

  // ACP 0.10.4 represents stdio as an untagged variant. Serde ignores an
  // optional `type: "stdio"`, but any other tag belongs to a failed tagged arm.
  if (value.type !== undefined && value.type !== "stdio") return undefined;
  if (
    typeof value.command !== "string"
    || !isStringArray(value.args)
    || !isNamedValues(value.env)
  ) return undefined;
  return {
    type: "stdio",
    name: value.name,
    command: value.command,
    args: [...value.args],
    env: cloneNamedValues(value.env),
    ...(meta === undefined ? {} : { _meta: meta }),
  };
}

export function filterGrokBuildInheritedMcpPool<T extends { name: string }>(
  parentPool: readonly T[] | undefined,
  inheritance: GrokBuildMcpInheritance,
): T[] | undefined {
  if (parentPool === undefined || inheritance === "none") return undefined;
  if (inheritance === "all") return [...parentPool];
  if ("named" in inheritance) {
    return parentPool.filter((server) => inheritance.named.some((name) => name === server.name));
  }
  return parentPool.filter((server) => !inheritance.except.some((name) => name === server.name));
}

/**
 * Resolve an agent against snapshots captured at spawn. Inline declarations
 * are independently parsed and skipped on failure, as in native Grok Build.
 */
export function resolveGrokBuildAgentMcp(options: {
  definition: GrokBuildAgentMcpDefinition;
  parentConfigs?: readonly GrokBuildAcpMcpServer[];
  parentPool?: readonly GrokBuildAcpMcpServer[];
  projectTrusted?: boolean;
}): GrokBuildAgentMcpResolution {
  const refs = parseGrokBuildAgentMcpServerRefs(options.definition.mcpServers);
  const inheritance = parseGrokBuildMcpInheritance(options.definition.mcpInheritance);
  const inherited = filterGrokBuildInheritedMcpPool(options.parentPool, inheritance);
  const skipped: GrokBuildAgentMcpResolution["skipped"] = [];
  const owned: GrokBuildAcpMcpServer[] = [];

  const blockedReason = options.definition.pluginName !== undefined
    ? "plugin-owned" as const
    : options.definition.scope === "project" && options.projectTrusted !== true
      ? "untrusted-project" as const
      : undefined;
  if (blockedReason !== undefined) {
    for (const ref of refs) skipped.push({ name: ref.name, reason: blockedReason });
    return { owned, inherited, skipped };
  }

  const parentConfigs = options.parentConfigs ?? [];
  for (const ref of refs) {
    if (ref.kind === "named") {
      const match = parentConfigs.find((server) => server.name === ref.name);
      if (match === undefined) skipped.push({ name: ref.name, reason: "named-not-found" });
      else owned.push(cloneServer(match));
      continue;
    }
    // Native forcibly overwrites a conflicting inline name with the map key.
    const parsed = parseGrokBuildAcpMcpServer({ ...ref.config, name: ref.name });
    if (parsed === undefined) skipped.push({ name: ref.name, reason: "invalid-inline" });
    else owned.push(parsed);
  }
  return { owned, inherited, skipped };
}

/** Owned catalogs are ordered first and override inherited same-name entries. */
export function composeGrokBuildMcpCatalog<T extends { name: string }>(
  owned: readonly T[],
  inherited: readonly T[] | undefined,
  /** Native suppresses shared collisions by configured name, even if owned init failed. */
  ownedConfigNames: readonly string[] = owned.map((entry) => entry.name),
): T[] {
  const ownedNames = new Set(ownedConfigNames);
  return [...owned, ...(inherited ?? []).filter((entry) => !ownedNames.has(entry.name))];
}

function cloneServer(server: GrokBuildAcpMcpServer): GrokBuildAcpMcpServer {
  if (server.type === "stdio") {
    return {
      ...server,
      args: [...server.args],
      env: cloneNamedValues(server.env),
      ...(server._meta === undefined ? {} : { _meta: cloneJsonRecord(server._meta) }),
    };
  }
  return {
    ...server,
    headers: cloneNamedValues(server.headers),
    ...(server._meta === undefined ? {} : { _meta: cloneJsonRecord(server._meta) }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNamedValues(value: unknown): value is Array<{ name: string; value: string }> {
  return Array.isArray(value) && value.every((entry) =>
    isRecord(entry) && typeof entry.name === "string" && typeof entry.value === "string"
  );
}

function cloneNamedValues(values: readonly { name: string; value: string }[]): Array<{ name: string; value: string }> {
  return values.map(({ name, value }) => ({ name, value }));
}

function cloneJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(value);
}
