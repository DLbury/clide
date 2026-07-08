use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use crate::process_util::command_no_window;

pub type NotificationHandler = Arc<dyn Fn(&str, &Value) + Send + Sync>;

pub struct NdjsonRpcProcess {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
    notification_handler: Mutex<Option<NotificationHandler>>,
    use_jsonrpc_envelope: bool,
}

impl NdjsonRpcProcess {
    pub fn spawn(
        program: &str,
        args: &[&str],
        cwd: Option<&Path>,
        use_jsonrpc_envelope: bool,
    ) -> Result<Arc<Self>, String> {
        let mut cmd = command_no_window(program);
        cmd.args(args);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("启动 {program} 失败: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("{program} 未提供 stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("{program} 未提供 stdout"))?;

        let proc = Arc::new(Self {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            notification_handler: Mutex::new(None),
            use_jsonrpc_envelope,
        });

        let reader_proc = proc.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                reader_proc.handle_incoming(&value);
            }
        });

        Ok(proc)
    }

    pub fn set_notification_handler(&self, handler: NotificationHandler) {
        *self.notification_handler.lock() = Some(handler);
    }

    pub fn is_alive(&self) -> bool {
        matches!(self.child.lock().try_wait(), Ok(None))
    }

    pub fn kill(&self) {
        let _ = self.child.lock().kill();
    }

    pub fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().insert(id, tx);
        self.write_message(method, Some(id), params)?;

        match rx.recv_timeout(timeout) {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(e)) => Err(e),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.pending.lock().remove(&id);
                Err(format!("RPC {method} 超时（>{timeout:?}）"))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(format!("RPC {method} 通道已关闭")),
        }
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write_message(method, None, params)
    }

    fn write_message(&self, method: &str, id: Option<u64>, params: Value) -> Result<(), String> {
        let mut msg = json!({ "method": method, "params": params });
        if let Some(id) = id {
            msg["id"] = json!(id);
        }
        if self.use_jsonrpc_envelope {
            msg["jsonrpc"] = json!("2.0");
        }
        let line = serde_json::to_string(&msg).map_err(|e| e.to_string())?;
        let mut stdin = self.stdin.lock();
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("写入 stdin 失败: {e}"))
    }

    fn respond(&self, id: u64, result: Value) -> Result<(), String> {
        let mut msg = json!({ "id": id, "result": result });
        if self.use_jsonrpc_envelope {
            msg["jsonrpc"] = json!("2.0");
        }
        let line = serde_json::to_string(&msg).map_err(|e| e.to_string())?;
        let mut stdin = self.stdin.lock();
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|e| e.to_string())
    }

    fn handle_incoming(&self, value: &Value) {
        if let Some(id) = value.get("id").and_then(|v| v.as_u64()) {
            if value.get("result").is_some() || value.get("error").is_some() {
                if let Some(tx) = self.pending.lock().remove(&id) {
                    if let Some(err) = value.get("error") {
                        let msg = err
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("RPC error");
                        let _ = tx.send(Err(msg.to_string()));
                    } else {
                        let result = value.get("result").cloned().unwrap_or(Value::Null);
                        let _ = tx.send(Ok(result));
                    }
                }
                return;
            }

            if let Some(method) = value.get("method").and_then(|m| m.as_str()) {
                if let Some(result) = auto_approve_request(method) {
                    let _ = self.respond(id, result);
                } else if let Some(handler) = self.notification_handler.lock().as_ref() {
                    handler(method, value.get("params").unwrap_or(&Value::Null));
                }
            }
            return;
        }

        if let Some(method) = value.get("method").and_then(|m| m.as_str()) {
            if let Some(handler) = self.notification_handler.lock().as_ref() {
                handler(method, value.get("params").unwrap_or(&Value::Null));
            }
        }
    }
}

fn auto_approve_request(method: &str) -> Option<Value> {
    match method {
        "item/commandExecution/requestApproval"
        | "item/fileChange/requestApproval"
        | "item/permissions/requestApproval" => Some(json!({ "decision": "acceptForSession" })),
        "session/request_permission" => Some(json!({
            "outcome": { "outcome": "selected", "optionId": "allow-once" }
        })),
        "cursor/ask_question" => Some(json!({
            "outcome": { "outcome": "skipped", "reason": "aiterm headless client" }
        })),
        "cursor/create_plan" => Some(json!({
            "outcome": { "outcome": "accepted" }
        })),
        _ => None,
    }
}
