import type { GrokBuildSkillInfo } from "./grok-build-skills.js";

export interface GrokBuildSlashAvailability {
  feedback?: boolean;
  memory?: boolean;
  memoryConfigured?: boolean;
  scheduler?: boolean;
  hooks?: boolean;
  plugins?: boolean;
  goal?: boolean;
  workflows?: boolean;
  workflowManagement?: boolean;
}

export interface GrokBuildSlashWorkflow {
  name: string;
  description: string;
  source?: string;
  path?: string;
}

export interface GrokBuildAvailableCommand {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: readonly string[];
  provenance: "builtin" | "skill" | "workflow";
  skill?: GrokBuildSkillInfo;
  workflow?: GrokBuildSlashWorkflow;
}

export type GrokBuildBuiltinSlashAction =
  | { type: "compact"; userContext?: string }
  | { type: "set-yolo"; enabled: boolean }
  | { type: "flush-memory" }
  | { type: "dream" }
  | { type: "memory-browse" }
  | { type: "memory-toggle"; enabled: boolean }
  | { type: "context-info" }
  | { type: "hooks-trust" }
  | { type: "hooks-list" }
  | { type: "hooks-add"; path: string }
  | { type: "hooks-remove"; path: string }
  | { type: "hooks-untrust" }
  | { type: "plugins-list" }
  | { type: "plugins-reload" }
  | { type: "plugins-trust" }
  | { type: "plugins-add"; path: string }
  | { type: "plugins-remove"; path: string }
  | { type: "plugins-install"; source: string; trust: boolean }
  | { type: "plugins-uninstall"; name: string; confirm: boolean }
  | { type: "plugins-update"; name?: string }
  | { type: "session-info" }
  | { type: "feedback"; text: string }
  | { type: "deep-research"; query: string }
  | { type: "workflow-manage"; runId: string; operation: string }
  | { type: "workflow-launch"; name: string; input: string }
  | { type: "goal-set"; objective: string; tokenBudget?: number }
  | { type: "goal-status" }
  | { type: "goal-pause" }
  | { type: "goal-resume" }
  | { type: "goal-clear" };

export type GrokBuildSlashResolution =
  | { type: "passthrough"; text: string }
  | { type: "builtin"; commandName: string; action: GrokBuildBuiltinSlashAction }
  | { type: "loop-prompt"; commandName: "loop"; text: string; displayText: string }
  | { type: "skill"; text: string; references: GrokBuildSlashSkillReference[] };

export interface GrokBuildSlashSkillReference {
  name: string;
  args: string;
  skillPath: string;
  qualifiedName: string;
  skill: GrokBuildSkillInfo;
}

type Gate = "always" | keyof GrokBuildSlashAvailability;
interface BuiltinSpec {
  name: string;
  description: string;
  argumentHint?: string;
  aliases: readonly string[];
  gate: Gate;
  resolve(args: string): GrokBuildBuiltinSlashAction;
}

