//! 原生 Rust MCP stdio 桥接：Claude Code 通过 `clide --aiterm-mcp-stdio` 拉起，无需本机 Node.js。
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::Write as _;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex as AsyncMutex;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

const PROTOCOL_VERSION: &str = "2024-11-05";
const SERVER_NAME: &str = "aiterm";
const RETRY_MS: u64 = 2500;
const STALE_MS: u64 = 60_000;
const WS_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

fn log_stderr(msg: &str) {
    let _ = writeln!(std::io::stderr(), "[clide-mcp] {msg}");
}

pub fn run_stdio_proxy() -> Result<(), String> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(2)
        .build()
        .map_err(|e| format!("创建 tokio runtime 失败: {e}"))?;
    rt.block_on(run_stdio_proxy_async())
}

fn find_bridge() -> Result<(u16, String), String> {
    if let (Ok(port_s), Ok(token)) = (
        std::env::var("AITERM_IDE_PORT"),
        std::env::var("AITERM_IDE_AUTH_TOKEN"),
    ) {
        if let Ok(port) = port_s.parse::<u16>() {
            if !token.is_empty() {
                return Ok((port, token));
            }
        }
    }

    let ide_dir = dirs::home_dir()
        .ok_or("无法定位 HOME")?
        .join(".claude")
        .join("ide");
    if !ide_dir.is_dir() {
        return Err("未找到 ~/.claude/ide，请先启动 Clide 并开启 AI 侧栏桥接".to_string());
    }

    let mut locks: Vec<(u64, u16, String)> = Vec::new();
    let entries = fs::read_dir(&ide_dir).map_err(|e| format!("读取 ide 目录失败: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("lock") {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(data) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let ide_name = data.get("ideName").and_then(|v| v.as_str()).unwrap_or("");
        if data.get("transport").and_then(|v| v.as_str()) != Some("ws") {
            continue;
        }
        if !matches!(ide_name, "clide" | "Clide" | "AI Terminal" | "AITerm") {
            continue;
        }
        let mtime = fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let port = path
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.parse::<u16>().ok());
        let token = data
            .get("authToken")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        if let (Some(port), Some(token)) = (port, token) {
            locks.push((mtime, port, token));
        }
    }

    locks.sort_by(|a, b| b.0.cmp(&a.0));
    locks
        .first()
        .map(|(_, port, token)| (*port, token.clone()))
        .ok_or_else(|| {
            "未找到 Clide IDE 桥接 lock 文件。请先启动 Clide 并确认 AI 侧栏桥接已就绪".to_string()
        })
}

type WsSink = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Message,
>;

struct BridgeRpc {
    sink: AsyncMutex<WsSink>,
    next_id: AtomicU64,
    pending: Arc<AsyncMutex<HashMap<u64, tokio::sync::oneshot::Sender<Value>>>>,
}

impl BridgeRpc {
    async fn connect(port: u16, auth_token: &str) -> Result<Arc<Self>, String> {
        let url = format!("ws://127.0.0.1:{port}");
        let mut request = url
            .into_client_request()
            .map_err(|e| format!("构建 WebSocket 请求失败: {e}"))?;
        request.headers_mut().insert(
            "x-claude-code-ide-authorization",
            HeaderValue::from_str(auth_token).map_err(|e| format!("无效 auth token: {e}"))?,
        );

        let (ws, _) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(|e| format!("无法连接 AITerm IDE 桥接 ws://127.0.0.1:{port}: {e}"))?;

        let (sink, mut stream) = ws.split();
        let pending = Arc::new(AsyncMutex::new(HashMap::new()));
        let pending_reader = pending.clone();
        let rpc = Arc::new(Self {
            sink: AsyncMutex::new(sink),
            next_id: AtomicU64::new(1),
            pending,
        });
        tokio::spawn(async move {
            while let Some(msg) = stream.next().await {
                let Ok(Message::Text(text)) = msg else {
                    continue;
                };
                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                if let Some(id) = value.get("id").and_then(|v| v.as_u64()) {
                    let mut map = pending_reader.lock().await;
                    if let Some(tx) = map.remove(&id) {
                        let _ = tx.send(value);
                    }
                }
            }
            let mut map = pending_reader.lock().await;
            for (_, tx) in map.drain() {
                let _ = tx.send(json!({"error": {"message": "AITerm 桥接连接已断开"}}));
            }
        });

        Ok(rpc)
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        self.sink
            .lock()
            .await
            .send(Message::Text(payload.to_string().into()))
            .await
            .map_err(|e| format!("发送桥接请求失败: {e}"))?;

        let response = tokio::time::timeout(WS_REQUEST_TIMEOUT, rx)
            .await
            .map_err(|_| format!("AITerm 桥接请求超时: {method}"))?
            .map_err(|_| "桥接响应通道已关闭".to_string())?;

        if let Some(err) = response.get("error") {
            let msg = err
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("桥接错误");
            return Err(msg.to_string());
        }
        Ok(response.get("result").cloned().unwrap_or(json!({})))
    }

