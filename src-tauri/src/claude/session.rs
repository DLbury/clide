use crate::claude::detect::resolve_claude_path;
use crate::process_util::{command_no_window, prepare_cli_discovery_environment};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

/// Windows 下 `.cmd` shim 经 `cmd /c` 传参时，系统提示中的特殊字符（`%`、`|`、换行等）
/// 会被 cmd.exe 误解析导致 Claude CLI 退出码 1。
/// 此函数绕过 cmd.exe，直接定位 `cli.js` 并用 `node.exe` 启动。
/// 返回 (program, initial_args)。
fn resolve_claude_invocation(claude_path: &str) -> (String, Vec<String>) {
    let path = PathBuf::from(claude_path);
    let is_cmd = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
        .unwrap_or(false);

    if !is_cmd {
        return (claude_path.to_string(), vec![]);
    }

    let Some(cmd_dir) = path.parent() else {
        tracing::warn!(".cmd path has no parent dir: {}", claude_path);
        return (claude_path.to_string(), vec![]);
    };

    let Some(cli_js) = locate_claude_cli_js(&path, cmd_dir) else {
        tracing::warn!("Cannot locate cli.js for .cmd bypass: {}", claude_path);
        return (claude_path.to_string(), vec![]);
    };

    let Some(program) = find_node_exe(cmd_dir) else {
        tracing::warn!("Cannot find node.exe for .cmd bypass, falling back to .cmd");
        return (claude_path.to_string(), vec![]);
    };

    tracing::info!(
        "Bypassing .cmd shim: node={}, cli.js={}",
        program,
        cli_js.display()
    );
    (program, vec![cli_js.to_string_lossy().into_owned()])
}

/// 定位 npm 全局安装的 cli.js（多种目录布局）。
fn locate_claude_cli_js(cmd_path: &Path, cmd_dir: &Path) -> Option<PathBuf> {
    if let Some(parsed) = parse_cmd_for_cli_js(cmd_path) {
        return Some(parsed);
    }

    let standard = cmd_dir
        .join("node_modules")
        .join("@anthropic-ai")
        .join("claude-code")
        .join("cli.js");
    if standard.is_file() {
        return Some(standard);
    }

    if let Ok(appdata) = std::env::var("APPDATA") {
        let global = PathBuf::from(appdata)
            .join("npm")
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code")
            .join("cli.js");
        if global.is_file() {
            return Some(global);
        }
    }

    if let Ok(home) = std::env::var("USERPROFILE") {
        let local = PathBuf::from(home)
            .join("AppData")
            .join("Roaming")
            .join("npm")
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code")
            .join("cli.js");
        if local.is_file() {
            return Some(local);
        }
    }

    None
}

/// 解析 .cmd 文件内容，提取 cli.js 路径。
/// npm 生成的 .cmd 通常包含形如：
///   "%~dp0\node.exe" "%~dp0\node_modules\@anthropic-ai\claude-code\cli.js" %*
/// 或：
///   "@ECHO off" ... "node.exe" "C:\path\to\cli.js"
#[cfg(windows)]
fn parse_cmd_for_cli_js(cmd_path: &Path) -> Option<PathBuf> {
    let content = std::fs::read_to_string(cmd_path).ok()?;
    let cmd_dir = cmd_path.parent()?;

    for line in content.lines() {
        let lower = line.to_lowercase();
        if !lower.contains("cli.js") && !lower.contains("claude-code") {
            continue;
        }

        // 提取引号内的 cli.js 路径
        for segment in extract_quoted_segments(line) {
            let normalized = segment.replace("%~dp0", &format!("{}\\", cmd_dir.display()));
            let normalized = normalized.replace("%dp0%", &format!("{}\\", cmd_dir.display()));
            let p = PathBuf::from(&normalized);
            if p.is_file() {
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if name.eq_ignore_ascii_case("cli.js") {
                    return Some(p);
                }
            }
        }

        // 尝试标准路径拼接
        let standard = cmd_dir
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code")
            .join("cli.js");
        if standard.is_file() {
            return Some(standard);
        }
    }
    None
}

#[cfg(not(windows))]
fn parse_cmd_for_cli_js(_cmd_path: &Path) -> Option<PathBuf> {
    None
}

