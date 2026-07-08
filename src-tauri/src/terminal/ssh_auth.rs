use super::{expand_home, ssh_jump, ConnectRequest, JumpHostConfig};
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

fn ssh_config() -> Arc<client::Config> {
    Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 5,
        inactivity_timeout: None,
        ..Default::default()
    })
}

async fn authenticate_session(
    session: &mut client::Handle<SshClientHandler>,
    user: &str,
    auth: &str,
    password: Option<&str>,
    private_key_path: Option<&str>,
) -> Result<(), String> {
    let authed: bool = match auth {
        "password" => {
            let password = password.ok_or_else(|| "密码认证需要填写密码".to_string())?;
            session
                .authenticate_password(user, password)
                .await
                .map_err(|e| format!("密码认证失败: {e}"))?
        }
        "key" => {
            let key_path = private_key_path.ok_or_else(|| "密钥认证需要私钥路径".to_string())?;
            let expanded = expand_home(key_path);
            let key_bytes =
                std::fs::read(&expanded).map_err(|e| format!("无法读取私钥 ({expanded}): {e}"))?;
            let key_text = std::str::from_utf8(&key_bytes)
                .map_err(|e| format!("私钥格式无效 ({expanded}): {e}"))?;
            let key_pair = russh_keys::decode_secret_key(key_text, None)
                .map_err(|e| format!("无法解析私钥 ({expanded}): {e}"))?;
            session
                .authenticate_publickey(user, Arc::new(key_pair))
                .await
                .map_err(|e| format!("密钥认证失败: {e}"))?
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
                                if session
                                    .authenticate_publickey(user, Arc::new(key_pair))
                                    .await
                                    .unwrap_or(false)
                                {
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
    Ok(())
}

fn jump_credentials<'a>(
    jump: &'a JumpHostConfig,
    target: &'a ConnectRequest,
) -> (&'a str, Option<&'a str>, Option<&'a str>) {
    let auth = jump
        .auth_method
        .as_deref()
        .or_else(|| target.authMethod.as_deref())
        .unwrap_or("none");
    let password = jump
        .password
        .as_deref()
        .or_else(|| target.password.as_deref());
    let key = jump
        .private_key_path
        .as_deref()
        .or_else(|| target.privateKeyPath.as_deref());
    (auth, password, key)
}

fn jump_user<'a>(jump: &'a JumpHostConfig, target: &'a ConnectRequest) -> Result<&'a str, String> {
    jump.user
        .as_deref()
        .or(target.user.as_deref())
        .ok_or_else(|| "SSH 需要用户名".to_string())
}

async fn connect_direct(request: &ConnectRequest) -> Result<client::Handle<SshClientHandler>, String> {
    let host = request.host.clone();
    let port = request.port.unwrap_or(22);
    let user = request
        .user
        .as_deref()
        .ok_or_else(|| "SSH 需要用户名".to_string())?;

    let config = ssh_config();
    let mut session = client::connect(config, (host.as_str(), port), SshClientHandler)
        .await
        .map_err(|e| format!("无法连接 {host}:{port}: {e}"))?;

    let auth = request.authMethod.as_deref().unwrap_or("none");
    authenticate_session(
        &mut session,
        user,
        auth,
        request.password.as_deref(),
        request.privateKeyPath.as_deref(),
    )
    .await?;

    Ok(session)
}

async fn connect_via_stream_to(
    from: client::Handle<SshClientHandler>,
    host: &str,
    port: u16,
    label: &str,
) -> Result<(client::Handle<SshClientHandler>, client::Handle<SshClientHandler>), String> {
    let config = ssh_config();
    let channel = from
        .channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0)
        .await
        .map_err(|e| format!("转发至 {label} ({host}:{port}) 失败: {e}"))?;
    let stream = channel.into_stream();
    let new_session = client::connect_stream(config, stream, SshClientHandler)
        .await
        .map_err(|e| format!("经跳板连接 {label} ({host}:{port}) 失败: {e}"))?;
    Ok((from, new_session))
}

async fn connect_via_jump_chain(
    hops: &[JumpHostConfig],
    target: &ConnectRequest,
    jump_owner: &str,
) -> Result<client::Handle<SshClientHandler>, String> {
    if hops.is_empty() {
        return Err("跳板链不能为空".to_string());
    }

    let target_host = target.host.trim();
    let target_port = target.port.unwrap_or(22);
    let target_user = target
        .user
        .as_deref()
        .ok_or_else(|| "SSH 需要用户名".to_string())?;
    let target_auth = target.authMethod.as_deref().unwrap_or("none");

    let first = &hops[0];
    let first_host = first.host.trim();
    if first_host.is_empty() {
        return Err("跳板机地址不能为空".to_string());
    }
    let first_port = first.port.unwrap_or(22);
    let first_user = jump_user(first, target)?;

    let config = ssh_config();
    let mut current_session = client::connect(config, (first_host, first_port), SshClientHandler)
        .await
        .map_err(|e| format!("无法连接跳板 {first_host}:{first_port}: {e}"))?;

    let (auth, password, key) = jump_credentials(first, target);
    authenticate_session(
        &mut current_session,
        first_user,
        auth,
        password,
        key,
    )
    .await
    .map_err(|e| format!("跳板 {first_host} 认证失败: {e}"))?;

    let mut held: Vec<client::Handle<SshClientHandler>> = Vec::new();

    for (idx, hop) in hops.iter().enumerate().skip(1) {
        let hop_host = hop.host.trim();
        if hop_host.is_empty() {
            return Err(format!("第 {} 跳跳板地址不能为空", idx + 1));
        }
        let hop_port = hop.port.unwrap_or(22);
        let hop_user = jump_user(hop, target)?;
        let label = format!("跳板{}", idx + 1);

        let (kept, next_session) =
            connect_via_stream_to(current_session, hop_host, hop_port, &label).await?;
        held.push(kept);
        current_session = next_session;

        let (auth, password, key) = jump_credentials(hop, target);
        authenticate_session(&mut current_session, hop_user, auth, password, key)
            .await
            .map_err(|e| format!("{label} ({hop_host}) 认证失败: {e}"))?;
    }

    let (kept, mut target_session) = connect_via_stream_to(
        current_session,
        target_host,
        target_port,
        "目标主机",
    )
    .await?;
    held.push(kept);

    authenticate_session(
        &mut target_session,
        target_user,
        target_auth,
        target.password.as_deref(),
        target.privateKeyPath.as_deref(),
    )
    .await
    .map_err(|e| format!("目标主机认证失败: {e}"))?;

    if let Some(key) = ssh_jump::jump_hold_owner_key(target, jump_owner) {
        ssh_jump::hold_jump_sessions(&key, held);
    }

    Ok(target_session)
}

pub async fn connect_and_auth(
    request: &ConnectRequest,
    jump_owner: &str,
) -> Result<client::Handle<SshClientHandler>, String> {
    let hops = super::resolve_jump_chain(request);
    if !hops.is_empty() {
        return connect_via_jump_chain(&hops, request, jump_owner).await;
    }
    connect_direct(request).await
}
