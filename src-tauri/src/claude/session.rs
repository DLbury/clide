use crate::claude::detect::resolve_claude_path;
use crate::process_util::command_no_window;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

/// IDE 桥接已启用时追加到 Claude，促使其调用 MCP 工具而非仅文字回答。
const IDE_BRIDGE_APPEND_PROMPT: &str = r#"You are connected to AI Terminal via IDE MCP integration (server `aiterm`).

Remote/server shell tasks — mandatory workflow:
1. Call `getFocusedServer` or `listActiveConnections` to get `profileId`.
   - `profileId` must be the stable ID from tool output; never use session name/host/shellId as `profileId`.
2. If the terminal is not connected, call `connectServer` with that `profileId`, then `runShellCommand`.
3. Call `runShellCommand` with `profileId` and `command`. Use the tool JSON `output` field in your reply.
4. NEVER say you "cannot connect directly" / "无法直接连接" / "MCP 受限" / "无法远程执行" and only paste bash blocks — you CAN execute via IDE tools.
5. NEVER use local Bash/WSL/PowerShell for remote SSH operations.

Tool names (IDE bridge): prefer runShellCommand/getFocusedServer/connectServer/getTerminalContext/listServerProfiles/listActiveConnections.
Compatibility aliases mcp__aiterm__* are accepted, but prefer non-prefixed names.

Sudo / interactive passwords:
- Run `sudo ...` via runShellCommand like any other command.
- NEVER ask the user to paste sudo or SSH passwords into chat, and NEVER embed passwords in commands.
- When sudo prompts for a password, tell the user to type it directly in the left Shell panel (same as a normal terminal); you cannot type it for them.
- SSH login passwords are handled by the app UI only — not by the AI.
"#;

