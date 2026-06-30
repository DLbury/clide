use super::ssh_auth::SshClientHandler;
use super::{enrich_connect_request, ssh_auth, ConnectRequest};
use crate::runtime::RuntimeStore;
use parking_lot::Mutex;
use russh::client;
use serde::Serialize;
use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// 本地 SOCKS5 代理（通过 SSH 会话动态转发，等价 `ssh -D`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SocksInfo {
    pub id: String,
    pub profile_id: String,
    pub local_host: String,
    pub local_port: u16,
    pub status: String,
}

struct ActiveSocks {
    info: SocksInfo,
    abort: Arc<AtomicBool>,
}

pub struct SocksManager {
    proxies: Mutex<HashMap<String, ActiveSocks>>,
}

impl SocksManager {
    pub fn new() -> Self {
        Self {
            proxies: Mutex::new(HashMap::new()),
        }
    }

    pub fn list(&self) -> Vec<SocksInfo> {
        self.proxies
            .lock()
            .values()
            .map(|p| p.info.clone())
            .collect()
    }

    pub fn stop(&self, id: &str) -> bool {
        if let Some(entry) = self.proxies.lock().remove(id) {
            entry.abort.store(true, Ordering::SeqCst);
            true
        } else {
            false
        }
    }

    pub fn stop_for_profile(&self, profile_id: &str) {
        let ids: Vec<String> = self
            .proxies
            .lock()
            .values()
            .filter(|p| p.info.profile_id == profile_id)
            .map(|p| p.info.id.clone())
            .collect();
        for id in ids {
            self.stop(&id);
        }
    }

    pub fn stop_all(&self) {
        let ids: Vec<String> = self.proxies.lock().keys().cloned().collect();
        for id in ids {
            self.stop(&id);
        }
    }

    /// 为某个 SSH 配置启动（或复用）一个本地 SOCKS5 代理，返回监听信息。
    pub async fn start(
        &self,
        runtime: &RuntimeStore,
        profile_id: &str,
    ) -> Result<SocksInfo, String> {
        if let Some(existing) = self
            .proxies
            .lock()
            .values()
            .find(|p| p.info.profile_id == profile_id)
        {
            return Ok(existing.info.clone());
        }

        let profile = runtime
            .profile_by_id(profile_id)
            .ok_or_else(|| format!("未找到服务器配置: {profile_id}"))?;
        if profile.session_type != "ssh" {
            return Err("SOCKS 代理仅支持 SSH 类型的服务器配置".into());
        }

        let mut request = ConnectRequest {
            sessionId: format!("{profile_id}::__socks__"),
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

        let session = ssh_auth::connect_and_auth(&request).await?;
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| format!("无法绑定本地端口: {e}"))?;
        let actual_port = listener
            .local_addr()
            .map_err(|e| format!("读取本地端口失败: {e}"))?
            .port();

        let id = uuid::Uuid::new_v4().to_string();
        let info = SocksInfo {
            id: id.clone(),
            profile_id: profile_id.to_string(),
            local_host: "127.0.0.1".into(),
            local_port: actual_port,
            status: "running".into(),
        };

        let session = Arc::new(tokio::sync::Mutex::new(session));
        let abort = Arc::new(AtomicBool::new(false));
        let abort_bg = abort.clone();
        let id_log = id.clone();

        tauri::async_runtime::spawn(async move {
            loop {
                if abort_bg.load(Ordering::Relaxed) {
                    break;
                }
                let accept =
                    tokio::time::timeout(std::time::Duration::from_millis(500), listener.accept())
                        .await;
                match accept {
                    Ok(Ok((stream, peer))) => {
                        let session = session.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = handle_socks_conn(stream, peer.port(), session).await {
                                tracing::debug!("socks connection ended: {e}");
                            }
                        });
                    }
                    Ok(Err(e)) => {
                        tracing::warn!("socks accept error: {e}");
                        break;
                    }
                    Err(_) => continue,
                }
            }
            tracing::info!("SOCKS proxy {id_log} listener stopped");
        });

        self.proxies.lock().insert(
            id.clone(),
            ActiveSocks {
                info: info.clone(),
                abort,
            },
        );
        tracing::info!("SOCKS proxy started: id={id} profile={profile_id} 127.0.0.1:{actual_port}");
        Ok(info)
    }
}

