mod channels;
mod command_prep;
pub use command_prep::prepare_command_for_pty;
mod exec_pool;
mod local;
mod local_fs;
mod manager;
pub mod output_buffer;
mod output_emit;
pub mod remote_fs;
mod remote_process;
mod remote_stats;
mod serial;
mod socks;
mod ssh;
mod ssh_auth;
mod ssh_jump;
mod telnet;
mod tunnel;
mod utf8_chunk;

pub use local_fs::{
    get_home_dir as get_local_home_dir, list_directory as list_local_directory,
    read_file as read_local_file, write_file as write_local_file,
};
pub use manager::{push_terminal_display, TerminalManager};
pub use output_buffer::{buffer_len, export_buffer, read_since, tail_snippet};
pub use output_emit::TerminalOutputEvent;
pub use exec_pool::{clear_exec_pool, init_exec_pool};
pub use remote_fs::{
    chmod_path as chmod_remote_path, create_directory as create_remote_directory,
    delete_path as delete_remote_path, get_cwd as get_remote_cwd,
    list_directory as list_remote_directory, move_path as move_remote_path,
    read_file as read_remote_file, read_file_base64 as read_remote_file_base64,
    rename_path as rename_remote_path, search_files as search_remote_files,
    write_file as write_remote_file, write_file_base64 as write_remote_file_base64,
    RemoteFileEntry,
};
pub use remote_stats::{get_host_stats as get_remote_host_stats, RemoteHostStats};
pub use remote_process::{
    kill_port as kill_remote_port, kill_process as kill_remote_process,
    list_ports as list_remote_ports, list_processes as list_remote_processes, RemotePort,
    RemoteProcess,
};
pub use socks::{SocksInfo, SocksManager};
pub use tunnel::{TunnelInfo, TunnelManager};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JumpHostConfig {
    pub host: String,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub auth_method: Option<String>,
    /// 密码只在连接请求中入站使用，序列化（如 MCP 工具回显 profile）时一律隐去
    #[serde(skip_serializing)]
    pub password: Option<String>,
    pub private_key_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConnectRequest {
    pub sessionId: String,
    #[serde(rename = "type")]
    pub session_type: String,
    pub host: String,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub authMethod: Option<String>,
    pub password: Option<String>,
    pub privateKeyPath: Option<String>,
    pub jumpHost: Option<JumpHostConfig>,
    pub jumpHosts: Option<Vec<JumpHostConfig>>,
    // Serial specific
    #[serde(rename = "serialPort")]
    pub serial_port: Option<String>,
    #[serde(rename = "baudRate")]
    pub baud_rate: Option<u32>,
    #[serde(rename = "dataBits")]
    pub data_bits: Option<u8>,
    #[serde(rename = "stopBits")]
    pub stop_bits: Option<u8>,
    pub parity: Option<String>,
}

/// 解析跳板链：优先 `jumpHosts`，回退到单跳 `jumpHost`。
pub fn resolve_jump_chain(request: &ConnectRequest) -> Vec<JumpHostConfig> {
    if let Some(hosts) = request.jumpHosts.as_ref() {
        if !hosts.is_empty() {
            return hosts.clone();
        }
    }
    if let Some(jump) = request.jumpHost.as_ref() {
        if !jump.host.trim().is_empty() {
            return vec![jump.clone()];
        }
    }
    Vec::new()
}

/// 终端 PTY id 形如 `{profileId}::{shellId}`，凭据 vault 按 profileId 索引。
pub fn resolve_profile_id(sessionId: &str) -> &str {
    if let Some((profile, _)) = sessionId.split_once("::") {
        profile
    } else {
        sessionId
    }
}

pub fn enrich_connect_request(mut request: ConnectRequest) -> ConnectRequest {
    let profile_id = resolve_profile_id(&request.sessionId);
    let (vault_auth, vault_pass, vault_key) = crate::secrets::to_connect_auth(profile_id);
    if vault_auth.is_some() {
        request.authMethod = vault_auth;
    }
    if vault_pass.is_some() {
        request.password = vault_pass;
    }
    if vault_key.is_some() {
        request.privateKeyPath = vault_key;
    }
    request
}

pub fn expand_home(path: &str) -> String {
    if path == "~" {
        if let Some(home) = dirs::home_dir() {
            return home.to_string_lossy().into_owned();
        }
    }
    if path.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(&path[2..]).to_string_lossy().into_owned();
        }
    }
    path.to_string()
}

/// SSH/PTY 后台任务结束时从 TerminalManager 移除，否则重连会误判为已连接。
pub(crate) fn unregister_terminal_session(app: &AppHandle, session_id: &str) {
    if let Some(state) = app.try_state::<crate::AppState>() {
        state.terminals.remove_session(session_id);
    }
}
