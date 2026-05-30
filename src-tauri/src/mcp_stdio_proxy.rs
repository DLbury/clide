use crate::app_paths::{node_script_argv, path_to_js_string};
use crate::process_util::{command_no_window, fix_gui_environment};
use std::path::{Path, PathBuf};
use std::process::Stdio;

const MCP_STDIO_FLAG: &str = "--aiterm-mcp-stdio";

/// Windows 发布包为 GUI 子系统 exe，Claude 通过此入口拉起 MCP 时不会出现 cmd 窗口。
pub fn try_run_mcp_stdio_proxy() -> bool {
    if !std::env::args().any(|a| a == MCP_STDIO_FLAG) {
        return false;
    }

    fix_gui_environment();

    let script = resolve_stdio_script_near_exe().unwrap_or_else(|e| {
        eprintln!("[clide-mcp] {e}");
        std::process::exit(1);
    });
    let script_arg = node_script_argv(&script).unwrap_or_else(|e| {
        eprintln!("[clide-mcp] {e}");
        std::process::exit(1);
    });

    let node = which::which("node")
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "node".to_string());

    let workdir = script
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    let status = command_no_window(&node)
        .arg(&script_arg)
        .current_dir(workdir)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status();

    match status {
        Ok(s) => std::process::exit(s.code().unwrap_or(1)),
        Err(e) => {
            eprintln!("[clide-mcp] 启动 Node MCP 失败 ({node}): {e}");
            std::process::exit(1);
        }
    }
}

pub fn mcp_stdio_proxy_flag() -> &'static str {
    MCP_STDIO_FLAG
}

/// Claude 在 Windows 上应使用 GUI exe 作为 MCP command，避免 node.exe 弹出控制台。
#[cfg(windows)]
pub fn mcp_stdio_launcher_command() -> Option<(String, Vec<String>)> {
    let exe = std::env::current_exe().ok()?;
    Some((
        exe.to_string_lossy().into_owned(),
        vec![MCP_STDIO_FLAG.to_string()],
    ))
}

#[cfg(not(windows))]
pub fn mcp_stdio_launcher_command() -> Option<(String, Vec<String>)> {
    None
}

pub fn resolve_stdio_script_near_exe() -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("scripts").join("aiterm-mcp-stdio.mjs"));
            candidates.push(dir.join("aiterm-mcp-stdio.mjs"));
            candidates.push(dir.join("resources").join("scripts").join("aiterm-mcp-stdio.mjs"));
            candidates.push(
                dir.join("..")
                    .join("lib")
                    .join("Clide")
                    .join("scripts")
                    .join("aiterm-mcp-stdio.mjs"),
            );
            candidates.push(
                dir.join("..")
                    .join("Resources")
                    .join("scripts")
                    .join("aiterm-mcp-stdio.mjs"),
            );
            candidates.push(
                dir.join("..")
                    .join("Resources")
                    .join("_up_")
                    .join("scripts")
                    .join("aiterm-mcp-stdio.mjs"),
            );
        }
    }

    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/aiterm-mcp-stdio.mjs");
    candidates.push(dev);

    let checked = candidates.len();
    for path in candidates {
        if path.is_file() {
            return Ok(path);
        }
    }

    Err(format!(
        "未找到 MCP stdio 脚本 aiterm-mcp-stdio.mjs（已检查 {checked} 个路径）"
    ))
}

/// 供 MCP 预检 / .mcp.json 使用的 node 启动参数（非 Windows 或 exe 代理不可用时）。
pub fn mcp_node_launcher_command(launcher_script: &Path) -> Result<(String, Vec<String>), String> {
    let script = if launcher_script
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n == "aiterm-mcp-stdio.mjs")
    {
        node_script_argv(launcher_script)?
    } else {
        let stdio = resolve_stdio_script_near_exe()?;
        node_script_argv(&stdio)?
    };
    let node = which::which("node")
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "node".to_string());
    Ok((node, vec![script]))
}

#[allow(dead_code)]
pub fn launcher_script_display(path: &Path) -> String {
    path_to_js_string(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_flag_is_stable() {
        assert_eq!(mcp_stdio_proxy_flag(), "--aiterm-mcp-stdio");
    }
}
