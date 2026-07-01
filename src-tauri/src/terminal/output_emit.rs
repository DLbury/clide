use super::output_buffer;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputEvent {
    pub session_id: String,
    pub data: String,
}

const COALESCE_WINDOW: Duration = Duration::from_millis(16);
const MAX_BATCH_CHARS: usize = 16 * 1024;
/// 交互式终端（PSReadLine 等）小包立即推送，避免合并导致光标/退格不同步
const INTERACTIVE_IMMEDIATE_MAX: usize = 512;

struct PendingEmit {
    data: String,
    last_emit: Instant,
    flush_scheduled: bool,
}

static PENDING: LazyLock<Mutex<HashMap<String, PendingEmit>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn flush_one(app: &AppHandle, session_id: &str, payload: String) {
    if payload.is_empty() {
        return;
    }
    let _ = app.emit(
        "terminal:output",
        TerminalOutputEvent {
            session_id: session_id.to_string(),
            data: payload,
        },
    );
}

fn schedule_coalesce_flush(app: &AppHandle, session_id: &str) {
    let app = app.clone();
    let sid = session_id.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(COALESCE_WINDOW).await;
        flush_session(&app, &sid);
    });
}

/// 写入 Rust 缓冲并推送到前端。首包与空闲窗口后立即 emit，避免仅见光标；
/// 高吞吐时 16ms 内合并，减轻长任务 IPC 压力。
pub fn append_and_emit(app: &AppHandle, session_id: &str, data: &str) {
    if data.is_empty() {
        return;
    }
    output_buffer::append_terminal_output(session_id, data);

    let mut map = PENDING.lock();
    let entry = map
        .entry(session_id.to_string())
        .or_insert_with(|| PendingEmit {
            data: String::new(),
            last_emit: Instant::now() - COALESCE_WINDOW,
            flush_scheduled: false,
        });
    entry.data.push_str(data);

    let should_flush = entry.data.len() >= MAX_BATCH_CHARS
        || data.len() < INTERACTIVE_IMMEDIATE_MAX
        || entry.last_emit.elapsed() >= COALESCE_WINDOW;
    if !should_flush {
        if !entry.flush_scheduled {
            entry.flush_scheduled = true;
            let sid = session_id.to_string();
            drop(map);
            schedule_coalesce_flush(app, &sid);
        }
        return;
    }

    let payload = std::mem::take(&mut entry.data);
    entry.last_emit = Instant::now();
    entry.flush_scheduled = false;
    drop(map);
    flush_one(app, session_id, payload);
}

pub fn flush_session(app: &AppHandle, session_id: &str) {
    let payload = {
        let mut map = PENDING.lock();
        if let Some(entry) = map.get_mut(session_id) {
            entry.flush_scheduled = false;
        }
        map.remove(session_id)
            .map(|mut p| std::mem::take(&mut p.data))
    };
    if let Some(data) = payload {
        flush_one(app, session_id, data);
    }
}

pub fn flush_all(app: &AppHandle) {
    let sessions: Vec<String> = PENDING.lock().keys().cloned().collect();
    for sid in sessions {
        flush_session(app, &sid);
    }
}
