use crate::mcp_stdio_server;
use crate::process_util::fix_gui_environment;

const MCP_STDIO_FLAG: &str = "--aiterm-mcp-stdio";

/// `clide --aiterm-mcp-stdio`：原生 Rust MCP stdio 桥接，不依赖本机 Node.js。
pub fn try_run_mcp_stdio_proxy() -> bool {
    if !std::env::args().any(|a| a == MCP_STDIO_FLAG) {
        return false;
    }

    fix_gui_environment();

    if let Err(e) = mcp_stdio_server::run_stdio_proxy() {
        eprintln!("[clide-mcp] {e}");
        std::process::exit(1);
    }
    std::process::exit(0);
}

pub fn mcp_stdio_proxy_flag() -> &'static str {
    MCP_STDIO_FLAG
}

/// 全平台：`.mcp.json` 与 `claude mcp add` 均使用 Clide 二进制，无需 Node。
pub fn mcp_stdio_launcher_command() -> Option<(String, Vec<String>)> {
    let exe = std::env::current_exe().ok()?;
    Some((
        exe.to_string_lossy().into_owned(),
        vec![MCP_STDIO_FLAG.to_string()],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_flag_is_stable() {
        assert_eq!(mcp_stdio_proxy_flag(), "--aiterm-mcp-stdio");
    }
}
