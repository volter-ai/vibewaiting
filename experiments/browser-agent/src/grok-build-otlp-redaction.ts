/** Source-faithful privacy chokepoint for browser-produced internal OTLP spans. */

export type GrokBuildOtlpScalar = string | boolean | number | bigint;
export type GrokBuildOtlpValue = GrokBuildOtlpScalar | string[] | boolean[] | number[];

export interface GrokBuildOtlpAttribute {
  key: string;
  value: GrokBuildOtlpValue;
}

export interface GrokBuildOtlpEvent {
  timeUnixNano: bigint;
  name: string;
  attributes: GrokBuildOtlpAttribute[];
  droppedAttributesCount?: number;
}

export interface GrokBuildOtlpLink {
  traceId: Uint8Array;
  spanId: Uint8Array;
  traceState?: string;
  attributes: GrokBuildOtlpAttribute[];
  droppedAttributesCount?: number;
  flags?: number;
}

export interface GrokBuildOtlpSpan {
  traceId: Uint8Array;
  spanId: Uint8Array;
  parentSpanId?: Uint8Array;
  traceState?: string;
  flags?: number;
  name: string;
  kind?: 0 | 1 | 2 | 3 | 4 | 5;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  attributes: GrokBuildOtlpAttribute[];
  droppedAttributesCount?: number;
  events?: GrokBuildOtlpEvent[];
  droppedEventsCount?: number;
  links?: GrokBuildOtlpLink[];
  droppedLinksCount?: number;
  status?: { code: 0 | 1 | 2; message?: string };
}

export interface GrokBuildOtlpRedactionContext {
  /** Browser VFS home, when one exists. Native reads HOME/USERPROFILE. */
  homePath?: string;
  /** Browser VFS user names. Native reads USERNAME/USER. */
  usernames?: readonly string[];
}

// Independent source pin from xai-grok-telemetry/src/otel_layer/redact.rs.
export const GROK_BUILD_OTLP_ALLOWED_STRING_KEYS = [
  "level", "target", "code.namespace", "code.filepath", "thread.name",
  "session_id", "prompt_id", "req_id", "request_id", "child_session_id",
  "parent_session_id", "subagent_id", "agent_id", "task_id", "tool_call_id",
  "call_id", "event_id", "conv_id", "turn_id", "model_id", "model",
  "compact_model", "client_type", "client_version", "subagent_type", "persona",
  "role", "skill_name", "server_name", "tool_name", "tool_names", "method",
  "operation", "endpoint", "path", "file_path", "repo_path", "gcs_path",
  "gcs_url", "url", "output_path", "dir", "dir_path", "notebook", "cwd",
  "original_cwd", "chosen_repo_root", "worktree", "source", "bucket_url",
  "object_path", "archive_name", "artifact", "verdict", "pattern_class", "phase",
  "upload_reason", "suppress_reason", "error_kind", "error_category", "error_type",
  "outcome", "decision", "update_type", "kind", "step", "token_type",
  "stop_reason", "compaction_outcome", "compaction_stop_reason", "compaction_trigger",
  "compaction_prefire_outcome", "aspect_ratio", "resolution", "schedule", "interval",
  "mode", "detail", "status", "action", "auth_method", "to_mode", "trigger",
  "survey_type", "mention_type", "install_kind", "transport_type", "invocation_trigger",
  "skill_source", "plugin_name", "plugin_version", "plugin_scope", "hook_event",
  "hook_name", "hook_type", "hook_source", "server_scope", "mcp_server.name",
  "mcp_tool.name", "agent.name", "skill.name", "query_source", "effort", "start_type",
  "error", "location", "user_id", "parent_agent_id", "from_mode", "tool_use_id",
  "command_name", "command_source", "event_type", "appearance_id", "terminal.brand",
  "terminal.multiplexer", "terminal.tmux_version", "terminal.term_var",
  "terminal.term_version", "terminal.term_version_source", "skip_reason",
  "auto_cadence_reason",
] as const;

const ALLOWED_KEYS = new Set<string>(GROK_BUILD_OTLP_ALLOWED_STRING_KEYS);
const URL_KEYS = new Set(["url", "endpoint", "gcs_url", "bucket_url"]);
const SENSITIVE_QUERY_PARAMS = new Set([
  "access_token", "api_key", "assertion", "auth", "client_secret", "code",
  "code_verifier", "id_token", "key", "password", "refresh_token",
  "requested_token", "session_id", "state", "subject_token", "token",
]);

/** Clone and redact every text-bearing span surface before protobuf encoding. */
export function redactGrokBuildOtlpSpan(
  input: GrokBuildOtlpSpan,
  context: GrokBuildOtlpRedactionContext = {},
): GrokBuildOtlpSpan {
  const span: GrokBuildOtlpSpan = {
    ...input,
    traceId: input.traceId.slice(),
    spanId: input.spanId.slice(),
    ...(input.parentSpanId === undefined ? {} : { parentSpanId: input.parentSpanId.slice() }),
    name: redactGrokBuildTelemetryString(input.name, context),
    attributes: scrubAttributes(input.attributes, context),
    ...(input.events === undefined ? {} : {
      events: input.events.map((event) => ({
        ...event,
        name: redactGrokBuildTelemetryString(eventCallsiteName(event), context),
        attributes: scrubAttributes(event.attributes, context),
      })),
    }),
    ...(input.links === undefined ? {} : {
      links: input.links.map((link) => ({
        ...link,
        traceId: link.traceId.slice(),
        spanId: link.spanId.slice(),
        attributes: scrubAttributes(link.attributes, context),
      })),
    }),
  };
  if (span.status?.code === 2 && span.status.message !== undefined) {
    span.status = {
      code: 2,
      message: redactGrokBuildTelemetryString(span.status.message, context),
    };
  }
  return span;
}