const BUILTINS: readonly BuiltinSpec[] = [
  command("compact", "Compress conversation history to save context window", "optional context about what to preserve", [], "always", (args) => ({ type: "compact", ...(args ? { userContext: args } : {}) })),
  command("always-approve", "Toggle always-approve mode (skip all permission prompts)", "on|off", ["yolo"], "always", (args) => ({ type: "set-yolo", enabled: !["off", "false", "0", "no", "disable"].includes(args.toLowerCase()) })),
  command("flush", "Flush conversation memory to disk now", undefined, [], "memory", () => ({ type: "flush-memory" })),
  command("dream", "Run memory consolidation (merge session logs into organized topics)", undefined, [], "memory", () => ({ type: "dream" })),
  command("memory", "Browse, view, and manage your memories", "on|off", ["mem"], "memoryConfigured", (args) => {
    const value = args.trim().toLowerCase();
    if (["on", "enable"].includes(value)) return { type: "memory-toggle", enabled: true };
    if (["off", "disable"].includes(value)) return { type: "memory-toggle", enabled: false };
    return { type: "memory-browse" };
  }),
  command("context", "Show context window usage and session stats", undefined, [], "always", () => ({ type: "context-info" })),
  command("hooks-trust", "Trust this project for hook execution", undefined, [], "hooks", () => ({ type: "hooks-trust" })),
  command("hooks-list", "Show hooks loaded in this session", undefined, [], "hooks", () => ({ type: "hooks-list" })),
  command("hooks-add", "Add a custom hook file or directory", "path to hook file or directory", [], "hooks", (args) => ({ type: "hooks-add", path: args.trim() })),
  command("hooks-remove", "Remove a custom hook file or directory path", "path to hook file or directory", [], "hooks", (args) => ({ type: "hooks-remove", path: args.trim() })),
  command("hooks-untrust", "Remove trust for the current project", undefined, [], "hooks", () => ({ type: "hooks-untrust" })),
  command("plugins", "Manage plugins (list, reload, trust, add, remove)", "list | reload | trust <path> | add <path> | remove <path>", ["plugin"], "plugins", resolvePlugins),
  command("reload-plugins", "Reload plugins from disk (alias for /plugins reload)", undefined, [], "plugins", () => ({ type: "plugins-reload" })),
  command("session-info", "Show session details (model, turns, context usage)", undefined, ["status", "info"], "always", () => ({ type: "session-info" })),
  command("feedback", "Send feedback about the current session", "feedback text", [], "feedback", (args) => ({ type: "feedback", text: args.trim() })),
  command("deep-research", "Research with bounded parallel agents, cross-check evidence, and write a cited report", "<query>", [], "workflows", (args) => ({ type: "deep-research", query: args.trim() })),
  command("workflow", "Launch a saved workflow, list runs, or manage a run (pause, resume, stop, save)", "<name> [--agent-budget N] [--effort LEVEL] [args] | runs | pause|resume|stop|save [name]", [], "workflowManagement", resolveWorkflow),
  command("goal", "Set, manage, or check an autonomous goal", "<objective> [--budget <tokens>] | status | pause | resume | clear", [], "goal", resolveGoal),
] as const;

const LOOP: BuiltinSpec = command("loop", "Run a prompt on a recurring interval", "[interval] <prompt>", [], "scheduler", () => { throw new Error("loop uses its prompt expansion path"); });

// Copied from native PAGER_COMMAND_KEYS. These names force colliding skills to
// use their scope-qualified spelling even when this browser has no TUI-only
// implementation for the pager command yet.
const PAGER_COMMAND_KEYS = new Set([
  "agents", "agents-dashboard", "always-approve", "announcements", "auto", "btw", "cd", "changelog", "chat", "clear", "cloud", "compact", "compact-mode", "config", "config-agents", "context", "copy", "cost", "dashboard", "debug", "delete", "docs", "doctor", "edit-prompt", "effort", "exit", "expand", "export", "feedback", "find", "fork", "full", "fullscreen", "gboom", "guides", "help", "history", "home", "hooks", "hooks-add", "hooks-list", "hooks-remove", "hooks-trust", "hooks-untrust", "howto", "imagine", "imagine-video", "import-claude", "jump", "login", "logout", "log", "loop", "m", "marketplace", "mcps", "minimal", "ml", "model", "multiline", "new", "onboarding", "personas", "plan", "plan-view", "plugin", "plugins", "preferences", "prefs", "privacy", "queue", "quit", "recap", "release-notes", "reload-plugins", "remember", "rename", "resume", "rewind", "scroll-debug", "session-info", "sessions", "settings", "share", "show-plan", "skills", "summarize", "tasks", "terminal-check", "terminal-info", "terminal-setup", "theme", "timeline", "timestamps", "title", "toggle-mouse-reporting", "tour", "transcript", "tutorial", "t", "undo", "usage", "view-plan", "vim-mode", "voice", "welcome", "workflow", "workflows", "yolo",
]);

export function grokBuildAvailableCommands(
  availability: GrokBuildSlashAvailability,
  skills: readonly GrokBuildSkillInfo[] = [],
  workflows: readonly GrokBuildSlashWorkflow[] = [],
): GrokBuildAvailableCommand[] {
  const builtins = [...BUILTINS, LOOP].filter((entry) => gateEnabled(entry.gate, availability));
  const output: GrokBuildAvailableCommand[] = builtins.map((entry) => ({
    name: entry.name, description: entry.description, ...(entry.argumentHint ? { argumentHint: entry.argumentHint } : {}),
    ...(entry.aliases.length ? { aliases: entry.aliases } : {}), provenance: "builtin",
  }));
  const catalog = effectiveSkillCatalog(skills, builtins);
  output.push(...catalog.commands.map(({ name, skill }) => ({ name, description: skill.description, provenance: "skill" as const, skill })));
  const counts = countBy(workflows, (workflow) => slashKey(workflow.name));
  for (const workflow of workflows) {
    const key = slashKey(workflow.name);
    if (!availability.workflows || counts.get(key) !== 1 || catalog.taken.has(key)) continue;
    output.push({ name: workflow.name, description: `Workflow: ${workflow.description}`, argumentHint: "[--agent-budget N] [--effort LEVEL] [args]", provenance: "workflow", workflow });
  }
  return output;
}

