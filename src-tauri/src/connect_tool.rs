use parking_lot::Mutex;
use std::collections::HashMap;
use std::time::{Duration, Instant};

const CONNECT_STALE_MS: u64 = 600_000; // 10 分钟未完成则允许 GC 清理

struct PendingConnect {
    done: bool,
    success: bool,
    error: Option<String>,
    created_at: Instant,
}

/// MCP `connectServer`：等待前端完成 SSH/终端连接后再向模型返回结果。
pub struct ConnectToolCoordinator {
    pending: Mutex<HashMap<String, PendingConnect>>,
}

impl ConnectToolCoordinator {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub fn begin(&self, request_id: String) {
        self.pending.lock().insert(
            request_id,
            PendingConnect {
                done: false,
                success: false,
                error: None,
                created_at: Instant::now(),
            },
        );
    }

    pub fn complete_success(&self, request_id: &str) -> Result<(), String> {
        let mut map = self.pending.lock();
        let slot = map
            .get_mut(request_id)
            .ok_or_else(|| format!("未知 connect 请求: {request_id}"))?;
        slot.success = true;
        slot.done = true;
        Ok(())
    }

    pub fn complete_error(&self, request_id: &str, error: String) -> Result<(), String> {
        let mut map = self.pending.lock();
        let slot = map
            .get_mut(request_id)
            .ok_or_else(|| format!("未知 connect 请求: {request_id}"))?;
        slot.error = Some(error);
        slot.done = true;
        Ok(())
    }

    pub async fn wait(&self, request_id: &str, timeout_ms: u64) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(1000));
        loop {
            {
                let map = self.pending.lock();
                let Some(slot) = map.get(request_id) else {
                    return Err(format!("未知 connect 请求: {request_id}"));
                };
                if slot.done {
                    if let Some(err) = &slot.error {
                        return Err(err.clone());
                    }
                    if slot.success {
                        return Ok(());
                    }
                    return Err("连接未完成".to_string());
                }
            }
            if Instant::now() >= deadline {
                return Err(
                    "连接超时（120s）。若需密码请在左侧 Shell 输入；完成后请重试 connectServer 或 runShellCommand"
                        .to_string(),
                );
            }
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
    }

    pub fn cleanup(&self, request_id: &str) {
        self.pending.lock().remove(request_id);
    }

    /// 清理超过 CONNECT_STALE_MS 未完成的孤儿条目，防止内存泄漏
    pub fn gc_stale(&self) -> usize {
        let mut map = self.pending.lock();
        let before = map.len();
        map.retain(|_id, slot| slot.done || slot.created_at.elapsed().as_millis() < CONNECT_STALE_MS as u128);
        before - map.len()
    }
}
