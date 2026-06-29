use crate::claude::detect::resolve_claude_path;
use crate::process_util::{
    command_no_window, configure_claude_cli_command, is_node_deprecation_noise,
    prepare_cli_discovery_environment, resolve_node_executable,
};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

const CLAUDE_REQUEST_OUTPUT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
/// IDE + MCP 冷启动在部分 Linux 上可能超过 90s 才有首条 stdout。
const CLAUDE_REQUEST_OUTPUT_TIMEOUT_IDE: std::time::Duration = std::time::Duration::from_secs(150);

fn request_output_timeout(with_ide_mcp: bool) -> std::time::Duration {
    if with_ide_mcp {
        CLAUDE_REQUEST_OUTPUT_TIMEOUT_IDE
    } else {
        CLAUDE_REQUEST_OUTPUT_TIMEOUT
    }
}

/// Windows 下 `.cmd` shim 经 `cmd /c` 传参时，系统提示中的特殊字符（`%`、`|`、换行等）
/// 会被 cmd.exe 误解析导致 Claude CLI 退出码 1。
/// 此函数绕过 cmd.exe，直接定位 `cli.js` 并用 `node.exe` 启动。
/// 返回 (program, initial_args)。
#[cfg(windows)]
fn resolve_claude_invocation(claude_path: &str) -> (String, Vec<String>) {
    let path = PathBuf::from(claude_path);
    let is_cmd = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
        .unwrap_or(false);

    if !is_cmd {
        return (claude_path.to_string(), vec![]);
    }

    let Some(cmd_dir) = path.parent() else {
        tracing::warn!(".cmd path has no parent dir: {}", claude_path);
        return (claude_path.to_string(), vec![]);
    };

    let Some(cli_js) = locate_claude_cli_js(&path, cmd_dir) else {
        tracing::warn!("Cannot locate cli.js for .cmd bypass: {}", claude_path);
        return (claude_path.to_string(), vec![]);
    };

    let Some(program) = find_node_exe(cmd_dir) else {
        tracing::warn!("Cannot find node.exe for .cmd bypass, falling back to .cmd");
        return (claude_path.to_string(), vec![]);
    };

    tracing::info!(
        "Bypassing .cmd shim: node={}, cli.js={}",
        program,
        cli_js.display()
    );
    (program, vec![cli_js.to_string_lossy().into_owned()])
}

/// Linux/macOS：npm 全局 `claude` 常为 shell 脚本；GUI 进程 PATH 不完整时 shebang 解析会卡住或失败。
/// 尽量用显式 node + cli.js 启动（与 Windows 策略一致）。
#[cfg(not(windows))]
fn resolve_claude_invocation(claude_path: &str) -> (String, Vec<String>) {
    let path = PathBuf::from(claude_path);
    if !path.is_file() {
        return (claude_path.to_string(), vec![]);
    }

    if path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("cli.js"))
    {
        if let Ok(node) = resolve_node_executable() {
            return (node, vec![claude_path.to_string()]);
        }
    }

    if let Some(cli_js) = locate_unix_claude_cli_js(&path) {
        if let Ok(node) = resolve_node_executable() {
            tracing::info!(
                "Bypassing claude shim on Unix: node={}, cli.js={}",
                node,
                cli_js.display()
            );
            return (node, vec![cli_js.to_string_lossy().into_owned()]);
        }
        tracing::warn!(
            "Found cli.js for {claude_path} but node not in PATH; falling back to shim"
        );
    }

    (claude_path.to_string(), vec![])
}

#[cfg(not(windows))]
fn locate_unix_claude_cli_js(entry: &Path) -> Option<PathBuf> {
    let resolved = std::fs::canonicalize(entry).unwrap_or_else(|_| entry.to_path_buf());

    if resolved
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("cli.js"))
    {
        return Some(resolved);
    }

    let base_dir = resolved.parent()?;

    const RELATIVE_CLI_PATHS: &[&[&str]] = &[
        &["node_modules", "@anthropic-ai", "claude-code", "cli.js"],
        &["..", "lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js"],
    ];

    for relative in RELATIVE_CLI_PATHS {
        let candidate = relative.iter().fold(base_dir.to_path_buf(), |acc, seg| acc.join(seg));
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    if let Ok(content) = std::fs::read_to_string(&resolved) {
        for line in content.lines().take(8) {
            if !line.contains("cli.js") {
                continue;
            }
            for segment in extract_quoted_segments(line) {
                let p = PathBuf::from(segment.replace("%~dp0", &format!("{}/", base_dir.display())));
                if p.is_file()
                    && p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.eq_ignore_ascii_case("cli.js"))
                {
                    return Some(p);
                }
            }
        }
    }

    if let Some(home) = dirs::home_dir() {
        for rel in [
            ".local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
            ".npm/lib/node_modules/@anthropic-ai/claude-code/cli.js",
            ".npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js",
            ".config/npm/global/lib/node_modules/@anthropic-ai/claude-code/cli.js",
        ] {
            let p = home.join(rel);
            if p.is_file() {
                return Some(p);
            }
        }
    }

    for global in [
        "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js",
        "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
        "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    ] {
        let p = PathBuf::from(global);
        if p.is_file() {
            return Some(p);
        }
    }

    None
}