export function resolveGrokBuildSlash(
  text: string,
  availability: GrokBuildSlashAvailability,
  skills: readonly GrokBuildSkillInfo[] = [],
  workflows: readonly GrokBuildSlashWorkflow[] = [],
  loopMode: "detached" | "in-session" = "detached",
): GrokBuildSlashResolution {
  const parsed = parseSlashPrefix(text);
  if (!parsed) return { type: "passthrough", text };
  const [typedName, args] = parsed;
  const key = slashKey(typedName);
  if (key === LOOP.name && gateEnabled(LOOP.gate, availability)) {
    return { type: "loop-prompt", commandName: "loop", text: grokBuildLoopInstruction(args, loopMode), displayText: args ? `/${typedName} ${args}` : `/${typedName}` };
  }
  const builtins = BUILTINS.filter((entry) => gateEnabled(entry.gate, availability));
  const builtin = builtins.find((entry) => slashKey(entry.name) === key || entry.aliases.some((alias) => slashKey(alias) === key));
  if (builtin) {
    const action = builtin.resolve(args);
    if (action.type === "workflow-launch" && !availability.workflows) return { type: "passthrough", text };
    return { type: "builtin", commandName: builtin.name, action };
  }
  const catalog = effectiveSkillCatalog(skills, [...builtins, ...(gateEnabled(LOOP.gate, availability) ? [LOOP] : [])]);
  const references = parseSkillReferences(text, catalog);
  if (references.length) return { type: "skill", text, references };
  if (availability.workflows) {
    const matches = workflows.filter((workflow) => slashKey(workflow.name) === key && !catalog.taken.has(key));
    if (matches.length === 1) return { type: "builtin", commandName: "workflow", action: { type: "workflow-launch", name: matches[0]!.name, input: args } };
  }
  return { type: "passthrough", text };
}

function command(name: string, description: string, argumentHint: string | undefined, aliases: readonly string[], gate: Gate, resolve: BuiltinSpec["resolve"]): BuiltinSpec {
  return { name, description, ...(argumentHint ? { argumentHint } : {}), aliases, gate, resolve };
}

function gateEnabled(gate: Gate, availability: GrokBuildSlashAvailability): boolean {
  if (gate === "always") return true;
  if (gate === "workflowManagement") return availability.workflows === true || availability.workflowManagement === true;
  return availability[gate] === true;
}

function slashKey(value: string): string { return value.toLowerCase(); }

function parseSlashPrefix(text: string): [string, string] | undefined {
  const withoutSlash = text.trim().startsWith("/") ? text.trim().slice(1) : undefined;
  if (withoutSlash === undefined) return;
  const boundary = withoutSlash.search(/\s/u);
  const name = boundary < 0 ? withoutSlash : withoutSlash.slice(0, boundary);
  if (!name) return;
  return [name, boundary < 0 ? "" : withoutSlash.slice(boundary).trim()];
}

function resolvePlugins(args: string): GrokBuildBuiltinSlashAction {
  const trimmed = args.trim();
  if (!trimmed || trimmed === "list") return { type: "plugins-list" };
  if (trimmed === "reload") return { type: "plugins-reload" };
  if (trimmed.startsWith("trust")) return { type: "plugins-trust" };
  if (trimmed.startsWith("add ")) return { type: "plugins-add", path: trimmed.slice(4).trim() };
  if (trimmed.startsWith("remove ")) return { type: "plugins-remove", path: trimmed.slice(7).trim() };
  if (trimmed.startsWith("install ")) {
    const value = trimmed.slice(8).trim();
    const trust = value.endsWith(" --trust") || value === "--trust";
    return { type: "plugins-install", source: trust ? value.replace(/ --trust$/u, "").trim() : value, trust };
  }
  if (trimmed.startsWith("uninstall ")) {
    const value = trimmed.slice(10).trim();
    const confirm = value.endsWith(" --confirm") || value === "--confirm";
    return { type: "plugins-uninstall", name: confirm ? value.replace(/ --confirm$/u, "").trim() : value, confirm };
  }
  if (trimmed === "update") return { type: "plugins-update" };
  if (trimmed.startsWith("update ")) return { type: "plugins-update", name: trimmed.slice(7).trim() };
  return { type: "plugins-list" };
}

