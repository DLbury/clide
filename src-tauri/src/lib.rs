pub mod app_paths;
pub mod claude;
pub mod process_util;
pub mod runtime;
pub mod secrets;
pub mod shell_tool;
pub mod state;
pub mod terminal;

use app_paths::McpBundlePaths;
use claude::bridge::ClaudeBridge;
use claude::detect::{detect_claude_binary, ClaudeAutoDetectManager, ClaudeDetectResult};
use claude::session::ClaudeSessionManager;
use parking_lot::Mutex;
use runtime::RuntimeStore;
use shell_tool::ShellToolCoordinator;
use state::IdeContext;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use terminal::{ConnectRequest, TerminalManager};

pub struct AppState {
    pub bridge: Mutex<Option<ClaudeBridge>>,
    pub sessions: ClaudeSessionManager,
    pub ide_context: Arc<Mutex<IdeContext>>,
    pub runtime: Arc<RuntimeStore>,
    pub terminals: TerminalManager,
    pub shell_tools: Arc<ShellToolCoordinator>,
    pub claude_auto_detect: Arc<ClaudeAutoDetectManager>,
}

#[tauri::command]
fn claude_detect() -> Result<ClaudeDetectResult, String> {
    Ok(detect_claude_binary())
}

#[tauri::command]
async fn claude_detect_async(
    state: State<'_, AppState>,
) -> Result<ClaudeDetectResult, String> {
    let result = state.claude_auto_detect.detect_now().await;
    Ok(result)
}

#[tauri::command]
async fn claude_start_auto_detect(
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.claude_auto_detect.start_auto_detect().await;
    Ok(())
}

#[tauri::command]
fn claude_stop_auto_detect(
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.claude_auto_detect.stop_auto_detect();
    Ok(())
}

#[tauri::command]
async fn claude_start_bridge(
    app: AppHandle,
    state: State<'_, AppState>,
    mcp_paths: State<'_, McpBundlePaths>,
    workspace_folders: Vec<String>,
    claude_path: Option<String>,
) -> Result<claude::bridge::BridgeStatus, String> {
    let mut bridge_guard = state.bridge.lock();
    if let Some(existing) = bridge_guard.as_ref() {
        if existing.is_running() {
            return Ok(existing.status());
        }
    }
    if let Some(dead) = bridge_guard.take() {
        dead.stop();
    }

    let context = state.ide_context.clone();
    let bridge = ClaudeBridge::start(app.clone(), context, workspace_folders, claude_path.clone())?;
    let status = bridge.status();
    let port = bridge.port();
    let token = bridge.auth_token().to_string();
    *bridge_guard = Some(bridge);
    let paths = (*mcp_paths).clone();
    std::thread::spawn(move || {
        claude::try_auto_register_mcp(&paths, claude_path, port, &token);
    });
    Ok(status)
}

#[tauri::command]
async fn claude_stop_bridge(state: State<'_, AppState>) -> Result<(), String> {
    let mut bridge_guard = state.bridge.lock();
    if let Some(bridge) = bridge_guard.take() {
        bridge.stop();
    }
    Ok(())
}

#[tauri::command]
fn claude_bridge_status(state: State<'_, AppState>) -> Result<Option<claude::bridge::BridgeStatus>, String> {
    let bridge_guard = state.bridge.lock();
    Ok(bridge_guard.as_ref().map(|b| b.status()))
}

#[tauri::command]
fn claude_mcp_status(
    mcp_paths: State<'_, McpBundlePaths>,
    claude_path: Option<String>,
) -> Result<claude::McpRegisterStatus, String> {
    Ok(claude::check_mcp_status(&mcp_paths, claude_path))
}

#[tauri::command]
fn claude_register_mcp(
    state: State<'_, AppState>,
    mcp_paths: State<'_, McpBundlePaths>,
    claude_path: Option<String>,
) -> Result<claude::McpRegisterStatus, String> {
    let bridge_env = {
        let bridge = state.bridge.lock();
        bridge
            .as_ref()
            .filter(|b| b.is_running())
            .map(|b| (b.port(), b.auth_token().to_string()))
    };
    let bridge_ref = bridge_env
        .as_ref()
        .map(|(p, t)| (*p, t.as_str()));
    claude::register_mcp(&mcp_paths, claude_path, bridge_ref)
}

