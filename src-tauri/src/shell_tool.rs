use parking_lot::Mutex;
use std::collections::HashMap;
use std::time::{Duration, Instant};

const STALE_ENTRY_MS: u64 = 600_000; // 10 分钟未完成则视为孤儿，允许 GC 清理
const ABSOLUTE_MAX_WAIT_MS: u64 = 600_000; // 即使 wait_ms=0，最多等 10 分钟

struct PendingShellTool {
    started: bool,
    output: Option<String>,
    error: Option<String>,
    timed_out: bool,
    done: bool,
    created_at: Instant,
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
                created_at: Instant::now(),
            },
        );
    }

    pub fn mark_started(&self, request_id: &str) {
        if let Some(slot) = self.pending.lock().get_mut(request_id) {
            slot.started = true;
        }
    }

    /// 等待前端 Shell 标签确认已接管执行（避免 emit 后立刻 wait 而 UI 尚未写入）
    pub async fn wait_until_started(&self, request_id: &str, timeout_ms: u64) -> bool {
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
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    pub fn complete(
        &self,
        request_id: &str,
        output: String,
        timed_out: bool,
    ) -> Result<(), String> {
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

    pub async fn wait(&self, request_id: &str, wait_ms: u64) -> Result<ShellToolResult, String> {
        // wait_ms 为 0 时表示由用户主动停止，但仍强制上界避免永久挂起
        let effective_ms = if wait_ms == 0 {
            ABSOLUTE_MAX_WAIT_MS
        } else {
            wait_ms
        };
        let deadline = Instant::now() + Duration::from_millis(effective_ms);

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
                // 超时前尝试读取前端已写入的部分输出（可能已 complete 但竞态未捕获）
                let partial = {
                    let map = self.pending.lock();
                    map.get(request_id)
                        .and_then(|s| s.output.clone())
                        .unwrap_or_default()
                };
                return Ok(ShellToolResult {
                    output: partial,
                    timed_out: true,
                });
            }
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
    }

    pub fn cleanup(&self, request_id: &str) {
        self.pending.lock().remove(request_id);
    }

    /// 清理超过 STALE_ENTRY_MS 未完成的孤儿条目，防止内存泄漏
    pub fn gc_stale(&self) -> usize {
        let mut map = self.pending.lock();
        let before = map.len();
        map.retain(|_id, slot| {
            slot.done || slot.created_at.elapsed().as_millis() < STALE_ENTRY_MS as u128
        });
        before - map.len()
    }
}
