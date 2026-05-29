use parking_lot::Mutex;
use std::collections::HashMap;
use std::time::{Duration, Instant};

struct PendingShellTool {
    started: bool,
    output: Option<String>,
    error: Option<String>,
    timed_out: bool,
    done: bool,
}

/// Claude MCP `run_shell_command`：由前端 Shell 标签写入并回传输出，Rust 仅协调等待。
pub struct ShellToolCoordinator {
    pending: Mutex<HashMap<String, PendingShellTool>>,
}

pub struct ShellToolResult {
    pub output: String,
    pub timed_out: bool,
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
                started: false,
                output: None,
                error: None,
                timed_out: false,
                done: false,
            },
        );
    }

    pub fn mark_started(&self, request_id: &str) {
        if let Some(slot) = self.pending.lock().get_mut(request_id) {
            slot.started = true;
        }
    }

    /// 等待前端 Shell 标签确认已接管执行（避免 emit 后立刻 wait 而 UI 尚未写入）
    pub fn wait_until_started(&self, request_id: &str, timeout_ms: u64) -> bool {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(100));
        loop {
            {
                let map = self.pending.lock();
                let Some(slot) = map.get(request_id) else {
                    return false;
                };
                if slot.started {
                    return true;
                }
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    pub fn complete(&self, request_id: &str, output: String, timed_out: bool) -> Result<(), String> {
        let mut map = self.pending.lock();
        let slot = map
            .get_mut(request_id)
            .ok_or_else(|| format!("未知 shell tool 请求: {request_id}"))?;
        slot.output = Some(output);
        slot.timed_out = timed_out;
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

    pub fn wait(&self, request_id: &str, wait_ms: u64) -> Result<ShellToolResult, String> {
        // 防止模型给出极大 waitMs 导致界面长时间卡住。
        let actual_wait_ms = wait_ms.clamp(5_000, 60_000);
        let deadline = Instant::now() + Duration::from_millis(actual_wait_ms);

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
                    return Ok(ShellToolResult {
                        output: slot.output.clone().unwrap_or_default(),
                        timed_out: slot.timed_out,
                    });
                }
            }
            if Instant::now() >= deadline {
                // 后端等待超时：由调用方决定如何对模型提示（不强制标记失败）
                return Ok(ShellToolResult {
                    output: String::new(),
                    timed_out: true,
                });
            }
            std::thread::sleep(Duration::from_millis(80));
        }
    }

    pub fn cleanup(&self, request_id: &str) {
        self.pending.lock().remove(request_id);
    }
}
