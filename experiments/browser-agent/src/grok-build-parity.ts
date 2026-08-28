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
    evidence: ["test/grok-build-skills.test.ts", "test/grok-build-skill-manager.test.ts", "test/grok-build-agent.test.ts"],
    gap: "Startup, paths-gated activation, nearby-directory discovery, announcement dedup, and mid-session reminder injection are ported; native dynamic-discovery traffic and full gitignore-glob corpora remain before exact.",
  },
  bundled_agents: {
    level: "source-ported",
    evidence: ["test/grok-build-bundle.test.ts", "test/grok-build-agents.test.ts", "test/grok-build-agent.test.ts"],
    gap: "Built-in/project/bundled definition precedence and full prompts are ported; extend-mode custom definitions and native fork/persona/role layering remain incomplete.",
  },
  bundled_workflows: {
    level: "source-ported",
    evidence: ["test/grok-build-bundle.test.ts", "test/grok-build-workflows.test.ts", "experiments/browser-agent/rhai-wasm/src/lib.rs"],
    gap: "Published/project/user discovery, metadata, precedence, listing, Rhai 1.25.1 WASM execution, async journal replay, native jsonschema 0.30 contract validation/correction, logical budgets, child-attempt accounting, events, and same-process resume are ported; native long-run traffic corpora and durable cross-reload resume remain before exact.",
  },
  telemetry_and_feedback: {
    level: "source-ported",
    evidence: ["test/fixtures/grok-conformance/native-pong-complete-v1.jsonl", "test/grok-build-telemetry.test.ts", "experiments/browser-agent/src/grok-build-telemetry.ts"],
    gap: "Feedback config, session signals, turn deltas, and OTLP protobuf transport are browser-ported; automatic lifecycle wiring, native span production/redaction, and full control-plane corpus proof remain before exact.",
  },
} as const satisfies Record<string, GrokSystemParity>;

/**
 * Auditable coverage for every entry in the captured Grok Build tool registry.
 * The release gate treats both `partial` and `source-ported` as unfinished.
 * Source translation is implementation evidence, not corpus proof.
 */