/// 定位 npm 全局安装的 cli.js（多种目录布局）。
fn locate_claude_cli_js(cmd_path: &Path, cmd_dir: &Path) -> Option<PathBuf> {
    if let Some(parsed) = parse_cmd_for_cli_js(cmd_path) {
        return Some(parsed);
    }

    let standard = cmd_dir
        .join("node_modules")
        .join("@anthropic-ai")
        .join("claude-code")
        .join("cli.js");
    if standard.is_file() {
        return Some(standard);
    }

    if let Ok(appdata) = std::env::var("APPDATA") {
        let global = PathBuf::from(appdata)
            .join("npm")
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code")
            .join("cli.js");
        if global.is_file() {
            return Some(global);
        }
    }

    if let Ok(home) = std::env::var("USERPROFILE") {
        let local = PathBuf::from(home)
            .join("AppData")
            .join("Roaming")
            .join("npm")
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code")
            .join("cli.js");
        if local.is_file() {
            return Some(local);
        }
    }

    None
}

/// 解析 .cmd 文件内容，提取 cli.js 路径。
/// npm 生成的 .cmd 通常包含形如：
///   "%~dp0\node.exe" "%~dp0\node_modules\@anthropic-ai\claude-code\cli.js" %*
/// 或：
///   "@ECHO off" ... "node.exe" "C:\path\to\cli.js"
#[cfg(windows)]
fn parse_cmd_for_cli_js(cmd_path: &Path) -> Option<PathBuf> {
    let content = std::fs::read_to_string(cmd_path).ok()?;
    let cmd_dir = cmd_path.parent()?;

    for line in content.lines() {
        let lower = line.to_lowercase();
        if !lower.contains("cli.js") && !lower.contains("claude-code") {
            continue;
        }

        // 提取引号内的 cli.js 路径
        for segment in extract_quoted_segments(line) {
            let normalized = segment.replace("%~dp0", &format!("{}\\", cmd_dir.display()));
            let normalized = normalized.replace("%dp0%", &format!("{}\\", cmd_dir.display()));
            let p = PathBuf::from(&normalized);
            if p.is_file() {
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if name.eq_ignore_ascii_case("cli.js") {
                    return Some(p);
                }
            }
        }

        // 尝试标准路径拼接
        let standard = cmd_dir
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code")
            .join("cli.js");
        if standard.is_file() {
            return Some(standard);
        }
    }
    None
}

#[cfg(not(windows))]
fn parse_cmd_for_cli_js(_cmd_path: &Path) -> Option<PathBuf> {
    None
}

/// 从命令行文本中提取所有双引号包裹的片段。
fn extract_quoted_segments(line: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut in_quotes = false;
    let mut current = String::new();
    for ch in line.chars() {
        if ch == '"' {
            if in_quotes {
                segments.push(std::mem::take(&mut current));
            }
            in_quotes = !in_quotes;
        } else if in_quotes {
            current.push(ch);
        }
    }
    segments
}

/// 在多个位置搜索 node.exe。
#[cfg(windows)]
fn find_node_exe(cmd_dir: &Path) -> Option<String> {
    prepare_cli_discovery_environment();
    // cmd 同目录（npm 内嵌 Node）
    let node_in_cmd_dir = cmd_dir.join("node.exe");
    if node_in_cmd_dir.is_file() {
        return Some(node_in_cmd_dir.to_string_lossy().into_owned());
    }
    // npm 根目录（cmd 在 npm/ 子目录下时）
    let node_in_parent = cmd_dir.join("..").join("node.exe");
    if node_in_parent.is_file() {
        return Some(node_in_parent.to_string_lossy().into_owned());
    }
    // npm 根目录再上一级（某些安装布局）
    let node_in_grandparent = cmd_dir.join("..").join("..").join("node.exe");
    if node_in_grandparent.is_file() {
        return Some(node_in_grandparent.to_string_lossy().into_owned());
    }
    // 系统 PATH
    if let Ok(n) = which::which("node.exe") {
        return Some(n.to_string_lossy().into_owned());
    }
    // 常见安装路径
    if let Some(home) = std::env::var_os("LOCALAPPDATA") {
        let p = PathBuf::from(home).join("fnm_multishells").join("node.exe");
        if p.is_file() { return Some(p.to_string_lossy().into_owned()); }
    }
    if let Some(home) = std::env::var_os("APPDATA") {
        for sub in &["nvm\\current", "volta"] {
            let p = PathBuf::from(home.clone()).join(sub).join("node.exe");
            if p.is_file() { return Some(p.to_string_lossy().into_owned()); }
        }
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        for sub in &[".nvm\\current\\bin", ".volta\\bin", ".fnm\\current"] {
            let p = PathBuf::from(home.clone()).join(sub).join("node.exe");
            if p.is_file() { return Some(p.to_string_lossy().into_owned()); }
        }
    }
    // Program Files
    if let Some(pf) = std::env::var_os("PROGRAMFILES") {
        let p = PathBuf::from(pf).join("nodejs").join("node.exe");
        if p.is_file() { return Some(p.to_string_lossy().into_owned()); }
    }
    None
}

#[cfg(not(windows))]
fn find_node_exe(_cmd_dir: &Path) -> Option<String> {
    prepare_cli_discovery_environment();
    which::which("node").ok().map(|p| p.to_string_lossy().into_owned())
}


/// IDE 桥接已启用时追加到 Claude，促使其调用 MCP 工具而非仅文字回答。
const IDE_BRIDGE_APPEND_PROMPT: &str = r#"You are connected to AI Terminal via IDE MCP integration (server `aiterm`).

Conversational messages (greetings, thanks, small talk, general questions):
- Reply in plain text only. Do NOT call runShellCommand or other MCP tools.

Remote/server shell tasks — mandatory workflow:
1. Call `getFocusedServer` or `listActiveConnections` to get `profileId`.
   - `profileId` must be the stable ID from tool output; never use session name/host/shellId as `profileId`.