    async fn notify(&self, method: &str, params: Value) {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        let _ = self
            .sink
            .lock()
            .await
            .send(Message::Text(payload.to_string().into()))
            .await;
    }

    async fn bootstrap(&self) -> Result<Vec<Value>, String> {
        self.request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "clide-mcp-stdio", "version": "0.1.0" },
            }),
        )
        .await?;
        self.notify("notifications/initialized", json!({})).await;
        let list = self.request("tools/list", json!({})).await?;
        Ok(list
            .get("tools")
            .and_then(|t| t.as_array())
            .cloned()
            .unwrap_or_default())
    }
}

struct ProxyState {
    rpc: AsyncMutex<Option<Arc<BridgeRpc>>>,
    upstream_key: AsyncMutex<String>,
    tools: AsyncMutex<Vec<Value>>,
    last_tool_count: AsyncMutex<usize>,
    last_success: AsyncMutex<Instant>,
}

impl ProxyState {
    fn new() -> Self {
        Self {
            rpc: AsyncMutex::new(None),
            upstream_key: AsyncMutex::new(String::new()),
            tools: AsyncMutex::new(Vec::new()),
            last_tool_count: AsyncMutex::new(0),
            last_success: AsyncMutex::new(Instant::now()),
        }
    }

    async fn ensure_upstream(&self, force: bool) -> Vec<Value> {
        if !force {
            let rpc = self.rpc.lock().await;
            let key = self.upstream_key.lock().await;
            let tools = self.tools.lock().await;
            if rpc.is_some() && !key.is_empty() && !tools.is_empty() {
                return tools.clone();
            }
        }
        self.do_connect(force).await;
        self.tools.lock().await.clone()
    }

    async fn do_connect(&self, force: bool) {
        match find_bridge() {
            Ok((port, token)) => {
                let key = format!("{port}:{token}");
                if !force {
                    let cur_key = self.upstream_key.lock().await;
                    let tools = self.tools.lock().await;
                    if self.rpc.lock().await.is_some() && *cur_key == key && !tools.is_empty() {
                        return;
                    }
                }

                if force || self.upstream_key.lock().await.as_str() != key.as_str() {
                    *self.rpc.lock().await = None;
                }

                log_stderr(&format!("桥接 ws://127.0.0.1:{port}"));
                match BridgeRpc::connect(port, &token).await {
                    Ok(rpc) => match rpc.bootstrap().await {
                        Ok(tools) => {
                            let count = tools.len();
                            *self.rpc.lock().await = Some(rpc);
                            *self.upstream_key.lock().await = key;
                            *self.tools.lock().await = tools;
                            *self.last_success.lock().await = Instant::now();
                            let mut last = self.last_tool_count.lock().await;
                            if count != *last {
                                *last = count;
                                log_stderr(&format!("已加载 {count} 个工具"));
                                write_stdout_line(&json!({
                                    "jsonrpc": "2.0",
                                    "method": "notifications/tools/list_changed"
                                }));
                            }
                        }
                        Err(e) => {
                            log_stderr(&format!("桥接 bootstrap 失败: {e}"));
                            self.reset_upstream().await;
                        }
                    },
                    Err(e) => {
                        log_stderr(&format!("上游未就绪（{RETRY_MS}ms 后重试）: {e}"));
                        self.reset_upstream().await;
                    }
                }
            }
            Err(e) => {
                log_stderr(&format!("上游未就绪（{RETRY_MS}ms 后重试）: {e}"));
                self.reset_upstream().await;
            }
        }
    }

