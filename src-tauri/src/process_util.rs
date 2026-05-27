use std::path::Path;

/// GUI 应用启动时补齐 PATH（Windows 从注册表合并用户/系统路径）。
pub fn fix_gui_environment() {
    #[cfg(windows)]
    {
        static FIX_GUI_ENV_ONCE: std::sync::Once = std::sync::Once::new();
        FIX_GUI_ENV_ONCE.call_once(fix_windows_path_from_registry);
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
    let mut cmd = std::process::Command::new(program);
    apply_subprocess_environment(&mut cmd);
    cmd
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
        if std::env::var_os("HOME").is_none() {
            if let Some(home) = dirs::home_dir() {
                cmd.env("HOME", home.as_os_str());
            }
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

/// 优先选用 `.exe`，避免 npm 全局安装返回 `.cmd` 时启动失败。
pub fn prefer_claude_executable(candidates: &[String]) -> Option<String> {
    let mut sorted = candidates.to_vec();
    sorted.sort_by_key(|p| {
        let lower = p.to_ascii_lowercase();
        if lower.ends_with(".exe") {
            0
        } else if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            2
        } else {
            1
        }
    });
    sorted.into_iter().find(|p| Path::new(p).exists())
}

/// 规范化 Windows 路径分隔符。
pub fn normalize_path(path: &str) -> String {
    if cfg!(windows) {
        path.replace('/', "\\")
    } else {
        path.to_string()
    }
}