2. If the terminal is not connected, call `mcp__aiterm__connectServer` with that `profileId`, then `mcp__aiterm__runShellCommand`.
3. Call `mcp__aiterm__runShellCommand` with `profileId` and `command`. Use the tool JSON `output` field in your reply.
4. NEVER say you "cannot connect directly" / "无法直接连接" / "MCP 受限" / "无法远程执行" and only paste bash blocks — you CAN execute via IDE tools.
5. NEVER use local Bash/WSL/PowerShell, and NEVER use the Skill tool (skills are not MCP). Do not invoke `runShellCommand` as a skill name.

MCP tool names (server `aiterm` only): mcp__aiterm__runShellCommand, mcp__aiterm__getFocusedServer, mcp__aiterm__connectServer, mcp__aiterm__listActiveConnections, etc.
NEVER claim these tools are missing when the bridge is ready — call mcp__aiterm__runShellCommand first.

Sudo / interactive passwords:
- Run `sudo ...` via runShellCommand like any other command.
- NEVER ask the user to paste sudo or SSH passwords into chat, and NEVER embed passwords in commands.
- When sudo prompts for a password, tell the user to type it directly in the left Shell panel (same as a normal terminal); you cannot type it for them.
- SSH login passwords are handled by the app UI only — not by the AI.
"#;

/// --ide 模式下放行的工具。
/// 兼容部分模型偶发调用 `mcp__aiterm__*` 前缀名，避免 dontAsk 模式下被权限拒绝。
const AITERM_IDE_ALLOWED_TOOLS: &[&str] = &[
    "runShellCommand",
    "mcp__aiterm__runShellCommand",
    "connectServer",
    "mcp__aiterm__connectServer",
    "disconnectServer",
    "mcp__aiterm__disconnectServer",
    "getFocusedServer",
    "mcp__aiterm__getFocusedServer",
    "getTerminalContext",
    "mcp__aiterm__getTerminalContext",
    "listServerProfiles",
    "mcp__aiterm__listServerProfiles",
    "listActiveConnections",
    "mcp__aiterm__listActiveConnections",
    "listRemoteFiles",
    "mcp__aiterm__listRemoteFiles",
    "readRemoteFile",
    "mcp__aiterm__readRemoteFile",
    "listPortForwards",
    "mcp__aiterm__listPortForwards",
    "openRemoteBrowser",
    "mcp__aiterm__openRemoteBrowser",
    "getWorkspaceFolders",
    "mcp__aiterm__getWorkspaceFolders",
    "getOpenFiles",
    "mcp__aiterm__getOpenFiles",
    "getCurrentSelection",
    "mcp__aiterm__getCurrentSelection",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStreamEvent {
    pub request_id: String,
    pub event_type: String,
    pub text: Option<String>,
    pub session_id: Option<String>,
    pub done: bool,
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_input: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_error: Option<String>,
}

/// 常驻 Claude CLI 进程：用 `--input-format stream-json` 让单个进程跨多轮消息复用，
/// 消除每条消息全新 `claude -p` 的冷启动（Node 启动 + MCP 握手 ~4-5s）。
struct Persistent {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    /// 启动时的配置指纹（claude 路径/桥接端口/工作区/mcp 配置）；变化则需重启进程。
    fingerprint: String,
    /// 进程代号；reader 线程退出时据此判断是否仍是当前进程，避免误清掉已重启的新进程。
    generation: u64,
    /// 是否以 IDE 桥接 + MCP 配置启动（影响看门狗超时时长）。
    with_ide_mcp: bool,
    /// IDE system prompt 临时文件路径，进程结束时清理。
    prompt_path: Option<PathBuf>,
}

pub struct ClaudeSessionManager {
    proc: Arc<Mutex<Option<Persistent>>>,
    /// 当前进行中的请求 id；reader 线程据此给事件打标签，`result`（done）后清空。
    current_request: Arc<Mutex<Option<String>>>,
    /// 进程已建立的 Claude 会话 id（来自 system/init 与 result 事件）。
    session_id: Arc<Mutex<Option<String>>>,
    /// 本轮是否已通过 text_delta 推送过正文，供 assistant 快照回退判断。
    saw_text: Arc<AtomicBool>,
    /// 当前请求是否已收到 stdout（看门狗用，每轮消息重置）。
    request_output_seen: Arc<AtomicBool>,
    /// 进程代号自增计数器。
    generation: Arc<AtomicU64>,
    /// 首次发送时记录的 AppHandle，供取消时补发 done 事件清理前端 handler。
    app: Arc<Mutex<Option<AppHandle>>>,
}

/// 由可变参数生成进程复用指纹。任一变化都要求重启常驻进程。
fn build_fingerprint(
    claude: &str,
    bridge_port: Option<u16>,
    workspace_dir: Option<&PathBuf>,
    mcp_config: Option<&PathBuf>,
) -> String {
    format!(
        "{}|{}|{}|{}",
        claude,
        bridge_port.map(|p| p.to_string()).unwrap_or_default(),
        workspace_dir
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        mcp_config
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
    )
}

/// 将一条用户消息以 stream-json NDJSON 写入常驻进程 stdin。
fn write_user_message(stdin: &mut std::process::ChildStdin, prompt: &str) -> std::io::Result<()> {
    let msg = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{ "type": "text", "text": prompt }],
        },
    });
    let line = serde_json::to_string(&msg).unwrap_or_default();
    stdin.write_all(line.as_bytes())?;
    stdin.write_all(b"\n")?;
    stdin.flush()
}

impl ClaudeSessionManager {
    pub fn new() -> Self {
        Self {
            proc: Arc::new(Mutex::new(None)),
            current_request: Arc::new(Mutex::new(None)),
            session_id: Arc::new(Mutex::new(None)),
            saw_text: Arc::new(AtomicBool::new(false)),
            request_output_seen: Arc::new(AtomicBool::new(false)),
            generation: Arc::new(AtomicU64::new(0)),
            app: Arc::new(Mutex::new(None)),
        }
    }

