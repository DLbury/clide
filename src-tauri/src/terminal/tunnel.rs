use super::{enrich_connect_request, ConnectRequest};
use crate::runtime::RuntimeStore;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::net::TcpListener;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
    pub id: String,
    pub profile_id: String,
    pub remote_host: String,
    pub remote_port: u16,
    pub local_port: u16,
    pub local_url: String,
    pub status: String,
}

struct ActiveTunnel {
    info: TunnelInfo,
    abort: Arc<AtomicBool>,
}

pub struct TunnelManager {
    tunnels: Mutex<HashMap<String, ActiveTunnel>>,
}

impl TunnelManager {
    pub fn new() -> Self {
        Self {
            tunnels: Mutex::new(HashMap::new()),
        }
    }

    pub fn list(&self) -> Vec<TunnelInfo> {
        self.tunnels
            .lock()
            .values()
            .map(|t| t.info.clone())
            .collect()
    }

    pub fn list_for_profile(&self, profile_id: &str) -> Vec<TunnelInfo> {
        self.tunnels
            .lock()
            .values()
            .filter(|t| t.info.profile_id == profile_id)
            .map(|t| t.info.clone())
            .collect()
    }

    pub fn stop(&self, tunnel_id: &str) -> bool {
        if let Some(entry) = self.tunnels.lock().remove(tunnel_id) {
            entry.abort.store(true, Ordering::SeqCst);
            true
        } else {
            false
        }
    }

    pub fn stop_for_profile(&self, profile_id: &str) {
        let ids: Vec<String> = self
            .tunnels
            .lock()
            .values()
            .filter(|t| t.info.profile_id == profile_id)
            .map(|t| t.info.id.clone())
            .collect();
        for id in ids {
            self.stop(&id);
        }
    }

    pub fn stop_all(&self) {
        let ids: Vec<String> = self.tunnels.lock().keys().cloned().collect();
        for id in ids {
            self.stop(&id);
        }
    }

    /// 建立本地 → 远程 SSH 端口转发（-L），仅绑定 127.0.0.1。
    pub async fn start(
        &self,
        runtime: &RuntimeStore,
        profile_id: &str,
        remote_host: &str,
        remote_port: u16,
        local_port: Option<u16>,
        path: Option<&str>,
    ) -> Result<TunnelInfo, String> {
        let profile = runtime
            .profile_by_id(profile_id)
            .ok_or_else(|| format!("未找到服务器配置: {profile_id}"))?;
        if profile.session_type != "ssh" {
            return Err("SSH 端口转发仅支持 SSH 类型的服务器配置".into());
        }

        let mut request = ConnectRequest {
            sessionId: format!("{profile_id}::__tunnel__"),
            session_type: "ssh".into(),
            host: profile.host.clone(),
            port: profile.port,
            user: profile.user.clone(),
            authMethod: None,
            password: None,
            privateKeyPath: None,
            serial_port: None,
            baud_rate: None,
            data_bits: None,
            stop_bits: None,
            parity: None,
        };
        request = enrich_connect_request(request);

        let session = super::ssh_auth::connect_and_auth(&request).await?;
        let bind_port = local_port
            .or_else(portpicker::pick_unused_port)
            .ok_or_else(|| "无法分配本地端口".to_string())?;

        let listener = TcpListener::bind(("127.0.0.1", bind_port))
            .await
            .map_err(|e| format!("无法绑定本地端口 {bind_port}: {e}"))?;
        let actual_port = listener
            .local_addr()
            .map_err(|e| format!("读取本地端口失败: {e}"))?
            .port();

        let tunnel_id = uuid::Uuid::new_v4().to_string();
        let path_suffix = path
            .filter(|p| !p.is_empty())
            .map(|p| {
                if p.starts_with('/') {
                    p.to_string()
                } else {
                    format!("/{p}")
                }
            })
            .unwrap_or_default();
        let local_url = format!("http://127.0.0.1:{actual_port}{path_suffix}");

        let info = TunnelInfo {
            id: tunnel_id.clone(),
            profile_id: profile_id.to_string(),
            remote_host: remote_host.to_string(),
            remote_port,
            local_port: actual_port,
            local_url: local_url.clone(),
            status: "running".into(),
        };

        let abort = Arc::new(AtomicBool::new(false));
        let remote_host_owned = remote_host.to_string();
        let remote_port_u32 = remote_port as u32;
        let session = Arc::new(tokio::sync::Mutex::new(session));
        let abort_bg = abort.clone();
        let (conn_tx, mut conn_rx) =
            tokio::sync::mpsc::unbounded_channel::<(tokio::net::TcpStream, std::net::SocketAddr)>();

        let session_worker = session.clone();
        let remote_host_worker = remote_host_owned.clone();
        let tunnel_id_log = tunnel_id.clone();
        tauri::async_runtime::spawn(async move {
            while let Some((mut local_socket, peer_addr)) = conn_rx.recv().await {
                let origin_port = peer_addr.port() as u32;
                let ssh = session_worker.lock().await;
                let channel = match ssh
                    .channel_open_direct_tcpip(
                        remote_host_worker.as_str(),
                        remote_port_u32,
                        "127.0.0.1",
                        origin_port,
                    )
                    .await
                {
                    Ok(ch) => ch,
                    Err(e) => {
                        tracing::warn!("tunnel channel_open_direct_tcpip failed: {e}");
                        continue;
                    }
                };
                drop(ssh);
                let mut remote_stream = channel.into_stream();
                tauri::async_runtime::spawn(async move {
                    let _ =
                        tokio::io::copy_bidirectional(&mut local_socket, &mut remote_stream).await;
                });
            }
            tracing::info!("SSH tunnel {tunnel_id_log} worker stopped");
        });

        let tunnel_id_listener = tunnel_id.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                if abort_bg.load(Ordering::Relaxed) {
                    break;
                }
                let accept =
                    tokio::time::timeout(std::time::Duration::from_millis(500), listener.accept())
                        .await;
                match accept {
                    Ok(Ok((stream, addr))) => {
                        let _ = conn_tx.send((stream, addr));
                    }
                    Ok(Err(e)) => {
                        tracing::warn!("tunnel accept error: {e}");
                        break;
                    }
                    Err(_) => continue,
                }
            }
            tracing::info!("SSH tunnel {tunnel_id_listener} listener stopped");
        });

        self.tunnels.lock().insert(
            tunnel_id.clone(),
            ActiveTunnel {
                info: info.clone(),
                abort,
            },
        );
        tracing::info!(
            "SSH tunnel started: id={tunnel_id} profile={profile_id} 127.0.0.1:{actual_port} -> {remote_host}:{remote_port}"
        );
        Ok(info)
    }
}