export const GROK_BUILD_TOOL_PARITY = {
  run_terminal_command: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-runtime.test.ts", "test/browser-node-check.test.ts", "e2e/browser-agent.e2e.mjs"],
    gap: "Native exit headers, omitted-timeout foreground completion, explicit foreground timeout framing, positive background timeout enforcement, and the recorded Pong npm/node syntax check now match; broader shell/process-group TERM-to-KILL escalation, redirection, and native command corpora remain before exact.",
  },
  read_file: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-runtime.test.ts", "test/grok-build-rich-files-and-tasks.test.ts", "experiments/browser-agent/src/grok-build-filesystem.ts"],
    gap: "Text/notebook windows (including lenient signed offsets and inline data-URI extraction), PPTX extraction, PDF page selection/text/rendering, endpoint-image structural gates, bounds/transcoding, and multimodal outputs are browser-ported. PDF.js/canvas cannot promise pdf-oxide/image-crate byte identity; malformed-PPTX/error-path and native PDF/image corpora, plus native deferred image-follow-up framing, remain before exact.",
  },
  search_replace: { owner: "browser", level: "source-ported", evidence: ["test/grok-build-runtime.test.ts"] },
  list_dir: { owner: "browser", level: "source-ported", evidence: ["test/grok-build-runtime.test.ts"] },
  grep: { owner: "browser", level: "source-ported", evidence: ["test/grok-build-runtime.test.ts"] },
  kill_command_or_subagent: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-runtime.test.ts", "test/grok-build-rich-files-and-tasks.test.ts", "experiments/browser-agent/src/grok-build-background-tasks.ts"],
    gap: "UUIDv7 identity, terminal/subagent outcomes, discoverable not-found responses, and cancellation are ported; AlmostNode exposes cooperative abort rather than an OS-level timed TERM-to-KILL escalation, and native behavior corpus proof remains.",
  },
  todo_write: { owner: "browser", level: "source-ported", evidence: ["test/grok-build-runtime.test.ts"] },
  get_command_or_subagent_output: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-runtime.test.ts", "test/grok-build-rich-files-and-tasks.test.ts", "experiments/browser-agent/src/grok-build-background-tasks.ts"],
    gap: "Live output, full VFS logs, UTF-8-safe previews, soft wrapping, empty-output wording, capped-wait advisories, single/multi cards, ID normalization, poll/wait-all, positive background timeout enforcement, and timed_out propagation are ported. Browser logs use task-UUID VFS paths rather than native tool-call session paths; native timing corpus and detailed live-subagent progress metadata remain before exact.",
  },
  spawn_subagent: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-runtime.test.ts", "test/grok-build-subagent-admission.test.ts", "experiments/browser-agent/src/grok-build-subagent-admission.ts", "experiments/browser-agent/src/grok-build-agents.ts"],
    gap: "Background/foreground/resume lifecycle, capability pruning, 32-child FIFO admission, queued cancellation, and one-level nesting are ported; extend-mode custom prompt composition and native child traffic corpus proof remain before exact.",
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
    level: "source-ported",
    evidence: ["test/grok-build-monitor.test.ts", "experiments/browser-agent/src/grok-build-monitor.ts"],
    gap: "Native timeout/persistent semantics, line framing, truncation, batching, XML notification wrapping, UI delivery, and next-sample model reminders are ported; mid-sample wake interruption, token-bucket auto-kill, subagent reparenting, and native timing corpus proof remain before exact.",
  },
  search_tool: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-mcp.test.ts", "experiments/browser-agent/src/grok-build-mcp.ts", "experiments/browser-agent/src/grok-build-mcp-search.ts"],
    gap: "Registry/filtering/grouping, identifier expansion, NLTK English stop words, duplicate-query weighting, and bm25 2.3.2's f32 k1/b/IDF/TF scoring are source-ported. Full deunicode transliteration, byte-for-byte Snowball English stemming, native HashSet tie order, and a native ranking corpus remain before exact.",
  },
  use_tool: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-mcp.test.ts", "experiments/browser-agent/src/grok-build-mcp-protocol.ts", "experiments/browser-agent/src/grok-build-mcp-events.ts", "experiments/browser-agent/src/grok-build-mcp-oauth.ts", "experiments/browser-agent/src/grok-build-mcp.ts"],
    gap: "Streamable HTTP lifecycle, incremental POST/GET SSE, resumable notification streams, live catalog refresh, form/URL elicitation bounds/cancellation, and RFC 9728/8414 OAuth with DCR/PKCE/refresh are source-ported. Full form-value/schema UI validation, DNS-resolved private-host rejection, cross-tab auth dedup, less-common OAuth client-auth/scope-upgrade branches, browser/relay traffic recordings, and native long-session corpus proof remain before exact.",
  },
  workflow: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-workflows.test.ts", "experiments/browser-agent/src/grok-build-workflows.ts", "experiments/browser-agent/src/grok-build-workflow-engine.ts", "experiments/browser-agent/src/grok-build-workflow-host.ts", "experiments/browser-agent/rhai-wasm/src/lib.rs"],
    gap: "The real published deep-research workflow executes in browser Rhai WASM with host-call journal replay; native jsonschema 0.30 compiles in that WASM, one continuation correction retry is source-ported, and the production child callback aggregates provider-reported tokens/duration across every attempt. Missing provider usage is flagged internally but the native AgentResult shape cannot expose incompleteness; native long-run traffic proof remains before exact.",
  },
  enter_plan_mode: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-runtime.test.ts", "e2e/browser-agent.e2e.mjs", "experiments/browser-agent/src/grok-build-plan-dialog.ts"],
    gap: "Entry approval, plan-file seeding, persisted active state, and the native edit gate are ported; native permission/notification corpus is required before promotion to exact.",
  },
  exit_plan_mode: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-runtime.test.ts", "e2e/browser-agent.e2e.mjs", "experiments/browser-agent/src/grok-build-plan-dialog.ts"],
    gap: "Approve, request-changes, abandon, feedback, and state restoration are ported; disconnect/re-park behavior and native ACP corpus remain before exact.",
  },
  ask_user_question: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-question-dialog.test.ts", "experiments/browser-agent/src/grok-build-question-dialog.ts"],
    gap: "Structured single/multi-select, Other, previews, cancellation, timeout, plan-interview actions, and browser interaction E2E are ported; a native ACP/UI corpus is still required before promotion to exact.",
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
  write: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-runtime.test.ts", "e2e/browser-agent.e2e.mjs"],
    gap: "New/overwrite behavior and the recorded Pong write effect/output are strict-matched; native permission, notification, oversized-file, and failure corpora remain before exact.",
  },
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