export function scrubGrokBuildOtlpAttributes(
  attributes: readonly GrokBuildOtlpAttribute[],
  context: GrokBuildOtlpRedactionContext = {},
): GrokBuildOtlpAttribute[] {
  return scrubAttributes(attributes, context);
}

export function redactGrokBuildTelemetryString(
  input: string,
  context: GrokBuildOtlpRedactionContext = {},
): string {
  return redactUserPaths(redactSecrets(input), context);
}

function scrubAttributes(
  attributes: readonly GrokBuildOtlpAttribute[],
  context: GrokBuildOtlpRedactionContext,
): GrokBuildOtlpAttribute[] {
  const output: GrokBuildOtlpAttribute[] = [];
  for (const attribute of attributes) {
    if (isContentValue(attribute.value) && !ALLOWED_KEYS.has(attribute.key)) continue;
    let value = cloneValue(attribute.value);
    if (URL_KEYS.has(attribute.key) && typeof value === "string") value = urlOrigin(value);
    if (typeof value === "string") value = redactGrokBuildTelemetryString(value, context);
    else if (isStringArray(value)) value = value.map((item) => redactGrokBuildTelemetryString(item, context));
    output.push({ key: attribute.key, value });
  }
  return output;
}

function eventCallsiteName(event: GrokBuildOtlpEvent): string {
  const file = event.attributes.find(({ key, value }) => key === "code.filepath" && typeof value === "string")?.value;
  const line = event.attributes.find(({ key, value }) => key === "code.lineno" && typeof value === "number")?.value;
  if (typeof file !== "string") return "event";
  return typeof line === "number" && Number.isInteger(line) ? `${file}:${line}` : file;
}

function isContentValue(value: GrokBuildOtlpValue): boolean {
  return typeof value === "string" || isStringArray(value);
}

function cloneValue(value: GrokBuildOtlpValue): GrokBuildOtlpValue {
  if (!Array.isArray(value)) return value;
  if (value.every((item) => typeof item === "string")) return [...value] as string[];
  if (value.every((item) => typeof item === "boolean")) return [...value] as boolean[];
  return [...value] as number[];
}

function isStringArray(value: GrokBuildOtlpValue): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function urlOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.host === "") return value;
    return `${url.protocol}//${url.host}`;
  } catch {
    return value;
  }
}

function redactSecrets(input: string): string {
  let output = input
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----/gsu, "[REDACTED_SECRET]")
    .replace(/\b(?:sk[-_]|xai-)[A-Za-z0-9_-]{20,}/gu, "[REDACTED_SECRET]")
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu, "[REDACTED_SECRET]")
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/gu, "[REDACTED_SECRET]")
    .replace(/\b(?:glpat-|xox[abp]-|xapp-)[A-Za-z0-9-]{10,}/gu, "[REDACTED_SECRET]")
    .replace(/\bAIza[0-9A-Za-z_-]{35}/gu, "[REDACTED_SECRET]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{16,}\b/giu, "Bearer [REDACTED_SECRET]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED_SECRET]");
  output = output.replace(/https?:\/\/[^\s"'<>(){}\[\],;`]+/gu, redactSensitiveUrl);
  return output.replace(
    /\b(api[_-]?key|(?:access|refresh|id)[_-]token|token|secret|client[_-]secret|password)\b(\s*[:=]\s*)(["']?)[^\s"',&]{8,}/giu,
    "$1$2$3[REDACTED_SECRET]",
  );
}

function redactSensitiveUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.hash = "";
    if (url.search !== "") {
      const scrubbed = new URLSearchParams();
      for (const [key, value] of url.searchParams) {
        scrubbed.append(key, SENSITIVE_QUERY_PARAMS.has(key.toLowerCase()) ? "redacted" : value);
      }
      url.search = scrubbed.toString();
    }
    return url.toString();
  } catch {
    return raw;
  }
}

function redactUserPaths(input: string, context: GrokBuildOtlpRedactionContext): string {
  const home = context.homePath?.trim();
  const usernames = (context.usernames ?? []).filter((name) => name.trim().length >= 3);
  let output = home ? replaceWholeSegment(input, home, "~") : input;
  for (const username of usernames) output = replacePathSegment(output, username, "<user>");
  if (!home && usernames.length === 0) {
    output = output.replace(/([/\\](?:Users|home)[/\\])([^/\\]+)/gu, "$1<user>");
  }
  return output;
}

function replaceWholeSegment(input: string, needle: string, replacement: string): string {
  let offset = 0;
  let output = "";
  for (;;) {
    const index = input.indexOf(needle, offset);
    if (index < 0) return output + input.slice(offset);
    const before = input[index - 1];
    const after = input[index + needle.length];
    output += input.slice(offset, index);
    output += isBoundary(before) && isBoundary(after) ? replacement : needle;
    offset = index + needle.length;
  }
}

function replacePathSegment(input: string, segment: string, replacement: string): string {
  let output = "";
  let token = "";
  for (const character of input) {
    if (!isBoundary(character)) {
      token += character;
      continue;
    }
    output += token === segment ? replacement : token;
    token = "";
    output += character;
  }
  return output + (token === segment ? replacement : token);
}

function isBoundary(value: string | undefined): boolean {
  return value === undefined || !/[\p{L}\p{N}_.-]/u.test(value);
}
