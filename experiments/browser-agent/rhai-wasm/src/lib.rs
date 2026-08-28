// Copyright 2023-2026 SpaceXAI
// SPDX-License-Identifier: Apache-2.0
// Modified for the Vibewaiting browser port, 2026.

use std::cell::RefCell;
use std::rc::Rc;

use rhai::{Dynamic, EvalAltResult, Position};
use serde::{Deserialize, Serialize};
use sha2::Digest as _;
use wasm_bindgen::prelude::*;

const MAX_HOST_CALLS: u64 = 10_000;
const MAX_PARALLEL: usize = 1_024;
const HOST_ERROR_KEY: &str = "__xai_workflow_host_error";
const HOST_TERMINAL_KEY: &str = "__xai_workflow_parallel_terminal";
const SCHEMA_MAX_BYTES: usize = 256 * 1024;
const CONTRACT_OUTPUT_MAX_BYTES: usize = 2 * 1024 * 1024;
const SCHEMA_REGEX_SIZE_LIMIT: usize = 256 * 1024;
const SCHEMA_REGEX_DFA_SIZE_LIMIT: usize = 2 * 1024 * 1024;

type ScriptResult<T> = Result<T, Box<EvalAltResult>>;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    script: String,
    args: serde_json::Value,
    #[serde(default)]
    journal: Vec<JournalEntry>,
    max_operations: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalEntry {
    seq: u64,
    kind: String,
    request_hash: String,
    value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostRequest {
    seq: u64,
    kind: String,
    request_hash: String,
    payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
struct HostEvent {
    kind: String,
    payload: serde_json::Value,
    replayed: bool,
}

#[derive(Debug, Clone)]
enum Control {
    Complete(serde_json::Value),
    Pause(String, String),
    Budget(String),
    Cancelled,
    Yield,
    Fatal(String),
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Step {
    HostRequests { requests: Vec<HostRequest>, events: Vec<HostEvent> },
    Completed { result: serde_json::Value, events: Vec<HostEvent> },
    Paused {
        kind: String,
        message: String,
        #[serde(rename = "journalEntries", skip_serializing_if = "Vec::is_empty")]
        journal_entries: Vec<JournalEntry>,
        events: Vec<HostEvent>,
    },
    BudgetExceeded { message: String, events: Vec<HostEvent> },
    Cancelled { events: Vec<HostEvent> },
    Failed { error: String, events: Vec<HostEvent> },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AgentOpts {
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    effort: Option<String>,
    #[serde(default)]
    max_output_tokens: Option<u64>,
    #[serde(default)]
    agent_type: Option<String>,
    #[serde(default)]
    capability_mode: Option<String>,
    #[serde(default)]
    isolation_worktree: bool,
    #[serde(default)]
    fork_context: bool,
    #[serde(default)]
    resume_from: Option<String>,
    #[serde(default)]
    output_schema: Option<serde_json::Value>,
    #[serde(default)]
    phase: Option<String>,
}

struct Ctx {
    journal: Vec<JournalEntry>,
    seq: u64,
    requests: Vec<HostRequest>,
    self_entries: Vec<JournalEntry>,
    events: Vec<HostEvent>,
}

impl Ctx {
    fn next_seq(&mut self) -> ScriptResult<u64> {
        let seq = self.seq;
        self.seq = self.seq.checked_add(1).ok_or_else(|| fatal("workflow host-call count overflowed"))?;
        if self.seq > MAX_HOST_CALLS {
            return Err(fatal(format!("workflow exceeded the maximum of {MAX_HOST_CALLS} result-bearing host calls")));
        }
        Ok(seq)
    }

    fn replay(&self, seq: u64, kind: &str, hash: &str) -> ScriptResult<Option<serde_json::Value>> {
        let Some(entry) = usize::try_from(seq).ok().and_then(|index| self.journal.get(index)) else {
            return Ok(None);
        };
        if entry.seq != seq || entry.kind != kind || entry.request_hash != hash {
            return Err(fatal(format!(
                "replay divergence at seq {seq} ({kind}): the script issued a different call than the recorded run — the workflow script is nondeterministic or was edited mid-run"
            )));
        }
        Ok(Some(entry.value.clone()))
    }
}

#[wasm_bindgen]
pub fn evaluate_json(input_json: &str) -> String {
    let step = match serde_json::from_str::<Input>(input_json) {
        Ok(input) => evaluate(input),
        Err(error) => Step::Failed { error: format!("invalid evaluator input: {error}"), events: Vec::new() },
    };
    serde_json::to_string(&step).unwrap_or_else(|error| {
        format!(r#"{{"type":"failed","error":"failed to serialize evaluator result: {error}"}}"#)
    })
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum ContractVerdict {
    Valid { value: serde_json::Value },
    Invalid { error: String },
}

#[derive(Debug)]
struct RejectExternalSchemaRefs;

impl jsonschema::Retrieve for RejectExternalSchemaRefs {
    fn retrieve(
        &self,
        uri: &jsonschema::Uri<String>,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
        Err(format!("external JSON Schema references are disabled: {uri}").into())
    }
}

/// Browser/WASM form of Grok Build's structured-output contract validator.
/// An absent `final_text` compiles only, so callers reject bad schemas before
/// consuming a physical child-agent run just like the native host service.
#[wasm_bindgen]
pub fn validate_contract_json(schema_json: &str, final_text: Option<String>) -> String {
    let verdict = validate_contract(schema_json, final_text.as_deref())
        .map_or_else(|error| ContractVerdict::Invalid { error }, |value| ContractVerdict::Valid { value });
    serde_json::to_string(&verdict).unwrap_or_else(|error| {
        format!(r#"{{"status":"invalid","error":"failed to serialize contract verdict: {error}"}}"#)
    })
}

fn validate_contract(
    schema_json: &str,
    final_text: Option<&str>,
) -> Result<serde_json::Value, String> {
    if schema_json.len() > SCHEMA_MAX_BYTES {
        return Err(format!(
            "output_schema is too large ({} bytes; maximum is {SCHEMA_MAX_BYTES})",
            schema_json.len()
        ));
    }
    let schema: serde_json::Value = serde_json::from_str(schema_json)
        .map_err(|error| format!("output_schema cannot be serialized: {error}"))?;
    let validator = jsonschema::options()
        .with_retriever(RejectExternalSchemaRefs)
        .with_pattern_options(
            jsonschema::PatternOptions::regex()
                .size_limit(SCHEMA_REGEX_SIZE_LIMIT)
                .dfa_size_limit(SCHEMA_REGEX_DFA_SIZE_LIMIT),
        )
        .build(&schema)
        .map_err(|error| format!("output_schema is not a valid self-contained JSON Schema: {error}"))?;
    let Some(final_text) = final_text else {
        return Ok(serde_json::Value::Null);
    };
    if final_text.len() > CONTRACT_OUTPUT_MAX_BYTES {
        return Err(format!(
            "final message exceeds the {CONTRACT_OUTPUT_MAX_BYTES} byte structured-output limit"
        ));
    }
    let text = final_text.trim();
    let mut candidates: Vec<&str> = Vec::new();
    if let Some(start) = text.rfind("```json") {
        let body = &text[start + "```json".len()..];
        if let Some(end) = body.find("```") {
            candidates.push(body[..end].trim());
        }
    }
    candidates.push(text);
    for (open, close) in [('{', '}'), ('[', ']')] {
        if let (Some(start), Some(end)) = (text.find(open), text.rfind(close)) {
            if start < end {
                candidates.push(text[start..=end].trim());
            }
        }
    }
    let mut parse_error = String::new();
    for candidate in candidates {
        match serde_json::from_str::<serde_json::Value>(candidate) {
            Ok(value) => {
                return match validator.validate(&value) {
                    Ok(()) => Ok(value),
                    Err(error) => Err(format!("output does not match the required schema: {error}")),
                };
            }
            Err(error) if parse_error.is_empty() => parse_error = error.to_string(),
            Err(_) => {}
        }
    }
    Err(format!(
        "final message did not contain valid JSON (expected a ```json fenced block): {parse_error}"
    ))
}

fn evaluate(input: Input) -> Step {
    let ctx = Rc::new(RefCell::new(Ctx {
        journal: input.journal,
        seq: 0,
        requests: Vec::new(),
        self_entries: Vec::new(),
        events: Vec::new(),
    }));
    let mut engine = rhai::Engine::new();
    engine.set_max_operations(input.max_operations);
    engine.set_max_call_levels(64);
    engine.set_max_expr_depths(128, 64);
    engine.set_max_string_size(16 * 1024 * 1024);
    engine.set_max_array_size(65_536);
    engine.set_max_map_size(65_536);
    engine.set_module_resolver(rhai::module_resolvers::DummyModuleResolver::new());
    engine.disable_symbol("eval");
    register_host_fns(&mut engine, &ctx);

    let ast = match engine.compile(&input.script) {
        Ok(ast) => ast,
        Err(error) => return Step::Failed { error: format!("script failed to compile: {error}"), events: Vec::new() },
    };
    let args = match rhai::serde::to_dynamic(&input.args) {
        Ok(args) => args,
        Err(error) => return Step::Failed { error: format!("invalid workflow args: {error}"), events: Vec::new() },
    };
    let mut scope = rhai::Scope::new();
    scope.push_dynamic("args", args);
    match engine.eval_ast_with_scope::<Dynamic>(&mut scope, &ast) {
        Ok(value) => Step::Completed { result: dynamic_to_value(value), events: ctx.borrow().events.clone() },
        Err(error) => step_from_error(*error, &ctx.borrow()),
    }
}

fn step_from_error(error: EvalAltResult, ctx: &Ctx) -> Step {
    match find_control(&error) {
        Some(Control::Complete(result)) => Step::Completed { result, events: ctx.events.clone() },
        Some(Control::Pause(kind, message)) => Step::Paused {
            kind,
            message,
            journal_entries: ctx.self_entries.clone(),
            events: ctx.events.clone(),
        },
        Some(Control::Budget(message)) => Step::BudgetExceeded { message, events: ctx.events.clone() },
        Some(Control::Cancelled) => Step::Cancelled { events: ctx.events.clone() },
        Some(Control::Yield) => Step::HostRequests { requests: ctx.requests.clone(), events: ctx.events.clone() },
        Some(Control::Fatal(error)) => Step::Failed { error, events: ctx.events.clone() },
        None => Step::Failed { error: with_rhai_hint(error.to_string()), events: ctx.events.clone() },
    }
}

fn find_control(error: &EvalAltResult) -> Option<Control> {
    match error {
        EvalAltResult::ErrorTerminated(value, _) => value.clone().try_cast::<Control>(),
        EvalAltResult::ErrorInFunctionCall(_, _, inner, _) | EvalAltResult::ErrorInModule(_, inner, _) => find_control(inner),
        _ => None,
    }
}

fn terminated(control: Control) -> Box<EvalAltResult> {
    Box::new(EvalAltResult::ErrorTerminated(Dynamic::from(control), Position::NONE))
}

fn fatal(message: impl Into<String>) -> Box<EvalAltResult> { terminated(Control::Fatal(message.into())) }

fn runtime_error(message: impl Into<String>) -> Box<EvalAltResult> {
    Box::new(EvalAltResult::ErrorRuntime(Dynamic::from(message.into()), Position::NONE))
}

fn dynamic_to_value(value: Dynamic) -> serde_json::Value {
    rhai::serde::from_dynamic::<serde_json::Value>(&value).unwrap_or(serde_json::Value::Null)
}

fn value_to_dynamic(value: &serde_json::Value) -> ScriptResult<Dynamic> {
    rhai::serde::to_dynamic(value).map_err(|error| runtime_error(format!("host result conversion: {error}")))
}

fn map_to_value(map: rhai::Map) -> ScriptResult<serde_json::Value> {
    rhai::serde::from_dynamic::<serde_json::Value>(&Dynamic::from_map(map))
        .map_err(|error| runtime_error(format!("invalid options map: {error}")))
}

fn canonical_json(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_unstable_by(|left, right| left.0.cmp(right.0));
            serde_json::Value::Object(entries.into_iter().map(|(key, value)| (key.clone(), canonical_json(value))).collect())
        }
        serde_json::Value::Array(items) => serde_json::Value::Array(items.iter().map(canonical_json).collect()),
        other => other.clone(),
    }
}

fn request_hash(kind: &str, payload: &serde_json::Value) -> String {
    let mut hasher = sha2::Sha256::new();
    hasher.update(kind.as_bytes());
    hasher.update([0]);
    hasher.update(canonical_json(payload).to_string().as_bytes());
    hasher.finalize().iter().take(16).map(|byte| format!("{byte:02x}")).collect()
}

fn replay_value(value: serde_json::Value) -> ScriptResult<Dynamic> {
    if let Some(message) = value.get(HOST_ERROR_KEY).and_then(serde_json::Value::as_str) {
        return Err(runtime_error(message));
    }
    if let Some(kind) = value.get(HOST_TERMINAL_KEY).and_then(serde_json::Value::as_str) {
        return Err(match kind {
            "budget_exceeded" => terminated(Control::Budget("workflow agent budget exceeded".into())),
            "cancelled" => terminated(Control::Cancelled),
            "dropped_reply" => fatal("workflow host dropped reply"),
            _ => fatal("workflow journal contains an unknown terminal marker"),
        });
    }
    value_to_dynamic(&value)
}

fn host_call(ctx: &Rc<RefCell<Ctx>>, kind: &str, payload: serde_json::Value) -> ScriptResult<Dynamic> {
    let hash = request_hash(kind, &payload);
    let seq = ctx.borrow_mut().next_seq()?;
    if let Some(value) = ctx.borrow().replay(seq, kind, &hash)? {
        return replay_value(value);
    }
    ctx.borrow_mut().requests.push(HostRequest { seq, kind: kind.into(), request_hash: hash, payload });
    Err(terminated(Control::Yield))
}

fn agent_opts(prompt: Option<&str>, map: rhai::Map) -> ScriptResult<AgentOpts> {
    let mut opts: AgentOpts = serde_json::from_value(map_to_value(map)?)
        .map_err(|error| runtime_error(format!("invalid agent options: {error}")))?;
    if let Some(prompt) = prompt { opts.prompt = prompt.into(); }
    if opts.prompt.trim().is_empty() { return Err(runtime_error("agent prompt must not be empty")); }
    Ok(opts)
}

fn spawn_agent(ctx: &Rc<RefCell<Ctx>>, opts: AgentOpts) -> ScriptResult<Dynamic> {
    let payload = serde_json::to_value(opts).map_err(|error| runtime_error(format!("invalid agent options: {error}")))?;
    host_call(ctx, "spawn_agent", payload)
}

fn register_host_fns(engine: &mut rhai::Engine, ctx: &Rc<RefCell<Ctx>>) {
    engine.register_fn("timestamp", || -> ScriptResult<()> { Err(runtime_error("timestamp() is unavailable: workflow scripts must be deterministic (wall-clock time breaks resume). Pass timestamps in via `args` instead.")) });
    engine.register_fn("sleep", |_seconds: i64| -> ScriptResult<()> { Err(runtime_error("sleep() is unavailable in workflow scripts — host calls already block until their work finishes.")) });
    engine.register_fn("sleep", |_seconds: f64| -> ScriptResult<()> { Err(runtime_error("sleep() is unavailable in workflow scripts — host calls already block until their work finishes.")) });
    engine.register_fn("exit", || -> ScriptResult<()> { Err(runtime_error("exit() is unavailable — end a workflow with complete(value) or pause(kind, msg).")) });

    let c = ctx.clone();
    engine.register_fn("agent", move |prompt: &str| spawn_agent(&c, AgentOpts { prompt: prompt.into(), ..Default::default() }));
    let c = ctx.clone();
    engine.register_fn("agent", move |prompt: &str, opts: rhai::Map| spawn_agent(&c, agent_opts(Some(prompt), opts)?));

    let c = ctx.clone();
    engine.register_fn("parallel", move |items: rhai::Array| -> ScriptResult<rhai::Array> {
        if items.len() > MAX_PARALLEL {
            return Err(runtime_error(format!("parallel() accepts at most {MAX_PARALLEL} items per call (got {})", items.len())));
        }
        let opts = items.into_iter().map(|item| {
            let map = item.try_cast::<rhai::Map>().ok_or_else(|| runtime_error("parallel() items must be option maps"))?;
            agent_opts(None, map)
        }).collect::<ScriptResult<Vec<_>>>()?;
        let mut values = Vec::with_capacity(opts.len());
        let mut missing = false;
        for opts in opts {
            let payload = serde_json::to_value(opts).map_err(|error| runtime_error(format!("invalid agent options: {error}")))?;
            let hash = request_hash("spawn_agent", &payload);
            let seq = c.borrow_mut().next_seq()?;
            let replayed = { c.borrow().replay(seq, "spawn_agent", &hash)? };
            match replayed {
                Some(value) => values.push(Some(value)),
                None => {
                    missing = true;
                    c.borrow_mut().requests.push(HostRequest { seq, kind: "spawn_agent".into(), request_hash: hash, payload });
                    values.push(None);
                }
            }
        }
        if missing { return Err(terminated(Control::Yield)); }
        values.into_iter().map(|value| replay_value(value.expect("all parallel values replayed"))).collect()
    });

    let c = ctx.clone();
    engine.register_fn("phase", move |title: &str| emit_event(&c, "phase", serde_json::json!({ "title": title })));
    let c = ctx.clone();
    engine.register_fn("log", move |message: &str| emit_event(&c, "log", serde_json::json!({ "message": message })));
    let c = ctx.clone();
    engine.on_print(move |message| emit_event(&c, "log", serde_json::json!({ "message": message })));
    let c = ctx.clone();
    engine.on_debug(move |message, _source, _position| emit_event(&c, "log", serde_json::json!({ "message": message })));
    let c = ctx.clone();
    engine.register_fn("telemetry_event", move |name: &str, fields: rhai::Map| -> ScriptResult<()> {
        emit_event(&c, "telemetry", serde_json::json!({ "name": name, "fields": map_to_value(fields)? }));
        Ok(())
    });
    engine.register_fn("complete", |value: Dynamic| -> ScriptResult<()> { Err(terminated(Control::Complete(dynamic_to_value(value)))) });
    engine.register_fn("complete", || -> ScriptResult<()> { Err(terminated(Control::Complete(serde_json::Value::Null))) });
    engine.register_fn("pause", |kind: &str, message: &str| -> ScriptResult<()> {
        let normalized = match kind {
            "user" => "user", "back_off" | "backoff" => "back_off", "no_progress" => "no_progress",
            "verification" | "blocked" => "verification", "infra" => "infra",
            other => return Err(runtime_error(format!("unknown pause kind: {other}"))),
        };
        Err(terminated(Control::Pause(normalized.into(), message.into())))
    });

    let c = ctx.clone();
    engine.register_fn("await_user", move |kind: &str, message: &str| -> ScriptResult<()> {
        let payload = serde_json::json!({ "kind": kind, "message": message });
        let hash = request_hash("await_user", &payload);
        let seq = c.borrow_mut().next_seq()?;
        if c.borrow().replay(seq, "await_user", &hash)?.is_some() { return Ok(()); }
        c.borrow_mut().self_entries.push(JournalEntry { seq, kind: "await_user".into(), request_hash: hash, value: serde_json::Value::Null });
        Err(terminated(Control::Pause(kind.into(), message.into())))
    });

    let c = ctx.clone();
    engine.register_fn("budget", move || host_call(&c, "budget", serde_json::Value::Null));
    let c = ctx.clone();
    engine.register_fn("render_template", move |name: &str, vars: rhai::Map| {
        let vars = map_to_value(vars)?;
        host_call(&c, "render_template", serde_json::json!({ "name": name, "vars": vars }))
    });
    let c = ctx.clone();
    engine.register_fn("write_scratch_file", move |name: &str, content: &str| {
        host_call(&c, "write_scratch_file", serde_json::json!({ "name": name, "content": content }))
    });
    let c = ctx.clone();
    engine.register_fn("read_scratch_file", move |name: &str| host_call(&c, "read_scratch_file", serde_json::json!({ "name": name })));
    let c = ctx.clone();
    engine.register_fn("git_diff_since", move |commit: &str| host_call(&c, "git_diff_since", serde_json::json!({ "commit": commit })));
    engine.register_fn("fingerprint", |text: &str| request_hash("fingerprint", &serde_json::Value::String(text.into())));
    engine.register_fn("json_encode", |value: Dynamic| -> ScriptResult<String> {
        serde_json::to_string(&dynamic_to_value(value)).map_err(|error| runtime_error(format!("json encoding failed: {error}")))
    });
}

fn emit_event(ctx: &Rc<RefCell<Ctx>>, kind: &str, payload: serde_json::Value) {
    let mut ctx = ctx.borrow_mut();
    let replayed = usize::try_from(ctx.seq).is_ok_and(|seq| seq < ctx.journal.len());
    ctx.events.push(HostEvent { kind: kind.into(), payload, replayed });
}

fn with_rhai_hint(message: String) -> String {
    let hint = if message.contains("Expression exceeds maximum complexity") {
        Some("a single expression nests too deep — usually one long chained `+` string concatenation. Split it into multiple `+=` statements.")
    } else if message.contains("reserved keyword") {
        Some("Rhai reserves identifiers it doesn't use — rename the variable.")
    } else if message.contains("getter is not registered for type 'char'") {
        Some("indexing a string yields a `char`; check the value with type_of() and slice with sub_string().")
    } else { None };
    hint.map_or(message.clone(), |hint| format!("{message}\nhint: {hint}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(script: &str, journal: Vec<JournalEntry>) -> Input {
        Input { script: script.into(), args: serde_json::json!({"objective":"test"}), journal, max_operations: 1_000_000 }
    }

    #[test]
    fn completes_pure_rhai() {
        let step = evaluate(input("let meta = #{ name: \"x\", description: \"d\" }; complete(40 + 2);", vec![]));
        assert!(matches!(step, Step::Completed { result, .. } if result == serde_json::json!(42)));
    }

    #[test]
    fn structured_contract_matches_native_candidate_order_and_schema_validation() {
        let schema = serde_json::json!({
            "type": "object",
            "required": ["ok"],
            "properties": { "ok": { "type": "boolean" } }
        })
        .to_string();
        let output = "```json\n{\"wrong\": 1}\n```\ncorrected:\n```json\n{\"ok\": true}\n```";
        assert_eq!(
            validate_contract(&schema, Some(output)).unwrap(),
            serde_json::json!({"ok": true})
        );
        let error = validate_contract(&schema, Some("result: {\"ok\": \"yes\"}"))
            .unwrap_err();
        assert!(error.contains("output does not match the required schema"), "{error}");
    }

    #[test]
    fn structured_contract_rejects_external_schema_references() {
        let schema = serde_json::json!({ "$ref": "https://example.com/schema.json" }).to_string();
        let error = validate_contract(&schema, None).unwrap_err();
        assert!(error.contains("external JSON Schema references are disabled"), "{error}");
    }

    #[test]
    fn yields_and_replays_agent() {
        let script = "let meta = #{ name: \"x\", description: \"d\" }; let r = agent(\"work\"); complete(r.output);";
        let Step::HostRequests { requests, .. } = evaluate(input(script, vec![])) else { panic!("expected request") };
        let request = requests.into_iter().next().unwrap();
        let entry = JournalEntry { seq: request.seq, kind: request.kind, request_hash: request.request_hash, value: serde_json::json!({"output":"done"}) };
        let step = evaluate(input(script, vec![entry]));
        assert!(matches!(step, Step::Completed { result, .. } if result == serde_json::json!("done")));
    }
}