#[tauri::command]
fn get_project_root(mcp_paths: State<'_, McpBundlePaths>) -> String {
    mcp_paths.display_root()
}

#[tauri::command]
fn claude_update_context(state: State<'_, AppState>, context: IdeContext) -> Result<(), String> {
    *state.ide_context.lock() = context;
    Ok(())
}

#[tauri::command]
fn sync_app_runtime(state: State<'_, AppState>, snapshot: runtime::RuntimeSnapshot) -> Result<(), String> {
    state.runtime.update(snapshot.clone());
    {
        let mut ide = state.ide_context.lock();
        runtime::apply_focus_to_ide_context(&mut ide, &snapshot);
    }
    Ok(())
}

#[tauri::command]
fn register_profile_auth(payload: secrets::RegisterAuthPayload) -> Result<(), String> {
    secrets::register_profile_auth(payload)
}

#[tauri::command]
fn complete_shell_tool_command(
    state: State<'_, AppState>,
    request_id: String,
    output: Option<String>,
    error: Option<String>,
) -> Result<(), String> {
    if let Some(err) = error.filter(|e| !e.is_empty()) {
        state.shell_tools.fail(&request_id, err)
    } else {
        state.shell_tools.complete(&request_id, output.unwrap_or_default())
    }
}

#[tauri::command]
async fn claude_send_message(
    app: AppHandle,
    state: State<'_, AppState>,
    mcp_paths: State<'_, McpBundlePaths>,
    prompt: String,
    claude_path: Option<String>,
    session_id: Option<String>,
    continue_session: bool,
    request_id: Option<String>,
) -> Result<String, String> {
    let bridge_info = {
        let bridge_guard = state.bridge.lock();
        bridge_guard.as_ref().filter(|b| b.is_running()).map(|b| {
            (
                b.port(),
                b.auth_token().to_string(),
                b.workspace_folders()
                    .first()
                    .map(std::path::PathBuf::from),
            )
        })
    };

    let workspace_dir = bridge_info
        .as_ref()
        .and_then(|(_, _, d)| d.clone())
        .or_else(|| {
            crate::claude::bridge::resolve_workspace_folders(&[])
                .first()
                .map(std::path::PathBuf::from)
        });

    let request_id = request_id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let (bridge_port, bridge_auth_token, workspace_dir) = match &bridge_info {
        Some((p, t, _)) => (Some(*p), Some(t.clone()), workspace_dir.clone()),
        None => (None, None, workspace_dir),
    };

    if let Some((port, token, _)) = &bridge_info {
        let _ = claude::sync_mcp_bridge_env(&mcp_paths, *port, token);
        let _ = claude::ensure_project_mcp_json(&mcp_paths, Some((*port, token.as_str())));
    } else {
        let _ = claude::ensure_project_mcp_json(&mcp_paths, None);
    }

    state.sessions.spawn(
        app,
        request_id.clone(),
        prompt,
        claude_path,
        session_id,
        continue_session,
        bridge_port,
        bridge_auth_token,
        workspace_dir,
        Some(mcp_paths.mcp_config_file.clone()),
    )?;
    Ok(request_id)
}

#[tauri::command]
fn claude_cancel_message(state: State<'_, AppState>, request_id: String) -> Result<(), String> {
    state.sessions.cancel(&request_id);
    Ok(())
}

#[tauri::command]
fn claude_cancel_all_messages(state: State<'_, AppState>) -> Result<(), String> {
    state.sessions.cancel_all();
    Ok(())
}

#[tauri::command]
async fn terminal_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ConnectRequest,
) -> Result<(), String> {
    state.terminals.connect(app, request)
}

#[tauri::command]
fn terminal_write(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    state.terminals.write(&session_id, &data)
}

#[tauri::command]
fn terminal_disconnect(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    state.terminals.disconnect(&app, &session_id)
}

#[tauri::command]
fn terminal_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.terminals.resize(&session_id, cols, rows)
}

#[tauri::command]
fn terminal_is_connected(state: State<'_, AppState>, session_id: String) -> Result<bool, String> {
    Ok(state.terminals.is_connected(&session_id))
}

#[tauri::command]
async fn terminal_list_directory(
    request: terminal::ConnectRequest,
    path: String,
    use_root: bool,
) -> Result<Vec<terminal::RemoteFileEntry>, String> {
    let request = terminal::enrich_connect_request(request);
    terminal::list_remote_directory(request, path, use_root).await
}

