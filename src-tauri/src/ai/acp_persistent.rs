use super::codex_persistent::{
    emit_done, emit_error, emit_reasoning, emit_text, emit_tool_result, emit_tool_start,
};
use super::ndjson_rpc::NdjsonRpcProcess;
use super::provider::AiProvider;
use crate::claude::mcp_register;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;

const RPC_TIMEOUT: Duration = Duration::from_secs(120);

struct AcpStreamState {
    message_buffer: Mutex<String>,
    reasoning_buffer: Mutex<String>,
}

impl AcpStreamState {
    fn new() -> Self {
        Self {
            message_buffer: Mutex::new(String::new()),
            reasoning_buffer: Mutex::new(String::new()),
        }
    }

    fn reset(&self) {
        *self.message_buffer.lock() = String::new();
        *self.reasoning_buffer.lock() = String::new();
    }

    fn emit_message(
        &self,
        app: &AppHandle,
        request_id: &str,
        text: &str,
        session_id: &str,
    ) {
        let delta = take_stream_delta(&self.message_buffer, text);
        if !delta.is_empty() {
            emit_text(app, request_id, &delta, Some(session_id.to_string()));
        }
    }

    fn emit_thought(
        &self,
        app: &AppHandle,
        request_id: &str,
        text: &str,
        session_id: &str,
    ) {
        let delta = take_stream_delta(&self.reasoning_buffer, text);
        if !delta.is_empty() {
            emit_reasoning(app, request_id, &delta, Some(session_id.to_string()));
        }
    }
}

/// Cursor ACP 常发送「截至目前的全文」而非纯增量；只向前端推送新增后缀。
fn take_stream_delta(buffer: &Mutex<String>, incoming: &str) -> String {
    if incoming.is_empty() {
        return String::new();
    }
    let mut buf = buffer.lock();
    if buf.is_empty() {
        *buf = incoming.to_string();
        return incoming.to_string();
    }
    if incoming.starts_with(buf.as_str()) {
        let delta = incoming[buf.len()..].to_string();
        *buf = incoming.to_string();
        return delta;
    }
    if incoming.len() <= buf.len() && buf.contains(incoming) {
        return String::new();
    }
    if buf.ends_with(incoming) {
        return String::new();
    }
    buf.push_str(incoming);
    incoming.to_string()
}

pub struct AcpPersistent {
    rpc: Arc<NdjsonRpcProcess>,
    session_id: String,
    provider: AiProvider,
    active_request: Arc<Mutex<String>>,
    stream_state: Arc<AcpStreamState>,
}

