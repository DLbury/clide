use super::channels::TerminalChannels;
use super::output_buffer;
use super::{local, ssh, ConnectRequest};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalStatusEvent {
    session_id: String,
    status: String,
    error: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputEvent {
    pub session_id: String,
    pub data: String,
}

/// 将文本写入会话缓冲并推送到前端 xterm（用于 Claude 工具执行等场景的可视反馈）。
pub fn push_terminal_display(app: &AppHandle, session_id: &str, data: &str) {
    output_buffer::append_terminal_output(session_id, data);
    let _ = app.emit(
        "terminal:output",
        TerminalOutputEvent {
            session_id: session_id.to_string(),
            data: data.to_string(),
        },
    );
}

struct ActiveTerminal {
    write_tx: Sender<Vec<u8>>,
    resize_tx: Sender<(u16, u16)>,
    abort: Arc<AtomicBool>,
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

    pub fn connect(&self, app: AppHandle, request: ConnectRequest) -> Result<(), String> {
        let request = super::enrich_connect_request(request);
        let session_id = request.sessionId.clone();

        if self.sessions.lock().contains_key(&session_id) {
            let _ = app.emit(
                "terminal:status",
                TerminalStatusEvent {
                    session_id: session_id.clone(),
                    status: "connected".to_string(),
                    error: None,
                },
            );
            return Ok(());
        }

        let abort = Arc::new(AtomicBool::new(false));

        let TerminalChannels { write_tx, resize_tx } = match request.session_type.as_str() {
            "ssh" => ssh::spawn_ssh(app.clone(), request, abort.clone())?,
            "local" | "wsl" => local::spawn_local_pty(app.clone(), request, abort.clone())?,
            other => {
                return Err(format!(
                    "协议「{other}」的真实连接尚未支持，当前支持 SSH、本地终端、WSL"
                ));
            }
        };

        self.sessions.lock().insert(
            session_id,
            ActiveTerminal {
                write_tx,
                resize_tx,
                abort,
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
        if let Some(active) = removed {
            active.abort.store(true, Ordering::Relaxed);
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

    pub fn is_connected(&self, session_id: &str) -> bool {
        self.sessions.lock().contains_key(session_id)
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

        let deadline = std::time::Instant::now() + Duration::from_millis(wait_ms.max(500));
        let mut last_len = offset;
        let mut stable_ticks = 0u32;

        while std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(150));
            let current_len = output_buffer::buffer_len(terminal_session_id);
            if current_len == last_len {
                stable_ticks += 1;
                if stable_ticks >= 4 {
                    break;
                }
            } else {
                stable_ticks = 0;
                last_len = current_len;
            }
        }

        Ok(output_buffer::read_since(terminal_session_id, offset))
    }
}
