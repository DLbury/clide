use super::ide_connector;
use super::tools::{self, ToolContext};
use crate::AppState;
use crate::state::IdeContext;
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::http::HeaderMap;
use tokio_tungstenite::{accept_hdr_async, tungstenite::Message};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    pub running: bool,
    pub port: u16,
    pub lock_file: String,
    pub ide_name: String,
    pub connected: bool,
    #[serde(rename = "hasClient")]
    pub has_client: bool,
    pub workspace_folders: Vec<String>,
}


pub struct ClaudeBridge {
    port: u16,
    auth_token: String,
    lock_path: PathBuf,
    workspace_folders: Vec<String>,
    shutdown: Arc<AtomicBool>,
    connected: Arc<AtomicBool>,
    client_count: Arc<AtomicUsize>,
    server_task: tokio::task::JoinHandle<()>,
    connector_task: tokio::task::JoinHandle<()>,
}

impl ClaudeBridge {
    pub fn start(
        app: AppHandle,
        ide_context: Arc<Mutex<IdeContext>>,
        workspace_folders: Vec<String>,
        _claude_path: Option<String>,
    ) -> Result<Self, String> {
        let port = portpicker::pick_unused_port().ok_or("无法分配本地端口")?;
        let auth_token = uuid::Uuid::new_v4().to_string();
        let shutdown = Arc::new(AtomicBool::new(false));
        let connected = Arc::new(AtomicBool::new(false));
        let client_count = Arc::new(AtomicUsize::new(0));

        let folders = resolve_workspace_folders(&workspace_folders);
        let lock_path = write_lock_file(port, &auth_token, &folders)?;

        let app_clone = app.clone();
        let token_clone = auth_token.clone();
        let shutdown_clone = shutdown.clone();
        let connected_clone = connected.clone();
        let client_count_clone = client_count.clone();

        let server_task = tokio::spawn(async move {
            if let Err(err) = run_server(
                port,
                token_clone,
                ide_context,
                app_clone,
                shutdown_clone,
                connected_clone,
                client_count_clone,
            )
            .await
            {
                tracing::error!("Claude IDE bridge stopped: {err}");
            }
        });

        let connector_task = ide_connector::start_keepalive_loop(
            port,
            auth_token.clone(),
            shutdown.clone(),
        );

        Ok(Self {
            port,
            auth_token,
            lock_path,
            workspace_folders: folders,
            shutdown,
            connected,
            client_count,
            server_task,
            connector_task,
        })
    }

