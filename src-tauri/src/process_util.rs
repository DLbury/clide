use std::path::{Path, PathBuf};

/// GUI 应用启动时补齐 PATH（Windows 从注册表合并用户/系统路径；Unix 补齐常见 bin 目录）。
pub fn fix_gui_environment() {
    #[cfg(windows)]
    {
        static FIX_GUI_ENV_ONCE: std::sync::Once = std::sync::Once::new();
        FIX_GUI_ENV_ONCE.call_once(fix_windows_path_from_registry);
    }
    #[cfg(not(windows))]
    {
        static FIX_GUI_ENV_ONCE: std::sync::Once = std::sync::Once::new();
        FIX_GUI_ENV_ONCE.call_once(fix_unix_gui_environment);
    }
}

#[cfg(not(windows))]
fn fix_unix_gui_environment() {
    if std::env::var_os("HOME").is_none() {
        if let Some(home) = dirs::home_dir() {
            std::env::set_var("HOME", home.as_os_str());
        }
    }

    let mut path = std::env::var("PATH").unwrap_or_default();
    if let Ok(content) = std::fs::read_to_string("/etc/environment") {
        for line in content.lines() {
            let Some(rest) = line.strip_prefix("PATH=") else {
                continue;
            };
            let from_etc = rest.trim().trim_matches('"');
            if !from_etc.is_empty() {
                path = if path.is_empty() {
                    from_etc.to_string()
                } else {
                    format!("{from_etc}:{path}")
                };
                break;
            }
        }
    }

    let merged = augment_unix_path(&path);
    if !merged.is_empty() {
        std::env::set_var("PATH", &merged);
    }
}

#[cfg(windows)]
fn fix_windows_path_from_registry() {
    let current = std::env::var("PATH")
        .or_else(|_| std::env::var("Path"))
        .unwrap_or_default();
    let machine = read_registry_path(
        "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
    );
    let user = read_registry_path("HKCU\\Environment");
    let merged = merge_path_segments(&[machine, user, current]);
    if !merged.is_empty() {
        std::env::set_var("PATH", &merged);
    }
}

#[cfg(windows)]
fn read_registry_path(key: &str) -> String {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // 注意：这里不能走 command_no_window，否则会再次触发 fix_gui_environment 导致重入。
    let output = std::process::Command::new("reg")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["query", key, "/v", "Path"])
        .output();
    let Ok(output) = output else {
        return String::new();
    };
    if !output.status.success() {
        return String::new();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.len() < 3 {
            continue;
        }
        if !tokens[0].eq_ignore_ascii_case("Path") {
            continue;
        }
        let value = tokens[2..].join(" ");
        return expand_registry_value(&value);
    }
    String::new()
}

#[cfg(windows)]
fn expand_registry_value(value: &str) -> String {
    let mut out = value.to_string();
    for (key, var) in [
        ("%USERPROFILE%", "USERPROFILE"),
        ("%LOCALAPPDATA%", "LOCALAPPDATA"),
        ("%APPDATA%", "APPDATA"),
        ("%PROGRAMFILES%", "PROGRAMFILES"),
        ("%PROGRAMFILES(X86)%", "PROGRAMFILES(X86)"),
    ] {
        if let Ok(val) = std::env::var(var) {
            out = out.replace(key, &val);
        }
    }
    out
}

fn merge_path_segments(segments: &[String]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for segment in segments {
        for piece in segment.split(';') {
            let piece = piece.trim();
            if piece.is_empty() {
                continue;
            }
            if parts.iter().any(|p| p.eq_ignore_ascii_case(piece)) {
                continue;
            }
            parts.push(piece.to_string());
        }
    }
    parts.join(";")
}

/// Windows 下启动子进程时隐藏控制台窗口。
/// `.cmd` / `.bat` 必须通过 `cmd.exe /c` 启动，否则 CreateProcess 会报
/// “batch file arguments are invalid”。
#[cfg(windows)]
pub fn command_no_window<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // 惰性修复 GUI 环境，避免应用启动阶段执行外部 reg 命令导致首屏卡顿。
    fix_gui_environment();
    let program = program.as_ref();
    let ext = Path::new(program)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());

    let mut cmd = match ext.as_deref() {
        Some("cmd") | Some("bat") => {
            let comspec = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
            let mut c = std::process::Command::new(comspec);
            c.arg("/c").arg(program);
            c
        }
        _ => std::process::Command::new(program),
    };
    cmd.creation_flags(CREATE_NO_WINDOW);
    apply_subprocess_environment(&mut cmd);
    cmd
}