function resolveWorkflow(args: string): GrokBuildBuiltinSlashAction {
  const trimmed = args.trim();
  const parts = trimmed.split(/\s+/u).filter(Boolean);
  const first = parts[0] ?? "";
  const second = parts[1] ?? "";
  const operations = new Set(["pause", "resume", "stop", "save"]);
  const firstOperation = operations.has(first.toLowerCase());
  const runs = first.toLowerCase() === "runs" && !second;
  const secondFinalOperation = operations.has(second.toLowerCase()) && parts.length === 2;
  if (!first || firstOperation || runs || secondFinalOperation) {
    if (firstOperation) return { type: "workflow-manage", runId: trimmed.slice(first.length).trimStart(), operation: first.toLowerCase() };
    if (runs) return { type: "workflow-manage", runId: "", operation: "runs" };
    if (secondFinalOperation) return { type: "workflow-manage", runId: first, operation: second.toLowerCase() };
    return { type: "workflow-manage", runId: "", operation: "" };
  }
  return { type: "workflow-launch", name: first, input: trimmed.slice(first.length).trimStart() };
}

function resolveGoal(args: string): GrokBuildBuiltinSlashAction {
  const trimmed = args.trim();
  switch (trimmed.toLowerCase()) {
    case "": case "status": return { type: "goal-status" };
    case "pause": return { type: "goal-pause" };
    case "resume": return { type: "goal-resume" };
    case "clear": return { type: "goal-clear" };
  }
  const parsed = /^(?<objective>.+\S)\s+--budget\s+(?<budget>\d+)$/u.exec(trimmed);
  const tokenBudget = parsed?.groups?.budget ? Number(parsed.groups.budget) : undefined;
  if (parsed?.groups?.objective && Number.isSafeInteger(tokenBudget) && tokenBudget! > 0) return { type: "goal-set", objective: parsed.groups.objective, tokenBudget: tokenBudget! };
  return { type: "goal-set", objective: trimmed };
}

interface EffectiveSkillCatalog {
  commands: Array<{ name: string; skill: GrokBuildSkillInfo }>;
  taken: Set<string>;
}

function effectiveSkillCatalog(skills: readonly GrokBuildSkillInfo[], builtins: readonly BuiltinSpec[]): EffectiveSkillCatalog {
  const taken = new Set([...PAGER_COMMAND_KEYS, ...builtins.flatMap((entry) => [entry.name, ...entry.aliases])].map(slashKey));
  const candidates = skills.filter((skill) => skill.enabled);
  const bareCounts = countBy(candidates, (skill) => slashKey(skill.name));
  const qualifiedCounts = countBy(candidates, (skill) => slashKey(qualifiedSkillName(skill)));
  const commands: EffectiveSkillCatalog["commands"] = [];
  for (const skill of candidates) {
    const bare = slashKey(skill.name);
    const qualified = slashKey(qualifiedSkillName(skill));
    const name = bareCounts.get(bare) === 1 && !taken.has(bare) ? bare
      : qualifiedCounts.get(qualified) === 1 && !taken.has(qualified) ? qualified
        : undefined;
    if (!name) continue;
    taken.add(name);
    commands.push({ name, skill });
  }
  for (const bare of bareCounts.keys()) taken.add(bare);
  return { commands, taken };
}