impl Default for SocksManager {
    fn default() -> Self {
        Self::new()
    }
}

fn reply(rep: u8) -> [u8; 10] {
    [0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0]
}

/// 处理单个 SOCKS5 连接：握手 → 解析目标 → 通过 SSH 打开 direct-tcpip → 双向转发。
async fn handle_socks_conn(
    mut client_conn: tokio::net::TcpStream,
    origin_port: u16,
    session: Arc<tokio::sync::Mutex<client::Handle<SshClientHandler>>>,
) -> Result<(), String> {
    let mut greeting = [0u8; 2];
    client_conn
        .read_exact(&mut greeting)
        .await
        .map_err(|e| e.to_string())?;
    if greeting[0] != 0x05 {
        return Err("非 SOCKS5 请求".into());
    }
    let nmethods = greeting[1] as usize;
    if nmethods > 0 {
        let mut methods = vec![0u8; nmethods];
        client_conn
            .read_exact(&mut methods)
            .await
            .map_err(|e| e.to_string())?;
    }
    // 选择「无需认证」
    client_conn
        .write_all(&[0x05, 0x00])
        .await
        .map_err(|e| e.to_string())?;

    let mut req = [0u8; 4];
    client_conn
        .read_exact(&mut req)
        .await
        .map_err(|e| e.to_string())?;
    if req[0] != 0x05 {
        return Err("SOCKS5 请求版本错误".into());
    }
    // 仅支持 CONNECT
    if req[1] != 0x01 {
        let _ = client_conn.write_all(&reply(0x07)).await;
        return Err("仅支持 CONNECT".into());
    }

    let target_host = match req[3] {
        0x01 => {
            let mut addr = [0u8; 4];
            client_conn
                .read_exact(&mut addr)
                .await
                .map_err(|e| e.to_string())?;
            Ipv4Addr::from(addr).to_string()
        }
        0x04 => {
            let mut addr = [0u8; 16];
            client_conn
                .read_exact(&mut addr)
                .await
                .map_err(|e| e.to_string())?;
            Ipv6Addr::from(addr).to_string()
        }
        0x03 => {
            let mut len = [0u8; 1];
            client_conn
                .read_exact(&mut len)
                .await
                .map_err(|e| e.to_string())?;
            let mut domain = vec![0u8; len[0] as usize];
            client_conn
                .read_exact(&mut domain)
                .await
                .map_err(|e| e.to_string())?;
            String::from_utf8_lossy(&domain).into_owned()
        }
        _ => {
            let _ = client_conn.write_all(&reply(0x08)).await;
            return Err("不支持的地址类型".into());
        }
    };

    let mut port_bytes = [0u8; 2];
    client_conn
        .read_exact(&mut port_bytes)
        .await
        .map_err(|e| e.to_string())?;
    let target_port = u16::from_be_bytes(port_bytes);

    let channel = {
        let ssh = session.lock().await;
        ssh.channel_open_direct_tcpip(
            target_host.as_str(),
            target_port as u32,
            "127.0.0.1",
            origin_port as u32,
        )
        .await
    };

    let channel = match channel {
        Ok(ch) => ch,
        Err(e) => {
            let _ = client_conn.write_all(&reply(0x05)).await;
            return Err(format!("无法连接 {target_host}:{target_port}: {e}"));
        }
    };

    client_conn
        .write_all(&reply(0x00))
        .await
        .map_err(|e| e.to_string())?;

    let mut remote = channel.into_stream();
    tokio::io::copy_bidirectional(&mut client_conn, &mut remote)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