#[tauri::command]
async fn terminal_read_file(
    request: terminal::ConnectRequest,
    path: String,
    use_root: bool,
) -> Result<String, String> {
    let request = terminal::enrich_connect_request(request);
    terminal::read_remote_file(request, path, use_root).await
}

#[tauri::command]
async fn terminal_write_file(
    request: terminal::ConnectRequest,
    path: String,
    content: String,
    use_root: bool,
) -> Result<(), String> {
    let request = terminal::enrich_connect_request(request);
    terminal::write_remote_file(request, path, content, use_root).await
}

#[tauri::command]
async fn terminal_read_file_binary(
    request: terminal::ConnectRequest,
    path: String,
    use_root: bool,
) -> Result<String, String> {
    let request = terminal::enrich_connect_request(request);
    terminal::read_remote_file_base64(request, path, use_root).await
}

#[tauri::command]
async fn terminal_write_file_binary(
    request: terminal::ConnectRequest,
    path: String,
    content_base64: String,
    use_root: bool,
) -> Result<(), String> {
    let request = terminal::enrich_connect_request(request);
    terminal::write_remote_file_base64(request, path, content_base64, use_root).await
}

#[tauri::command]
async fn terminal_get_cwd(
    request: terminal::ConnectRequest,
    use_root: bool,
) -> Result<String, String> {
    let request = terminal::enrich_connect_request(request);
    terminal::get_remote_cwd(request, use_root).await
}

#[tauri::command]
async fn terminal_move_path(
    request: terminal::ConnectRequest,
    source: String,
    dest_dir: String,
    use_root: bool,
) -> Result<(), String> {
    let request = terminal::enrich_connect_request(request);
    terminal::move_remote_path(request, source, dest_dir, use_root).await
}

#[tauri::command]
async fn terminal_delete_path(
    request: terminal::ConnectRequest,
    path: String,
    use_root: bool,
) -> Result<(), String> {
    let request = terminal::enrich_connect_request(request);
    terminal::delete_remote_path(request, path, use_root).await
}

#[tauri::command]
async fn terminal_get_host_stats(
    request: terminal::ConnectRequest,
) -> Result<terminal::RemoteHostStats, String> {
    let request = terminal::enrich_connect_request(request);
    terminal::get_remote_host_stats(request).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            // Never block app startup on MCP scripts.
            // Desktop launchers often have a different environment; MCP may be temporarily unavailable.
            let mcp_paths = McpBundlePaths::resolve(&handle).unwrap_or_else(|e| {
                tracing::warn!("MCP paths not ready at startup: {e}");
                McpBundlePaths::fallback(&handle)
            });
            handle.manage(mcp_paths);

            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "linux")]
                {
                    // Overlay title bar is macOS-oriented; keep system decorations on Linux.
                    let _ = window.set_decorations(true);
                }
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            Ok(())
        })
        .manage(AppState {
            bridge: Mutex::new(None),
            sessions: ClaudeSessionManager::new(),
            ide_context: Arc::new(Mutex::new(IdeContext::default())),
            runtime: Arc::new(RuntimeStore::new()),
            terminals: TerminalManager::new(),
            shell_tools: Arc::new(ShellToolCoordinator::new()),
            claude_auto_detect: Arc::new(ClaudeAutoDetectManager::new()),
        })
        .invoke_handler(tauri::generate_handler![
            get_project_root,
            claude_detect,
            claude_detect_async,
            claude_start_auto_detect,
            claude_stop_auto_detect,
            claude_start_bridge,
            claude_stop_bridge,
            claude_bridge_status,
            claude_mcp_status,
            claude_register_mcp,
            claude_update_context,
            sync_app_runtime,
            register_profile_auth,
            complete_shell_tool_command,
            claude_send_message,
            claude_cancel_message,
            claude_cancel_all_messages,
            terminal_connect,
            terminal_write,
            terminal_resize,
            terminal_disconnect,
            terminal_is_connected,
            terminal_list_directory,
            terminal_read_file,
            terminal_write_file,
            terminal_read_file_binary,
            terminal_write_file_binary,
            terminal_get_cwd,
            terminal_move_path,
            terminal_delete_path,
            terminal_get_host_stats,
        ])
        .run(tauri::generate_context!())
        .map_err(|e| {
            eprintln!("Clide failed to run: {e}");
            e
        })
        .expect("error while running tauri application");
}
