use crate::process_util::{command_no_window, normalize_path, prefer_claude_executable};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeDetectResult {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub candidates: Vec<String>,
}

/// 自动发现状态管理器
pub struct ClaudeAutoDetectManager {
    running: Arc<AtomicBool>,
    last_result: Arc<RwLock<ClaudeDetectResult>>,
}

impl ClaudeAutoDetectManager {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            last_result: Arc::new(RwLock::new(ClaudeDetectResult {
                found: false,
                path: None,
                version: None,
                candidates: vec![],
            })),
        }
    }

    /// 启动后台自动发现
    pub async fn start_auto_detect(&self) {
        if self.running.swap(true, Ordering::SeqCst) {
            return; // 已经在运行
        }

        let running = self.running.clone();
        let last_result = self.last_result.clone();

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(30));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

            while running.load(Ordering::SeqCst) {
                let result = detect_claude_binary_internal(true);
                let mut guard = last_result.write().await;
                *guard = result;
                guard.candidates = detect_all_claude_candidates();
                interval.tick().await;
            }
        });
    }

    /// 停止后台自动发现
    pub fn stop_auto_detect(&self) {
        self.running.store(false, Ordering::SeqCst);
    }

    /// 获取最新的发现结果
    pub async fn get_last_result(&self) -> ClaudeDetectResult {
        self.last_result.read().await.clone()
    }

    /// 立即执行一次发现
    pub async fn detect_now(&self) -> ClaudeDetectResult {
        let result = detect_claude_binary_internal(true);
        let mut guard = self.last_result.write().await;
        *guard = result;
        guard.clone()
    }
}

/// 获取环境变量中指定的 Claude Code 路径
pub fn get_claude_path_from_env() -> Option<String> {
    // 检查 CLAUDE_CODE_PATH 环境变量
    if let Ok(path) = std::env::var("CLAUDE_CODE_PATH") {
        let path = path.trim();
        if !path.is_empty() && std::path::Path::new(&path).exists() {
            return Some(path.to_string());
        }
    }

    // 检查 ANTHROPIC_CLI_PATH 环境变量（兼容性）
    if let Ok(path) = std::env::var("ANTHROPIC_CLI_PATH") {
        let path = path.trim();
        if !path.is_empty() && std::path::Path::new(&path).exists() {
            return Some(path.to_string());
        }
    }

    None
}

/// 检测所有可能的 Claude Code 候选路径
fn detect_all_claude_candidates() -> Vec<String> {
    let mut candidates = Vec::new();

    // 1. 首先检查环境变量
    if let Some(path) = get_claude_path_from_env() {
        candidates.push(path);
    }

    // 2. 检查 PATH 中的 claude
    if let Ok(path) = which::which("claude") {
        candidates.push(path.display().to_string());
    }

    // 3. 检查常见的安装路径
    #[cfg(windows)]
    {
        // Windows 常见路径
        let common_paths = [
            "%USERPROFILE%/.claude/local/claude.exe",
            "%USERPROFILE%/.claude/claude.exe",
            "%LOCALAPPDATA%/Programs/claude/claude.exe",
            "%PROGRAMFILES%/Claude/claude.exe",
            "%PROGRAMFILES(x86)%/Claude/claude.exe",
            "%USERPROFILE%/AppData/Roaming/npm/claude.exe",
            "%USERPROFILE%/AppData/Local/npm/claude.exe",
        ];

        for path_template in &common_paths {
            let expanded = expand_env_vars(path_template);
            let path = PathBuf::from(&expanded);
            if path.exists() {
                candidates.push(path.display().to_string());
            }
        }

        // 检查通过 npm/pnpm/yarn 全局安装的路径
        if let Ok(home) = std::env::var("USERPROFILE") {
            let npm_paths = [
                format!("{}/AppData/Roaming/npm/claude.exe", home),
                format!("{}/AppData/Roaming/npm/claude.cmd", home),
                format!("{}/AppData/Local/npm/claude.exe", home),
            ];
            for path in &npm_paths {
                if PathBuf::from(path).exists() {
                    candidates.push(path.to_string());
                }
            }
        }
    }

    #[cfg(not(windows))]
    {
        // macOS 和 Linux 常见路径
        let common_paths = [
            "/usr/local/bin/claude",
            "/usr/bin/claude",
            "/opt/claude/bin/claude",
            "/opt/claude/claude",
            "/Applications/Claude.app/Contents/MacOS/claude",
            "/Applications/Claude.app/Contents/MacOS/Claude",
        ];

        for path in &common_paths {
            if PathBuf::from(path).exists() {
                candidates.push(path.to_string());
            }
        }

        if let Some(home) = dirs::home_dir() {
            // 用户目录下的安装路径
            let user_paths = [
                home.join(".claude").join("local").join("claude"),
                home.join(".claude").join("claude"),
                home.join(".local").join("bin").join("claude"),
                home.join("bin").join("claude"),
                home.join(".npm-global").join("bin").join("claude"),
                home.join(".nvm").join("versions").join("node").join("*/bin/claude"),
                home.join(".config").join("npm").join("global").join("bin").join("claude"),
            ];

            for path in &user_paths {
                let path_str = path.display().to_string();
                // 处理通配符路径
                if path_str.contains('*') {
                    if let Some(parent) = path.parent() {
                        if let Ok(entries) = std::fs::read_dir(parent) {
                            for entry in entries.flatten() {
                                let file_name = entry.file_name().to_string_lossy().to_string();
                                if file_name.contains("claude") && entry.path().exists() {
                                    candidates.push(entry.path().display().to_string());
                                }
                            }
                        }
                    }
                } else if path.exists() {
                    candidates.push(path_str);
                }
            }
        }
    }

    // 去重并排序：优先 .exe，其次无扩展名，最后 .cmd/.bat
    candidates.sort();
    candidates.dedup();
    if let Some(best) = prefer_claude_executable(&candidates) {
        candidates.retain(|p| p != &best);
        candidates.insert(0, best);
    }

    candidates
}

