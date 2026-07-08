use super::acp_persistent::AcpPersistent;
use super::codex_persistent::CodexPersistent;
use super::detect::detect_ai_backend;
use super::provider::AiProvider;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;

enum PersistentBackend {
    Codex(CodexPersistent),
    Acp(AcpPersistent),
}

struct ProviderSlot {
    fingerprint: String,
    backend: PersistentBackend,
    session_id: Option<String>,
}

pub struct GenericSessionManager {
    slots: Mutex<HashMap<String, ProviderSlot>>,
    /// request_id -> slot_key，用于 cancel
    inflight: Mutex<HashMap<String, String>>,
}

impl GenericSessionManager {
    pub fn new() -> Self {
        Self {
            slots: Mutex::new(HashMap::new()),
            inflight: Mutex::new(HashMap::new()),
        }
    }

    pub fn spawn(
        &self,
        app: tauri::AppHandle,
        provider: AiProvider,
        request_id: String,
        prompt: String,
        cli_path: Option<String>,
        workspace_dir: Option<PathBuf>,
        session_id: Option<String>,
        bridge: Option<(u16, String)>,
        connection_key: Option<String>,
    ) -> Result<(), String> {
        let executable = detect_ai_backend(provider, cli_path.clone())
            .path
            .ok_or_else(|| format!("未检测到 {} CLI", provider.display_name()))?;

        let conn_key = connection_key
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "default".to_string());
        let slot_key = slot_key(provider, &conn_key);
        let fingerprint = build_fingerprint(&executable, workspace_dir.as_ref(), &conn_key);
        let want_session = session_id.filter(|s| !s.trim().is_empty());
        let bridge_ref = bridge.as_ref().map(|(p, t)| (*p, t.as_str()));

        let reuse = {
            let mut slots = self.slots.lock();
            if let Some(slot) = slots.get_mut(&slot_key) {
                let alive = match &slot.backend {
                    PersistentBackend::Codex(c) => c.is_alive(),
                    PersistentBackend::Acp(a) => a.is_alive(),
                };
                if alive && slot.fingerprint == fingerprint {
                    match &mut slot.backend {
                        PersistentBackend::Codex(c) => c.send_prompt(
                            &request_id,
                            &prompt,
                            workspace_dir.as_deref(),
                        ),
                        PersistentBackend::Acp(a) => a.send_prompt(&app, &request_id, &prompt),
                    }?;
                    slot.session_id = Some(match &slot.backend {
                        PersistentBackend::Codex(c) => c.thread_id().to_string(),
                        PersistentBackend::Acp(a) => a.session_id().to_string(),
                    });
                    self.inflight
                        .lock()
                        .insert(request_id.clone(), slot_key.clone());
                    tracing::info!(
                        "Reusing persistent {} process for connection={conn_key} request_id={request_id}",
                        provider.display_name()
                    );
                    return Ok(());
                }
                if let Some(old) = slots.remove(&slot_key) {
                    kill_backend(old.backend);
                }
            }
            false
        };
        let _ = reuse;

        let backend = match provider {
            AiProvider::Codex => {
                let codex = CodexPersistent::start(
                    &executable,
                    workspace_dir.as_deref(),
                    want_session.as_deref(),
                    &app,
                    &request_id,
                )?;
                codex.send_prompt(&request_id, &prompt, workspace_dir.as_deref())?;
                PersistentBackend::Codex(codex)
            }
            AiProvider::OpenCode | AiProvider::Cursor => {
                let acp = AcpPersistent::start(
                    provider,
                    &executable,
                    workspace_dir.as_deref(),
                    &app,
                    bridge_ref,
                )?;
                acp.send_prompt(&app, &request_id, &prompt)?;
                PersistentBackend::Acp(acp)
            }
            AiProvider::ClaudeCode => {
                return Err("Claude Code 应使用专用会话管理器".into());
            }
        };

        let session_id = match &backend {
            PersistentBackend::Codex(c) => Some(c.thread_id().to_string()),
            PersistentBackend::Acp(a) => Some(a.session_id().to_string()),
        };

        self.slots.lock().insert(
            slot_key.clone(),
            ProviderSlot {
                fingerprint,
                backend,
                session_id,
            },
        );
        self.inflight
            .lock()
            .insert(request_id.clone(), slot_key);

        tracing::info!(
            "Started persistent {} process for connection={conn_key} request_id={request_id}",
            provider.display_name()
        );
        Ok(())
    }

    pub fn cancel(&self, request_id: &str) {
        let slot_key = self.inflight.lock().remove(request_id);
        if let Some(slot_key) = slot_key {
            if let Some(slot) = self.slots.lock().get(&slot_key) {
                match &slot.backend {
                    PersistentBackend::Codex(c) => c.cancel_turn(),
                    PersistentBackend::Acp(a) => a.cancel(),
                }
            }
        }
    }

    pub fn cancel_all(&self) {
        self.inflight.lock().clear();
        let mut slots = self.slots.lock();
        for (_, slot) in slots.drain() {
            kill_backend(slot.backend);
        }
    }
}

impl Default for GenericSessionManager {
    fn default() -> Self {
        Self::new()
    }
}

fn slot_key(provider: AiProvider, connection_key: &str) -> String {
    format!("{}:{}", provider.as_str(), connection_key)
}

fn build_fingerprint(executable: &str, workspace: Option<&PathBuf>, connection_key: &str) -> String {
    format!(
        "{}|{}|{}",
        executable,
        workspace
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        connection_key
    )
}

fn kill_backend(backend: PersistentBackend) {
    match backend {
        PersistentBackend::Codex(c) => c.kill(),
        PersistentBackend::Acp(a) => a.kill(),
    }
}
