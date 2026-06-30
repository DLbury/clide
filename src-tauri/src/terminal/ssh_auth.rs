use super::{expand_home, ConnectRequest};
use async_trait::async_trait;
use russh::client;
use russh::keys::key;
use std::sync::Arc;
use std::time::Duration;

pub struct SshClientHandler;

#[async_trait]
impl client::Handler for SshClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

pub async fn connect_and_auth(
    request: &ConnectRequest,
) -> Result<client::Handle<SshClientHandler>, String> {
    let host = request.host.clone();
    let port = request.port.unwrap_or(22);
    let user = request
        .user
        .clone()
        .ok_or_else(|| "SSH 需要用户名".to_string())?;

    let config = Arc::new(client::Config {
        // 定期发 keepalive，避免 NAT/防火墙长时间空闲后静默断线
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 5,
        inactivity_timeout: None,
        ..Default::default()
    });

    let conn_future = client::connect(config, (host.as_str(), port), SshClientHandler);
    let conn_result: Result<client::Handle<SshClientHandler>, _> = conn_future.await;
    let mut session = conn_result.map_err(|e| format!("无法连接 {host}:{port}: {e}"))?;

    let auth = request.authMethod.as_deref().unwrap_or("none");
    let authed: bool = match auth {
        "password" => {
            let password = request
                .password
                .as_deref()
                .ok_or_else(|| "密码认证需要填写密码".to_string())?;
            let result: Result<bool, russh::Error> =
                session.authenticate_password(&user, password).await;
            result.map_err(|e| format!("密码认证失败: {e}"))?
        }
        "key" => {
            let key_path = request
                .privateKeyPath
                .as_deref()
                .ok_or_else(|| "密钥认证需要私钥路径".to_string())?;
            let expanded = expand_home(key_path);
            let key_bytes =
                std::fs::read(&expanded).map_err(|e| format!("无法读取私钥 ({expanded}): {e}"))?;
            let key_text = std::str::from_utf8(&key_bytes)
                .map_err(|e| format!("私钥格式无效 ({expanded}): {e}"))?;
            let key_pair = russh_keys::decode_secret_key(key_text, None)
                .map_err(|e| format!("无法解析私钥 ({expanded}): {e}"))?;
            let result: Result<bool, russh::Error> = session
                .authenticate_publickey(&user, Arc::new(key_pair))
                .await;
            result.map_err(|e| format!("密钥认证失败: {e}"))?
        }
        _ => {
            if let Some(home) = dirs::home_dir() {
                let mut ok = false;
                for name in ["id_ed25519", "id_rsa", "id_ecdsa"] {
                    let path = home.join(".ssh").join(name);
                    if !path.exists() {
                        continue;
                    }
                    if let Ok(key_bytes) = std::fs::read(&path) {
                        if let Ok(key_text) = std::str::from_utf8(&key_bytes) {
                            if let Ok(key_pair) = russh_keys::decode_secret_key(key_text, None) {
                                let result: Result<bool, russh::Error> = session
                                    .authenticate_publickey(&user, Arc::new(key_pair))
                                    .await;
                                if result.unwrap_or(false) {
                                    ok = true;
                                    break;
                                }
                            }
                        }
                    }
                }
                if !ok {
                    return Err(
                        "未配置认证方式，且默认密钥认证失败。请在会话中设置密码或密钥。"
                            .to_string(),
                    );
                }
                true
            } else {
                return Err("无法定位用户目录".to_string());
            }
        }
    };

    if !authed {
        return Err("SSH 认证失败".to_string());
    }

    Ok(session)
}