impl AcpPersistent {
    pub fn start(
        provider: AiProvider,
        executable: &str,
        workspace: Option<&Path>,
        app: &AppHandle,
        bridge: Option<(u16, &str)>,
    ) -> Result<Self, String> {
        if provider == AiProvider::Cursor {
            let _ = mcp_register::ensure_cursor_mcp_json(bridge);
            if let Some(dir) = workspace {
                let _ = mcp_register::ensure_workspace_cursor_mcp_json(dir, bridge);
            }
        }

        let rpc = match provider {
            AiProvider::OpenCode => {
                let mut args: Vec<String> = vec!["acp".into()];
                if let Some(dir) = workspace {
                    args.push("--cwd".into());
                    args.push(dir.display().to_string());
                }
                let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
                NdjsonRpcProcess::spawn(executable, &arg_refs, workspace, true)?
            }
            AiProvider::Cursor => NdjsonRpcProcess::spawn(
                executable,
                &["--approve-mcps", "acp"],
                workspace,
                true,
            )?,
            _ => return Err("ACP 仅用于 OpenCode / Cursor".into()),
        };

        rpc.request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false
                },
                "clientInfo": { "name": "aiterm", "version": env!("CARGO_PKG_VERSION") }
            }),
            RPC_TIMEOUT,
        )?;
        rpc.notify("initialized", json!({}))?;

        if provider == AiProvider::Cursor && !cursor_has_auth() {
            let _ = rpc.request(
                "authenticate",
                json!({ "methodId": "cursor_login" }),
                Duration::from_secs(30),
            );
        }

        let mcp_servers = if provider == AiProvider::Cursor {
            mcp_register::aiterm_acp_mcp_servers(bridge).unwrap_or_else(|e| {
                tracing::warn!("构建 Cursor ACP MCP 列表失败: {e}");
                json!([])
            })
        } else {
            json!([])
        };

        let mut session_params = json!({
            "mcpServers": mcp_servers
        });
        if let Some(dir) = workspace {
            session_params["cwd"] = json!(dir.display().to_string());
        }

        let result = match rpc.request("session/new", session_params.clone(), RPC_TIMEOUT) {
            Ok(result) => result,
            Err(err) if provider == AiProvider::Cursor && auth_error(&err) => {
                let _ = rpc.request(
                    "authenticate",
                    json!({ "methodId": "cursor_login" }),
                    Duration::from_secs(120),
                );
                rpc.request("session/new", session_params, RPC_TIMEOUT)?
            }
            Err(err) => return Err(err),
        };

        let session_id = result
            .pointer("/sessionId")
            .or_else(|| result.pointer("/session/id"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| "ACP session/new 未返回 session id".to_string())?
            .to_string();

        let active_request = Arc::new(Mutex::new(String::new()));
        let stream_state = Arc::new(AcpStreamState::new());
        let ar = active_request.clone();
        let ss = stream_state.clone();
        let app_emit = app.clone();
        let sid_emit = session_id.clone();

        rpc.set_notification_handler(Arc::new(move |method, params| {
            let rid = ar.lock().clone();
            if rid.is_empty() {
                return;
            }
            handle_acp_notification(method, params, &rid, &app_emit, &sid_emit, &ss);
        }));

        Ok(Self {
            rpc,
            session_id,
            provider,
            active_request,
            stream_state,
        })
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn is_alive(&self) -> bool {
        self.rpc.is_alive()
    }

    pub fn send_prompt(&self, app: &AppHandle, request_id: &str, prompt: &str) -> Result<(), String> {
        *self.active_request.lock() = request_id.to_string();
        self.stream_state.reset();

        let rpc = self.rpc.clone();
        let session_id = self.session_id.clone();
        let request_id = request_id.to_string();
        let prompt = prompt.to_string();
        let app = app.clone();

        std::thread::spawn(move || {
            let result = rpc.request(
                "session/prompt",
                json!({
                    "sessionId": session_id.clone(),
                    "prompt": [{
                        "type": "text",
                        "text": prompt
                    }]
                }),
                RPC_TIMEOUT,
            );
            match result {
                Ok(_) => emit_done(&app, &request_id, Some(session_id)),
                Err(e) => {
                    emit_error(&app, &request_id, e);
                    emit_done(&app, &request_id, Some(session_id));
                }
            }
        });

        Ok(())
    }

    pub fn cancel(&self) {
        let _ = self.rpc.request(
            "session/cancel",
            json!({ "sessionId": self.session_id }),
            Duration::from_secs(10),
        );
    }

    pub fn kill(&self) {
        self.rpc.kill();
    }

    #[allow(dead_code)]
    pub fn provider(&self) -> AiProvider {
        self.provider
    }
}

fn cursor_has_auth() -> bool {
    std::env::var("CURSOR_API_KEY")
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
        || std::env::var("CURSOR_AUTH_TOKEN")
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
}

fn auth_error(err: &str) -> bool {
    let lower = err.to_lowercase();
    lower.contains("auth")
        || lower.contains("login")
        || lower.contains("unauthorized")
        || lower.contains("not authenticated")
}

