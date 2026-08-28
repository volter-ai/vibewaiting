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
    evidence: ["test/fixtures/grok-conformance/native-pong-complete-v1.jsonl", "e2e/browser-agent.e2e.mjs", "e2e/browser-agent-long.e2e.mjs", "scripts/grok-conformance-proxy.mjs"],
  },
  compaction: {
    level: "exact",
    evidence: ["test/fixtures/grok-conformance/native-auto-compaction-v1.jsonl", "test/grok-build-agent.test.ts", "test/grok-browser-protocol.test.ts", "test/grok-relay.test.ts", "worker-test/cloudflare-auth-session.test.ts"],
  },
  startup_models: {
    level: "source-ported",
    evidence: ["test/grok-build-bootstrap.test.ts", "test/grok-relay.test.ts"],
    gap: "Needs a fail-closed native startup replay corpus before promotion to exact.",
  },
  startup_settings: {
    level: "source-ported",
    evidence: ["test/grok-build-bootstrap.test.ts", "test/grok-browser-protocol.test.ts", "test/grok-relay.test.ts", "worker-test/cloudflare-auth-session.test.ts", "test/fixtures/grok-conformance/native-auto-compaction-v1.jsonl", "e2e/browser-agent-long.e2e.mjs"],
    gap: "Exact remote compaction header policy is proven for root, post-compaction, and subagent sessions; failure-path and post-auth re-apply traffic corpora remain before the whole startup-settings row can be promoted to exact.",
  },
  published_bundle_cache: {
    level: "source-ported",
    evidence: ["test/fixtures/grok-conformance/native-auto-compaction-v1.jsonl", "test/grok-build-bundle.test.ts", "test/grok-relay.test.ts"],
    gap: "The real archive and source semantics are covered, but native legacy/failure traffic corpora are still required before promotion to exact.",
  },
  skill_discovery: {
    level: "source-ported",
    evidence: ["test/grok-build-skills.test.ts", "test/grok-build-skill-manager.test.ts", "test/grok-build-custom-agent.test.ts", "test/grok-build-agent.test.ts"],
    gap: "Startup/inherited discovery, explicit skill-body envelopes, paths-gated activation/reset, nearby-directory discovery, live bundle-baseline refresh, compaction lifecycle, announcement dedup, and native wrong-root SKILL.md recovery (including ambiguity, disabled-owner precedence, held skills, and fork display paths) are ported. The pinned GitignoreBuilder corpus proves matcher edge semantics; recorded native dynamic-discovery traffic remains before promotion to exact.",
  },
  bundled_agents: {
    level: "source-ported",
    evidence: ["test/fixtures/grok-conformance/native-control-behaviors-v1.json", "test/grok-build-native-control-parity.test.ts", "test/grok-build-bundle.test.ts", "test/grok-build-agents.test.ts", "test/grok-build-subagent-config.test.ts", "test/grok-build-custom-agent.test.ts", "test/grok-build-agent-mcp.test.ts", "test/grok-build-agent.test.ts"],
    gap: "Pinned native discovery/default/frontmatter/completion cases now have deterministic browser equivalence proof in addition to live definition, prompt, tool, memory, hook, and MCP wiring. Browser MCP cannot launch stdio child processes; provider-backed long-session child traffic remains before exact.",
  },
  bundled_workflows: {
    level: "source-ported",
    evidence: ["test/fixtures/grok-conformance/native-control-behaviors-v1.json", "test/grok-build-native-control-parity.test.ts", "test/grok-build-bundle.test.ts", "test/grok-build-workflows.test.ts", "experiments/browser-agent/rhai-wasm/src/lib.rs"],
    gap: "Pinned native pause/schema-correction/token-accounting cases execute through real browser Rhai WASM, alongside discovery, durable replay/resume, budgets, cancellation, and per-run concurrency coverage. Provider-backed multi-agent workflow traffic remains before exact.",
  },
  prompt_queue: {
    level: "source-ported",
    evidence: ["test/fixtures/grok-conformance/native-control-behaviors-v1.json", "test/grok-build-native-control-parity.test.ts", "test/grok-build-prompt-queue.test.ts", "experiments/browser-agent/src/main.ts"],
    gap: "Every pinned native merge gate and byte-exact steer/interrupt envelope, including the Rust scalar-crossing UTF-8 boundary, has deterministic browser equivalence proof. Native concurrent producer/safe-boundary traffic remains before exact.",
  },
  telemetry_and_feedback: {
    level: "source-ported",
    evidence: ["test/fixtures/grok-conformance/native-pong-complete-v1.jsonl", "e2e/browser-agent-long.e2e.mjs", "test/grok-build-telemetry.test.ts", "test/grok-build-otlp.test.ts", "test/grok-build-mcp-trace.test.ts", "experiments/browser-agent/src/grok-build-telemetry.ts"],
    gap: "Feedback config, session signals, and turn deltas are strict-matched through final shutdown over the long native control-plane corpus. Root/subagent agent spans, MCP connection/call spans, privacy redaction, and OTLP protobuf export are source-ported and structurally tested; native process/thread/plugin spans describe components absent from the browser and cannot be byte-identical.",
  },
} as const satisfies Record<string, GrokSystemParity>;