#[cfg(not(windows))]
pub fn command_no_window<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    fix_gui_environment();
    let mut cmd = std::process::Command::new(program);
    apply_subprocess_environment(&mut cmd);
    cmd
}

/// Windows 下异步子进程同样隐藏控制台（MCP 预检等）。
#[cfg(windows)]
pub fn async_command_no_window<S: AsRef<std::ffi::OsStr>>(program: S) -> tokio::process::Command {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    fix_gui_environment();
    let program = program.as_ref();
    let ext = Path::new(program)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());

    let mut cmd = match ext.as_deref() {
        Some("cmd") | Some("bat") => {
            let comspec = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
            let mut c = tokio::process::Command::new(comspec);
            c.arg("/c").arg(program);
            c
        }
        _ => tokio::process::Command::new(program),
    };
    cmd.creation_flags(CREATE_NO_WINDOW);
    apply_subprocess_environment_tokio(&mut cmd);
    cmd
}

#[cfg(not(windows))]
pub fn async_command_no_window<S: AsRef<std::ffi::OsStr>>(program: S) -> tokio::process::Command {
    fix_gui_environment();
    let mut cmd = tokio::process::Command::new(program);
    apply_subprocess_environment_tokio(&mut cmd);
    cmd
}

/// 为 Claude Code CLI（Node）子进程抑制 DEP0169 等弃用警告，避免 stderr 刷屏。
pub fn configure_claude_cli_command(cmd: &mut std::process::Command) {
    append_node_options(cmd, "--no-deprecation");
    append_node_options(cmd, "--no-warnings");
}

pub fn configure_claude_cli_async_command(cmd: &mut tokio::process::Command) {
    append_node_options_tokio(cmd, "--no-deprecation");
    append_node_options_tokio(cmd, "--no-warnings");
}

/// Node stderr/stdout 中的弃用噪音（Claude CLI 依赖链触发 DEP0169 url.parse）。
pub fn is_node_deprecation_noise(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    line.contains("DeprecationWarning")
        || line.contains("[DEP0169]")
        || line.contains("url.parse()")
        || lower.contains("trace-deprecation")
        || lower.contains("(use `node --trace-deprecation")
        || lower.contains("(use `claude --trace-deprecation")
        || (lower.contains("deprecation") && lower.contains("warning"))
}

/// 将 Claude 认证相关环境变量传给子进程（GUI 启动时常未继承用户 shell 中的变量）。
pub fn propagate_claude_auth_env(cmd: &mut std::process::Command) {
    const KEYS: &[&str] = &[
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_API_URL",
        "CLAUDE_CODE_OAUTH_TOKEN",
    ];
    for key in KEYS {
        let value = std::env::var(key)
            .ok()
            .filter(|v| !v.trim().is_empty())
            .or_else(|| {
                #[cfg(windows)]
                {
                    read_registry_env_var("HKCU\\Environment", key)
                }
                #[cfg(not(windows))]
                {
                    None
                }
            });
        if let Some(value) = value {
            cmd.env(key, value);
        }
    }
}

#[cfg(windows)]
fn read_registry_env_var(key: &str, name: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = std::process::Command::new("reg")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["query", key, "/v", name])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.len() < 3 {
            continue;
        }
        if !tokens[0].eq_ignore_ascii_case(name) {
            continue;
        }
        let value = tokens[2..].join(" ");
        return Some(expand_registry_value(&value));
    }
    None
}

fn append_node_options(cmd: &mut std::process::Command, flag: &str) {
    const KEY: &str = "NODE_OPTIONS";
    match std::env::var(KEY) {
        Ok(existing) if existing.split_whitespace().any(|p| p == flag) => {}
        Ok(existing) => {
            cmd.env(KEY, format!("{existing} {flag}"));
        }
        Err(_) => {
            cmd.env(KEY, flag);
        }
    }
}

fn append_node_options_tokio(cmd: &mut tokio::process::Command, flag: &str) {
    const KEY: &str = "NODE_OPTIONS";
    match std::env::var(KEY) {
        Ok(existing) if existing.split_whitespace().any(|p| p == flag) => {}
        Ok(existing) => {
            cmd.env(KEY, format!("{existing} {flag}"));
        }
        Err(_) => {
            cmd.env(KEY, flag);
        }
    }
}

