export type GrokParityLevel = "exact" | "source-ported" | "provider-native" | "partial";

export interface GrokToolParity {
  owner: "browser" | "relay" | "xai-provider";
  level: GrokParityLevel;
  evidence: readonly string[];
  gap?: string;
}

export interface GrokSystemParity {
  level: GrokParityLevel;
  evidence: readonly string[];
  gap?: string;
}

/** Agent-wide behavior that cannot be represented by one tool-registry row. */
export const GROK_BUILD_SYSTEM_PARITY = {
  system_prompt: {
    level: "exact",
    evidence: ["src/grok-build-system-prompt.generated.txt", "test/grok-conformance.test.ts"],
  },
  responses_transport: {
    level: "exact",
    evidence: ["test/fixtures/grok-conformance/native-pong-complete-v1.jsonl", "e2e/browser-agent.e2e.mjs"],
  },
  compaction: {
    level: "exact",
    evidence: ["test/fixtures/grok-conformance/native-auto-compaction-v1.jsonl", "test/grok-build-agent.test.ts"],
  },
  startup_models: {
    level: "source-ported",
    evidence: ["test/grok-build-bootstrap.test.ts", "test/grok-relay.test.ts"],
    gap: "Needs a fail-closed native startup replay corpus before promotion to exact.",
  },
  startup_settings: {
    level: "source-ported",
    evidence: ["test/grok-build-bootstrap.test.ts", "test/grok-relay.test.ts"],
    gap: "Needs failure-path and post-auth re-apply traffic corpora before promotion to exact.",
  },
  published_bundle_cache: {
    level: "source-ported",
    evidence: ["test/fixtures/grok-conformance/native-auto-compaction-v1.jsonl", "test/grok-build-bundle.test.ts", "test/grok-relay.test.ts"],
    gap: "The real archive and source semantics are covered, but native legacy/failure traffic corpora are still required before promotion to exact.",
  },
  skill_discovery: {
    level: "source-ported",
    evidence: ["test/grok-build-skills.test.ts", "test/grok-build-agent.test.ts"],
    gap: "Startup discovery and listing are ported; path-gated activation and directory-triggered mid-session discovery remain unported.",
  },
  bundled_agents: {
    level: "source-ported",
    evidence: ["test/grok-build-bundle.test.ts", "test/grok-build-agents.test.ts", "test/grok-build-agent.test.ts"],
    gap: "Built-in/project/bundled definition precedence and full prompts are ported; extend-mode custom definitions and native fork/persona/role layering remain incomplete.",
  },
  bundled_workflows: {
    level: "partial",
    evidence: ["test/grok-build-bundle.test.ts"],
    gap: "Published Rhai workflows are cached, but the browser Rhai runtime and workflow listing/execution are not ported yet.",
  },
  telemetry_and_feedback: {
    level: "partial",
    evidence: ["test/fixtures/grok-conformance/native-pong-complete-v1.jsonl"],
    gap: "Native feedback config, signals, and trace traffic are recorded but intentionally not emitted by the browser port yet.",
  },
} as const satisfies Record<string, GrokSystemParity>;

/**
 * Auditable coverage for every entry in the captured Grok Build tool registry.
 * The release gate treats both `partial` and `source-ported` as unfinished.
 * Source translation is implementation evidence, not corpus proof.
 */
