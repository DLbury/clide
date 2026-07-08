use super::channels::TerminalChannels;
use super::output_buffer;
use super::output_emit::{self};
use super::{local, serial, ssh, telnet, ConnectRequest};
use parking_lot::Mutex;
use portable_pty::ChildKiller;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStatusEvent {
    session_id: String,
    status: String,
    error: Option<String>,
}

/// 将文本写入会话缓冲并推送到前端 xterm（用于 Claude 工具执行等场景的可视反馈）。
pub fn push_terminal_display(app: &AppHandle, session_id: &str, data: &str) {
    output_emit::append_and_emit(app, session_id, data);
}

struct ActiveTerminal {
    write_tx: Sender<Vec<u8>>,
    resize_tx: Sender<(u16, u16)>,
    abort: Arc<AtomicBool>,
    child_killer: Option<Box<dyn ChildKiller + Send + Sync>>,
}

pub struct TerminalManager {
    sessions: Mutex<HashMap<String, ActiveTerminal>>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn remove_session(&self, session_id: &str) {
        if let Some(mut active) = self.sessions.lock().remove(session_id) {
            active.abort.store(true, Ordering::Relaxed);
            if let Some(mut killer) = active.child_killer.take() {
                let _ = killer.kill();
            }
        }
    }

    pub fn connect(&self, app: AppHandle, request: ConnectRequest) -> Result<(), String> {
        let request = super::enrich_connect_request(request);
        let session_id = request.sessionId.clone();
        tracing::info!(
            "TerminalManager::connect: session_id={}, type={}",
            session_id,
            request.session_type
        );

        let _ = app.emit(
            "terminal:status",
            TerminalStatusEvent {
                session_id: session_id.clone(),
                status: "connecting".to_string(),
                error: None,
            },
        );

        // 旧会话若仍留在 map（SSH 自然断开时常见），先终止再重连，避免误报 connected。
        if let Some(mut stale) = self.sessions.lock().remove(&session_id) {
            tracing::warn!("Replacing stale terminal session: {session_id}");
            stale.abort.store(true, Ordering::Relaxed);
            if let Some(mut killer) = stale.child_killer.take() {
                let _ = killer.kill();
            }
        }

        let abort = Arc::new(AtomicBool::new(false));

        let TerminalChannels {
            write_tx,
            resize_tx,
            child_killer,
        } = match request.session_type.as_str() {
            "ssh" => ssh::spawn_ssh(app.clone(), request, abort.clone())?,
            "telnet" => telnet::spawn_telnet(app.clone(), request, abort.clone())?,
            "serial" => serial::spawn_serial(app.clone(), request, abort.clone())?,
            "local" | "wsl" => local::spawn_local_pty(app.clone(), request, abort.clone())?,
            other => {
                return Err(format!(
                    "协议「{other}」的真实连接尚未支持，当前支持 SSH、Telnet、串口、本地终端、WSL"
                ));
            }
        };

        self.sessions.lock().insert(
            session_id,
            ActiveTerminal {
                write_tx,
                resize_tx,
                abort,
                child_killer,
            },
        );

        Ok(())
    }

    pub fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let sessions = self.sessions.lock();
        let active = sessions
            .get(session_id)
            .ok_or_else(|| "终端未连接".to_string())?;
        active
            .write_tx
            .send(data.as_bytes().to_vec())
            .map_err(|e| format!("发送数据失败: {e}"))
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        if cols == 0 || rows == 0 {
            return Ok(());
        }
        let sessions = self.sessions.lock();
        let active = sessions
            .get(session_id)
            .ok_or_else(|| "终端未连接".to_string())?;
        active
            .resize_tx
            .send((cols, rows))
            .map_err(|e| format!("同步终端尺寸失败: {e}"))
    }

    pub fn disconnect(&self, app: &AppHandle, session_id: &str) -> Result<(), String> {
        let removed = self.sessions.lock().remove(session_id);
        if let Some(mut active) = removed {
            active.abort.store(true, Ordering::Relaxed);
            if let Some(mut killer) = active.child_killer.take() {
                let _ = killer.kill();
            }
            output_emit::flush_session(app, session_id);
            let _ = app.emit(
                "terminal:status",
                TerminalStatusEvent {
                    session_id: session_id.to_string(),
                    status: "disconnected".to_string(),
                    error: None,
                },
            );
        }
        Ok(())
    }

    /// Abort every terminal session and kill local/WSL PTY shell children.
    pub fn disconnect_all(&self, app: &AppHandle) {
        let ids: Vec<String> = self.sessions.lock().keys().cloned().collect();
        for id in ids {
            let _ = self.disconnect(app, &id);
        }
    }

    pub fn is_connected(&self, session_id: &str) -> bool {
        self.sessions.lock().contains_key(session_id)
    }

    /// 向 PTY 写入命令并等待输出；同时推送到前端 xterm 显示。
    pub fn run_command_with_display(
        &self,
        app: &AppHandle,
        terminal_session_id: &str,
        command: &str,
        wait_ms: u64,
    ) -> Result<String, String> {
        if !self.is_connected(terminal_session_id) {
            tracing::warn!(
                "run_command_with_display: terminal not connected: {}",
                terminal_session_id
            );
            return Err("终端未连接".to_string());
        }

        let safe = command.replace('\x1b', "").trim().to_string();
        tracing::info!(
            "run_command_with_display: session={}, command={}",
            terminal_session_id,
            safe
        );

        if !safe.is_empty() {
            let display_line = format!("\r\n\x1b[90m[Claude Code]\x1b[0m \x1b[36m$ {safe}\x1b[0m");
            tracing::debug!("Pushing display line: {}", display_line);
            push_terminal_display(app, terminal_session_id, &display_line);
        }

        let offset = output_buffer::buffer_len(terminal_session_id);
        tracing::debug!("Buffer offset before command: {}", offset);

        let payload = if command.ends_with('\n') || command.ends_with('\r') {
            command.to_string()
        } else {
            format!("{command}\r")
        };

        tracing::debug!("Writing payload: {:?}", payload);
        self.write(terminal_session_id, &payload)?;

        let output = wait_for_command_output(terminal_session_id, offset, wait_ms);
        tracing::info!(
            "run_command_with_display: output length={}, preview={}",
            output.len(),
            output.chars().take(100).collect::<String>()
        );
        Ok(output)
    }

    /// 向 PTY 写入命令并等待输出（用于 Claude MCP tools）。
    pub fn run_command(
        &self,
        terminal_session_id: &str,
        command: &str,
        wait_ms: u64,
    ) -> Result<String, String> {
        if !self.is_connected(terminal_session_id) {
            return Err("终端未连接".to_string());
        }
        let offset = output_buffer::buffer_len(terminal_session_id);
        let payload = if command.ends_with('\n') || command.ends_with('\r') {
            command.to_string()
        } else {
            format!("{command}\r")
        };
        self.write(terminal_session_id, &payload)?;

        Ok(wait_for_command_output(
            terminal_session_id,
            offset,
            wait_ms,
        ))
    }
}