/// --ide 模式下放行的工具。
/// 兼容部分模型偶发调用 `mcp__aiterm__*` 前缀名，避免 dontAsk 模式下被权限拒绝。
const AITERM_IDE_ALLOWED_TOOLS: &[&str] = &[
    "runShellCommand",
    "mcp__aiterm__runShellCommand",
    "connectServer",
    "mcp__aiterm__connectServer",
    "disconnectServer",
    "mcp__aiterm__disconnectServer",
    "getFocusedServer",
    "mcp__aiterm__getFocusedServer",
    "getTerminalContext",
    "mcp__aiterm__getTerminalContext",
    "listServerProfiles",
    "mcp__aiterm__listServerProfiles",
    "listActiveConnections",
    "mcp__aiterm__listActiveConnections",
    "listRemoteFiles",
    "mcp__aiterm__listRemoteFiles",
    "readRemoteFile",
    "mcp__aiterm__readRemoteFile",
    "getWorkspaceFolders",
    "mcp__aiterm__getWorkspaceFolders",
    "getOpenFiles",
    "mcp__aiterm__getOpenFiles",
    "getCurrentSelection",
    "mcp__aiterm__getCurrentSelection",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStreamEvent {
    pub request_id: String,
    pub event_type: String,
    pub text: Option<String>,
    pub session_id: Option<String>,
    pub done: bool,
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_input: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_error: Option<String>,
}

pub struct ClaudeSessionManager {
    running: Arc<Mutex<HashMap<String, std::process::Child>>>,
}

impl ClaudeSessionManager {
    pub fn new() -> Self {
        Self {
            running: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn spawn(
        &self,
        app: AppHandle,
        request_id: String,
        prompt: String,
        claude_path: Option<String>,
        session_id: Option<String>,
        continue_session: bool,
        bridge_port: Option<u16>,
        bridge_auth_token: Option<String>,
        workspace_dir: Option<PathBuf>,
        mcp_config: Option<PathBuf>,
    ) -> Result<(), String> {
        let claude = resolve_claude_path(claude_path)?;

        let mut args = vec![
            "-p".to_string(),
            prompt,
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--verbose".to_string(),
            "--include-partial-messages".to_string(),
        ];

        // 会话选择策略：
        // - 指定 session_id => --resume
        // - 用户明确继续 => --continue
        // - 其余情况不附加隔离参数（兼容不支持 --isolated 的 Claude CLI 版本）
        if let Some(sid) = session_id.filter(|s| !s.trim().is_empty()) {
            args.push("--resume".to_string());
            args.push(sid);
        } else if continue_session {
            args.push("--continue".to_string());
        }

        if bridge_port.is_some() {
            args.push("--ide".to_string());
            args.push("--permission-mode".to_string());
            args.push("dontAsk".to_string());
            for tool in AITERM_IDE_ALLOWED_TOOLS {
                args.push("--allowed-tools".to_string());
                args.push(tool.to_string());
            }
            args.push("--append-system-prompt".to_string());
            args.push(IDE_BRIDGE_APPEND_PROMPT.to_string());
        } else {
            args.push("--permission-mode".to_string());
            args.push("default".to_string());
        }

        if let Some(ref cfg) = mcp_config {
            if cfg.is_file() {
                args.push("--mcp-config".to_string());
                args.push(cfg.display().to_string());
            }
        }

        let mut command = command_no_window(&claude);
        command
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if let Some(port) = bridge_port {
            command
                .env("ENABLE_IDE_INTEGRATION", "true")
                .env("CLAUDE_CODE_SSE_PORT", port.to_string())
                .env("AITERM_IDE_PORT", port.to_string());
            if let Some(token) = bridge_auth_token {
                command.env("AITERM_IDE_AUTH_TOKEN", token);
            }
        }

        if let Some(ref cfg) = mcp_config {
            if cfg.is_file() {
                command.env("CLAUDE_MCP_CONFIG", cfg.as_os_str());
            }
        }

        if let Some(dir) = workspace_dir {
            if dir.is_dir() {
                command
                    .current_dir(&dir)
                    .env("CLAUDE_PROJECT_DIR", dir.as_os_str());
            }
        }

        let mut child = command
            .spawn()
            .map_err(|e| format!("启动 Claude Code 失败 ({claude}): {e}"))?;

        let stdout = child.stdout.take().ok_or("无法读取 Claude Code 输出")?;
        let stderr = child.stderr.take().ok_or("无法读取 Claude Code 错误输出")?;

        self.running
            .lock()
            .insert(request_id.clone(), child);

        let app_stdout = app.clone();
        let app_stderr = app.clone();
        let request_stdout = request_id.clone();
        let request_stderr = request_id.clone();
        let running = self.running.clone();

        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut session_id: Option<String> = None;

            for line in reader.lines() {
                let Ok(line) = line else { break };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                for event in parse_stream_line(trimmed, &request_stdout, &mut session_id) {
                    let _ = app_stdout.emit("claude:stream", event);
                }
            }

            let exit_error = running
                .lock()
                .remove(&request_stdout)
                .and_then(|mut child| {
                    child.wait().ok().and_then(|status| {
                        if status.success() {
                            None
                        } else {
                            Some(format!("Claude Code 进程异常退出 ({status})"))
                        }
                    })
                });

            if let Some(err) = exit_error {
                let _ = app_stdout.emit(
                    "claude:stream",
                    ClaudeStreamEvent {
                        request_id: request_stdout.clone(),
                        event_type: "process_error".into(),
                        text: Some(err.clone()),
                        session_id: session_id.clone(),
                        done: false,
                        error: Some(err),
                        reasoning: None,
                        tool_id: None,
                        tool_name: None,
                        tool_input: None,
                        tool_output: None,
                        tool_error: None,
                    },
                );
            }

            let _ = app_stdout.emit(
                "claude:stream",
                ClaudeStreamEvent {
                    request_id: request_stdout,
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
        });

        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                if line.trim().is_empty() {
                    continue;
                }
                let lower = line.to_lowercase();
                let stale = lower.contains("no conversation found")
                    || lower.contains("conversation not found");
                let fatal = !stale
                    && (lower.contains("not recognized")
                        || lower.contains("enoent")
                        || lower.contains("cannot find")
                        || lower.contains("command not found")
                        || lower.contains("error:")
                        || lower.contains("failed"));
                let stream_error = if stale || fatal {
                    Some(line.clone())
                } else {
                    None
                };
                let _ = app_stderr.emit(
                    "claude:stream",
                    ClaudeStreamEvent {
                        request_id: request_stderr.clone(),
                        event_type: if stale {
                            "session_error".into()
                        } else {
                            "stderr".into()
                        },
                        text: Some(line),
                        session_id: None,
                        done: stale || fatal,
                        error: stream_error,
                        reasoning: None,
                        tool_id: None,
                        tool_name: None,
                        tool_input: None,
                        tool_output: None,
                        tool_error: None,
                    },
                );
            }
        });

        Ok(())
    }

    pub fn cancel(&self, request_id: &str) {
        if let Some(mut child) = self.running.lock().remove(request_id) {
            let _ = child.kill();
        }
    }

    pub fn cancel_all(&self) {
        let mut guard = self.running.lock();
        for (_, mut child) in guard.drain() {
            let _ = child.kill();
        }
    }
}