export const GROK_BUILD_TOOL_PARITY = {
  run_terminal_command: { owner: "browser", level: "source-ported", evidence: ["test/grok-build-runtime.test.ts"] },
  read_file: {
    owner: "browser",
    level: "partial",
    evidence: ["test/grok-build-runtime.test.ts"],
    gap: "PDF, PPTX, notebook, and multimodal image output are not yet native-equivalent.",
  },
  search_replace: { owner: "browser", level: "source-ported", evidence: ["test/grok-build-runtime.test.ts"] },
  list_dir: { owner: "browser", level: "source-ported", evidence: ["test/grok-build-runtime.test.ts"] },
  grep: { owner: "browser", level: "source-ported", evidence: ["test/grok-build-runtime.test.ts"] },
  kill_command_or_subagent: {
    owner: "browser",
    level: "partial",
    evidence: ["test/grok-build-runtime.test.ts"],
    gap: "Native UUID task identity and graceful TERM-to-KILL timing are not yet exact.",
  },
  todo_write: { owner: "browser", level: "source-ported", evidence: ["test/grok-build-runtime.test.ts"] },
  get_command_or_subagent_output: {
    owner: "browser",
    level: "partial",
    evidence: ["test/grok-build-runtime.test.ts"],
    gap: "Native overflow files and multi-task wait formatting are not yet exact.",
  },
  spawn_subagent: {
    owner: "browser",
    level: "partial",
    evidence: ["test/grok-build-runtime.test.ts"],
    gap: "Native queue/concurrency policy and child prompt templates still need corpus proof.",
  },
  scheduler_create: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-scheduler.test.ts", "experiments/browser-agent/src/grok-build-scheduler.ts"],
    gap: "Persistence, interval parsing, update semantics, firing, expiry, and loop framing are ported; native scheduler traffic corpus is still required before promotion to exact.",
  },
  scheduler_delete: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-scheduler.test.ts", "experiments/browser-agent/src/grok-build-scheduler.ts"],
    gap: "Native response and notification traffic corpus is still required before promotion to exact.",
  },
  scheduler_list: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-scheduler.test.ts", "experiments/browser-agent/src/grok-build-scheduler.ts"],
    gap: "Native timestamp serialization and list traffic corpus is still required before promotion to exact.",
  },
  monitor: {
    owner: "browser",
    level: "partial",
    evidence: ["test/grok-build-runtime.test.ts"],
    gap: "Notification wake events and persistent-monitor semantics need browser UI wiring.",
  },
  search_tool: {
    owner: "browser",
    level: "partial",
    evidence: ["test/grok-build-runtime.test.ts"],
    gap: "No browser MCP registry is connected yet.",
  },
  use_tool: {
    owner: "browser",
    level: "partial",
    evidence: ["test/grok-build-runtime.test.ts"],
    gap: "No browser MCP transport is connected yet.",
  },
  workflow: {
    owner: "browser",
    level: "partial",
    evidence: ["test/grok-build-runtime.test.ts"],
    gap: "The Rhai workflow runtime is not yet ported to browser WASM.",
  },
  enter_plan_mode: {
    owner: "browser",
    level: "partial",
    evidence: ["test/grok-build-runtime.test.ts"],
    gap: "Native approval UI and plan-mode toolset restrictions are not yet exact.",
  },
  exit_plan_mode: {
    owner: "browser",
    level: "partial",
    evidence: ["test/grok-build-runtime.test.ts"],
    gap: "Native approval UI and plan-mode toolset restoration are not yet exact.",
  },
  ask_user_question: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-question-dialog.test.ts", "experiments/browser-agent/src/grok-build-question-dialog.ts"],
    gap: "Structured single/multi-select, Other, previews, cancellation, timeout, and plan-interview actions are ported; native ACP/UI corpus and browser interaction E2E are still required before promotion to exact.",
  },
  web_fetch: {
    owner: "relay",
    level: "exact",
    evidence: ["test/grok-build-web-fetch.test.ts", "test/cloudflare-security.test.ts"],
  },
  image_gen: {
    owner: "relay",
    level: "source-ported",
    evidence: ["test/grok-build-media.test.ts", "test/cloudflare-security.test.ts"],
  },
  image_edit: {
    owner: "relay",
    level: "source-ported",
    evidence: ["test/grok-build-media.test.ts", "test/cloudflare-security.test.ts"],
  },
  image_to_video: {
    owner: "relay",
    level: "source-ported",
    evidence: ["test/grok-build-media.test.ts", "test/cloudflare-security.test.ts"],
  },
  reference_to_video: {
    owner: "relay",
    level: "source-ported",
    evidence: ["test/grok-build-media.test.ts", "test/cloudflare-security.test.ts"],
  },
  write: { owner: "browser", level: "source-ported", evidence: ["test/grok-build-runtime.test.ts"] },
  web_search: { owner: "xai-provider", level: "provider-native", evidence: ["test/grok-build-agent.test.ts"] },
  x_search: { owner: "xai-provider", level: "provider-native", evidence: ["test/grok-build-agent.test.ts"] },
} as const satisfies Record<string, GrokToolParity>;

export function incompleteGrokParity(): Array<{ tool: string; gap: string }> {
  return Object.entries(GROK_BUILD_TOOL_PARITY).flatMap(([tool, value]) => {
    const row: GrokToolParity = value;
    return row.level !== "exact" && row.level !== "provider-native"
    ? [{ tool, gap: row.gap ?? "Source-ported behavior still needs native corpus proof before promotion to exact." }]
    : [];
  });
}

export function incompleteGrokSystemParity(): Array<{ subsystem: string; gap: string }> {
  return Object.entries(GROK_BUILD_SYSTEM_PARITY).flatMap(([subsystem, value]) => {
    const row: GrokSystemParity = value;
    return row.level !== "exact" && row.level !== "provider-native"
    ? [{ subsystem, gap: row.gap ?? "Source-ported behavior still needs native corpus proof before promotion to exact." }]
    : [];
  });
}