/**
 * Auditable coverage for every entry in the captured Grok Build tool registry.
 * `partial` means implementation is unfinished. `source-ported` means the
 * browser-representable implementation is complete but has not been promoted
 * to traffic-exact for every native branch. Those are deliberately separate
 * release measurements: source translation is not corpus proof, and missing
 * corpus proof is not missing implementation.
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
    evidence: ["test/fixtures/grok-conformance/native-control-behaviors-v1.json", "test/grok-build-native-control-parity.test.ts", "test/grok-build-runtime.test.ts", "test/grok-build-subagent-admission.test.ts", "experiments/browser-agent/src/grok-build-subagent-admission.ts", "experiments/browser-agent/src/grok-build-agents.ts"],
    gap: "The pinned native 32-child default, FIFO admission, and queued-cancellation cases have deterministic browser equivalence proof; background/foreground/resume, capability, depth, and custom-prompt lifecycles are source-tested. Provider-backed child request/response traffic remains before exact.",
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
    level: "exact",
    evidence: ["test/fixtures/mcp/native-http-corpus.json", "test/grok-build-mcp-native-corpus.test.ts", "test/grok-build-mcp.test.ts", "experiments/browser-agent/src/grok-build-mcp.ts", "experiments/browser-agent/src/grok-build-mcp-search.ts", "experiments/browser-agent/rhai-wasm/src/lib.rs"],
  },
  use_tool: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/fixtures/mcp/native-http-corpus.json", "test/grok-build-mcp-native-corpus.test.ts", "test/grok-build-mcp.test.ts", "experiments/browser-agent/src/grok-build-mcp-protocol.ts", "experiments/browser-agent/src/grok-build-mcp-events.ts", "experiments/browser-agent/src/grok-build-mcp-elicitation.ts", "experiments/browser-agent/src/grok-build-mcp-oauth.ts", "experiments/browser-agent/src/grok-build-mcp.ts"],
    gap: "A trusted native long session now proves initialize/initialized/list/call request bodies, rmcp request-id/progress-token counters, no-OAuth discovery ordering, search_tool→use_tool dispatch, and model-visible output; strict browser replay preserves every stable field. Streamable HTTP/SSE/session lifecycle, notifications, elicitation, and OAuth DCR/PKCE/refresh/scope-upgrade/client-secret/private-key-JWT branches remain source-derived rather than native authenticated-traffic corpora. Browser Web Locks replace the native credential mutex/keychain, and cross-origin authorization metadata requires the relay's public-DNS validation contract.",
  },
  workflow: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/fixtures/grok-conformance/native-control-behaviors-v1.json", "test/grok-build-native-control-parity.test.ts", "test/grok-build-workflows.test.ts", "experiments/browser-agent/src/grok-build-workflows.ts", "experiments/browser-agent/src/grok-build-workflow-engine.ts", "experiments/browser-agent/src/grok-build-workflow-host.ts", "experiments/browser-agent/rhai-wasm/src/lib.rs"],
    gap: "The real published workflow and pinned native pause/schema-correction/physical-attempt accounting corpus execute through browser Rhai WASM and the production host shape. Missing provider usage is flagged internally but the native AgentResult cannot expose incompleteness; provider-backed long-run traffic remains before exact.",
  },
  enter_plan_mode: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/fixtures/grok-conformance/native-control-behaviors-v1.json", "test/grok-build-native-control-parity.test.ts", "test/grok-build-runtime.test.ts", "e2e/browser-agent.e2e.mjs", "experiments/browser-agent/src/grok-build-plan-dialog.ts"],
    gap: "Pinned native approval, seeding, rejection, and edit-gate outcomes have deterministic browser equivalence proof. Native ACP permission/notification wire traffic is outside the browser dialog boundary and remains unrecorded.",
  },
  exit_plan_mode: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/fixtures/grok-conformance/native-control-behaviors-v1.json", "test/grok-build-native-control-parity.test.ts", "test/grok-build-runtime.test.ts", "e2e/browser-agent.e2e.mjs", "experiments/browser-agent/src/grok-build-plan-dialog.ts"],
    gap: "Pinned native approve, revise, abandon, empty-plan, and restored-approval outcomes have deterministic browser equivalence proof, plus persisted disconnect and fail-closed state tests. Native ACP wire traffic is outside the browser dialog boundary and remains unrecorded.",
  },
  ask_user_question: {
    owner: "browser",
    level: "source-ported",
    evidence: ["test/fixtures/grok-conformance/native-control-behaviors-v1.json", "test/grok-build-native-control-parity.test.ts", "test/grok-build-question-dialog.test.ts", "experiments/browser-agent/src/grok-build-question-dialog.ts"],
    gap: "Every pinned native accepted/chat/skip/cancel model-visible format has byte-exact browser equivalence proof; structured selection, validation, replacement, and timeout behavior is source-tested. Browser promise failures replace native ACP wire failures, so ACP transport identity is not browser-representable.",
  },
  web_fetch: {
    owner: "relay",
    level: "source-ported",
    evidence: ["test/grok-build-web-fetch.test.ts", "test/cloudflare-security.test.ts", "worker-test/cloudflare-auth-session.test.ts"],
    gap: "Default and remote allowed-domain policies, path scoping, explicit-empty denial, redirect control, SSRF rejection, bounded bodies, and distributed budgets are ported. A generic remote HTTP(S) forward-proxy endpoint cannot be expressed through Cloudflare Workers fetch; the relay fails closed when that optional enterprise setting is present.",
  },
  image_gen: {
    owner: "relay",
    level: "source-ported",
    evidence: ["test/grok-build-media.test.ts", "test/cloudflare-security.test.ts", "worker-test/cloudflare-auth-session.test.ts"],
    gap: "Native remote model override precedence is enforced from the encrypted server-side settings cache; provider-backed success, tier, and failure traffic corpora remain before exact.",
  },
  image_edit: {
    owner: "relay",
    level: "source-ported",
    evidence: ["test/grok-build-media.test.ts", "test/cloudflare-security.test.ts", "worker-test/cloudflare-auth-session.test.ts"],
    gap: "Native remote edit-model override precedence is enforced from the encrypted server-side settings cache; provider-backed success and multi-reference traffic corpora remain before exact.",
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
    return row.level === "partial"
    ? [{ tool, gap: row.gap ?? "Browser-representable implementation is incomplete." }]
    : [];
  });
}

export function incompleteGrokSystemParity(): Array<{ subsystem: string; gap: string }> {
  return Object.entries(GROK_BUILD_SYSTEM_PARITY).flatMap(([subsystem, value]) => {
    const row: GrokSystemParity = value;
    return row.level === "partial"
    ? [{ subsystem, gap: row.gap ?? "Browser-representable implementation is incomplete." }]
    : [];
  });
}

export function unprovenExactGrokParity(): Array<{ tool: string; boundary: string }> {
  return Object.entries(GROK_BUILD_TOOL_PARITY).flatMap(([tool, value]) => {
    const row: GrokToolParity = value;
    return row.level === "source-ported"
      ? [{ tool, boundary: row.gap ?? "Source-ported behavior needs native corpus proof before promotion to exact." }]
      : [];
  });
}

export function unprovenExactGrokSystemParity(): Array<{ subsystem: string; boundary: string }> {
  return Object.entries(GROK_BUILD_SYSTEM_PARITY).flatMap(([subsystem, value]) => {
    const row: GrokSystemParity = value;
    return row.level === "source-ported"
      ? [{ subsystem, boundary: row.gap ?? "Source-ported behavior needs native corpus proof before promotion to exact." }]
      : [];
  });
}