/// 内部检测函数，用于自动发现管理器
fn detect_claude_binary_internal(skip_version: bool) -> ClaudeDetectResult {
    let candidates = detect_all_claude_candidates();

    // 优先使用环境变量指定的路径
    let path = if let Some(env_path) = get_claude_path_from_env() {
        Some(env_path)
    } else {
        candidates.first().cloned()
    };

    let version = if skip_version {
        None
    } else {
        path.as_ref().and_then(|p| read_claude_version(p))
    };

    ClaudeDetectResult {
        found: path.is_some(),
        path,
        version,
        candidates,
    }
}

/// 公共 API：检测 Claude Code 二进制文件（快速，不跑 --version 子进程）
pub fn detect_claude_binary() -> ClaudeDetectResult {
    detect_claude_binary_internal(true)
}

/// 含版本信息的完整检测（设置页等场景）
pub fn detect_claude_binary_full() -> ClaudeDetectResult {
    detect_claude_binary_internal(false)
}

/// 读取 Claude Code 版本
fn read_claude_version(path: &str) -> Option<String> {
    // 尝试使用 --version 参数
    let output = command_no_window(path)
        .arg("--version")
        .output()
        .ok()?;

    if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !text.is_empty() {
            return Some(text);
        }
    }

    // 如果 --version 失败，尝试 -v
    let output = command_no_window(path)
        .arg("-v")
        .output()
        .ok()?;

    if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !text.is_empty() {
            return Some(text);
        }
    }

    // 尝试 --help 并从帮助文本中提取版本信息
    let output = command_no_window(path)
        .arg("--help")
        .output()
        .ok()?;

    if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout);
        // 尝试从第一行提取版本
        let first_line = text.lines().next().unwrap_or("");
        if first_line.contains("claude") && first_line.contains("v") {
            return Some(first_line.trim().to_string());
        }
    }

    None
}

/// 解析用户提供的自定义路径
pub fn resolve_claude_path(custom: Option<String>) -> Result<String, String> {
    // 首先检查环境变量
    if let Some(path) = get_claude_path_from_env() {
        if std::path::Path::new(&path).exists() {
            return Ok(normalize_path(&path));
        }
    }

    // 然后检查用户提供的自定义路径
    if let Some(path) = custom.filter(|p| !p.trim().is_empty()) {
        if std::path::Path::new(&path).exists() {
            return Ok(normalize_path(&path));
        }
        return Err(format!("未找到 Claude Code: {path}"));
    }

    // 最后执行自动检测
    let detected = detect_claude_binary();
    detected
        .path
        .map(|p| normalize_path(&p))
        .ok_or_else(|| "未检测到 Claude Code CLI，请先安装并登录 claude。\n可以通过以下方式安装:\n  npm install -g @anthropic-ai/claude-code\n或者设置环境变量 CLAUDE_CODE_PATH 指定路径。".to_string())
}

/// 扩展环境变量
#[cfg(windows)]
fn expand_env_vars(path: &str) -> String {
    let mut result = path.to_string();

    // 替换 %VAR% 格式的环境变量
    for (key, value) in [
        ("%USERPROFILE%", std::env::var("USERPROFILE").unwrap_or_default()),
        ("%LOCALAPPDATA%", std::env::var("LOCALAPPDATA").unwrap_or_default()),
        ("%PROGRAMFILES%", std::env::var("PROGRAMFILES").unwrap_or_default()),
        ("%PROGRAMFILES(x86)%", std::env::var("PROGRAMFILES(x86)").unwrap_or_default()),
        ("%APPDATA%", std::env::var("APPDATA").unwrap_or_default()),
    ] {
        result = result.replace(key, &value);
    }

    result
}

#[cfg(not(windows))]
fn expand_env_vars(path: &str) -> String {
    // Unix 系统通常使用 $HOME 等格式，但这里我们主要处理固定路径
    path.to_string()
}
