use parking_lot::Mutex;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::LazyLock;

/// 会话凭据仅存于本机进程内存，不进入 IDE 上下文或工具返回值。
#[derive(Debug, Clone)]
pub enum ProfileCredential {
    Password(String),
    PasswordEnv { var_name: String },
    PrivateKeyPath(String),
    KeyEnv { var_name: String },
    SshAgent,
    DefaultKeys,
}

static VAULT: LazyLock<Mutex<HashMap<String, ProfileCredential>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterAuthPayload {
    pub profile_id: String,
    #[serde(rename = "type")]
    pub auth_type: String,
    pub env_var: Option<String>,
    pub key_path: Option<String>,
    /// 仅通过 invoke 注册时传入，永不写入 Runtime 同步或日志
    pub password: Option<String>,
}

pub fn register_profile_auth(payload: RegisterAuthPayload) -> Result<(), String> {
    let cred = match payload.auth_type.as_str() {
        "password-plain" => {
            if let Some(p) = payload.password.filter(|p| !p.is_empty()) {
                ProfileCredential::Password(p)
            } else {
                return Ok(());
            }
        }
        "password-env" => ProfileCredential::PasswordEnv {
            var_name: payload
                .env_var
                .filter(|v| !v.is_empty())
                .ok_or("password-env 需要 envVar")?,
        },
        "key-path" => ProfileCredential::PrivateKeyPath(
            payload
                .key_path
                .filter(|p| !p.is_empty())
                .ok_or("key-path 需要 keyPath")?,
        ),
        "key-env" => ProfileCredential::KeyEnv {
            var_name: payload
                .env_var
                .filter(|v| !v.is_empty())
                .ok_or("key-env 需要 envVar")?,
        },
        "ssh-agent" => ProfileCredential::SshAgent,
        "default-keys" => ProfileCredential::DefaultKeys,
        "password" | "password-keychain" => {
            if let Some(p) = payload.password.filter(|p| !p.is_empty()) {
                ProfileCredential::Password(p)
            } else if let Some(var_name) = payload.env_var.filter(|v| !v.is_empty()) {
                ProfileCredential::PasswordEnv { var_name }
            } else {
                return Err("需要 password 或 envVar".to_string());
            }
        }
        "key" => ProfileCredential::PrivateKeyPath(
            payload
                .key_path
                .filter(|p| !p.is_empty())
                .ok_or("key 需要 keyPath")?,
        ),
        other => return Err(format!("不支持的认证类型: {other}")),
    };
    VAULT.lock().insert(payload.profile_id, cred);
    Ok(())
}

pub fn remove_profile(profile_id: &str) {
    VAULT.lock().remove(profile_id);
}

pub fn resolve_password(profile_id: &str) -> Option<String> {
    let vault = VAULT.lock();
    let cred = vault.get(profile_id)?;
    match cred {
        ProfileCredential::Password(p) => Some(p.clone()),
        ProfileCredential::PasswordEnv { var_name } => std::env::var(var_name).ok(),
        _ => None,
    }
}

pub fn to_connect_auth(profile_id: &str) -> (Option<String>, Option<String>, Option<String>) {
    let vault = VAULT.lock();
    let Some(cred) = vault.get(profile_id) else {
        return (None, None, None);
    };
    match cred {
        ProfileCredential::Password(p) => (Some("password".into()), Some(p.clone()), None),
        ProfileCredential::PasswordEnv { .. } => {
            (Some("password".into()), resolve_password(profile_id), None)
        }
        ProfileCredential::PrivateKeyPath(p) => (Some("key".into()), None, Some(p.clone())),
        ProfileCredential::KeyEnv { var_name } => {
            let path = std::env::var(var_name).ok();
            (Some("key".into()), None, path)
        }
        ProfileCredential::SshAgent => (Some("ssh-agent".into()), None, None),
        ProfileCredential::DefaultKeys => (None, None, None),
    }
}

/// 将命令中的占位符替换为真实秘密（仅在实际写入 PTY 前调用）。
pub fn substitute_command_placeholders(command: &str, active_profile_id: Option<&str>) -> String {
    let mut out = command.to_string();
    if let Some(pid) = active_profile_id {
        let needle = format!("{{{{AITERM_PASSWORD:{pid}}}}}");
        if let Some(pw) = resolve_password(pid) {
            out = out.replace(&needle, &pw);
        }
        let needle2 = format!("{{{{AITERM_SECRET:{pid}}}}}");
        if let Some(pw) = resolve_password(pid) {
            out = out.replace(&needle2, &pw);
        }
    }
    if let Some(pid) = active_profile_id {
        if out.contains("{{AITERM_PASSWORD}}") || out.contains("{{AITERM_SECRET}}") {
            if let Some(pw) = resolve_password(pid) {
                out = out.replace("{{AITERM_PASSWORD}}", &pw);
                out = out.replace("{{AITERM_SECRET}}", &pw);
            }
        }
    }
    // {{AITERM_ENV:NAME}}
    while let Some(start) = out.find("{{AITERM_ENV:") {
        if let Some(end) = out[start..].find("}}") {
            let inner = &out[start + 14..start + end];
            let var_name = inner.trim();
            let replacement = std::env::var(var_name).unwrap_or_default();
            let full = &out[start..start + end + 2];
            out = out.replacen(full, &replacement, 1);
        } else {
            break;
        }
    }
    out
}

/// 供日志 / 事件展示，隐藏秘密内容。
pub fn redact_for_display(command: &str, active_profile_id: Option<&str>) -> String {
    let mut out = command.to_string();
    if let Some(pid) = active_profile_id {
        let needle = format!("{{{{AITERM_PASSWORD:{pid}}}}}");
        out = out.replace(&needle, "***");
        let needle2 = format!("{{{{AITERM_SECRET:{pid}}}}}");
        out = out.replace(&needle2, "***");
    }
    out = out.replace("{{AITERM_PASSWORD}}", "***");
    out = out.replace("{{AITERM_SECRET}}", "***");
    while let Some(start) = out.find("{{AITERM_ENV:") {
        if let Some(end) = out[start..].find("}}") {
            let full = &out[start..start + end + 2];
            out = out.replacen(full, "***", 1);
        } else {
            break;
        }
    }
    if let Some(pid) = active_profile_id {
        if let Some(pw) = resolve_password(pid) {
            if !pw.is_empty() {
                out = out.replace(&pw, "***");
            }
        }
    }
    out
}
