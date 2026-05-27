use std::path::Path;

/// Windows 下启动子进程时隐藏控制台窗口。
/// `.cmd` / `.bat` 必须通过 `cmd.exe /c` 启动，否则 CreateProcess 会报
/// “batch file arguments are invalid”。
#[cfg(windows)]
pub fn command_no_window<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
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
    cmd
}

#[cfg(not(windows))]
pub fn command_no_window<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    std::process::Command::new(program)
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