    /// 发送一条消息：优先复用常驻进程；指纹/会话不匹配或进程已死则重启。
    pub fn spawn(
        &self,
        app: AppHandle,
        request_id: String,
        prompt: String,
        claude_path: Option<String>,
        session_id: Option<String>,
        continue_session: bool,
        bridge_port: Option<u16>,
        bridge_auth_token: Option<String>,
        workspace_dir: Option<PathBuf>,
        mcp_config: Option<PathBuf>,
    ) -> Result<(), String> {
        let claude = resolve_claude_path(claude_path)?;
        let want_session = session_id.filter(|s| !s.trim().is_empty());
        let fingerprint =
            build_fingerprint(&claude, bridge_port, workspace_dir.as_ref(), mcp_config.as_ref());

        if self.try_reuse(
            &app,
            &request_id,
            &prompt,
            &fingerprint,
            &want_session,
        ) {
            return Ok(());
        }

        self.spawn_process(
            app,
            request_id,
            prompt,
            &claude,
            want_session,
            continue_session,
            bridge_port,
            bridge_auth_token,
            workspace_dir,
            mcp_config,
            fingerprint,
        )
    }

    /// 尝试复用现有常驻进程。成功写入消息返回 true；否则杀掉旧进程并返回 false。
    fn try_reuse(
        &self,
        app: &AppHandle,
        request_id: &str,
        prompt: &str,
        fingerprint: &str,
        want_session: &Option<String>,
    ) -> bool {
        let mut guard = self.proc.lock();
        if guard.is_none() {
            return false;
        }

        let (alive, fp_ok) = {
            let p = guard.as_mut().unwrap();
            (
                matches!(p.child.try_wait(), Ok(None)),
                p.fingerprint == fingerprint,
            )
        };
        let established = self.session_id.lock().clone();
        // 复用条件：进程存活、配置一致，且请求未指定会话或与进程会话一致。
        let session_ok = want_session.is_none()
            || established.is_none()
            || want_session.as_deref() == established.as_deref();

        if !(alive && fp_ok && session_ok) {
            if let Some(mut old) = guard.take() {
                let _ = old.child.kill();
                if let Some(path) = &old.prompt_path {
                    let _ = std::fs::remove_file(path);
                }
            }
            return false;
        }

        self.saw_text.store(false, Ordering::SeqCst);
        self.request_output_seen.store(false, Ordering::SeqCst);
        *self.current_request.lock() = Some(request_id.to_string());
        let (generation, with_ide_mcp) = {
            let p = guard.as_mut().unwrap();
            (p.generation, p.with_ide_mcp)
        };
        let p = guard.as_mut().unwrap();
        match write_user_message(&mut p.stdin, prompt) {
            Ok(()) => {
                tracing::info!("Reusing persistent Claude process for request_id={request_id}");
                drop(guard);
                self.arm_request_watchdog(
                    app.clone(),
                    request_id.to_string(),
                    generation,
                    with_ide_mcp,
                );
                true
            }
            Err(e) => {
                tracing::warn!("persistent stdin write failed, will respawn: {e}");
                if let Some(mut old) = guard.take() {
                    let _ = old.child.kill();
                    if let Some(path) = &old.prompt_path {
                        let _ = std::fs::remove_file(path);
                    }
                }
                *self.current_request.lock() = None;
                false
            }
        }
    }

