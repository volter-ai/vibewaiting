/**
 * Browser-representable input validation copied from Grok Build's Bash tool.
 * Keep this separate from process execution: the latter is intentionally an
 * AlmostNode adapter, while these rules are part of the model-facing contract.
 */

const EXACT_FLOAT_INTEGER_LIMIT = 9_007_199_254_740_992;
const SELF_MATCHING_PROCESS = /(?:^|[;&|(\n])\s*(?<cmd>pkill|pgrep)(?<args>(?:\s+-[A-Za-z]*f[A-Za-z]*|\s+--full\b)+)\s+(?:'(?<sq>[^']*)'|"(?<dq>[^"]*)"|(?<bare>[^\s;&|()]+))/gmu;
const KILL_TOKEN = /(?:^|[\s;&|()])kill(?:\s|$)/u;

/** Port of `deserialize_lenient_u64`: number or numeric string, whole + finite. */
export function parseGrokLenientU64(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error(`expected number, got ${JSON.stringify(value)}`);
  }
  if (typeof value === "string" && value.trim() !== value) {
    throw new Error(`expected number, got string ${JSON.stringify(value)}`);
  }
  if (typeof value === "string" && !/^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|inf(?:inity)?|nan)$/iu.test(value)) {
    throw new Error(`expected number, got string ${JSON.stringify(value)}`);
  }
  const normalized = typeof value === "string"
    ? value.replace(/^\+?inf$/iu, "Infinity").replace(/^-inf$/iu, "-Infinity")
    : value;
  const parsed = typeof normalized === "number" ? normalized : Number(normalized);
  if (!Number.isFinite(parsed)) throw new Error("expected finite number");
  if (!Number.isInteger(parsed)) throw new Error(`expected whole number, got ${parsed}`);
  if (Math.abs(parsed) > EXACT_FLOAT_INTEGER_LIMIT) {
    throw new Error(`number ${parsed} exceeds f64 integer precision (whole floats above ${EXACT_FLOAT_INTEGER_LIMIT} may be inaccurate)`);
  }
  if (parsed < 0) throw new Error("expected non-negative number");
  return parsed;
}

/** Return native's rejection for the wrapper-killing pkill/pgrep footgun. */
export function selfMatchingPkillError(command: string): string | undefined {
  SELF_MATCHING_PROCESS.lastIndex = 0;
  for (const match of command.matchAll(SELF_MATCHING_PROCESS)) {
    const pattern = match.groups?.sq ?? match.groups?.dq ?? match.groups?.bare;
    if (!pattern || pattern.length < 3 || /\$\(|\$`|^`|\$\{/u.test(pattern)) continue;
    const start = match.index ?? 0;
    const rest = `${command.slice(0, start)}\n${command.slice(start + match[0].length)}`;
    const executable = match.groups?.cmd;
    if (executable === "pgrep" && !KILL_TOKEN.test(rest)) continue;
    if (!rest.includes(pattern)) continue;
    return `self-matching ${executable}/-f: \`${executable} -f <pat>\` matches against the full /proc/PID/cmdline of every process, including the bash wrapper that runs this command (its argv contains \`${pattern}\`). The wrapper would be killed by the resulting signal before the rest of the script runs. Use one of: \`pkill -x <basename>\` (no \`-f\`), \`pgrep -f <pat> | xargs -r kill\` invoked from a separate command, a fully-qualified path that does not appear later in the script, or kill by PID file.`;
  }
  return undefined;
}
