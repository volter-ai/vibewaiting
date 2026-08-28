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
    evidence: ["test/grok-build-skills.test.ts", "test/grok-build-skill-manager.test.ts", "test/grok-build-custom-agent.test.ts", "test/grok-build-agent.test.ts"],
    gap: "Startup, inherited discovery, exact explicit skill-body envelopes, paths-gated activation, nearby-directory discovery, announcement dedup, and mid-session reminders are ported; native dynamic-discovery traffic and full gitignore-glob corpora remain before exact.",
  },
  bundled_agents: {
    level: "source-ported",
    evidence: ["test/grok-build-bundle.test.ts", "test/grok-build-agents.test.ts", "test/grok-build-subagent-config.test.ts", "test/grok-build-custom-agent.test.ts", "test/grok-build-agent-mcp.test.ts", "test/grok-build-agent.test.ts"],
    gap: "Definition discovery/precedence, exact full/extend prompts, role/persona/fork layering, completion recovery, configured tool renames/params and hosted overrides, scoped memory injection, trusted inline hooks, and custom MCP ownership/inheritance are live. Browser MCP cannot launch stdio child processes, and native long-session corpus proof remains before exact.",
  },
  bundled_workflows: {
    level: "source-ported",
    evidence: ["test/grok-build-bundle.test.ts", "test/grok-build-workflows.test.ts", "experiments/browser-agent/rhai-wasm/src/lib.rs"],
    gap: "Published/project/user discovery, checksum-verified built-in privilege, metadata, precedence, listing, Rhai 1.25.1 WASM execution, durable journal replay/resume, native jsonschema 0.30 correction, logical budgets, precise child-attempt accounting, cancellation, and per-run concurrency lifecycle are ported; native long-run traffic corpora remain before exact.",
  },
  prompt_queue: {
    level: "source-ported",
    evidence: ["test/grok-build-prompt-queue.test.ts", "experiments/browser-agent/src/main.ts"],
    gap: "Eligible-prefix queued follow-ups, attachment-preserving steering, and FIFO mid-turn interjection envelopes are wired at live model-safe boundaries; a native queue/interjection traffic corpus remains before exact.",
  },
  telemetry_and_feedback: {
    level: "source-ported",
    evidence: ["test/fixtures/grok-conformance/native-pong-complete-v1.jsonl", "e2e/browser-agent-long.e2e.mjs", "test/grok-build-telemetry.test.ts", "test/grok-build-otlp.test.ts", "test/grok-build-mcp-trace.test.ts", "experiments/browser-agent/src/grok-build-telemetry.ts"],
    gap: "Feedback config, session signals, and turn deltas are strict-matched through final shutdown over the long native control-plane corpus. Root/subagent agent spans, MCP connection/call spans, privacy redaction, and OTLP protobuf export are source-ported and structurally tested; native process/thread/plugin spans describe components absent from the browser and cannot be byte-identical.",
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
    evidence: ["test/grok-build-runtime.test.ts", "test/grok-build-command-isolation.test.ts", "test/browser-node-check.test.ts", "e2e/browser-agent.e2e.mjs"],
    gap: "Native exit headers, omitted-timeout foreground completion/auto-background identity, explicit foreground timeout framing, positive background timeout enforcement, shell redirection through AlmostNode, module-aware compound node syntax checks, and container-wide output/cancellation isolation are ported. AlmostNode 0.2.14 has module-global execution callbacks, so the browser adapter safely serializes commands instead of reproducing native parallel process scheduling. A browser AbortSignal is cooperative and cannot reproduce OS process-group TERM-to-KILL escalation; broader native command corpora remain before exact.",
  },
  read_file: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-runtime.test.ts", "test/grok-build-rich-files-and-tasks.test.ts", "experiments/browser-agent/src/grok-build-filesystem.ts", "experiments/browser-agent/src/grok-build-file-pdf.ts", "experiments/browser-agent/src/grok-build-file-pptx.ts"],
    gap: "Text/notebook windows, lenient signed offsets, native deferred data-URI image reminders, strict/malformed PPTX XML with best-effort notes and a cooperative 60s deadline, PDF selection/text/rendering, and endpoint-image gates/transcoding are browser-ported. PDF.js/canvas cannot promise pdf-oxide/image-crate byte identity, and synchronous browser code cannot be force-preempted like spawn_blocking; native rich-file corpora remain before exact.",
  },
  search_replace: { owner: "browser", level: "source-ported", evidence: ["test/grok-build-runtime.test.ts"] },
  list_dir: { owner: "browser", level: "source-ported", evidence: ["test/grok-build-runtime.test.ts"] },
  grep: { owner: "browser", level: "source-ported", evidence: ["test/grok-build-runtime.test.ts"] },
  kill_command_or_subagent: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-runtime.test.ts", "test/grok-build-rich-files-and-tasks.test.ts", "test/grok-build-command-isolation.test.ts", "experiments/browser-agent/src/grok-build-background-tasks.ts"],
    gap: "UUIDv7 identity, terminal/subagent outcomes, discoverable not-found responses, queued-command cancellation without execution, and active cancellation isolation are ported; AlmostNode exposes cooperative abort rather than an OS-level timed TERM-to-KILL escalation, and native behavior corpus proof remains.",
  },
  todo_write: { owner: "browser", level: "source-ported", evidence: ["test/grok-build-runtime.test.ts"] },
  get_command_or_subagent_output: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-runtime.test.ts", "test/grok-build-rich-files-and-tasks.test.ts", "experiments/browser-agent/src/grok-build-background-tasks.ts"],
    gap: "Live output, native 20k front/back command rings, retained VFS logs, UTF-8-safe previews, soft wrapping, empty-output wording, capped waits, single/multi cards, UUIDv7 explicit-background IDs, tool-call log identity, poll/wait-all, completion wake reminders, and timed_out propagation are ported. The browser uses a logical VFS session folder rather than an OS SessionFolder; native timing corpora and detailed live-subagent progress metadata remain before exact.",
  },
  spawn_subagent: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-runtime.test.ts", "test/grok-build-subagent-admission.test.ts", "experiments/browser-agent/src/grok-build-subagent-admission.ts", "experiments/browser-agent/src/grok-build-agents.ts"],
    gap: "Background/foreground/resume lifecycle, capability pruning, 32-child FIFO admission, queued cancellation, one-level nesting, and full/extend custom prompt composition are ported; native child traffic corpus proof remains before exact.",
  },
  scheduler_create: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-scheduler.test.ts", "experiments/browser-agent/src/grok-build-scheduler.ts"],
    gap: "Persistence, lenient inputs, UUIDv7-derived IDs, interval/update semantics, firing/expiry, loop framing with the native 4,000-byte completion cap, RFC3339 timestamps, generation/revision notifications, and bounded durable tombstone transactions are ported; native scheduler traffic corpus proof remains.",
  },
  scheduler_delete: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-scheduler.test.ts", "experiments/browser-agent/src/grok-build-scheduler.ts"],
    gap: "Delete responses, retry-stable tombstone versions, pending-mutation gates, persistence/notification failures, the 30-second durability barrier, and deleted/expired generation-revision notifications are ported; native traffic corpus proof remains.",
  },
  scheduler_list: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-scheduler.test.ts", "experiments/browser-agent/src/grok-build-scheduler.ts"],
    gap: "Native chrono-style RFC3339 serialization, UTF-8 prompt truncation, cadence fields, and restore behavior are ported; native list traffic corpus proof remains.",
  },
  monitor: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-monitor.test.ts", "test/grok-build-runtime.test.ts", "experiments/browser-agent/src/grok-build-monitor.ts"],
    gap: "Timeout/persistent semantics, line framing/truncation/batching, XML-wrapped recovery/overload notices, the native token bucket, completion wakes, reminders arriving during a sample, and nested-subagent terminal/monitor notification reparenting are ported. Native timing and process traffic corpus proof remains before exact.",
  },
  search_tool: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-mcp.test.ts", "experiments/browser-agent/src/grok-build-mcp.ts", "experiments/browser-agent/src/grok-build-mcp-search.ts", "experiments/browser-agent/rhai-wasm/src/lib.rs"],
    gap: "Ranking executes Grok Build's exact bm25 2.3.2 crate in browser WASM, including deunicode, English stop words, Snowball stemming, identifier expansion, duplicate-query weighting, and f32 scoring; the complete native 55+ production haystack exact/fuzzy/disambiguation corpus is mirrored in browser tests. Only recorded native live-server formatting traffic remains before this row can be marked exact.",
  },
  use_tool: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-mcp.test.ts", "experiments/browser-agent/src/grok-build-mcp-protocol.ts", "experiments/browser-agent/src/grok-build-mcp-events.ts", "experiments/browser-agent/src/grok-build-mcp-elicitation.ts", "experiments/browser-agent/src/grok-build-mcp-oauth.ts", "experiments/browser-agent/src/grok-build-mcp.ts"],
    gap: "Streamable HTTP/SSE/session lifecycle, resumable notifications, live catalog refresh, replacement/cancellation-aware form and URL elicitation with full native schema/value validation, and OAuth discovery/DCR/PKCE/refresh/scope-upgrade/client-secret/private-key-JWT branches are source-ported. Cross-tab auth uses browser Web Locks; cross-origin authorization metadata fails closed unless a relay resolves it exclusively to public IPs. Recorded native browser/relay traffic and long-session corpus proof remain before exact.",
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
    gap: "Approve, request-changes, abandon, empty-plan interception, fail-closed unknown outcomes, persisted disconnect gates, resume re-park state/action semantics, and the root lifecycle's synthetic resume turn are ported; native ACP corpus proof remains before exact.",
  },
  ask_user_question: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/grok-build-question-dialog.test.ts", "experiments/browser-agent/src/grok-build-question-dialog.ts"],
    gap: "Structured single/multi-select with lenient bools, freeform-only batches, Other, previews, duplicate validation, empty-batch behavior, replacement cancellation, timeout, and plan-interview actions are ported; transport failures are direct browser promise failures rather than ACP wire failures, and native ACP/UI corpus is still required before exact.",
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
