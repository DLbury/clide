use crate::app_paths::{path_to_js_string, McpBundlePaths};
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const MCP_SERVER_NAME: &str = "aiterm";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRegisterStatus {
    pub project_root: String,
    pub mcp_script_exists: bool,
    pub project_mcp_config_ready: bool,
    pub claude_project_registered: bool,
    pub ready: bool,
}

fn resolve_node_command() -> String {
    which::which("node")
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "node".to_string())
}

fn mcp_config_template(launcher_script: &Path, bridge: Option<(u16, &str)>) -> Value {
    let script = path_to_js_string(launcher_script);
    let node = resolve_node_command();
    let mut server = json!({
        "command": node,
        "args": [script],
        "alwaysLoad": true
    });
    if let Some((port, token)) = bridge {
        server["env"] = json!({
            "AITERM_IDE_PORT": port.to_string(),
            "AITERM_IDE_AUTH_TOKEN": token,
            "ENABLE_IDE_INTEGRATION": "true",
            "CLAUDE_CODE_SSE_PORT": port.to_string(),
        });
    }
    json!({
        "mcpServers": {
            MCP_SERVER_NAME: server
        }
    })
}

fn write_mcp_config(paths: &McpBundlePaths, bridge: Option<(u16, &str)>) -> Result<PathBuf, String> {
    tracing::info!("Writing MCP config...");
    tracing::debug!("Launcher script: {}", paths.launcher_script.display());

    if !paths.launcher_script.is_file() {
        let err_msg = format!(
            "未找到 MCP 启动脚本: {}",
            paths.launcher_script.display()
        );
        tracing::error!("{}", err_msg);
        return Err(err_msg);
    }

    let template = mcp_config_template(&paths.launcher_script, bridge);
    let config_json = serde_json::to_string_pretty(&template).map_err(|e| {
        let msg = format!("序列化 MCP 配置失败: {}", e);
        tracing::error!("{}", msg);
        msg
    })?;

    tracing::debug!("MCP config content: {}", config_json);

    fs::write(&paths.mcp_config_file, config_json)
        .map_err(|e| {
            let msg = format!("写入 MCP 配置失败: {}", e);
            tracing::error!("{}", msg);
            msg
        })?;

    tracing::info!("MCP config written to: {}", paths.mcp_config_file.display());
    Ok(paths.mcp_config_file.clone())
}

fn config_has_aiterm(content: &str) -> bool {
    content.contains(MCP_SERVER_NAME)
}

pub fn check_mcp_status(
    paths: &McpBundlePaths,
    _claude_path: Option<String>,
) -> McpRegisterStatus {
    tracing::info!("Checking MCP status...");
    tracing::debug!("Launcher script path: {}", paths.launcher_script.display());
    tracing::debug!("Config file path: {}", paths.mcp_config_file.display());
    tracing::debug!("Config dir: {}", paths.config_dir.display());

    let mcp_script_exists = paths.launcher_script.is_file();
    tracing::info!("MCP script exists: {}", mcp_script_exists);

    let project_mcp_config_ready = paths
        .mcp_config_file
        .is_file()
        .then(|| fs::read_to_string(&paths.mcp_config_file).ok())
        .flatten()
        .map(|c| config_has_aiterm(&c))
        .unwrap_or(false);
    tracing::info!("Project MCP config ready: {}", project_mcp_config_ready);

    // 不在 UI 热路径执行 `claude mcp list`（可能阻塞/等待），
    // 以本地 .mcp.json 是否就绪作为可用性的主判定。
    let claude_project_registered = project_mcp_config_ready;

    let ready = mcp_script_exists && project_mcp_config_ready;
    tracing::info!("MCP ready: {}", ready);

    McpRegisterStatus {
        project_root: paths.display_root(),
        mcp_script_exists,
        project_mcp_config_ready,
        claude_project_registered,
        ready,
    }
}

/// 写入/更新应用数据目录下的 `.mcp.json`（可选写入当前桥接端口与 token）。
pub fn ensure_project_mcp_json(
    paths: &McpBundlePaths,
    bridge: Option<(u16, &str)>,
) -> Result<PathBuf, String> {
    write_mcp_config(paths, bridge)
}

/// 桥接启动或端口变化时同步 MCP 配置中的 IDE 环境变量。
pub fn sync_mcp_bridge_env(
    paths: &McpBundlePaths,
    port: u16,
    auth_token: &str,
) -> Result<PathBuf, String> {
    write_mcp_config(paths, Some((port, auth_token)))
}

pub fn register_mcp(
    paths: &McpBundlePaths,
    _claude_path: Option<String>,
    bridge: Option<(u16, &str)>,
) -> Result<McpRegisterStatus, String> {
    ensure_project_mcp_json(paths, bridge)?;
    Ok(check_mcp_status(paths, None))
}

pub fn try_auto_ensure_project_mcp(paths: &McpBundlePaths) {
    if let Err(err) = ensure_project_mcp_json(paths, None) {
        tracing::debug!("自动写入 MCP 配置跳过: {err}");
    }
}

/// 桥接就绪后尝试注册 MCP（失败仅记日志，不阻断桥接）。
pub fn try_auto_register_mcp(
    paths: &McpBundlePaths,
    claude_path: Option<String>,
    port: u16,
    auth_token: &str,
) {
    if let Err(err) = register_mcp(
        paths,
        claude_path,
        Some((port, auth_token)),
    ) {
        tracing::warn!("自动注册 MCP 失败: {err}");
    }
}