function parseSkillReferences(text: string, catalog: EffectiveSkillCatalog): GrokBuildSlashSkillReference[] {
  const trimmed = text.trim();
  const hits: Array<{ offset: number; typedName: string; skill: GrokBuildSkillInfo }> = [];
  const expression = /(?:^|\s)\/(?<name>\S+)/gu;
  for (const match of trimmed.matchAll(expression)) {
    const typedName = match.groups?.name;
    if (!typedName) continue;
    const offset = (match.index ?? 0) + (match[0].startsWith("/") ? 0 : match[0].indexOf("/"));
    const key = slashKey(typedName);
    let entry = catalog.commands.find((candidate) => candidate.name === key);
    if (!entry && offset === 0) entry = catalog.commands.find((candidate) => slashKey(qualifiedSkillName(candidate.skill)) === key);
    if (entry) hits.push({ offset, typedName, skill: entry.skill });
  }
  return hits.map((hit, index) => {
    const wordEnd = hit.offset + 1 + hit.typedName.length;
    const argsEnd = hits[index + 1]?.offset ?? trimmed.length;
    return {
      name: hit.typedName,
      args: trimmed.slice(wordEnd, argsEnd).trim(),
      skillPath: hit.skill.path,
      qualifiedName: qualifiedSkillName(hit.skill),
      skill: hit.skill,
    };
  });
}

function qualifiedSkillName(skill: GrokBuildSkillInfo): string { return `${skill.scope}:${skill.name}`; }

function countBy<T>(values: readonly T[], key: (value: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(key(value), (counts.get(key(value)) ?? 0) + 1);
  return counts;
}

export function grokBuildLoopInstruction(args: string, mode: "detached" | "in-session"): string {
  if (!args.trim()) return "Usage: /loop [interval] <prompt>\nExample: /loop 30m check deploy status\nExample: /loop check deploy status every hour\n\nTell me how often it should run (e.g. 30m, 1 hour, every 2 days).";
  const fireContext = mode === "detached"
    ? "Each fire runs in a detached background subagent, not in this conversation,\nso the prompt you store must stand on its own.\n\n## Writing a prompt that survives a fresh fire\n- Inline the state a fire needs: paths, job/PR/branch ids, the command that checks\n  status, and what \"healthy\" looks like. A fire cannot see this conversation, and\n  a long-running task restarts from a short summary every few iterations.\n- Only a short status comes back here, so say what that status must contain."
    : "Each fire arrives as a new turn in this conversation, and earlier results from\nthe same task may still be above it. The stored prompt is re-sent verbatim every\ntime, so write a standing order rather than a one-off request.\n\n## Writing a prompt that reads well on every fire\n- Name the state that must not be guessed: paths, job/PR/branch ids, the command\n  that checks status, and what \"healthy\" looks like. This conversation is\n  compacted as it grows, so do not rely on details staying visible.\n- Earlier fires may be above you: continue from them instead of restarting.";
  return `# /loop -- schedule a recurring prompt\n\nTurn the input below into a scheduler_create call. ${fireContext}\n- Say what one fire does and when it bails: \"if still pending, report one line and\n  stop.\" A fire must not poll inline.\n- Give it a stop condition and an exit: \"when <condition> holds, report it and call\n  scheduler_delete <task_id>.\" Without that the loop runs until it expires.\n- Keep it short and concrete -- the stored prompt is re-sent on every fire.\n\n## Deriving the interval\nConvert the user's cadence -- however phrased, at either end of the request -- into a\ncompact \`<number><unit>\` string (\`s\`/\`m\`/\`h\`/\`d\`); the remaining text is the prompt.\nThe minimum is 60 seconds and shorter values are raised, so say so when it applies.\nIf no cadence is given, ask the user how often it should run -- never invent one.\n\n## Action\nSchedule from what the user already gave you — do not explore the workspace or run\nchecks before scheduling; the first fire does that.\n1. Call scheduler_create with the interval, the prompt, and fire_immediately: true.\n   If the interval is rejected, fix the string rather than guessing.\n2. Confirm what's scheduled, the cadence, its stop condition, that it auto-expires\n   after 7 days, and the task_id to cancel with scheduler_delete.\n3. Do NOT execute the prompt inline. The scheduler fires it immediately.\n\n## Wrong tool for the job\n- \"Tell me when X finishes\" -> a background command or watch tool that wakes you on\n  the event, not a recurring loop that re-checks on a timer.\n- \"Do X once in N minutes\" -> background \`sleep <secs> && <command>\`; scheduling is\n  recurring-only.\n\n## Changing an existing loop\nCall scheduler_create with its task_id and only the changed fields; do not\ndelete and recreate. If later work changes what a loop should do, update its\nprompt the same way.\n\n## Input\n${args}`;
}
