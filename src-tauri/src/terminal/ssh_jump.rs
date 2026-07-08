use parking_lot::Mutex;
use russh::client::Handle;
use std::collections::HashMap;
use std::sync::LazyLock;

use super::ssh_auth::SshClientHandler;
use super::ConnectRequest;

/// 按 owner（PTY sessionId / exec pool key 等）隔离跳板 hold，避免互相覆盖。
static JUMP_HOLDS: LazyLock<Mutex<HashMap<String, Vec<Handle<SshClientHandler>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn jump_hold_base_key(request: &ConnectRequest) -> Option<String> {
    let hops = super::resolve_jump_chain(request);
    if hops.is_empty() {
        return None;
    }
    let profile = super::resolve_profile_id(&request.sessionId);
    let route = hops
        .iter()
        .map(|h| format!("{}:{}", h.host, h.port.unwrap_or(22)))
        .collect::<Vec<_>>()
        .join("->");
    let target_port = request.port.unwrap_or(22);
    Some(format!(
        "{profile}::jump::{route}->{}:{target_port}",
        request.host
    ))
}

pub fn jump_hold_owner_key(request: &ConnectRequest, owner: &str) -> Option<String> {
    jump_hold_base_key(request).map(|base| format!("{base}::{owner}"))
}

pub fn hold_jump_sessions(key: &str, handles: Vec<Handle<SshClientHandler>>) {
    if handles.is_empty() {
        return;
    }
    JUMP_HOLDS.lock().insert(key.to_string(), handles);
}

pub fn release_jump_session(key: &str) {
    JUMP_HOLDS.lock().remove(key);
}

pub fn release_jump_for_owner(request: &ConnectRequest, owner: &str) {
    if let Some(key) = jump_hold_owner_key(request, owner) {
        release_jump_session(&key);
    }
}
