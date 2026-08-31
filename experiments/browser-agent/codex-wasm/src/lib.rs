//! Browser-owned Codex turn state and Responses wire projection.
//!
//! This is the first `wasm32` extraction boundary from openai/codex. The data
//! shapes and replay rules follow the pinned upstream implementation in:
//! - codex-rs/core/src/client.rs
//! - codex-rs/protocol/src/models.rs
//! - codex-rs/codex-api/src/endpoint/responses.rs
//!
//! Fetch, credentials, filesystem access, and command execution deliberately
//! remain host capabilities. They are not serialized into this module.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

pub const CODEX_SOURCE_REVISION: &str = "e4d0ba4e927363f695bb8d0fef187fd229700657";
pub const CODEX_CLIENT_VERSION: &str = "0.150.1";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    version: u8,
    source_revision: String,
    session_id: String,
    thread_id: String,
    turn: u32,
    input: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AcceptedResponse {
    assistant_text: String,
    reasoning: String,
    tool_calls: Vec<ToolCall>,
    has_tools: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolCall {
    call_id: String,
    name: String,
    arguments: String,
}

#[wasm_bindgen]
pub struct CodexBrowserCore {
    session_id: String,
    thread_id: String,
    turn: u32,
    input: Vec<Value>,
}

#[wasm_bindgen]
impl CodexBrowserCore {
    #[wasm_bindgen(constructor)]
    pub fn new(session_id: String, thread_id: String) -> Result<CodexBrowserCore, JsError> {
        validate_identity("session_id", &session_id)?;
        validate_identity("thread_id", &thread_id)?;
        Ok(Self {
            session_id,
            thread_id,
            turn: 0,
            input: Vec::new(),
        })
    }

    #[wasm_bindgen(js_name = sourceRevision)]
    pub fn source_revision() -> String {
        CODEX_SOURCE_REVISION.to_string()
    }

    #[wasm_bindgen(js_name = clientVersion)]
    pub fn client_version() -> String {
        CODEX_CLIENT_VERSION.to_string()
    }

    #[wasm_bindgen(js_name = fromSnapshot)]
    pub fn from_snapshot(snapshot: JsValue) -> Result<CodexBrowserCore, JsError> {
        let snapshot: Snapshot = from_js(snapshot)?;
        if snapshot.version != 1 || snapshot.source_revision != CODEX_SOURCE_REVISION {
            return Err(JsError::new("The Codex browser snapshot belongs to another source revision."));
        }
        validate_identity("session_id", &snapshot.session_id)?;
        validate_identity("thread_id", &snapshot.thread_id)?;
        Ok(Self {
            session_id: snapshot.session_id,
            thread_id: snapshot.thread_id,
            turn: snapshot.turn,
            input: snapshot.input,
        })
    }

    pub fn snapshot(&self) -> Result<JsValue, JsError> {
        to_js(&Snapshot {
            version: 1,
            source_revision: CODEX_SOURCE_REVISION.to_string(),
            session_id: self.session_id.clone(),
            thread_id: self.thread_id.clone(),
            turn: self.turn,
            input: self.input.clone(),
        })
    }

    #[wasm_bindgen(getter, js_name = sessionId)]
    pub fn session_id(&self) -> String {
        self.session_id.clone()
    }

    #[wasm_bindgen(getter, js_name = threadId)]
    pub fn thread_id(&self) -> String {
        self.thread_id.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn turn(&self) -> u32 {
        self.turn
    }

    /// Adds the user input and produces Codex's Responses request projection.
    #[wasm_bindgen(js_name = buildRequest)]
    pub fn build_request(
        &mut self,
        prompt: String,
        model: String,
        instructions: String,
        tools: JsValue,
        reasoning_effort: String,
    ) -> Result<JsValue, JsError> {
        if prompt.trim().is_empty() {
            return Err(JsError::new("Codex requires a non-empty prompt."));
        }
        if !valid_model(&model) {
            return Err(JsError::new("The Codex model identifier is invalid."));
        }
        if !matches!(reasoning_effort.as_str(), "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra") {
            return Err(JsError::new("The Codex reasoning effort is invalid."));
        }
        let tools: Vec<Value> = from_js(tools)?;
        if tools.len() > 64 {
            return Err(JsError::new("Codex browser sessions permit at most 64 tools."));
        }

        self.turn = self.turn.saturating_add(1);
        self.input.push(json!({
            "type": "message",
            "role": "user",
            "content": [{ "type": "input_text", "text": prompt }]
        }));

        let request = json!({
            "model": model,
            "instructions": instructions,
            "input": self.input,
            "tools": tools,
            "tool_choice": "auto",
            "parallel_tool_calls": true,
            "reasoning": {
                "effort": reasoning_effort,
                "summary": "none"
            },
            "store": false,
            "stream": true,
            "include": ["reasoning.encrypted_content"],
            "prompt_cache_key": self.thread_id,
            "text": { "verbosity": "low" },
            "client_metadata": {
                "session_id": self.session_id,
                "thread_id": self.thread_id
            }
        });
        to_js(&request)
    }

    /// Replays the model-visible output families exactly into the next request.
    #[wasm_bindgen(js_name = acceptResponse)]
    pub fn accept_response(&mut self, response: JsValue) -> Result<JsValue, JsError> {
        let response: Value = from_js(response)?;
        let output = response
            .get("output")
            .and_then(Value::as_array)
            .ok_or_else(|| JsError::new("Codex completed response is missing output."))?;
        let mut assistant_text = Vec::new();
        let mut reasoning_text = Vec::new();
        let mut tool_calls = Vec::new();

        for raw in output {
            let Some(kind) = raw.get("type").and_then(Value::as_str) else {
                continue;
            };
            match kind {
                "message" | "agent_message" => {
                    collect_text(raw.get("content"), "output_text", &mut assistant_text);
                    self.input.push(raw.clone());
                }
                "function_call" => {
                    let call = ToolCall {
                        call_id: string_field(raw, "call_id"),
                        name: string_field(raw, "name"),
                        arguments: string_field(raw, "arguments"),
                    };
                    if !call.call_id.is_empty() && !call.name.is_empty() {
                        tool_calls.push(call);
                    }
                    self.input.push(raw.clone());
                }
                "reasoning" => {
                    collect_text(raw.get("summary"), "summary_text", &mut reasoning_text);
                    collect_text(raw.get("content"), "reasoning_text", &mut reasoning_text);
                    let mut replay = raw.clone();
                    if let Some(object) = replay.as_object_mut() {
                        object.remove("status");
                    }
                    self.input.push(replay);
                }
                "custom_tool_call" | "web_search_call" | "code_interpreter_call" => {
                    self.input.push(raw.clone());
                }
                _ => {}
            }
        }

        to_js(&AcceptedResponse {
            assistant_text: assistant_text.join(""),
            reasoning: reasoning_text.join("\n"),
            has_tools: !tool_calls.is_empty(),
            tool_calls,
        })
    }

    #[wasm_bindgen(js_name = appendToolOutput)]
    pub fn append_tool_output(
        &mut self,
        call_id: String,
        output: String,
        is_error: bool,
    ) -> Result<(), JsError> {
        if call_id.trim().is_empty() {
            return Err(JsError::new("Codex tool output requires a call id."));
        }
        let rendered = if is_error {
            format!("Error: {output}")
        } else {
            output
        };
        self.input.push(json!({
            "type": "function_call_output",
            "call_id": call_id,
            "output": rendered
        }));
        Ok(())
    }

    /// Rebuilds the same request without adding another user message after tool execution.
    #[wasm_bindgen(js_name = buildContinuationRequest)]
    pub fn build_continuation_request(
        &self,
        model: String,
        instructions: String,
        tools: JsValue,
        reasoning_effort: String,
    ) -> Result<JsValue, JsError> {
        let tools: Vec<Value> = from_js(tools)?;
        let request = json!({
            "model": model,
            "instructions": instructions,
            "input": self.input,
            "tools": tools,
            "tool_choice": "auto",
            "parallel_tool_calls": true,
            "reasoning": { "effort": reasoning_effort, "summary": "none" },
            "store": false,
            "stream": true,
            "include": ["reasoning.encrypted_content"],
            "prompt_cache_key": self.thread_id,
            "text": { "verbosity": "low" },
            "client_metadata": {
                "session_id": self.session_id,
                "thread_id": self.thread_id
            }
        });
        to_js(&request)
    }
}

fn collect_text(value: Option<&Value>, expected_type: &str, output: &mut Vec<String>) {
    let Some(parts) = value.and_then(Value::as_array) else {
        return;
    };
    for part in parts {
        if part.get("type").and_then(Value::as_str) == Some(expected_type)
            && let Some(text) = part.get("text").and_then(Value::as_str)
        {
            output.push(text.to_string());
        }
    }
}

fn string_field(value: &Value, name: &str) -> String {
    value
        .get(name)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn valid_model(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= 96
        && model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn validate_identity(name: &str, value: &str) -> Result<(), JsError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(JsError::new(&format!("Codex {name} is invalid.")));
    }
    Ok(())
}

fn from_js<T: for<'de> Deserialize<'de>>(value: JsValue) -> Result<T, JsError> {
    serde_wasm_bindgen::from_value(value).map_err(|error| JsError::new(&error.to_string()))
}

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsError> {
    serde_wasm_bindgen::to_value(value).map_err(|error| JsError::new(&error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_model_names() {
        assert!(valid_model("gpt-5.6-sol"));
        assert!(!valid_model("https://example.com"));
    }

    #[test]
    fn source_revision_is_pinned() {
        assert_eq!(CODEX_SOURCE_REVISION.len(), 40);
    }
}
