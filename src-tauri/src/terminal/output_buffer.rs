use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::LazyLock;

const MAX_BUFFER_CHARS: usize = 512 * 1024;

#[derive(Default)]
struct SessionBuffer {
    data: String,
    /// 已从环形缓冲前端丢弃的字符数（逻辑偏移单调递增）
    dropped: usize,
}

/// 返回 `idx`（字节偏移）之后最近的 UTF-8 字符边界（上限为字符串长度）。
/// 偏移量按字节计算，直接切片可能落在多字节字符（如中文）内部导致 panic，
/// 故所有切片前都需对齐到字符边界。
fn ceil_char_boundary(s: &str, idx: usize) -> usize {
    let mut i = idx.min(s.len());
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

impl SessionBuffer {
    fn append(&mut self, chunk: &str) {
        self.data.push_str(chunk);
        if self.data.len() > MAX_BUFFER_CHARS {
            let drop = ceil_char_boundary(&self.data, self.data.len() - MAX_BUFFER_CHARS);
            self.data.drain(..drop);
            self.dropped += drop;
        }
    }

    fn logical_len(&self) -> usize {
        self.dropped + self.data.len()
    }

    fn read_since(&self, logical_offset: usize) -> String {
        if logical_offset < self.dropped {
            return self.data.clone();
        }
        let local = logical_offset - self.dropped;
        if local >= self.data.len() {
            String::new()
        } else {
            let start = ceil_char_boundary(&self.data, local);
            self.data[start..].to_string()
        }
    }

    fn tail(&self, max_chars: usize) -> String {
        if self.data.len() <= max_chars {
            self.data.clone()
        } else {
            let start = ceil_char_boundary(&self.data, self.data.len() - max_chars);
            self.data[start..].to_string()
        }
    }
}

static BUFFERS: LazyLock<Mutex<HashMap<String, SessionBuffer>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn append_terminal_output(session_id: &str, data: &str) {
    if data.is_empty() {
        return;
    }
    let mut map = BUFFERS.lock();
    map.entry(session_id.to_string()).or_default().append(data);
}

/// 逻辑偏移（自会话开始累计，裁剪后仍单调有效）
pub fn buffer_len(session_id: &str) -> usize {
    BUFFERS
        .lock()
        .get(session_id)
        .map(|s| s.logical_len())
        .unwrap_or(0)
}

pub fn read_since(session_id: &str, logical_offset: usize) -> String {
    BUFFERS
        .lock()
        .get(session_id)
        .map(|s| s.read_since(logical_offset))
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
        .map(|s| s.tail(max_chars))
        .unwrap_or_default()
}