    /// 启动一个全新的常驻进程并写入首条消息，挂上 stdout/stderr 读取线程与冷启动看门狗。
    #[allow(clippy::too_many_arguments)]
    fn spawn_process(
        &self,
        app: AppHandle,
        request_id: String,
        prompt: String,
        claude: &str,
        want_session: Option<String>,
        continue_session: bool,
        bridge_port: Option<u16>,
        bridge_auth_token: Option<String>,
        workspace_dir: Option<PathBuf>,
        mcp_config: Option<PathBuf>,
        fingerprint: String,
    ) -> Result<(), String> {
        let (claude_program, claude_prefix_args) = resolve_claude_invocation(claude);
        *self.app.lock() = Some(app.clone());
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        tracing::info!(
            "Spawning persistent Claude CLI: resolved={claude}, program={claude_program}, gen={generation}, request_id={request_id}, bridge_port={:?}, workspace={:?}",
            bridge_port,
            workspace_dir.as_ref().map(|p| p.display().to_string())
        );

        let mut args = vec![
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--input-format".to_string(),
            "stream-json".to_string(),
            "--verbose".to_string(),
            "--include-partial-messages".to_string(),
        ];

        // 会话选择：指定会话 => --resume（重启后保留上下文）；用户明确继续 => --continue。
        if let Some(sid) = want_session.filter(|s| !s.trim().is_empty()) {
            args.push("--resume".to_string());
            args.push(sid);
        } else if continue_session {
            args.push("--continue".to_string());
        }

        let mut prompt_path: Option<PathBuf> = None;
        if bridge_port.is_some() {
            args.push("--ide".to_string());
            args.push("--permission-mode".to_string());
            args.push("dontAsk".to_string());
            for tool in AITERM_IDE_ALLOWED_TOOLS {
                args.push("--allowed-tools".to_string());
                args.push(tool.to_string());
            }
            // 避免 Windows cmd.exe 8191 字符限制：长 system prompt 写入临时文件
            let append_path =
                std::env::temp_dir().join(format!("clide-ide-prompt-{request_id}.txt"));
            std::fs::write(&append_path, IDE_BRIDGE_APPEND_PROMPT.as_bytes())
                .map_err(|e| format!("无法写入 Claude IDE 提示词临时文件: {e}"))?;
            args.push("--append-system-prompt-file".to_string());
            args.push(append_path.display().to_string());
            prompt_path = Some(append_path);
        } else {
            args.push("--permission-mode".to_string());
            args.push("default".to_string());
        }

        if let Some(ref cfg) = mcp_config {
            if cfg.is_file() {
                args.push("--mcp-config".to_string());
                args.push(cfg.display().to_string());
            }
        }

        // -p：非交互模式（stream-json 输入要求）；prompt 通过 stdin 的 NDJSON 消息提供，不作参数。
        args.push("-p".to_string());

        let mut command = command_no_window(&claude_program);
        if !claude_prefix_args.is_empty() {
            command.args(&claude_prefix_args);
        }
        command
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if let Some(port) = bridge_port {
            command
                .env("ENABLE_IDE_INTEGRATION", "true")
                .env("CLAUDE_CODE_SSE_PORT", port.to_string())
                .env("AITERM_IDE_PORT", port.to_string());
            if let Some(token) = bridge_auth_token {
                command.env("AITERM_IDE_AUTH_TOKEN", token);
            }
        }

        if let Some(ref cfg) = mcp_config {
            if cfg.is_file() {
                command.env("CLAUDE_MCP_CONFIG", cfg.as_os_str());
            }
        }

        if let Some(dir) = workspace_dir {
            if dir.is_dir() {
                command
                    .current_dir(&dir)
                    .env("CLAUDE_PROJECT_DIR", dir.as_os_str());
            }
        }

        configure_claude_cli_command(&mut command);

        let mut child = command.spawn().map_err(|e| {
            if let Some(path) = &prompt_path {
                let _ = std::fs::remove_file(path);
            }
            let msg = format!("启动 Claude Code 失败 ({claude}): {e}");
            tracing::error!("{msg}");
            msg
        })?;

        let stdout = child.stdout.take().ok_or("无法读取 Claude Code 输出")?;
        let stderr = child.stderr.take().ok_or("无法读取 Claude Code 错误输出")?;
        let mut stdin = child.stdin.take().ok_or("无法写入 Claude Code 输入")?;

        let with_ide_mcp = bridge_port.is_some();
        let stderr_collector: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let request_output_seen = self.request_output_seen.clone();

        self.saw_text.store(false, Ordering::SeqCst);
        request_output_seen.store(false, Ordering::SeqCst);
        *self.current_request.lock() = Some(request_id.clone());
        *self.session_id.lock() = None;

        *self.proc.lock() = Some(Persistent {
            child,
            stdin,
            fingerprint,
            generation,
            with_ide_mcp,
            prompt_path,
        });

        // 先挂 reader 再写 stdin，避免 Linux 上 stderr 填满管道导致子进程阻塞。
        self.spawn_readers(
            app.clone(),
            stdout,
            stderr,
            generation,
            request_output_seen.clone(),
            stderr_collector,
        );

        if let Err(e) = {
            let mut guard = self.proc.lock();
            let Some(p) = guard.as_mut() else {
                return Err("Claude 进程意外丢失".to_string());
            };
            write_user_message(&mut p.stdin, &prompt)
        } {
            if let Some(mut dead) = self.proc.lock().take() {
                let _ = dead.child.kill();
                if let Some(path) = &dead.prompt_path {
                    let _ = std::fs::remove_file(path);
                }
            }
            *self.current_request.lock() = None;
            return Err(format!("写入 Claude 首条消息失败: {e}"));
        }

        self.arm_request_watchdog(app, request_id.clone(), generation, with_ide_mcp);

        tracing::info!("persistent Claude spawned, request_id={request_id}, gen={generation}");
        Ok(())
    }

    /// 若本轮请求在超时内无任何 stdout，杀掉进程并向前端报错（冷启动与复用均适用）。
    fn arm_request_watchdog(
        &self,
        app: AppHandle,
        request_id: String,
        generation: u64,
        with_ide_mcp: bool,
    ) {
        let timeout = request_output_timeout(with_ide_mcp);
        let proc = self.proc.clone();
        let current = self.current_request.clone();
        let session = self.session_id.clone();
        let saw = self.request_output_seen.clone();
        std::thread::spawn(move || {
            std::thread::sleep(timeout);
            if saw.load(Ordering::SeqCst) {
                return;
            }
            if current.lock().as_deref() != Some(request_id.as_str()) {
                return;
            }
            let mut guard = proc.lock();
            if guard.as_ref().map(|p| p.generation) != Some(generation) {
                return;
            }
            if let Some(mut dead) = guard.take() {
                tracing::warn!(
                    "Claude produced no stdout for {}s; killing gen={}",
                    timeout.as_secs(),
                    generation
                );
                let _ = dead.child.kill();
                if let Some(path) = &dead.prompt_path {
                    let _ = std::fs::remove_file(path);
                }
            }
            drop(guard);
            if let Some(req) = current.lock().take() {
                let sid = session.lock().clone();
                let hint = if with_ide_mcp {
                    "Claude 在 MCP/IDE 初始化阶段长时间无输出（部分 Linux 环境较慢）。请确认已登录 Claude CLI（终端执行 claude /login），并检查侧栏 MCP 状态；也可在终端直接运行 claude -p 测试。"
                } else {
                    "Claude 启动后长时间无任何输出。请确认 CLI 已安装并登录（claude /login）。"
                };
                emit_turn_failure(&app, &req, sid, hint.to_string());
            }
        });
    }

