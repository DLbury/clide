use super::output_buffer;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputEvent {
    pub session_id: String,
    pub data: String,
}

const MAX_BATCH_CHARS: usize = 16 * 1024;
const FLUSH_INTERVAL: Duration = Duration::from_millis(48);

struct PendingEmit {
    data: String,
    last_flush: Instant,
}

static PENDING: LazyLock<Mutex<HashMap<String, PendingEmit>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static SWEEPER_STARTED: AtomicBool = AtomicBool::new(false);

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

fn ensure_sweeper(app: &AppHandle) {
    if SWEEPER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(FLUSH_INTERVAL);
            flush_stale(&app);
        }
    });
}

/// 将超时未刷新的 pending 数据推送到前端（防止首屏提示符等单次小包永远卡在缓冲里）。
fn flush_stale(app: &AppHandle) {
    let batches: Vec<(String, String)> = {
        let mut map = PENDING.lock();
        let mut out = Vec::new();
        for (sid, entry) in map.iter_mut() {
            if entry.data.is_empty() {
                continue;
            }
            if entry.last_flush.elapsed() >= FLUSH_INTERVAL {
                out.push((sid.clone(), std::mem::take(&mut entry.data)));
                entry.last_flush = Instant::now();
            }
        }
        out
    };
    for (sid, payload) in batches {
        flush_one(app, &sid, payload);
    }
}

/// 写入 Rust 缓冲并按批次推送到前端，避免高输出长任务时 IPC 风暴导致 WebView 崩溃。
pub fn append_and_emit(app: &AppHandle, session_id: &str, data: &str) {
    if data.is_empty() {
        return;
    }
    ensure_sweeper(app);
    output_buffer::append_terminal_output(session_id, data);

    let mut map = PENDING.lock();
    let entry = map
        .entry(session_id.to_string())
        .or_insert_with(|| PendingEmit {
            data: String::new(),
            // 新会话首包立即刷新，避免 PowerShell/SSH 提示符只输出一次后永远不可见
            last_flush: Instant::now() - FLUSH_INTERVAL,
        });
    entry.data.push_str(data);

    let should_flush = entry.data.len() >= MAX_BATCH_CHARS
        || entry.last_flush.elapsed() >= FLUSH_INTERVAL;
    if !should_flush {
        return;
    }

    let payload = std::mem::take(&mut entry.data);
    entry.last_flush = Instant::now();
    drop(map);
    flush_one(app, session_id, payload);
}

pub fn flush_session(app: &AppHandle, session_id: &str) {
    let payload = {
        let mut map = PENDING.lock();
        map.remove(session_id).map(|mut p| std::mem::take(&mut p.data))
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