fn parse_stream_line(
    line: &str,
    request_id: &str,
    session_id: &mut Option<String>,
) -> Vec<ClaudeStreamEvent> {
    let value: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let event_type = match value.get("type").and_then(|v| v.as_str()) {
        Some(t) => t.to_string(),
        None => return vec![],
    };

    let mut events_out = Vec::new();

    let sid = session_id.clone();
    let mk = |event_type: &str| ClaudeStreamEvent {
        request_id: request_id.to_string(),
        event_type: event_type.to_string(),
        text: None,
        session_id: sid.clone(),
        done: false,
        error: None,
        reasoning: None,
        tool_id: None,
        tool_name: None,
        tool_input: None,
        tool_output: None,
        tool_error: None,
    };

    if event_type == "stream_event" {
        let inner_type = value
            .pointer("/event/type")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let delta_type = value
            .pointer("/event/delta/type")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if inner_type == "content_block_delta" {
            if delta_type == "text_delta" {
                if let Some(text) = value
                    .pointer("/event/delta/text")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                {
                    let mut ev = mk("stream_event");
                    ev.text = Some(text.to_string());
                    events_out.push(ev);
                }
            } else if delta_type == "thinking_delta" {
                if let Some(thinking) = value
                    .pointer("/event/delta/thinking")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                {
                    let mut ev = mk("reasoning_delta");
                    ev.reasoning = Some(thinking.to_string());
                    events_out.push(ev);
                }
            }
        }

        return events_out;
    }

    if event_type == "assistant" {
        if let Some(arr) = value.pointer("/message/content").and_then(|c| c.as_array()) {
            for block in arr {
                match block.get("type").and_then(|t| t.as_str()) {
                    Some("thinking") => {
                        if let Some(thinking) = block.get("thinking").and_then(|v| v.as_str()) {
                            let mut ev = mk("reasoning_delta");
                            ev.reasoning = Some(thinking.to_string());
                            events_out.push(ev);
                        }
                    }
                    Some("tool_use") => {
                        let mut ev = mk("tool_start");
                        ev.tool_id = block
                            .get("id")
                            .and_then(|v| v.as_str())
                            .map(str::to_string);
                        ev.tool_name = block
                            .get("name")
                            .and_then(|v| v.as_str())
                            .map(str::to_string);
                        ev.tool_input = block.get("input").cloned();
                        events_out.push(ev);
                    }
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                            if !text.is_empty() {
                                let mut ev = mk("stream_event");
                                ev.text = Some(text.to_string());
                                events_out.push(ev);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        return events_out;
    }

    if event_type == "user" {
        if let Some(arr) = value.pointer("/message/content").and_then(|c| c.as_array()) {
            for block in arr {
                if block.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                    continue;
                }
                let mut ev = mk("tool_result");
                ev.tool_id = block
                    .get("tool_use_id")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                let is_error = block.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
                let content = tool_result_text(block);
                if is_error {
                    ev.tool_error = content;
                } else {
                    ev.tool_output = content;
                }
                events_out.push(ev);
            }
        }
        return events_out;
    }

    if event_type == "result" {
        if let Some(id) = value.get("session_id").and_then(|v| v.as_str()) {
            *session_id = Some(id.to_string());
        }
        let error = value
            .get("is_error")
            .and_then(|v| v.as_bool())
            .filter(|&e| e)
            .map(|_| {
                value
                    .get("result")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Claude Code 返回错误")
                    .to_string()
            });

        let mut ev = mk("result");
        if let Some(text) = value
            .get("result")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            ev.text = Some(text.to_string());
        }
        ev.session_id = session_id.clone();
        ev.done = true;
        ev.error = error;
        return vec![ev];
    }

    vec![]
}

fn tool_result_text(block: &Value) -> Option<String> {
    if let Some(s) = block.get("content").and_then(|v| v.as_str()) {
        return Some(s.to_string());
    }
    block
        .get("content")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|s| !s.is_empty())
}