    pub fn is_running(&self) -> bool {
        !self.shutdown.load(Ordering::SeqCst)
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn auth_token(&self) -> &str {
        &self.auth_token
    }

    pub fn workspace_folders(&self) -> &[String] {
        &self.workspace_folders
    }

    pub fn status(&self) -> BridgeStatus {
        let running = self.is_running();
        let has_client = self.connected.load(Ordering::SeqCst);
        BridgeStatus {
            running,
            port: self.port,
            lock_file: self.lock_path.display().to_string(),
            ide_name: "clide".to_string(),
            // 监听中即 MCP 可用；has_client 仅表示有 Claude/保活 WS 客户端
            connected: running,
            has_client,
            workspace_folders: self.workspace_folders.clone(),
        }
    }

    pub fn stop(self) {
        self.shutdown.store(true, Ordering::SeqCst);
        let _ = fs::remove_file(&self.lock_path);
        self.connector_task.abort();
        self.server_task.abort();
    }
}

pub fn resolve_workspace_folders(workspace_folders: &[String]) -> Vec<String> {
    if !workspace_folders.is_empty() {
        return workspace_folders.to_vec();
    }
    if let Ok(dir) = std::env::current_dir() {
        // `tauri dev` 时 cwd 常为 src-tauri，Claude 需匹配仓库根目录
        if dir.file_name().and_then(|n| n.to_str()) == Some("src-tauri") {
            if let Some(parent) = dir.parent() {
                return vec![parent.to_string_lossy().into_owned()];
            }
        }
        return vec![dir.to_string_lossy().into_owned()];
    }
    dirs::home_dir()
        .map(|h| vec![h.to_string_lossy().into_owned()])
        .unwrap_or_default()
}

/// 移除本应用遗留的 lock，避免 Claude 连到已关闭的旧端口
fn clean_aiterm_lock_files(ide_dir: &std::path::Path) -> Result<(), String> {
    let entries = match fs::read_dir(ide_dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("lock") {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        if content.contains("\"ideName\": \"clide\"")
            || content.contains("\"ideName\":\"clide\"")
            || content.contains("\"ideName\": \"AI Terminal\"")
            || content.contains("\"ideName\":\"AI Terminal\"")
        {
            let _ = fs::remove_file(&path);
        }
    }
    Ok(())
}

fn write_lock_file(
    port: u16,
    auth_token: &str,
    workspace_folders: &[String],
) -> Result<PathBuf, String> {
    let ide_dir = dirs::home_dir()
        .ok_or("无法定位用户目录")?
        .join(".claude")
        .join("ide");
    fs::create_dir_all(&ide_dir).map_err(|e| e.to_string())?;
    clean_aiterm_lock_files(&ide_dir)?;

    let folders = resolve_workspace_folders(workspace_folders);
    let lock_path = ide_dir.join(format!("{port}.lock"));
    let lock_data = json!({
        "pid": std::process::id(),
        "workspaceFolders": folders,
        "ideName": "clide",
        "transport": "ws",
        "authToken": auth_token,
        "mcpServerInfo": {
            "name": "aiterm",
            "version": "0.1.0"
        }
    });
    let json = serde_json::to_string_pretty(&lock_data).map_err(|e| e.to_string())?;
    fs::write(&lock_path, json)
        .map_err(|e| e.to_string())?;
    Ok(lock_path)
}

fn register_client(
    client_count: &AtomicUsize,
    connected: &AtomicBool,
    app: &AppHandle,
) {
    if client_count.fetch_add(1, Ordering::SeqCst) == 0 {
        connected.store(true, Ordering::SeqCst);
        let _ = app.emit("claude:bridge-connected", ());
        tracing::info!("Claude IDE bridge: client connected");
    }
}

fn unregister_client(client_count: &AtomicUsize, connected: &AtomicBool) {
    if client_count.fetch_sub(1, Ordering::SeqCst) == 1 {
        connected.store(false, Ordering::SeqCst);
        tracing::info!("Claude IDE bridge: all clients disconnected");
    }
}

async fn run_server(
    port: u16,
    auth_token: String,
    ide_context: Arc<Mutex<IdeContext>>,
    app: AppHandle,
    shutdown: Arc<AtomicBool>,
    connected: Arc<AtomicBool>,
    client_count: Arc<AtomicUsize>,
) -> Result<(), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = TcpListener::bind(addr).await.map_err(|e| e.to_string())?;
    tracing::info!("Claude IDE bridge listening on 127.0.0.1:{port}");

    loop {
        if shutdown.load(Ordering::SeqCst) {
            break;
        }

        let accept = tokio::select! {
            res = listener.accept() => res,
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(200)) => {
                continue;
            }
        };

        let (stream, _) = accept.map_err(|e| e.to_string())?;
        let token = auth_token.clone();
        let ctx = ide_context.clone();
        let app_handle = app.clone();
        let connected_flag = connected.clone();
        let client_count_flag = client_count.clone();

        tokio::spawn(async move {
            if let Err(err) = handle_connection(
                stream,
                token,
                ctx,
                app_handle,
                connected_flag,
                client_count_flag,
            )
            .await
            {
                tracing::warn!("IDE bridge connection error: {err}");
            }
        });
    }

    Ok(())
}

