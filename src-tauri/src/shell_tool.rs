use parking_lot::Mutex;
use std::collections::HashMap;
use std::time::{Duration, Instant};

struct PendingShellTool {
    output: Option<String>,
    error: Option<String>,
    done: bool,
}

/// Claude MCP `run_shell_command`：由前端 Shell 标签写入并回传输出，Rust 仅协调等待。
pub struct ShellToolCoordinator {
    pending: Mutex<HashMap<String, PendingShellTool>>,
}

impl ShellToolCoordinator {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub fn begin(&self, request_id: String) {
        self.pending.lock().insert(
            request_id,
            PendingShellTool {
                output: None,
                error: None,
                done: false,
            },
        );
    }

    pub fn complete(&self, request_id: &str, output: String) -> Result<(), String> {
        let mut map = self.pending.lock();
        let slot = map
            .get_mut(request_id)
            .ok_or_else(|| format!("未知 shell tool 请求: {request_id}"))?;
        slot.output = Some(output);
        slot.done = true;
        Ok(())
    }

    pub fn fail(&self, request_id: &str, error: String) -> Result<(), String> {
        let mut map = self.pending.lock();
        let slot = map
            .get_mut(request_id)
            .ok_or_else(|| format!("未知 shell tool 请求: {request_id}"))?;
        slot.error = Some(error);
        slot.done = true;
        Ok(())
    }

    pub fn wait(&self, request_id: &str, wait_ms: u64) -> Result<String, String> {
        let deadline = Instant::now() + Duration::from_millis(wait_ms.max(500));
        loop {
            {
                let map = self.pending.lock();
                let Some(slot) = map.get(request_id) else {
                    return Err(format!("未知 shell tool 请求: {request_id}"));
                };
                if slot.done {
                    if let Some(err) = &slot.error {
                        return Err(err.clone());
                    }
                    return Ok(slot.output.clone().unwrap_or_default());
                }
            }
            if Instant::now() >= deadline {
                let msg = format!("等待 Shell 标签输出超时 ({wait_ms}ms)");
                let _ = self.fail(request_id, msg.clone());
                return Err(msg);
            }
            std::thread::sleep(Duration::from_millis(80));
        }
    }

    pub fn cleanup(&self, request_id: &str) {
        self.pending.lock().remove(request_id);
    }
}
