use crate::state::IdeContext;
use crate::terminal::tail_snippet;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub profiles: Vec<ProfileSnapshot>,
    pub connections: Vec<ConnectionSnapshot>,
    pub active_connection_id: Option<String>,
    pub active_shell_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSnapshot {
    pub id: String,
    pub name: String,
    pub host: String,
    pub user: Option<String>,
    #[serde(rename = "type")]
    pub session_type: String,
    pub status: String,
    pub port: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSnapshot {
    pub id: String,
    pub profile_id: String,
    pub profile_name: String,
    pub host: String,
    pub active_shell_id: String,
    pub shells: Vec<ShellSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSnapshot {
    pub id: String,
    pub name: String,
    pub terminal_session_id: String,
    pub terminal_status: Option<String>,
}

pub struct RuntimeStore {
    inner: Mutex<RuntimeSnapshot>,
}

impl RuntimeStore {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(RuntimeSnapshot::default()),
        }
    }

    pub fn update(&self, snapshot: RuntimeSnapshot) {
        *self.inner.lock() = snapshot;
    }

    pub fn get(&self) -> RuntimeSnapshot {
        self.inner.lock().clone()
    }

    pub fn active_profile_id(&self) -> Option<String> {
        let snap = self.inner.lock();
        let conn_id = snap.active_connection_id.as_ref()?;
        let conn = snap.connections.iter().find(|c| &c.id == conn_id)?;
        Some(conn.profile_id.clone())
    }

    pub fn find_terminal_session(
        &self,
        profile_or_terminal_id: &str,
        shell_id: Option<&str>,
    ) -> Option<(String, String, String)> {
        let snap = self.inner.lock();
        if profile_or_terminal_id.contains("::") {
            for conn in &snap.connections {
                for shell in &conn.shells {
                    if shell.terminal_session_id == profile_or_terminal_id {
                        return Some((
                            shell.terminal_session_id.clone(),
                            conn.profile_id.clone(),
                            shell.id.clone(),
                        ));
                    }
                }
            }
            return None;
        }

        let profile_id = profile_or_terminal_id;
        if let Some(conn_id) = &snap.active_connection_id {
            if let Some(conn) = snap.connections.iter().find(|c| &c.id == conn_id) {
                if conn.profile_id == profile_id {
                    let shell = conn.shells.iter().find(|s| {
                        shell_id
                            .map(|id| s.id == id)
                            .unwrap_or(s.id == conn.active_shell_id)
                    })?;
                    return Some((
                        shell.terminal_session_id.clone(),
                        conn.profile_id.clone(),
                        shell.id.clone(),
                    ));
                }
            }
        }

        for conn in &snap.connections {
            if conn.profile_id == profile_id {
                let shell = conn.shells.iter().find(|s| {
                    shell_id
                        .map(|id| s.id == id)
                        .unwrap_or(s.id == conn.active_shell_id)
                })?;
                return Some((
                    shell.terminal_session_id.clone(),
                    conn.profile_id.clone(),
                    shell.id.clone(),
                ));
            }
        }
        None
    }

    pub fn profile_by_id(&self, profile_id: &str) -> Option<ProfileSnapshot> {
        let snap = self.inner.lock();
        snap.profiles.iter().find(|p| p.id == profile_id).cloned()
    }
}

/// 根据运行时快照刷新 IDE 焦点字段（供 sync_app_runtime 与工具查询）。
pub fn apply_focus_to_ide_context(ide: &mut IdeContext, snap: &RuntimeSnapshot) {
    let Some(conn) = RuntimeStore::focused_connection_static(snap) else {
        ide.active_profile_id = None;
        ide.active_connection_id = None;
        ide.active_shell_id = None;
        ide.active_session_name = None;
        ide.active_session_host = None;
        ide.terminal_snippet = None;
        return;
    };

    let profile = snap.profiles.iter().find(|p| p.id == conn.profile_id);
    let shell = RuntimeStore::focused_shell_static(snap, conn);

    ide.active_profile_id = Some(conn.profile_id.clone());
    ide.active_connection_id = Some(conn.id.clone());
    ide.active_shell_id = shell
        .map(|s| s.id.clone())
        .or(Some(conn.active_shell_id.clone()));
    ide.active_session_name = Some(conn.profile_name.clone());

    let host_label = match profile {
        Some(p) if p.session_type == "ssh" || p.session_type == "telnet" => {
            let user = p.user.as_deref().unwrap_or("root");
            let port = p.port.map(|n| format!(":{n}")).unwrap_or_default();
            format!("{user}@{}{port} ({})", p.host, p.session_type)
        }
        Some(p) if p.session_type == "local" || p.session_type == "wsl" => {
            format!("本机 {} ({})", p.host, p.session_type)
        }
        Some(p) => format!("{} ({})", p.host, p.session_type),
        None => conn.host.clone(),
    };
    ide.active_session_host = Some(host_label);

    if let Some(shell) = shell {
        let snippet = tail_snippet(&shell.terminal_session_id, 12_000);
        ide.terminal_snippet = if snippet.is_empty() {
            None
        } else {
            Some(snippet)
        };
    } else {
        ide.terminal_snippet = None;
    }
}

impl RuntimeStore {
    pub(crate) fn focused_connection_static(snap: &RuntimeSnapshot) -> Option<&ConnectionSnapshot> {
        let conn_id = snap.active_connection_id.as_ref()?;
        snap.connections.iter().find(|c| &c.id == conn_id)
    }

    pub(crate) fn focused_shell_static<'a>(
        snap: &'a RuntimeSnapshot,
        conn: &'a ConnectionSnapshot,
    ) -> Option<&'a ShellSnapshot> {
        let shell_id = snap
            .active_shell_id
            .as_deref()
            .unwrap_or(conn.active_shell_id.as_str());
        conn.shells.iter().find(|s| s.id == shell_id)
    }
}

pub type SharedRuntime = Arc<RuntimeStore>;