    async fn reset_upstream(&self) {
        *self.rpc.lock().await = None;
        *self.upstream_key.lock().await = String::new();
        let had_tools = !self.tools.lock().await.is_empty();
        self.tools.lock().await.clear();
        *self.last_tool_count.lock().await = 0;
        if had_tools {
            write_stdout_line(&json!({
                "jsonrpc": "2.0",
                "method": "notifications/tools/list_changed"
            }));
        }
    }

    async fn touch_success(&self) {
        *self.last_success.lock().await = Instant::now();
    }
}

fn write_stdout_line(value: &Value) {
    let line = value.to_string();
    let mut out = std::io::stdout();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

fn reply(id: &Value, result: Value) {
    write_stdout_line(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    }));
}

fn reply_error(id: &Value, code: i32, message: &str) {
    write_stdout_line(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    }));
}

async fn handle_message(state: Arc<ProxyState>, msg: Value) {
    let id = msg.get("id").cloned();
    let Some(method) = msg.get("method").and_then(|v| v.as_str()) else {
        return;
    };
    let params = msg.get("params").cloned().unwrap_or(json!({}));

    let result: Result<(), String> = async {
        match method {
            "initialize" => {
                if let Some(ref id) = id {
                    reply(
                        id,
                        json!({
                            "protocolVersion": PROTOCOL_VERSION,
                            "capabilities": { "tools": { "listChanged": true } },
                            "serverInfo": { "name": SERVER_NAME, "version": "0.1.0" },
                        }),
                    );
                }
                let bg = state.clone();
                tokio::spawn(async move {
                    bg.ensure_upstream(false).await;
                });
                Ok(())
            }
            "notifications/initialized" => {
                state.ensure_upstream(false).await;
                Ok(())
            }
            "tools/list" => {
                let tools = state.ensure_upstream(false).await;
                if let Some(ref id) = id {
                    reply(id, json!({ "tools": tools }));
                }
                state.touch_success().await;
                Ok(())
            }
            "prompts/list" => {
                if let Some(ref id) = id {
                    reply(id, json!({ "prompts": [] }));
                }
                Ok(())
            }
            "resources/list" => {
                if let Some(ref id) = id {
                    reply(id, json!({ "resources": [] }));
                }
                Ok(())
            }
            "tools/call" => {
                let tools = state.ensure_upstream(false).await;
                let rpc = state.rpc.lock().await.clone();
                if rpc.is_none() || tools.is_empty() {
                    return Err(
                        "AITerm IDE 桥接未就绪，无法执行工具。请确认应用已启动且侧栏显示 IDE 桥接已就绪。"
                            .to_string(),
                    );
                }
                let rpc = rpc.unwrap();
                let call_result = match rpc.request("tools/call", params.clone()).await {
                    Ok(r) => Ok(r),
                    Err(_) => {
                        state.do_connect(true).await;
                        let tools = state.tools.lock().await.clone();
                        let rpc = state.rpc.lock().await.clone();
                        if rpc.is_none() || tools.is_empty() {
                            Err("AITerm IDE 桥接暂不可用，请重试".to_string())
                        } else {
                            rpc.unwrap().request("tools/call", params).await
                        }
                    }
                }?;
                if let Some(ref id) = id {
                    reply(id, call_result);
                }
                state.touch_success().await;
                Ok(())
            }
            _ => {
                if id.is_some() {
                    return Err(format!("Method not found: {method}"));
                }
                Ok(())
            }
        }
    }
    .await;

    if let Err(e) = result {
        if let Some(ref id) = id {
            let code = if e.starts_with("Method not found") {
                -32601
            } else {
                -32603
            };
            reply_error(id, code, &e);
        }
    }
}

async fn run_stdio_proxy_async() -> Result<(), String> {
    let state = Arc::new(ProxyState::new());
    let state_bg = state.clone();

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(RETRY_MS));
        loop {
            interval.tick().await;
            if state_bg.last_success.lock().await.elapsed() > Duration::from_millis(STALE_MS) {
                if state_bg.rpc.lock().await.is_some() {
                    log_stderr("桥接连接疑似静默死亡，强制重连");
                    state_bg.reset_upstream().await;
                }
            }
            if state_bg.rpc.lock().await.is_none() || state_bg.tools.lock().await.is_empty() {
                state_bg.ensure_upstream(false).await;
            }
        }
    });

    state.ensure_upstream(false).await;

    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();
    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|e| format!("读取 stdin 失败: {e}"))?
    {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        handle_message(state.clone(), msg).await;
    }
    Ok(())
}