/// 从命令行文本中提取所有双引号包裹的片段。
fn extract_quoted_segments(line: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut in_quotes = false;
    let mut current = String::new();
    for ch in line.chars() {
        if ch == '"' {
            if in_quotes {
                segments.push(std::mem::take(&mut current));
            }
            in_quotes = !in_quotes;
        } else if in_quotes {
            current.push(ch);
        }
    }
    segments
}

/// 在多个位置搜索 node.exe。
#[cfg(windows)]
fn find_node_exe(cmd_dir: &Path) -> Option<String> {
    prepare_cli_discovery_environment();
    // cmd 同目录（npm 内嵌 Node）
    let node_in_cmd_dir = cmd_dir.join("node.exe");
    if node_in_cmd_dir.is_file() {
        return Some(node_in_cmd_dir.to_string_lossy().into_owned());
    }
    // npm 根目录（cmd 在 npm/ 子目录下时）
    let node_in_parent = cmd_dir.join("..").join("node.exe");
    if node_in_parent.is_file() {
        return Some(node_in_parent.to_string_lossy().into_owned());
    }
    // npm 根目录再上一级（某些安装布局）
    let node_in_grandparent = cmd_dir.join("..").join("..").join("node.exe");
    if node_in_grandparent.is_file() {
        return Some(node_in_grandparent.to_string_lossy().into_owned());
    }
    // 系统 PATH
    if let Ok(n) = which::which("node.exe") {
        return Some(n.to_string_lossy().into_owned());
    }
    // 常见安装路径
    if let Some(home) = std::env::var_os("LOCALAPPDATA") {
        let p = PathBuf::from(home).join("fnm_multishells").join("node.exe");
        if p.is_file() { return Some(p.to_string_lossy().into_owned()); }
    }
    if let Some(home) = std::env::var_os("APPDATA") {
        for sub in &["nvm\\current", "volta"] {
            let p = PathBuf::from(home.clone()).join(sub).join("node.exe");
            if p.is_file() { return Some(p.to_string_lossy().into_owned()); }
        }
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        for sub in &[".nvm\\current\\bin", ".volta\\bin", ".fnm\\current"] {
            let p = PathBuf::from(home.clone()).join(sub).join("node.exe");
            if p.is_file() { return Some(p.to_string_lossy().into_owned()); }
        }
    }
    // Program Files
    if let Some(pf) = std::env::var_os("PROGRAMFILES") {
        let p = PathBuf::from(pf).join("nodejs").join("node.exe");
        if p.is_file() { return Some(p.to_string_lossy().into_owned()); }
    }
    None
}

#[cfg(not(windows))]
fn find_node_exe(_cmd_dir: &Path) -> Option<String> {
    prepare_cli_discovery_environment();
    which::which("node").ok().map(|p| p.to_string_lossy().into_owned())
}


/// IDE 桥接已启用时追加到 Claude，促使其调用 MCP 工具而非仅文字回答。
const IDE_BRIDGE_APPEND_PROMPT: &str = r#"You are connected to AI Terminal via IDE MCP integration (server `aiterm`).

Remote/server shell tasks — mandatory workflow:
1. Call `getFocusedServer` or `listActiveConnections` to get `profileId`.
   - `profileId` must be the stable ID from tool output; never use session name/host/shellId as `profileId`.
2. If the terminal is not connected, call `mcp__aiterm__connectServer` with that `profileId`, then `mcp__aiterm__runShellCommand`.
3. Call `mcp__aiterm__runShellCommand` with `profileId` and `command`. Use the tool JSON `output` field in your reply.
4. NEVER say you "cannot connect directly" / "无法直接连接" / "MCP 受限" / "无法远程执行" and only paste bash blocks — you CAN execute via IDE tools.
5. NEVER use local Bash/WSL/PowerShell, and NEVER use the Skill tool (skills are not MCP). Do not invoke `runShellCommand` as a skill name.

