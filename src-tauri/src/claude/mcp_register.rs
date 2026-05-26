use super::detect::resolve_claude_path;
use crate::app_paths::{path_to_js_string, McpBundlePaths};
use crate::process_util::command_no_window;
use serde::Serialize;
use serde_json::json;
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

fn mcp_config_template(launcher_script: &Path) -> serde_json::Value {
    let script = path_to_js_string(launcher_script);
    json!({
        "mcpServers": {
            MCP_SERVER_NAME: {
                "command": "node",
                "args": [script],
                "alwaysLoad": true
            }
        }
    })
}

fn config_has_aiterm(content: &str) -> bool {
    content.contains(MCP_SERVER_NAME)
}

fn is_listed_in_claude(claude_path: &str, scope_dir: &Path) -> bool {
    let output = match command_no_window(claude_path)
        .current_dir(scope_dir)
        .args(["mcp", "list"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return false,
    };
    if !output.status.success() {
        return false;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().any(|line| line.contains(MCP_SERVER_NAME))
}

pub fn check_mcp_status(
    paths: &McpBundlePaths,
    claude_path: Option<String>,
) -> McpRegisterStatus {
    let mcp_script_exists = paths.launcher_script.is_file();
    let project_mcp_config_ready = paths
        .mcp_config_file
        .is_file()
        .then(|| fs::read_to_string(&paths.mcp_config_file).ok())
        .flatten()
        .map(|c| config_has_aiterm(&c))
        .unwrap_or(false);

    let claude_project_registered = claude_path
        .as_deref()
        .and_then(|p| {
            if mcp_script_exists {
                Some(is_listed_in_claude(p, &paths.config_dir))
            } else {
                None
            }
        })
        .unwrap_or(false);

    let ready = mcp_script_exists && project_mcp_config_ready;

    McpRegisterStatus {
        project_root: paths.display_root(),
        mcp_script_exists,
        project_mcp_config_ready,
        claude_project_registered,
        ready,
    }
}

pub fn ensure_project_mcp_json(paths: &McpBundlePaths) -> Result<PathBuf, String> {
    if !paths.launcher_script.is_file() {
        return Err(format!(
            "未找到 MCP 启动脚本: {}",
            paths.launcher_script.display()
        ));
    }

    let path = &paths.mcp_config_file;
    if path.is_file() {
        let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
        if config_has_aiterm(&content) {
            return Ok(path.clone());
        }
    }

    let template = mcp_config_template(&paths.launcher_script);
    fs::write(
        path,
        serde_json::to_string_pretty(&template).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(path.clone())
}

pub fn register_mcp(
    paths: &McpBundlePaths,
    claude_path: Option<String>,
) -> Result<McpRegisterStatus, String> {
    let claude = resolve_claude_path(claude_path)?;
    ensure_project_mcp_json(paths)?;

    let script_arg = path_to_js_string(&paths.launcher_script);

    if !is_listed_in_claude(&claude, &paths.config_dir) {
        let output = command_no_window(&claude)
            .current_dir(&paths.config_dir)
            .args([
                "mcp",
                "add",
                "-s",
                "user",
                MCP_SERVER_NAME,
                "--",
                "node",
                &script_arg,
            ])
            .output()
            .map_err(|e| format!("执行 claude mcp add 失败: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let detail = if stderr.trim().is_empty() {
                stdout.trim().to_string()
            } else {
                stderr.trim().to_string()
            };
            let lower = detail.to_lowercase();
            if !lower.contains("already exists") && !lower.contains("already registered") {
                return Err(if detail.is_empty() {
                    "claude mcp add 失败".to_string()
                } else {
                    format!("claude mcp add 失败: {detail}")
                });
            }
        }
    }

    Ok(check_mcp_status(paths, Some(claude)))
}

pub fn try_auto_ensure_project_mcp(paths: &McpBundlePaths) {
    if let Err(err) = ensure_project_mcp_json(paths) {
        tracing::debug!("自动写入 MCP 配置跳过: {err}");
    }
}
