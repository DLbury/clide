use super::detect::resolve_claude_path;
use serde::Serialize;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

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

pub fn project_root_path() -> PathBuf {
    super::bridge::resolve_workspace_folders(&[])
        .into_iter()
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn mcp_config_template() -> serde_json::Value {
    json!({
        "mcpServers": {
            MCP_SERVER_NAME: {
                "command": "node",
                "args": ["scripts/run-aiterm-mcp.mjs"],
                "alwaysLoad": true
            }
        }
    })
}

fn config_has_aiterm(content: &str) -> bool {
    content.contains(MCP_SERVER_NAME)
}

fn is_listed_in_claude(claude_path: &str, project_root: &Path) -> bool {
    let output = match Command::new(claude_path)
        .current_dir(project_root)
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

pub fn check_mcp_status(claude_path: Option<String>) -> McpRegisterStatus {
    let project_root = project_root_path();
    let script_path = project_root.join("scripts").join("run-aiterm-mcp.mjs");
    let config_path = project_root.join(".mcp.json");

    let mcp_script_exists = script_path.is_file();
    let project_mcp_config_ready = config_path
        .is_file()
        .then(|| fs::read_to_string(&config_path).ok())
        .flatten()
        .map(|c| config_has_aiterm(&c))
        .unwrap_or(false);

    let claude_project_registered = claude_path
        .as_deref()
        .and_then(|p| {
            if mcp_script_exists {
                Some(is_listed_in_claude(p, &project_root))
            } else {
                None
            }
        })
        .unwrap_or(false);

    let ready = mcp_script_exists && project_mcp_config_ready;

    McpRegisterStatus {
        project_root: project_root.display().to_string(),
        mcp_script_exists,
        project_mcp_config_ready,
        claude_project_registered,
        ready,
    }
}

pub fn ensure_project_mcp_json(project_root: &Path) -> Result<PathBuf, String> {
    let script_path = project_root.join("scripts").join("run-aiterm-mcp.mjs");
    if !script_path.is_file() {
        return Err(format!(
            "未找到 MCP 启动脚本: {}",
            script_path.display()
        ));
    }

    let path = project_root.join(".mcp.json");
    if path.is_file() {
        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if config_has_aiterm(&content) {
            return Ok(path);
        }
    }

    let template = mcp_config_template();
    fs::write(
        &path,
        serde_json::to_string_pretty(&template).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(path)
}

pub fn register_mcp(claude_path: Option<String>) -> Result<McpRegisterStatus, String> {
    let claude = resolve_claude_path(claude_path)?;
    let project_root = project_root_path();
    ensure_project_mcp_json(&project_root)?;

    if !is_listed_in_claude(&claude, &project_root) {
        let output = Command::new(&claude)
            .current_dir(&project_root)
            .args([
                "mcp",
                "add",
                "-s",
                "project",
                MCP_SERVER_NAME,
                "--",
                "node",
                "scripts/run-aiterm-mcp.mjs",
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

    Ok(check_mcp_status(Some(claude)))
}

pub fn try_auto_ensure_project_mcp() {
    let root = project_root_path();
    if let Err(err) = ensure_project_mcp_json(&root) {
        tracing::debug!("自动写入 .mcp.json 跳过: {err}");
    }
}