MCP tool names (server `aiterm` only): mcp__aiterm__runShellCommand, mcp__aiterm__getFocusedServer, mcp__aiterm__connectServer, mcp__aiterm__listActiveConnections, etc.
NEVER claim these tools are missing when the bridge is ready — call mcp__aiterm__runShellCommand first.

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
        let (claude_program, claude_prefix_args) = resolve_claude_invocation(&claude);
        tracing::info!(
            "Spawning Claude CLI: resolved={claude}, program={claude_program}, request_id={request_id}, bridge_port={:?}, workspace={:?}",
            bridge_port,
            workspace_dir.as_ref().map(|p| p.display().to_string())
        );

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
            // 避免 Windows cmd.exe 8191 字符限制：长 system prompt 写入临时文件
            let append_path =
                std::env::temp_dir().join(format!("clide-ide-prompt-{request_id}.txt"));
            std::fs::write(&append_path, IDE_BRIDGE_APPEND_PROMPT.as_bytes()).map_err(|e| {
                format!("无法写入 Claude IDE 提示词临时文件: {e}")
            })?;
            args.push("--append-system-prompt-file".to_string());
            args.push(append_path.display().to_string());
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

        let mut command = command_no_window(&claude_program);
        if !claude_prefix_args.is_empty() {
            command.args(&claude_prefix_args);
        }
        command
            .args(&args)
            .stdin(Stdio::null())
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
            .map_err(|e| {
                let msg = format!("启动 Claude Code 失败 ({claude}): {e}");
                tracing::error!("{msg}");
                msg
            })?;

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

        /** 共享状态：stderr 收集器 + stdout 事件计数器。
         *  当 Claude 进程 exit 0 但 stdout 未产生任何可解析事件时，
         *  将 stderr 内容作为 error 返回，避免前端显示"已结束但未返回任何内容" */
        let stderr_collector: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let unhandled_stdout: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let event_counter: Arc<AtomicUsize> = Arc::new(AtomicUsize::new(0));
        let raw_line_counter: Arc<AtomicUsize> = Arc::new(AtomicUsize::new(0));
        let stderr_for_stdout = stderr_collector.clone();
        let unhandled_for_stdout = unhandled_stdout.clone();
        let counter_for_stdout = event_counter.clone();
        let raw_counter_for_stdout = raw_line_counter.clone();

        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut session_id: Option<String> = None;

            for line in reader.lines() {
                let Ok(line) = line else { break };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                let events = parse_stream_line(trimmed, &request_stdout, &mut session_id);
                if events.is_empty() {
                    let sample = if trimmed.len() > 240 {
                        format!("{}…", &trimmed[..240])
                    } else {
                        trimmed.to_string()
                    };
                    unhandled_for_stdout.lock().push(sample);
                } else {
                    for event in events {
                        event_counter.fetch_add(1, Ordering::SeqCst);
                        let _ = app_stdout.emit("claude:stream", event);
                    }
                }
                raw_line_counter.fetch_add(1, Ordering::SeqCst);
            }

            // 等待 stderr 线程读完剩余行（进程退出后管道很快关闭）
            std::thread::sleep(std::time::Duration::from_millis(300));

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

            // 统一收集 stderr，供诊断使用
            let collected_stderr: Vec<String> = stderr_for_stdout.lock().drain(..).collect();
            let saw_events = counter_for_stdout.load(Ordering::SeqCst) > 0;

            tracing::info!(
                "Claude session ended: request_id={}, saw_events={}, stderr_lines={}, exit_error={:?}",
                request_stdout,
                saw_events,
                collected_stderr.len(),
                exit_error.as_deref().unwrap_or("(none)")
            );

            let final_error = if let Some(exit_err) = exit_error {
                // 非零退出码：总是附带 stderr 内容，帮助诊断真正的失败原因
                if !collected_stderr.is_empty() {
                    Some(format!(
                        "{exit_err}\n\n--- Claude CLI stderr ---\n{}",
                        collected_stderr.join("\n")
                    ))
                } else {
                    Some(exit_err)
                }
            } else if !saw_events {
                // exit 0 但无任何 stdout 事件：stderr 可能包含错误原因
                let raw_lines = raw_counter_for_stdout.load(Ordering::SeqCst);
                let unhandled = unhandled_for_stdout.lock().clone();
                if !collected_stderr.is_empty() {
                    Some(collected_stderr.join("\n"))
                } else if !unhandled.is_empty() {
                    Some(format!(
                        "Claude Code 输出无法解析为 stream-json。\n\n--- CLI stdout ---\n{}",
                        unhandled.join("\n")
                    ))
                } else {
                    let mut msg = "Claude Code 进程退出但未产生任何输出。请确认 CLI 已安装、已登录（claude /login）且设置中路径正确。".to_string();
                    if raw_lines > 0 {
                        msg.push_str(&format!(
                            "（CLI 输出了 {raw_lines} 行但均无法解析为 stream-json 事件，可能版本不兼容）"
                        ));
                    }
                    Some(msg)
                }
            } else {
                None
            };

            if let Some(err) = &final_error {
                let _ = app_stdout.emit(
                    "claude:stream",
                    ClaudeStreamEvent {
                        request_id: request_stdout.clone(),
                        event_type: "process_error".into(),
                        text: Some(err.clone()),
                        session_id: session_id.clone(),
                        done: false,
                        error: Some(err.clone()),
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
                    error: final_error,
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
                // 收集所有 stderr 行，供 stdout 线程在无输出时作为错误原因
                stderr_collector.lock().push(line.clone());
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

    if event_type == "system" {
        if let Some(id) = value.get("session_id").and_then(|v| v.as_str()) {
            *session_id = Some(id.to_string());
        }
        let mut ev = mk("system");
        if value.get("subtype").and_then(|v| v.as_str()) == Some("status") {
            ev.event_type = "system_status".into();
        }
        events_out.push(ev);
        return events_out;
    }

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
                        // 已通过 thinking_delta 流式推送，跳过快照避免重复
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
                        // 正文已通过 content_block_delta 流式推送；assistant 快照会重复整段文本
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
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn test_resolve_claude_invocation_with_cmd() {
        let test_dir = std::env::temp_dir().join("claude_test");
        let cmd_path = test_dir.join("claude.cmd");
        
        if !cmd_path.is_file() {
            println!("Test .cmd file not found, skipping");
            return;
        }
        
        let (program, prefix_args) = resolve_claude_invocation(&cmd_path.display().to_string());
        
        println!("Program: {}", program);
        println!("Prefix args: {:?}", prefix_args);
        
        // 应该找到 node.exe 并绕过 cmd.exe
        assert!(program.contains("node.exe"), "Should find node.exe, got: {}", program);
        assert!(!prefix_args.is_empty(), "Should have cli.js in prefix args");
        assert!(prefix_args[0].contains("cli.js"), "First arg should be cli.js path");
    }

    #[test]
    #[cfg(windows)]
    fn test_parse_cmd_for_cli_js() {
        let test_dir = std::env::temp_dir().join("claude_test");
        let cmd_path = test_dir.join("claude.cmd");
        
        if !cmd_path.is_file() {
            println!("Test .cmd file not found, skipping");
            return;
        }
        
        let result = parse_cmd_for_cli_js(&cmd_path);
        println!("Parsed cli.js path: {:?}", result);
        
        assert!(result.is_some(), "Should parse cli.js path from .cmd");
        let path = result.unwrap();
        assert!(path.to_string_lossy().contains("cli.js"), "Path should contain cli.js");
    }

    #[test]
    #[cfg(windows)]
    fn test_find_node_exe() {
        let test_dir = std::env::temp_dir().join("claude_test");
        
        let result = find_node_exe(&test_dir);
        println!("Found node.exe: {:?}", result);
        
        assert!(result.is_some(), "Should find node.exe");
        let path = result.unwrap();
        assert!(path.contains("node.exe"), "Path should contain node.exe");
    }

    #[test]
    fn test_extract_quoted_segments() {
        let line = r#""%~dp0\node.exe" "%~dp0\node_modules\@anthropic-ai\claude-code\cli.js" %*"#;
        let segments = extract_quoted_segments(line);
        
        println!("Extracted segments: {:?}", segments);
        
        assert_eq!(segments.len(), 2, "Should extract 2 quoted segments");
        assert!(segments[0].contains("node.exe"), "First segment should contain node.exe");
        assert!(segments[1].contains("cli.js"), "Second segment should contain cli.js");
    }
}