pub mod acp_persistent;
pub mod codex_persistent;
pub mod detect;
pub mod ndjson_rpc;
pub mod persistent_manager;
pub mod provider;

pub use detect::{detect_ai_backend, AiDetectResult};
pub use persistent_manager::GenericSessionManager;
pub use provider::AiProvider;
