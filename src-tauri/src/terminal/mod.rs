mod channels;
mod command_prep;
pub use command_prep::prepare_command_for_pty;
mod local;
mod manager;
pub mod output_buffer;
mod output_emit;
pub mod remote_fs;
mod remote_stats;
mod ssh;
mod ssh_auth;
mod telnet;
mod serial;

pub use output_emit::TerminalOutputEvent;
pub use manager::{push_terminal_display, TerminalManager};
pub use output_buffer::{buffer_len, read_since, tail_snippet};
pub use remote_fs::{
    delete_path as delete_remote_path,
    get_cwd as get_remote_cwd,
    list_directory as list_remote_directory,
    move_path as move_remote_path,
    read_file as read_remote_file,
    read_file_base64 as read_remote_file_base64,
    write_file as write_remote_file,
    write_file_base64 as write_remote_file_base64,
    RemoteFileEntry,
};
pub use remote_stats::{get_host_stats as get_remote_host_stats, RemoteHostStats};

use serde::Deserialize;

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
    if path.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(&path[2..]).to_string_lossy().into_owned();
        }
    }
    path.to_string()
}