fn wait_for_command_output(terminal_session_id: &str, offset: usize, wait_ms: u64) -> String {
    // 普通命令：等待输出稳定
    wait_until_stable(terminal_session_id, wait_ms.max(500), 4);
    let output = output_buffer::read_since(terminal_session_id, offset);

    // 交互命令（sudo/password）：若检测到密码提示，再额外等待用户输入后的新输出
    if looks_like_password_prompt(&output) {
        let before_interactive = output_buffer::buffer_len(terminal_session_id);
        // 最长等 90s，让用户输入密码并回车；出现新输出后再等待稳定返回
        wait_for_new_output_then_stable(terminal_session_id, before_interactive, 90_000, 6);
        return output_buffer::read_since(terminal_session_id, offset);
    }

    output
}

fn wait_until_stable(terminal_session_id: &str, wait_ms: u64, stable_target: u32) {
    let deadline = std::time::Instant::now() + Duration::from_millis(wait_ms);
    let mut last_len = output_buffer::buffer_len(terminal_session_id);
    let mut stable_ticks = 0u32;

    while std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(150));
        let current_len = output_buffer::buffer_len(terminal_session_id);

        // 检测提示符出现（命令执行完成的标志）
        let output = output_buffer::tail_snippet(terminal_session_id, 512);
        if looks_like_shell_prompt(&output) {
            // 看到提示符了，再等一小会儿确保稳定
            std::thread::sleep(Duration::from_millis(200));
            break;
        }

        if current_len == last_len {
            stable_ticks += 1;
            if stable_ticks >= stable_target {
                break;
            }
        } else {
            stable_ticks = 0;
            last_len = current_len;
        }
    }
}

fn wait_for_new_output_then_stable(
    terminal_session_id: &str,
    start_len: usize,
    max_wait_ms: u64,
    stable_target: u32,
) {
    let deadline = std::time::Instant::now() + Duration::from_millis(max_wait_ms);
    let mut last_len = start_len;
    let mut saw_new_output = false;
    let mut stable_ticks = 0u32;

    while std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(150));
        let current_len = output_buffer::buffer_len(terminal_session_id);
        if current_len > last_len {
            saw_new_output = true;
            stable_ticks = 0;
            last_len = current_len;
            continue;
        }
        if saw_new_output && current_len == last_len {
            stable_ticks += 1;
            if stable_ticks >= stable_target {
                break;
            }
        }
    }
}

fn looks_like_password_prompt(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("password:")
        || lower.contains("password for")
        || lower.contains("[sudo]")
        || lower.contains("请输入密码")
        || lower.contains("输入密码")
        || lower.contains("密码：")
        || lower.contains("密码:")
}

/// 检测是否出现了 shell 提示符（命令执行完成的标志）
fn looks_like_shell_prompt(output: &str) -> bool {
    // 常见的提示符模式：
    // - user@host:path$ (bash)
    // - user@host:path# (root)
    // - path> (cmd/powershell)
    // - user@host path % (zsh)
    // 检测行尾的模式
    let lines: Vec<&str> = output.lines().collect();
    if lines.is_empty() {
        return false;
    }

    // 检查最后一行
    let last_line = lines.last().unwrap_or(&"");
    let trimmed = last_line.trim();

    // 如果行很短且以常见提示符结尾
    if trimmed.len() < 100 {
        // 检测 bash/zsh/fish 常见提示符
        if trimmed.ends_with('$')
            || trimmed.ends_with('#')
            || trimmed.ends_with('%')
            || trimmed.ends_with('>')
        {
            return true;
        }
        // 检测 user@host 模式
        if trimmed.contains('@') && trimmed.contains(':') {
            return true;
        }
        // 检测 Windows cmd/ps 提示符 (C:\> 或 PS C:\>)
        if trimmed.contains("::") || trimmed.starts_with("PS ") {
            return true;
        }
    }

    false
}
