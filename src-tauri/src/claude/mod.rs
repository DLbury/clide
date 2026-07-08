pub mod bridge;
pub mod detect;
pub mod ide_connector;
pub mod mcp_register;
pub mod session;
pub mod tools;

pub use detect::{
    detect_claude_binary, detect_claude_binary_with_custom, resolve_claude_path,
    ClaudeAutoDetectManager, ClaudeDetectResult,
};
pub use mcp_register::{
    aiterm_acp_mcp_servers, check_mcp_status, ensure_cursor_mcp_json, ensure_project_mcp_json,
    ensure_workspace_cursor_mcp_json, register_mcp, sync_mcp_bridge_env, try_auto_ensure_project_mcp,
    try_auto_register_mcp, wait_for_mcp_ready, McpRegisterStatus, McpRuntimeCache,
};