fn handle_acp_notification(
    method: &str,
    params: &Value,
    request_id: &str,
    app: &AppHandle,
    session_id: &str,
    stream_state: &AcpStreamState,
) {
    if method != "session/update" {
        return;
    }
    let update = params
        .get("update")
        .or_else(|| params.get("sessionUpdate"))
        .unwrap_or(params);

    let kind = update
        .get("sessionUpdate")
        .and_then(|v| v.as_str())
        .or_else(|| update.get("type").and_then(|v| v.as_str()))
        .unwrap_or("");

    match kind {
        "agent_message_chunk" | "agent_message" => {
            if let Some(text) = extract_text_from_update(update) {
                stream_state.emit_message(app, request_id, &text, session_id);
            }
        }
        "agent_thought_chunk" => {
            if let Some(text) = extract_text_from_update(update) {
                stream_state.emit_thought(app, request_id, &text, session_id);
            }
        }
        "tool_call" => {
            let tool_id = tool_id_from_update(update);
            if tool_id.is_empty() {
                return;
            }
            let name = tool_name_from_update(update);
            emit_tool_start(
                app,
                request_id,
                &tool_id,
                &name,
                tool_input_from_update(update),
                Some(session_id.to_string()),
            );
        }
        "tool_call_update" => {
            let tool_id = tool_id_from_update(update);
            if tool_id.is_empty() {
                return;
            }
            let status = update
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if matches!(status, "completed" | "failed" | "error" | "cancelled") {
                let (output, error) = tool_result_from_update(update, status);
                emit_tool_result(
                    app,
                    request_id,
                    &tool_id,
                    Some(tool_name_from_update(update).as_str()),
                    output,
                    error,
                    Some(session_id.to_string()),
                );
            } else if status.is_empty() || status == "running" || status == "pending" {
                emit_tool_start(
                    app,
                    request_id,
                    &tool_id,
                    &tool_name_from_update(update),
                    tool_input_from_update(update),
                    Some(session_id.to_string()),
                );
            }
        }
        "message_end" | "turn_complete" | "session_end" | "end_turn" | "turn_end" => {
            emit_done(app, request_id, Some(session_id.to_string()));
        }
        "error" => {
            let msg = update
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("ACP 会话错误");
            emit_error(app, request_id, msg.to_string());
            emit_done(app, request_id, Some(session_id.to_string()));
        }
        "user_message_chunk" => {}
        _ => {}
    }
}

fn extract_text_from_update(update: &Value) -> Option<String> {
    if let Some(text) = update
        .pointer("/content/text")
        .or_else(|| update.get("text"))
        .or_else(|| update.get("textDelta"))
        .and_then(|v| v.as_str())
    {
        if !text.is_empty() {
            return Some(text.to_string());
        }
    }
    if let Some(blocks) = update.get("content").and_then(|v| v.as_array()) {
        let mut merged = String::new();
        for block in blocks {
            if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                merged.push_str(text);
            }
        }
        if !merged.is_empty() {
            return Some(merged);
        }
    }
    None
}

fn tool_id_from_update(update: &Value) -> String {
    update
        .get("toolCallId")
        .or_else(|| update.get("tool_call_id"))
        .or_else(|| update.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn tool_name_from_update(update: &Value) -> String {
    update
        .get("title")
        .or_else(|| update.get("name"))
        .or_else(|| update.get("toolName"))
        .and_then(|v| v.as_str())
        .unwrap_or("tool")
        .to_string()
}

fn tool_input_from_update(update: &Value) -> Option<Value> {
    update
        .get("rawInput")
        .or_else(|| update.get("input"))
        .or_else(|| update.get("arguments"))
        .cloned()
}

fn tool_result_from_update(update: &Value, status: &str) -> (Option<String>, Option<String>) {
    if matches!(status, "failed" | "error" | "cancelled") {
        let err = update
            .get("error")
            .or_else(|| update.get("message"))
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .or_else(|| Some(format!("工具调用 {status}")));
        return (None, err);
    }
    if let Some(text) = extract_text_from_update(update) {
        return (Some(text), None);
    }
    if let Some(content) = update.get("content") {
        if content.is_string() {
            return (content.as_str().map(str::to_string), None);
        }
        if let Ok(serialized) = serde_json::to_string_pretty(content) {
            return (Some(serialized), None);
        }
    }
    (None, None)
}
