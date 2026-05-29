use crate::app_paths::{node_script_argv, path_to_js_string, McpBundlePaths};
use crate::claude::bridge;
use serde::Serialize;
use serde_json::{json, Value};
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

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
    let script = node_script_argv(launcher_script).unwrap_or_else(|_| path_to_js_string(launcher_script));
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

    // 检查现有配置是否相同，避免不必要的写入
    if paths.mcp_config_file.is_file() {
        match fs::read_to_string(&paths.mcp_config_file) {
            Ok(existing) if existing == config_json => {
                tracing::info!("MCP config unchanged, skipping write");
                return Ok(paths.mcp_config_file.clone());
            }
            _ => {}
        }
    }

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

fn mcp_launcher_path(paths: &McpBundlePaths) -> Result<PathBuf, String> {
    if paths.launcher_script.is_file() {
        Ok(paths.launcher_script.clone())
    } else if paths.stdio_script.is_file() {
        Ok(paths.stdio_script.clone())
    } else {
        Err(format!(
            "未找到 MCP 脚本: {}",
            paths.launcher_script.display()
        ))
    }
}

/// 启动一次 MCP stdio 子进程并读取 `tools/list`，用于在拉起 Claude 前预热。
async fn preflight_stdio_tools_once(
    paths: &McpBundlePaths,
    port: u16,
    auth_token: &str,
    per_attempt: Duration,
) -> Result<usize, String> {
    let script_path = mcp_launcher_path(paths)?;
    let script_arg = node_script_argv(&script_path)?;
    let node = resolve_node_command();
    let workdir = script_path
        .parent()
        .ok_or_else(|| format!("MCP 脚本无父目录: {}", script_path.display()))?;
    let workdir = fs::canonicalize(workdir)
        .map_err(|e| format!("无法解析 MCP 工作目录 {}: {e}", workdir.display()))?;

    tracing::debug!("MCP preflight: node={node} script={script_arg} cwd={}", workdir.display());

    let mut child = tokio::process::Command::new(&node)
        .arg(&script_arg)
        .current_dir(&workdir)
        .env("AITERM_IDE_PORT", port.to_string())
        .env("AITERM_IDE_AUTH_TOKEN", auth_token)
        .env("ENABLE_IDE_INTEGRATION", "true")
        .env("CLAUDE_CODE_SSE_PORT", port.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("启动 MCP 预检进程失败 ({node}): {e}"))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or("无法写入 MCP 预检 stdin")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("无法读取 MCP 预检 stdout")?;
    let mut lines = BufReader::new(stdout).lines();
    let stderr = child.stderr.take();
    let stderr_task = tokio::spawn(async move {
        let mut out = String::new();
        if let Some(stderr) = stderr {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if !line.trim().is_empty() {
                    let _ = writeln!(out, "{line}");
                }
            }
        }
        out
    });

    let init = json!({
        "jsonrpc": "2.0",
        "id": 0,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "aiterm-preflight", "version": "0.1.0" }
        }
    });
    stdin
        .write_all(format!("{init}\n").as_bytes())
        .await
        .map_err(|e| format!("写入 initialize 失败: {e}"))?;

    let deadline = tokio::time::Instant::now() + per_attempt;
    let mut init_ok = false;

    while tokio::time::Instant::now() < deadline {
        let line = match tokio::time::timeout(Duration::from_millis(800), lines.next_line()).await {
            Err(_) => return Err("MCP 预检读取超时".to_string()),
            Ok(Err(e)) => return Err(format!("读取 MCP 预检输出失败: {e}")),
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => {
                let log = collect_stderr(stderr_task).await;
                return Err(format!("MCP 预检进程已结束（未收到 tools/list）{log}"));
            }
        };

        let value: Value =
            serde_json::from_str(&line).map_err(|e| format!("解析 MCP 预检 JSON 失败: {e}"))?;

        // 忽略 notifications/tools/list_changed 等无 id 推送
        if value.get("id").is_none() {
            continue;
        }

        if value.get("id") == Some(&json!(0)) && value.get("result").is_some() {
            init_ok = true;
            let note = json!({
                "jsonrpc": "2.0",
                "method": "notifications/initialized"
            });
            stdin
                .write_all(format!("{note}\n").as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            let list = json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/list",
                "params": {}
            });
            stdin
                .write_all(format!("{list}\n").as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            continue;
        }

        if value.get("id") == Some(&json!(1)) {
            let count = value
                .get("result")
                .and_then(|r| r.get("tools"))
                .and_then(|t| t.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            let _ = child.kill().await;
            if count > 0 {
                let _ = stderr_task.abort();
                return Ok(count);
            }
            let log = collect_stderr(stderr_task).await;
            return Err(format!("MCP tools/list 返回空列表{log}"));
        }
    }

    let _ = child.kill().await;
    let log = collect_stderr(stderr_task).await;
    if init_ok {
        Err(format!("MCP 预检未返回 tools/list{log}"))
    } else {
        Err(format!("MCP 预检未完成 initialize{log}"))
    }
}

async fn collect_stderr(task: tokio::task::JoinHandle<String>) -> String {
    match tokio::time::timeout(Duration::from_millis(800), task).await {
        Ok(Ok(log)) if log.trim().is_empty() => String::new(),
        Ok(Ok(log)) => format!("; stderr:\n{log}"),
        _ => String::new(),
    }
}

/// 在拉起 Claude 前等待 MCP stdio 能列出工具（避免首条消息时 Claude 拿到空工具表）。
pub async fn wait_for_mcp_ready(
    paths: &McpBundlePaths,
    port: u16,
    auth_token: &str,
    timeout: Duration,
) -> Result<usize, String> {
    let _ = register_mcp(paths, None, Some((port, auth_token)))?;

    let bridge_slice = timeout.min(Duration::from_secs(3));
    let _ = bridge::wait_for_bridge_tools(port, auth_token, bridge_slice).await;

    let deadline = tokio::time::Instant::now() + timeout;
    let mut last_err = "MCP stdio 工具未就绪".to_string();
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let attempt = remaining.min(Duration::from_secs(4));
        match preflight_stdio_tools_once(paths, port, auth_token, attempt).await {
            Ok(n) if n > 0 => {
                tracing::info!("MCP preflight: {n} tools ready");
                return Ok(n);
            }
            Ok(_) => last_err = "MCP tools/list 为空".to_string(),
            Err(e) => last_err = e,
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    Err(last_err)
}
