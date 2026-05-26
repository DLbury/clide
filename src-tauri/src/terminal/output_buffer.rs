use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::LazyLock;

const MAX_BUFFER_CHARS: usize = 512 * 1024;

static BUFFERS: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn append_terminal_output(session_id: &str, data: &str) {
    let mut map = BUFFERS.lock();
    let buf = map.entry(session_id.to_string()).or_default();
    buf.push_str(data);
    if buf.len() > MAX_BUFFER_CHARS {
        let drop = buf.len() - MAX_BUFFER_CHARS;
        buf.drain(..drop);
    }
}

pub fn buffer_len(session_id: &str) -> usize {
    BUFFERS
        .lock()
        .get(session_id)
        .map(|s| s.len())
        .unwrap_or(0)
}

pub fn read_since(session_id: &str, offset: usize) -> String {
    BUFFERS
        .lock()
        .get(session_id)
        .map(|s| {
            if offset >= s.len() {
                String::new()
            } else {
                s[offset..].to_string()
            }
        })
        .unwrap_or_default()
}

pub fn clear_session(session_id: &str) {
    BUFFERS.lock().remove(session_id);
}

/// 取会话输出尾部，供 IDE 工具 / 上下文展示（最近 max_chars 个 Unicode 标量）。
pub fn tail_snippet(session_id: &str, max_chars: usize) -> String {
    BUFFERS
        .lock()
        .get(session_id)
        .map(|s| {
            if s.len() <= max_chars {
                s.clone()
            } else {
                s[s.len() - max_chars..].to_string()
            }
        })
        .unwrap_or_default()
}
