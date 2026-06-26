use crate::app_paths::McpBundlePaths;
use crate::claude::bridge;
use crate::claude::detect::resolve_claude_path;
use crate::mcp_stdio_proxy::{mcp_stdio_launcher_command, mcp_stdio_proxy_flag};
use crate::process_util::{async_command_no_window, command_no_window};
use serde::Serialize;
use serde_json::{json, Value};
use std::fmt::Write as _;
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Duration, Instant};
use parking_lot::Mutex;
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
    /// stdio MCP 进程能否列出工具（桥接运行后由预检更新）
    #[serde(default)]
    pub runtime_tools_ready: bool,
    #[serde(default)]
    pub runtime_tool_count: u32,
    pub runtime_error: Option<String>,
}

/// 最近一次 MCP 运行时预检结果（供 UI 查询，避免每次 `claude_mcp_status` 拉起子进程）。
#[derive(Default)]
pub struct McpRuntimeCache {
    tools_ready: AtomicBool,
    tool_count: AtomicU32,
    error: Mutex<Option<String>>,
    checked_at: Mutex<Option<Instant>>,
}

impl McpRuntimeCache {
    pub fn record_ok(&self, count: usize) {
        self.tools_ready.store(true, Ordering::Relaxed);
        self.tool_count.store(count.min(u32::MAX as usize) as u32, Ordering::Relaxed);
        *self.error.lock() = None;
        *self.checked_at.lock() = Some(Instant::now());
    }

    pub fn record_err(&self, err: String) {
        self.tools_ready.store(false, Ordering::Relaxed);
        self.tool_count.store(0, Ordering::Relaxed);
        *self.error.lock() = Some(err);
        *self.checked_at.lock() = Some(Instant::now());
    }

    /// 最近一次预检若成功且在 `ttl` 内，返回缓存工具数；否则 None。
    /// 用于跳过每条消息重复的 MCP stdio 预检（会额外拉起 node 进程）。
    pub fn ready_count_if_fresh(&self, ttl: Duration) -> Option<usize> {
        if !self.tools_ready.load(Ordering::Relaxed) {
            return None;
        }
        let checked = (*self.checked_at.lock())?;
        if checked.elapsed() <= ttl {
            Some(self.tool_count.load(Ordering::Relaxed) as usize)
        } else {
            None
        }
    }

    pub fn apply_to_status(&self, status: &mut McpRegisterStatus, bridge_running: bool, strict_runtime: bool) {
        status.runtime_tools_ready = self.tools_ready.load(Ordering::Relaxed);
        status.runtime_tool_count = self.tool_count.load(Ordering::Relaxed);
        status.runtime_error = self.error.lock().clone();
        let file_ready = status.mcp_script_exists && status.project_mcp_config_ready;
        if bridge_running && strict_runtime {
            status.ready = file_ready && status.runtime_tools_ready;
        } else {
            status.ready = file_ready;
        }
    }
}