    /// 为常驻进程挂上 stdout/stderr 读取线程，按当前 request_id 路由事件。
    fn spawn_readers(
        &self,
        app: AppHandle,
        stdout: std::process::ChildStdout,
        stderr: std::process::ChildStderr,
        generation: u64,
        request_output_seen: Arc<AtomicBool>,
        stderr_collector: Arc<Mutex<Vec<String>>>,
    ) {
        let app_stdout = app.clone();
        let proc = self.proc.clone();
        let current = self.current_request.clone();
        let session = self.session_id.clone();
        let saw_text = self.saw_text.clone();
        let stderr_for_stdout = stderr_collector.clone();

        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                request_output_seen.store(true, Ordering::SeqCst);

                let detected_type = serde_json::from_str::<serde_json::Value>(trimmed)
                    .ok()
                    .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(String::from))
                    .unwrap_or_default();
                let detail = if detected_type == "stream_event" {
                    serde_json::from_str::<serde_json::Value>(trimmed)
                        .ok()
                        .and_then(|v| {
                            let inner =
                                v.pointer("/event/type").and_then(|t| t.as_str()).unwrap_or("");
                            let delta = v
                                .pointer("/event/delta/type")
                                .and_then(|t| t.as_str())
                                .unwrap_or("");
                            Some(format!("{inner}/{delta}"))
                        })
                        .unwrap_or_default()
                } else {
                    String::new()
                };
                tracing::info!("stream line: type={detected_type} {detail}");

                let req = current.lock().clone();
                let mut local_sid = session.lock().clone();
                let mut events =
                    parse_stream_line(trimmed, req.as_deref().unwrap_or(""), &mut local_sid, &saw_text);
                if events.is_empty() {
                    events = parse_plaintext_fallback(
                        trimmed,
                        req.as_deref().unwrap_or(""),
                        &local_sid,
                    );
                }
                // 回写进程会话 id（system/init、result 都可能更新）。
                {
                    let mut s = session.lock();
                    if *s != local_sid {
                        *s = local_sid.clone();
                    }
                }

                // 轮次之间（req 为空，如 init 事件）只采集会话 id，不向前端派发。
                let Some(req_id) = req else { continue };
                for event in events {
                    let is_done = event.done;
                    if event.event_type == "stream_event" && event.text.is_some() {
                        saw_text.store(true, Ordering::SeqCst);
                    }
                    let _ = app_stdout.emit("claude:stream", event);
                    if is_done {
                        // 本轮以 result 收尾：清空当前请求，进程继续存活等待下一条。
                        let mut cur = current.lock();
                        if cur.as_deref() == Some(req_id.as_str()) {
                            *cur = None;
                        }
                    }
                }
            }

            // stdout EOF：进程已退出。仅当仍是当前进程时清理并上报失败。
            std::thread::sleep(std::time::Duration::from_millis(200));
            let mut guard = proc.lock();
            let is_current = guard.as_ref().map(|p| p.generation) == Some(generation);
            if !is_current {
                return;
            }
            let mut dead = guard.take();
            drop(guard);

            let exit_error = dead.as_mut().and_then(|p| {
                let status = p.child.wait().ok();
                if let Some(path) = &p.prompt_path {
                    let _ = std::fs::remove_file(path);
                }
                status.and_then(|s| {
                    if s.success() {
                        None
                    } else {
                        Some(format!("Claude Code 进程异常退出 ({s})"))
                    }
                })
            });

            let collected_stderr: Vec<String> = stderr_for_stdout.lock().drain(..).collect();
            let req = current.lock().take();
            let sid = session.lock().clone();
            tracing::info!(
                "persistent Claude process ended: gen={generation}, in_flight_request={:?}, exit_error={:?}",
                req.as_deref().unwrap_or("(none)"),
                exit_error.as_deref().unwrap_or("(none)")
            );

            // 仅当有进行中的轮次（进程在产出 result 前死亡）时才上报错误，避免空闲退出误报。
            if let Some(req_id) = req {
                let detail = exit_error
                    .map(|e| {
                        if collected_stderr.is_empty() {
                            e
                        } else {
                            format!("{e}\n\n--- Claude CLI stderr ---\n{}", collected_stderr.join("\n"))
                        }
                    })
                    .unwrap_or_else(|| {
                        if collected_stderr.is_empty() {
                            "Claude Code 进程在产生回复前退出。请确认 CLI 已安装并登录（claude /login）。".to_string()
                        } else {
                            collected_stderr.join("\n")
                        }
                    });
                emit_turn_failure(&app_stdout, &req_id, sid, detail);
            }
        });

        let app_stderr = app;
        let current_err = self.current_request.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                if line.trim().is_empty() || is_node_deprecation_noise(&line) {
                    continue;
                }
                stderr_collector.lock().push(line.clone());
                let req = current_err.lock().clone();
                let Some(req_id) = req else { continue };
                let lower = line.to_lowercase();
                let stale = lower.contains("no conversation found")
                    || lower.contains("conversation not found");
                let fatal = !stale
                    && (lower.contains("not recognized")
                        || lower.contains("enoent")
                        || lower.contains("cannot find")
                        || lower.contains("command not found")
                        || lower.contains("not logged in")
                        || lower.contains("/login")
                        || lower.contains("authentication required")
                        || lower.contains("error:")
                        || lower.contains("failed"));
                let stream_error = if stale || fatal {
                    Some(line.clone())
                } else {
                    None
                };
                let _ = app_stderr.emit(
                    "claude:stream",
                    ClaudeStreamEvent {
                        request_id: req_id,
                        event_type: if stale {
                            "session_error".into()
                        } else {
                            "stderr".into()
                        },
                        text: Some(line),
                        session_id: None,
                        done: stale || fatal,
                        error: stream_error,
                        reasoning: None,
                        tool_id: None,
                        tool_name: None,
                        tool_input: None,
                        tool_output: None,
                        tool_error: None,
                    },
                );
            }
        });
    }

    /// 取消某轮请求：杀掉常驻进程（下条消息会以 --resume 重启保留上下文）。
    pub fn cancel(&self, request_id: &str) {
        let is_current = self.current_request.lock().as_deref() == Some(request_id);
        if is_current {
            self.kill_process(Some(request_id));
        }
    }

    pub fn cancel_all(&self) {
        let req = self.current_request.lock().clone();
        self.kill_process(req.as_deref());
    }

    /// 杀掉常驻进程并清理临时文件；若给出请求 id 则补发 done，避免前端 handler 泄漏。
    fn kill_process(&self, request_id: Option<&str>) {
        if let Some(mut p) = self.proc.lock().take() {
            let _ = p.child.kill();
            if let Some(path) = &p.prompt_path {
                let _ = std::fs::remove_file(path);
            }
        }
        *self.current_request.lock() = None;
        if let Some(req) = request_id {
            if let Some(app) = self.app.lock().clone() {
                let sid = self.session_id.lock().clone();
                let _ = app.emit(
                    "claude:stream",
                    ClaudeStreamEvent {
                        request_id: req.to_string(),
                        event_type: "done".into(),
                        text: None,
                        session_id: sid,
                        done: true,
                        error: None,
                        reasoning: None,
                        tool_id: None,
                        tool_name: None,
                        tool_input: None,
                        tool_output: None,
                        tool_error: None,
                    },
                );
            }
        }
    }
}