/// 为子进程补齐 GUI 启动时缺失的用户环境（PATH、HOME 等）。
pub fn apply_subprocess_environment(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::ffi::OsString;

        let mut inject = |key: &str, value: OsString| {
            if std::env::var_os(key).is_none() {
                cmd.env(key, value);
            }
        };

        if let Some(userprofile) = std::env::var_os("USERPROFILE") {
            inject("USERPROFILE", userprofile.clone());
            inject("HOME", userprofile);
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            inject("APPDATA", appdata);
        }
        if let Some(localappdata) = std::env::var_os("LOCALAPPDATA") {
            inject("LOCALAPPDATA", localappdata);
        }

        // 显式设置 PATH，避免 Windows 上 Command 未继承或未搜索用户 PATH。
        if let Ok(path) = std::env::var("PATH") {
            cmd.env("PATH", augment_path_with_npm(&path));
        } else if let Ok(path) = std::env::var("Path") {
            cmd.env("PATH", augment_path_with_npm(&path));
        }
    }

    #[cfg(not(windows))]
    {
        fix_gui_environment();
        if std::env::var_os("HOME").is_none() {
            if let Some(home) = dirs::home_dir() {
                cmd.env("HOME", home.as_os_str());
            }
        }
        if let Ok(path) = std::env::var("PATH") {
            cmd.env("PATH", augment_unix_path(&path));
        } else {
            cmd.env("PATH", augment_unix_path(""));
        }
    }
}

fn apply_subprocess_environment_tokio(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        use std::ffi::OsString;

        let mut inject = |key: &str, value: OsString| {
            if std::env::var_os(key).is_none() {
                cmd.env(key, value);
            }
        };

        if let Some(userprofile) = std::env::var_os("USERPROFILE") {
            inject("USERPROFILE", userprofile.clone());
            inject("HOME", userprofile);
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            inject("APPDATA", appdata);
        }
        if let Some(localappdata) = std::env::var_os("LOCALAPPDATA") {
            inject("LOCALAPPDATA", localappdata);
        }

        if let Ok(path) = std::env::var("PATH") {
            cmd.env("PATH", augment_path_with_npm(&path));
        } else if let Ok(path) = std::env::var("Path") {
            cmd.env("PATH", augment_path_with_npm(&path));
        }
    }

    #[cfg(not(windows))]
    {
        fix_gui_environment();
        if std::env::var_os("HOME").is_none() {
            if let Some(home) = dirs::home_dir() {
                cmd.env("HOME", home.as_os_str());
            }
        }
        if let Ok(path) = std::env::var("PATH") {
            cmd.env("PATH", augment_unix_path(&path));
        } else {
            cmd.env("PATH", augment_unix_path(""));
        }
    }
}

#[cfg(windows)]
fn augment_path_with_npm(path: &str) -> String {
    let mut parts: Vec<String> = path
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();

    let mut extra = Vec::new();
    if let Ok(home) = std::env::var("USERPROFILE") {
        extra.push(format!("{home}\\AppData\\Roaming\\npm"));
        extra.push(format!("{home}\\AppData\\Local\\npm"));
        extra.push(format!("{home}\\.local\\bin"));
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        extra.push(format!("{local}\\Programs\\Microsoft VS Code\\bin"));
    }
    extra.push("C:\\Program Files\\nodejs".to_string());

    for dir in extra {
        let lower = dir.to_ascii_lowercase();
        if !parts.iter().any(|p| p.eq_ignore_ascii_case(&lower)) {
            parts.push(dir);
        }
    }

    parts.join(";")
}

/// 修复 GUI 进程 PATH 并补齐 npm/node 常见目录，供 claude/node 检测与子进程解析使用。
pub fn prepare_cli_discovery_environment() {
    fix_gui_environment();
    #[cfg(windows)]
    {
        let current = std::env::var("PATH")
            .or_else(|_| std::env::var("Path"))
            .unwrap_or_default();
        let merged = augment_path_with_npm(&current);
        if !merged.is_empty() {
            std::env::set_var("PATH", &merged);
        }
    }
    #[cfg(not(windows))]
    {
        let merged = augment_unix_path(&std::env::var("PATH").unwrap_or_default());
        if !merged.is_empty() {
            std::env::set_var("PATH", &merged);
        }
    }
}

