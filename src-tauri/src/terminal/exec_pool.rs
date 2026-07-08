use super::ssh_auth::SshClientHandler;
use super::{resolve_profile_id, ssh_auth, ConnectRequest};
use russh::client::Handle;
use russh::ChannelMsg;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const POOL_TTL: Duration = Duration::from_secs(90);
const EXEC_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum CachedPlatform {
    Unix,
    Windows,
}

impl CachedPlatform {
    pub fn is_windows(self) -> bool {
        matches!(self, CachedPlatform::Windows)
    }
}

struct PoolEntry {
    handle: Arc<Mutex<Handle<SshClientHandler>>>,
    platform: Option<CachedPlatform>,
    remote_home: Option<String>,
    last_used: Instant,
}

pub struct ExecPool {
    entries: Mutex<HashMap<String, PoolEntry>>,
}

impl ExecPool {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    fn pool_key(request: &ConnectRequest) -> String {
        let profile = resolve_profile_id(&request.sessionId);
        let hops = super::resolve_jump_chain(request);
        if !hops.is_empty() {
            let route = hops
                .iter()
                .map(|h| format!("{}:{}", h.host, h.port.unwrap_or(22)))
                .collect::<Vec<_>>()
                .join("->");
            return format!(
                "{}::via::{}->{}:{}",
                profile,
                route,
                request.host,
                request.port.unwrap_or(22)
            );
        }
        profile.to_string()
    }

    pub(crate) async fn get_or_connect(
        &self,
        request: &ConnectRequest,
    ) -> Result<Arc<Mutex<Handle<SshClientHandler>>>, String> {
        let key = Self::pool_key(request);
        let now = Instant::now();

        {
            let mut guard = self.entries.lock().await;
            if let Some(entry) = guard.get_mut(&key) {
                if now.duration_since(entry.last_used) < POOL_TTL {
                    entry.last_used = now;
                    return Ok(entry.handle.clone());
                }
                guard.remove(&key);
            }
        }

        let handle = ssh_auth::connect_and_auth(request, &key).await?;
        let shared = Arc::new(Mutex::new(handle));
        let mut guard = self.entries.lock().await;
        guard.insert(
            key,
            PoolEntry {
                handle: shared.clone(),
                platform: None,
                remote_home: None,
                last_used: now,
            },
        );
        Ok(shared)
    }

    async fn touch(&self, request: &ConnectRequest) {
        let key = Self::pool_key(request);
        let mut guard = self.entries.lock().await;
        if let Some(entry) = guard.get_mut(&key) {
            entry.last_used = Instant::now();
        }
    }

    pub async fn invalidate(&self, request: &ConnectRequest) {
        let key = Self::pool_key(request);
        self.entries.lock().await.remove(&key);
        super::ssh_jump::release_jump_for_owner(request, &key);
    }

    pub async fn get_platform(&self, request: &ConnectRequest) -> CachedPlatform {
        let key = Self::pool_key(request);
        {
            let guard = self.entries.lock().await;
            if let Some(entry) = guard.get(&key) {
                if let Some(p) = entry.platform {
                    return p;
                }
            }
        }

        let platform = if Self::detect_windows(request, self).await {
            CachedPlatform::Windows
        } else {
            CachedPlatform::Unix
        };

        let mut guard = self.entries.lock().await;
        if let Some(entry) = guard.get_mut(&key) {
            entry.platform = Some(platform);
        }

        platform
    }

    pub async fn get_remote_home(&self, request: &ConnectRequest) -> Result<String, String> {
        let key = Self::pool_key(request);
        {
            let guard = self.entries.lock().await;
            if let Some(entry) = guard.get(&key) {
                if let Some(home) = &entry.remote_home {
                    return Ok(home.clone());
                }
            }
        }

        let platform = self.get_platform(request).await;
        let home = if platform.is_windows() {
            let out = Self::run_on_session(
                &self.get_or_connect(request).await?,
                "powershell -NoProfile -NoLogo -NonInteractive -Command \"Write-Output $env:USERPROFILE\"",
            )
            .await?;
            super::remote_fs::normalize_path_slashes_public(out.trim())
        } else {
            let out = Self::run_on_session(
                &self.get_or_connect(request).await?,
                "echo \"$HOME\"",
            )
            .await?;
            super::remote_fs::normalize_path_slashes_public(out.trim())
        };

        if home.is_empty() {
            return Err("无法解析远程用户目录".to_string());
        }

        let mut guard = self.entries.lock().await;
        if let Some(entry) = guard.get_mut(&key) {
            entry.remote_home = Some(home.clone());
        }
        Ok(home)
    }

    async fn detect_windows(request: &ConnectRequest, pool: &ExecPool) -> bool {
        let session = match pool.get_or_connect(request).await {
            Ok(s) => s,
            Err(_) => return false,
        };
        let ps = "powershell -NoProfile -NoLogo -NonInteractive -Command \"if ($env:OS -eq 'Windows_NT') { Write-Output 'windows' } else { Write-Output 'unix' }\"";
        if let Ok(out) = Self::run_on_session(&session, ps).await {
            if out.trim().eq_ignore_ascii_case("windows") {
                return true;
            }
        }
        let cmd = "cmd /c \"if %OS%==Windows_NT (echo windows) else (echo unix)\"";
        if let Ok(out) = Self::run_on_session(&session, cmd).await {
            return out.trim().eq_ignore_ascii_case("windows");
        }
        false
    }

    pub async fn exec_raw(&self, request: &ConnectRequest, cmd: &str) -> Result<String, String> {
        let session = self.get_or_connect(request).await?;
        let result = Self::run_on_session(&session, cmd).await;
        match &result {
            Ok(_) => self.touch(request).await,
            Err(_) => self.invalidate(request).await,
        }
        result
    }

    async fn run_on_session(
        session: &Arc<Mutex<Handle<SshClientHandler>>>,
        cmd: &str,
    ) -> Result<String, String> {
        let handle = session.lock().await;
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("无法打开 SSH 通道: {e}"))?;

        channel
            .exec(true, cmd.to_string())
            .await
            .map_err(|e| format!("无法执行远程命令: {e}"))?;

        let mut output = String::new();
        let mut exit_code: u32 = 0;

        loop {
            match tokio::time::timeout(EXEC_TIMEOUT, channel.wait()).await {
                Ok(Some(ChannelMsg::Data { data })) => {
                    output.push_str(&String::from_utf8_lossy(&data));
                }
                Ok(Some(ChannelMsg::ExitStatus { exit_status })) => {
                    exit_code = exit_status;
                    break;
                }
                Ok(None) => break,
                Ok(Some(_)) => {}
                Err(_) => return Err("远程命令执行超时".to_string()),
            }
        }

        let _ = channel.close().await;

        if exit_code != 0 {
            let detail = output.trim();
            if detail.is_empty() {
                return Err(format!("远程命令失败 (exit {exit_code})"));
            }
            return Err(detail.to_string());
        }

        Ok(output)
    }
}

static EXEC_POOL: OnceLock<ExecPool> = OnceLock::new();

pub fn global_exec_pool() -> &'static ExecPool {
    EXEC_POOL.get_or_init(ExecPool::new)
}

pub fn init_exec_pool() {
    let _ = global_exec_pool();
}