/// 向前端上报某轮请求失败：先发 process_error（携带正文），再发 done 收尾。
fn emit_turn_failure(app: &AppHandle, request_id: &str, session_id: Option<String>, error: String) {
    let _ = app.emit(
        "claude:stream",
        ClaudeStreamEvent {
            request_id: request_id.to_string(),
            event_type: "process_error".into(),
            text: Some(error.clone()),
            session_id: session_id.clone(),
            done: false,
            error: Some(error.clone()),
            reasoning: None,
            tool_id: None,
            tool_name: None,
            tool_input: None,
            tool_output: None,
            tool_error: None,
        },
    );
    let _ = app.emit(
        "claude:stream",
        ClaudeStreamEvent {
            request_id: request_id.to_string(),
            event_type: "done".into(),
            text: None,
            session_id,
            done: true,
            error: Some(error),
            reasoning: None,
            tool_id: None,
            tool_name: None,
            tool_input: None,
            tool_output: None,
            tool_error: None,
        },
    );
}

fn parse_stream_line(
    line: &str,
    request_id: &str,
    session_id: &mut Option<String>,
    saw_text_stream: &AtomicBool,
) -> Vec<ClaudeStreamEvent> {
    let value: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let event_type = match value.get("type").and_then(|v| v.as_str()) {
        Some(t) => t.to_string(),
        None => return vec![],
    };

    let mut events_out = Vec::new();

    let sid = session_id.clone();
    let mk = |event_type: &str| ClaudeStreamEvent {
        request_id: request_id.to_string(),
        event_type: event_type.to_string(),
        text: None,
        session_id: sid.clone(),
        done: false,
        error: None,
        reasoning: None,
        tool_id: None,
        tool_name: None,
        tool_input: None,
        tool_output: None,
        tool_error: None,
    };

    if event_type == "system" {
        if let Some(id) = value.get("session_id").and_then(|v| v.as_str()) {
            *session_id = Some(id.to_string());
        }
        let mut ev = mk("system");
        if value.get("subtype").and_then(|v| v.as_str()) == Some("status") {
            ev.event_type = "system_status".into();
        }
        events_out.push(ev);
        return events_out;
    }

    if event_type == "stream_event" {
        let inner_type = value
            .pointer("/event/type")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let delta_type = value
            .pointer("/event/delta/type")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if inner_type == "content_block_start" {
            if let Some(block) = value.pointer("/event/content_block") {
                match block.get("type").and_then(|t| t.as_str()) {
                    Some("tool_use") => {
                        let mut ev = mk("tool_start");
                        ev.tool_id = block
                            .get("id")
                            .and_then(|v| v.as_str())
                            .map(str::to_string);
                        ev.tool_name = block
                            .get("name")
                            .and_then(|v| v.as_str())
                            .map(str::to_string);
                        ev.tool_input = block.get("input").cloned();
                        events_out.push(ev);
                    }
                    Some("text") => {
                        // 新文本块开始时重置标志，确保后续 assistant 快照能正确补发正文
                        saw_text_stream.store(false, Ordering::SeqCst);
                        let mut ev = mk("text_block_start");
                        events_out.push(ev);
                    }
                    _ => {}
                }
            }
            return events_out;
        }

        if inner_type == "content_block_delta" {
            if delta_type == "text_delta" {
                if let Some(text) = value
                    .pointer("/event/delta/text")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                {
                    let mut ev = mk("stream_event");
                    ev.text = Some(text.to_string());
                    events_out.push(ev);
                }
            } else if delta_type == "thinking_delta" {
                if let Some(thinking) = value
                    .pointer("/event/delta/thinking")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                {
                    let mut ev = mk("reasoning_delta");
                    ev.reasoning = Some(thinking.to_string());
                    events_out.push(ev);
                }
            }
        }

        return events_out;
    }

    if event_type == "assistant" {
        if let Some(arr) = value.pointer("/message/content").and_then(|c| c.as_array()) {
            for block in arr {
                match block.get("type").and_then(|t| t.as_str()) {
                    Some("thinking") => {
                        // 已通过 thinking_delta 流式推送，跳过快照避免重复
                    }
                    Some("tool_use") => {
                        let mut ev = mk("tool_start");
                        ev.tool_id = block
                            .get("id")
                            .and_then(|v| v.as_str())
                            .map(str::to_string);
                        ev.tool_name = block
                            .get("name")
                            .and_then(|v| v.as_str())
                            .map(str::to_string);
                        ev.tool_input = block.get("input").cloned();
                        events_out.push(ev);
                    }
                    Some("text") => {
                        // 无 text_delta 时（部分 CLI 版本）从 assistant 快照补发正文
                        if !saw_text_stream.load(Ordering::SeqCst) {
                            if let Some(text) = block
                                .get("text")
                                .and_then(|v| v.as_str())
                                .filter(|s| !s.is_empty())
                            {
                                saw_text_stream.store(true, Ordering::SeqCst);
                                let mut ev = mk("stream_event");
                                ev.text = Some(text.to_string());
                                events_out.push(ev);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        return events_out;
    }

    if event_type == "user" {
        if let Some(arr) = value.pointer("/message/content").and_then(|c| c.as_array()) {
            for block in arr {
                if block.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                    continue;
                }
                let mut ev = mk("tool_result");
                ev.tool_id = block
                    .get("tool_use_id")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                let is_error = block.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
                let content = tool_result_text(block);
                if is_error {
                    ev.tool_error = content;
                } else {
                    ev.tool_output = content;
                }
                events_out.push(ev);
            }
        }
        return events_out;
    }

    if event_type == "result" {
        if let Some(id) = value.get("session_id").and_then(|v| v.as_str()) {
            *session_id = Some(id.to_string());
        }
        let error = value
            .get("is_error")
            .and_then(|v| v.as_bool())
            .filter(|&e| e)
            .map(|_| {
                value
                    .get("result")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Claude Code 返回错误")
                    .to_string()
            });

        let mut ev = mk("result");
        if let Some(text) = value
            .get("result")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            ev.text = Some(text.to_string());
        }
        ev.session_id = session_id.clone();
        ev.done = true;
        ev.error = error;
        return vec![ev];
    }

    vec![]
}

/// CLI 在 stream-json 标志被截断时回退为纯文本；将其当作 assistant 回复。
fn parse_plaintext_fallback(
    line: &str,
    request_id: &str,
    session_id: &Option<String>,
) -> Vec<ClaudeStreamEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('{') {
        return vec![];
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("error:")
        || lower.starts_with("warning:")
        || lower.starts_with("usage:")
    {
        return vec![];
    }
    vec![ClaudeStreamEvent {
        request_id: request_id.to_string(),
        event_type: "stream_event".into(),
        text: Some(trimmed.to_string()),
        session_id: session_id.clone(),
        done: false,
        error: None,
        reasoning: None,
        tool_id: None,
        tool_name: None,
        tool_input: None,
        tool_output: None,
        tool_error: None,
    }]
}

fn tool_result_text(block: &Value) -> Option<String> {
    if let Some(s) = block.get("content").and_then(|v| v.as_str()) {
        return Some(s.to_string());
    }
    block
        .get("content")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|s| !s.is_empty())
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn test_resolve_claude_invocation_with_cmd() {
        let test_dir = std::env::temp_dir().join("claude_test");
        let cmd_path = test_dir.join("claude.cmd");
        
        if !cmd_path.is_file() {
            println!("Test .cmd file not found, skipping");
            return;
        }
        
        let (program, prefix_args) = resolve_claude_invocation(&cmd_path.display().to_string());
        
        println!("Program: {}", program);
        println!("Prefix args: {:?}", prefix_args);
        
        // 应该找到 node.exe 并绕过 cmd.exe
        assert!(program.contains("node.exe"), "Should find node.exe, got: {}", program);
        assert!(!prefix_args.is_empty(), "Should have cli.js in prefix args");
        assert!(prefix_args[0].contains("cli.js"), "First arg should be cli.js path");
    }

    #[test]
    #[cfg(windows)]
    fn test_parse_cmd_for_cli_js() {
        let test_dir = std::env::temp_dir().join("claude_test");
        let cmd_path = test_dir.join("claude.cmd");
        
        if !cmd_path.is_file() {
            println!("Test .cmd file not found, skipping");
            return;
        }
        
        let result = parse_cmd_for_cli_js(&cmd_path);
        println!("Parsed cli.js path: {:?}", result);
        
        assert!(result.is_some(), "Should parse cli.js path from .cmd");
        let path = result.unwrap();
        assert!(path.to_string_lossy().contains("cli.js"), "Path should contain cli.js");
    }

    #[test]
    #[cfg(windows)]
    fn test_find_node_exe() {
        let test_dir = std::env::temp_dir().join("claude_test");
        
        let result = find_node_exe(&test_dir);
        println!("Found node.exe: {:?}", result);
        
        assert!(result.is_some(), "Should find node.exe");
        let path = result.unwrap();
        assert!(path.contains("node.exe"), "Path should contain node.exe");
    }

    #[test]
    fn test_parse_content_block_start_tool_use() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_abc","name":"mcp__aiterm__runShellCommand","input":{"command":"echo hi"}}}}"#;
        let mut session_id = Some("sess-1".to_string());
        let saw_text = AtomicBool::new(false);
        let events = parse_stream_line(line, "req-1", &mut session_id, &saw_text);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "tool_start");
        assert_eq!(events[0].tool_id.as_deref(), Some("toolu_abc"));
        assert_eq!(
            events[0].tool_name.as_deref(),
            Some("mcp__aiterm__runShellCommand")
        );
    }

    #[test]
    fn test_extract_quoted_segments() {
        let line = r#""%~dp0\node.exe" "%~dp0\node_modules\@anthropic-ai\claude-code\cli.js" %*"#;
        let segments = extract_quoted_segments(line);
        
        println!("Extracted segments: {:?}", segments);
        
        assert_eq!(segments.len(), 2, "Should extract 2 quoted segments");
        assert!(segments[0].contains("node.exe"), "First segment should contain node.exe");
        assert!(segments[1].contains("cli.js"), "Second segment should contain cli.js");
    }
}