fn mcp_config_template(bridge: Option<(u16, &str)>) -> Result<Value, String> {
    let (command, args) = mcp_stdio_launcher_command()
        .ok_or_else(|| "无法定位 Clide 可执行文件（MCP 需要 clide --aiterm-mcp-stdio）".to_string())?;
    let mut server = json!({
        "command": command,
        "args": args,
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
    Ok(json!({
        "mcpServers": {
            MCP_SERVER_NAME: server
        }
    }))
}

/// 尽力通过 Claude Code CLI 登记 MCP（用户级/项目级），便于终端独立运行 `claude` 时也能发现 aiterm。
fn try_claude_mcp_add(claude_path: Option<String>) {
    let Ok(claude) = resolve_claude_path(claude_path) else {
        return;
    };
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let exe = exe.display().to_string();
    let flag = mcp_stdio_proxy_flag();

    let attempts: Vec<Vec<String>> = vec![
        vec![
            "mcp".into(),
            "add".into(),
            "-s".into(),
            "user".into(),
            MCP_SERVER_NAME.into(),
            "--".into(),
            exe.clone(),
            flag.into(),
        ],
        vec![
            "mcp".into(),
            "add".into(),
            "-s".into(),
            "project".into(),
            MCP_SERVER_NAME.into(),
            "--".into(),
            exe,
            flag.into(),
        ],
    ];

    for args in attempts {
        let output = command_no_window(&claude).args(&args).output();
        match output {
            Ok(o) if o.status.success() => {
                tracing::info!("claude mcp add 成功 ({})", args.join(" "));
                return;
            }
            Ok(o) => {
                tracing::debug!(
                    "claude mcp add 未成功 ({}): {}",
                    args.join(" "),
                    String::from_utf8_lossy(&o.stderr)
                );
            }
            Err(e) => tracing::debug!("claude mcp add 执行失败: {e}"),
        }
    }
}

fn write_mcp_config(paths: &McpBundlePaths, bridge: Option<(u16, &str)>) -> Result<PathBuf, String> {
    tracing::info!("Writing MCP config...");
    tracing::debug!("Config file path: {}", paths.mcp_config_file.display());

    if mcp_stdio_launcher_command().is_none() {
        return Err("无法定位 Clide 可执行文件，无法写入 MCP 配置".to_string());
    }

    let template = mcp_config_template(bridge)?;
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
    runtime: Option<&McpRuntimeCache>,
    bridge_running: bool,
    strict_runtime: bool,
) -> McpRegisterStatus {
    tracing::info!("Checking MCP status...");
    tracing::debug!("Launcher script path: {}", paths.launcher_script.display());
    tracing::debug!("Config file path: {}", paths.mcp_config_file.display());
    tracing::debug!("Config dir: {}", paths.config_dir.display());

    let mcp_binary_ready = mcp_stdio_launcher_command().is_some();
    let mcp_script_exists =
        mcp_binary_ready || paths.launcher_script.is_file() || paths.stdio_script.is_file();
    tracing::info!("MCP launcher ready: {}", mcp_script_exists);

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

    let mut status = McpRegisterStatus {
        project_root: paths.display_root(),
        mcp_script_exists,
        project_mcp_config_ready,
        claude_project_registered,
        ready: mcp_script_exists && project_mcp_config_ready,
        runtime_tools_ready: false,
        runtime_tool_count: 0,
        runtime_error: None,
    };
    if let Some(cache) = runtime {
        cache.apply_to_status(&mut status, bridge_running, strict_runtime);
    }
    tracing::info!("MCP ready: {}", status.ready);
    status
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
    claude_path: Option<String>,
    bridge: Option<(u16, &str)>,
    runtime: Option<&McpRuntimeCache>,
) -> Result<McpRegisterStatus, String> {
    ensure_project_mcp_json(paths, bridge)?;
    try_claude_mcp_add(claude_path);
    Ok(check_mcp_status(paths, None, runtime, bridge.is_some(), false))
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
        None,
    ) {
        tracing::warn!("自动注册 MCP 失败: {err}");
    }
}

/// 启动一次 MCP stdio 子进程并读取 `tools/list`，用于在拉起 Claude 前预热。
async fn preflight_stdio_tools_once(
    paths: &McpBundlePaths,
    port: u16,
    auth_token: &str,
    per_attempt: Duration,
) -> Result<usize, String> {
    let _ = paths;
    let (program, args) = mcp_stdio_launcher_command()
        .ok_or_else(|| "无法定位 Clide MCP 启动命令（clide --aiterm-mcp-stdio）".to_string())?;

    let workdir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(std::env::temp_dir);

    tracing::debug!(
        "MCP preflight: program={program} args={args:?} cwd={}",
        workdir.display()
    );

    let mut child = async_command_no_window(&program)
        .args(&args)
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
        .map_err(|e| format!("启动 MCP 预检进程失败 ({program}): {e}"))?;

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
        let read_budget = deadline
            .saturating_duration_since(tokio::time::Instant::now())
            .min(Duration::from_millis(2000))
            .max(Duration::from_millis(200));
        let line = match tokio::time::timeout(read_budget, lines.next_line()).await {
            Err(_) => continue,
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
    runtime: Option<&McpRuntimeCache>,
) -> Result<usize, String> {
    let _ = register_mcp(paths, None, Some((port, auth_token)), runtime)?;

    let bridge_slice = timeout.min(Duration::from_secs(3));
    match bridge::wait_for_bridge_tools(port, auth_token, bridge_slice).await {
        Ok(n) => tracing::info!("MCP bridge probe: {n} tools"),
        Err(e) => tracing::warn!("MCP bridge probe failed: {e}"),
    }

    let deadline = tokio::time::Instant::now() + timeout;
    let mut last_err = "MCP stdio 工具未就绪".to_string();
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let attempt = remaining.min(Duration::from_secs(4));
        match preflight_stdio_tools_once(paths, port, auth_token, attempt).await {
            Ok(n) if n > 0 => {
                tracing::info!("MCP preflight: {n} tools ready");
                if let Some(cache) = runtime {
                    cache.record_ok(n);
                }
                return Ok(n);
            }
            Ok(_) => last_err = "MCP tools/list 为空".to_string(),
            Err(e) => last_err = e,
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    if let Some(cache) = runtime {
        cache.record_err(last_err.clone());
    }
    Err(last_err)
}
