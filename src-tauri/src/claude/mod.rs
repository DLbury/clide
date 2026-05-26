pub mod bridge;
pub mod detect;
pub mod ide_connector;
pub mod mcp_register;
pub mod session;
pub mod tools;

pub use detect::{ClaudeDetectResult, ClaudeAutoDetectManager, detect_claude_binary, resolve_claude_path};
pub use mcp_register::{McpRegisterStatus, check_mcp_status, register_mcp, try_auto_ensure_project_mcp};
