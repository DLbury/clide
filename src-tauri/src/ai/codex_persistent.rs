use super::ndjson_rpc::NdjsonRpcProcess;
use crate::claude::session::ClaudeStreamEvent;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const RPC_TIMEOUT: Duration = Duration::from_secs(120);

pub struct CodexPersistent {
    rpc: Arc<NdjsonRpcProcess>,
    thread_id: String,
    active_turn_id: parking_lot::Mutex<Option<String>>,
    active_request: Arc<parking_lot::Mutex<String>>,
}

impl CodexPersistent {
    pub fn start(
        executable: &str,
        workspace: Option<&Path>,
        want_session: Option<&str>,
        app: &AppHandle,
        _request_id: &str,
    ) -> Result<Self, String> {
        let rpc = NdjsonRpcProcess::spawn(executable, &["app-server"], workspace, false)?;

        rpc.request(
            "initialize",
            json!({
                "clientInfo": { "name": "aiterm", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": {}
            }),
            RPC_TIMEOUT,
        )?;
        rpc.notify("initialized", json!({}))?;

        let thread_id = if let Some(sid) = want_session.filter(|s| !s.trim().is_empty()) {
            let result = rpc.request(
                "thread/resume",
                json!({ "threadId": sid }),
                RPC_TIMEOUT,
            )?;
            result
                .pointer("/thread/id")
                .and_then(|v| v.as_str())
                .unwrap_or(sid)
                .to_string()
        } else {
            let mut params = json!({});
            if let Some(dir) = workspace {
                params["cwd"] = json!(dir.display().to_string());
            }
            params["approvalPolicy"] = json!("onRequest");
            params["sandboxPolicy"] = json!({
                "type": "workspaceWrite",
                "networkAccess": true
            });
            let result = rpc.request("thread/start", params, RPC_TIMEOUT)?;
            result
                .pointer("/thread/id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Codex thread/start 未返回 thread id".to_string())?
                .to_string()
        };

        let active_turn_id = parking_lot::Mutex::new(None);
        let active_request = Arc::new(parking_lot::Mutex::new(String::new()));
        let turn_slot = Arc::new(parking_lot::Mutex::new(None::<String>));

        rpc.set_notification_handler(Arc::new({
            let turn_slot = turn_slot.clone();
            let active_request = active_request.clone();
            let app_emit = app.clone();
            move |method, params| {
                let rid = active_request.lock().clone();
                if rid.is_empty() {
                    return;
                }
                handle_codex_notification(method, params, &rid, &app_emit, &turn_slot);
            }
        }));

        Ok(Self {
            rpc,
            thread_id,
            active_turn_id,
            active_request,
        })
    }

    pub fn thread_id(&self) -> &str {
        &self.thread_id
    }

    pub fn is_alive(&self) -> bool {
        self.rpc.is_alive()
    }

    pub fn send_prompt(
        &self,
        request_id: &str,
        prompt: &str,
        workspace: Option<&Path>,
    ) -> Result<(), String> {
        *self.active_request.lock() = request_id.to_string();

        let mut params = json!({
            "threadId": self.thread_id,
            "input": [{ "type": "text", "text": prompt }],
            "approvalPolicy": "onRequest",
            "sandboxPolicy": {
                "type": "workspaceWrite",
                "networkAccess": true
            }
        });
        if let Some(dir) = workspace {
            params["cwd"] = json!(dir.display().to_string());
        }
        let result = self.rpc.request("turn/start", params, RPC_TIMEOUT)?;
        if let Some(tid) = result.pointer("/turn/id").and_then(|v| v.as_str()) {
            *self.active_turn_id.lock() = Some(tid.to_string());
        }
        Ok(())
    }

    pub fn cancel_turn(&self) {
        let turn_id = self.active_turn_id.lock().clone();
        if let Some(turn_id) = turn_id {
            let _ = self.rpc.request(
                "turn/interrupt",
                json!({ "threadId": self.thread_id, "turnId": turn_id }),
                Duration::from_secs(10),
            );
        }
    }

    pub fn kill(&self) {
        self.rpc.kill();
    }
}

fn handle_codex_notification(
    method: &str,
    params: &Value,
    request_id: &str,
    app: &AppHandle,
    turn_slot: &Arc<parking_lot::Mutex<Option<String>>>,
) {
    match method {
        "turn/started" => {
            if let Some(tid) = params.pointer("/turn/id").and_then(|v| v.as_str()) {
                *turn_slot.lock() = Some(tid.to_string());
            }
        }
        "item/agentMessage/delta" => {
            if let Some(delta) = params.get("delta").and_then(|v| v.as_str()) {
                if !delta.is_empty() {
                    emit_text(app, request_id, delta, None);
                }
            }
        }
        "turn/completed" => {
            let turn_id = params.pointer("/turn/id").and_then(|v| v.as_str());
            let active = turn_slot.lock().clone();
            if active.is_none() || active.as_deref() == turn_id {
                emit_done(app, request_id, None);
                *turn_slot.lock() = None;
            }
        }
        "item/started" | "item/completed" => {
            if let Some(item) = params.get("item") {
                let ty = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if ty == "agentMessage" {
                    if method == "item/completed" {
                        if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                            if !text.is_empty() {
                                emit_text(app, request_id, text, None);
                            }
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

pub fn emit_text(app: &AppHandle, request_id: &str, text: &str, session_id: Option<String>) {
    let _ = app.emit(
        "claude:stream",
        ClaudeStreamEvent {
            request_id: request_id.to_string(),
            event_type: "stream_event".into(),
            text: Some(text.to_string()),
            session_id,
            done: false,
            error: None,
            reasoning: None,
            tool_id: None,
            tool_name: None,
            tool_input: None,
            tool_output: None,
            tool_error: None,
        },
    );
}

pub fn emit_reasoning(app: &AppHandle, request_id: &str, text: &str, session_id: Option<String>) {
    let _ = app.emit(
        "claude:stream",
        ClaudeStreamEvent {
            request_id: request_id.to_string(),
            event_type: "reasoning_delta".into(),
            text: Some(text.to_string()),
            session_id,
            done: false,
            error: None,
            reasoning: Some(text.to_string()),
            tool_id: None,
            tool_name: None,
            tool_input: None,
            tool_output: None,
            tool_error: None,
        },
    );
}

pub fn emit_tool_start(
    app: &AppHandle,
    request_id: &str,
    tool_id: &str,
    tool_name: &str,
    tool_input: Option<Value>,
    session_id: Option<String>,
) {
    let _ = app.emit(
        "claude:stream",
        ClaudeStreamEvent {
            request_id: request_id.to_string(),
            event_type: "tool_start".into(),
            text: None,
            session_id,
            done: false,
            error: None,
            reasoning: None,
            tool_id: Some(tool_id.to_string()),
            tool_name: Some(tool_name.to_string()),
            tool_input,
            tool_output: None,
            tool_error: None,
        },
    );
}

pub fn emit_tool_result(
    app: &AppHandle,
    request_id: &str,
    tool_id: &str,
    tool_name: Option<&str>,
    tool_output: Option<String>,
    tool_error: Option<String>,
    session_id: Option<String>,
) {
    let _ = app.emit(
        "claude:stream",
        ClaudeStreamEvent {
            request_id: request_id.to_string(),
            event_type: "tool_result".into(),
            text: None,
            session_id,
            done: false,
            error: None,
            reasoning: None,
            tool_id: Some(tool_id.to_string()),
            tool_name: tool_name.map(str::to_string),
            tool_input: None,
            tool_output,
            tool_error,
        },
    );
}

pub fn emit_done(app: &AppHandle, request_id: &str, session_id: Option<String>) {
    let _ = app.emit(
        "claude:stream",
        ClaudeStreamEvent {
            request_id: request_id.to_string(),
            event_type: "done".into(),
            text: None,
            session_id,
            done: true,
            error: None,
            reasoning: None,
            tool_id: None,
            tool_name: None,
            tool_input: None,
            tool_output: None,
            tool_error: None,
        },
    );
}

pub fn emit_error(app: &AppHandle, request_id: &str, error: String) {
    let _ = app.emit(
        "claude:stream",
        ClaudeStreamEvent {
            request_id: request_id.to_string(),
            event_type: "session_error".into(),
            text: None,
            session_id: None,
            done: false,
            error: Some(error),
            reasoning: None,
            tool_id: None,
            tool_name: None,
            tool_input: None,
            tool_output: None,
            tool_error: None,
        },
    );
}

// silence unused import warning for AiProvider in this module if needed later