#[cfg(not(windows))]
fn augment_unix_path(path: &str) -> String {
    let mut parts: Vec<String> = path
        .split(':')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();

    let mut extra = vec![
        "/opt/homebrew/bin".to_string(),
        "/opt/homebrew/sbin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
        "/snap/bin".to_string(),
    ];
    if let Some(home) = dirs::home_dir() {
        let h = home.display().to_string();
        extra.push(format!("{h}/.local/bin"));
        extra.push(format!("{h}/.local/share/fnm/current/bin"));
        extra.push(format!("{h}/.fnm/current/bin"));
        extra.push(format!("{h}/.nvm/current/bin"));
        extra.push(format!("{h}/.volta/bin"));
        let nvm_versions = home.join(".nvm/versions/node");
        if nvm_versions.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
                let mut versions: Vec<PathBuf> = entries
                    .filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .filter(|p| p.join("bin/node").is_file())
                    .collect();
                versions.sort();
                if let Some(latest) = versions.last() {
                    extra.push(latest.join("bin").display().to_string());
                }
            }
        }
    }

    for dir in extra {
        if !parts.iter().any(|p| p == &dir) {
            parts.push(dir);
        }
    }
    parts.join(":")
}

/// 解析 Node 可执行文件（GUI 子进程 PATH 常不含 node；Ubuntu apt 包名为 nodejs）。
pub fn resolve_node_executable() -> Result<String, String> {
    prepare_cli_discovery_environment();

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = which::which("node") {
        candidates.push(p);
    }
    if let Ok(p) = which::which("nodejs") {
        candidates.push(p);
    }

    for fixed in [
        "/usr/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/nodejs",
        "/usr/local/bin/nodejs",
        "/snap/bin/node",
    ] {
        candidates.push(PathBuf::from(fixed));
    }
    if let Some(home) = dirs::home_dir() {
        for rel in [
            ".local/bin/node",
            ".nvm/current/bin/node",
            ".fnm/current/bin/node",
            ".volta/bin/node",
        ] {
            candidates.push(home.join(rel));
        }
        let nvm_versions = home.join(".nvm/versions/node");
        if nvm_versions.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
                let mut versions: Vec<PathBuf> = entries
                    .filter_map(|e| e.ok())
                    .map(|e| e.path().join("bin/node"))
                    .filter(|p| p.is_file())
                    .collect();
                versions.sort();
                candidates.extend(versions);
            }
        }
    }

    for path in candidates {
        if path.is_file() {
            return Ok(path.display().to_string());
        }
    }

    Err(
        "未找到 Node.js。MCP 桥接需要本机 Node.js 18+（Ubuntu: sudo apt install nodejs 或 NodeSource/nvm 安装 node）"
            .to_string(),
    )
}

/// 优先选用 Windows 可真正启动的格式：`.exe` > `.cmd`/`.bat` > 无扩展名（npm 的 `claude` 常为 Unix shim，直接执行会 os error 193）。
pub fn prefer_claude_executable(candidates: &[String]) -> Option<String> {
    let mut sorted = candidates.to_vec();
    sorted.sort_by_key(|p| {
        let lower = p.to_ascii_lowercase();
        if lower.ends_with(".exe") {
            0
        } else if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            1
        } else {
            2
        }
    });
    sorted.into_iter().find(|p| Path::new(p).exists())
}

/// Windows 下将 npm 无扩展名 `claude` shim 解析为同目录的 `claude.cmd` / `claude.exe`。
pub fn normalize_claude_executable(path: &str) -> String {
    let path = normalize_path(path);
    #[cfg(windows)]
    {
        let pb = Path::new(&path);
        if !pb.is_file() {
            return path;
        }
        let ext = pb
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase());
        let is_native = matches!(ext.as_deref(), Some("exe") | Some("cmd") | Some("bat"));
        if is_native {
            return path;
        }
        if let Some(parent) = pb.parent() {
            for alt in ["claude.cmd", "claude.exe", "claude.bat"] {
                let candidate = parent.join(alt);
                if candidate.is_file() {
                    return candidate.display().to_string();
                }
            }
        }
    }
    path
}

/// 规范化 Windows 路径分隔符。
pub fn normalize_path(path: &str) -> String {
    if cfg!(windows) {
        path.replace('/', "\\")
    } else {
        path.to_string()
    }
}