async fn handle_connection(
    stream: TcpStream,
    auth_token: String,
    _ide_context: Arc<Mutex<IdeContext>>,
    app: AppHandle,
    connected: Arc<AtomicBool>,
    client_count: Arc<AtomicUsize>,
) -> Result<(), String> {
    let expected = auth_token.clone();
    let ws_stream = accept_hdr_async(stream, |req: &Request, response: Response| {
        if !is_authorized(req, &expected) {
            tracing::warn!("Rejected Claude IDE bridge connection: invalid auth token");
            let reject = tokio_tungstenite::tungstenite::http::Response::builder()
                .status(401)
                .body(None)
                .map_err(|_| {
                    tokio_tungstenite::tungstenite::http::Response::builder()
                        .status(500)
                        .body(None)
                        .unwrap_or_else(|_| tokio_tungstenite::tungstenite::http::Response::new(None))
                })?;
            return Err(reject);
        }
        Ok(response)
    })
    .await
    .map_err(|e| e.to_string())?;

    register_client(&client_count, &connected, &app);

    let (mut write, mut read) = ws_stream.split();

    let result = async {
        while let Some(msg) = read.next().await {
            let msg = msg.map_err(|e| e.to_string())?;
            if !msg.is_text() {
                continue;
            }

            let text = msg.to_text().map_err(|e| e.to_string())?;
            let value: Value = serde_json::from_str(text).unwrap_or(json!({}));

            let outbound = handle_mcp_message(&value, &app);
            if let Some(response) = outbound.response {
                write
                    .send(Message::Text(response.to_string().into()))
                    .await
                    .map_err(|e| e.to_string())?;
            }
            for notification in outbound.notifications {
                write
                    .send(Message::Text(notification.to_string().into()))
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok::<(), String>(())
    }
    .await;

    unregister_client(&client_count, &connected);
    result
}

fn is_authorized(req: &Request, expected: &str) -> bool {
    let headers: &HeaderMap = req.headers();
    if let Some(value) = headers
        .get("x-claude-code-ide-authorization")
        .or_else(|| headers.get("X-Claude-Code-Ide-Authorization"))
        .and_then(|v| v.to_str().ok())
    {
        if value == expected {
            return true;
        }
    }
    if let Some(value) = headers
        .get("authorization")
        .or_else(|| headers.get("Authorization"))
        .and_then(|v| v.to_str().ok())
    {
        if value == format!("Bearer {expected}") || value == expected {
            return true;
        }
    }
    false
}

struct McpOutbound {
    response: Option<Value>,
    notifications: Vec<Value>,
}

fn tools_list_changed_notification() -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "notifications/tools/list_changed"
    })
}

fn handle_mcp_message(message: &Value, app: &AppHandle) -> McpOutbound {
    let Some(method) = message.get("method").and_then(|v| v.as_str()) else {
        return McpOutbound {
            response: None,
            notifications: vec![],
        };
    };
    let id = message.get("id").cloned();

    match method {
        "initialize" => {
            tracing::info!("IDE MCP: initialize");
            McpOutbound {
                response: Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {
                            "tools": { "listChanged": true },
                            "resources": { "subscribe": false, "listChanged": false },
                            "prompts": { "listChanged": false }
                        },
                        "serverInfo": { "name": "aiterm-ide", "version": "0.1.0" }
                    }
                })),
                notifications: vec![tools_list_changed_notification()],
            }
        }
        "notifications/initialized" => {
            tracing::info!("IDE MCP: client initialized");
            McpOutbound {
                response: None,
                notifications: vec![tools_list_changed_notification()],
            }
        }
        "tools/list" => {
            let tool_list = tools::get_available_tools();
            tracing::info!("IDE MCP: tools/list -> {} tools", tool_list.len());
            McpOutbound {
                response: Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "tools": tool_list }
                })),
                notifications: vec![],
            }
        }
        "prompts/list" => McpOutbound {
            response: Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "prompts": [] }
            })),
            notifications: vec![],
        },
        "resources/list" => McpOutbound {
            response: Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "resources": [] }
            })),
            notifications: vec![],
        },
        "tools/call" => {
            let Some(params) = message.get("params") else {
                return McpOutbound {
                    response: Some(json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": -32602, "message": "missing params" }
                    })),
                    notifications: vec![],
                };
            };
            let Some(name) = params.get("name").and_then(|v| v.as_str()) else {
                return McpOutbound {
                    response: Some(json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": -32602, "message": "missing tool name" }
                    })),
                    notifications: vec![],
                };
            };
            tracing::info!("IDE MCP: tools/call {name}");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let state = app.state::<AppState>();
            let tool_ctx = ToolContext {
                app,
                ide_context: &state.ide_context,
                runtime: &state.runtime,
                terminals: &state.terminals,
                shell_tools: &state.shell_tools,
            };
            let result = tools::execute_tool(&tool_ctx, name, &args);
            McpOutbound {
                response: Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [{ "type": "text", "text": result }],
                        "isError": result.contains("\"success\":false")
                    }
                })),
                notifications: vec![],
            }
        }
        "ping" => McpOutbound {
            response: Some(json!({ "jsonrpc": "2.0", "id": id, "result": {} })),
            notifications: vec![],
        },
        _ if id.is_some() => McpOutbound {
            response: Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {
                    "code": -32601,
                    "message": format!("Method not found: {method}")
                }
            })),
            notifications: vec![],
        },
        _ => McpOutbound {
            response: None,
            notifications: vec![],
        },
    }
}

#[derive(Debug, Deserialize)]
struct SelectionChangedParams {
    #[serde(default)]
    text: String,
    #[serde(default)]
    file_path: Option<String>,
}

pub fn selection_changed_payload(params: SelectionChangedParams) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "selection_changed",
        "params": {
            "text": params.text,
            "filePath": params.file_path,
        }
    })
}
