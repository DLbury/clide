use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeContext {
    pub workspace_folders: Vec<String>,
    pub active_session_name: Option<String>,
    pub active_session_host: Option<String>,
    pub active_profile_id: Option<String>,
    pub active_connection_id: Option<String>,
    pub active_shell_id: Option<String>,
    pub terminal_snippet: Option<String>,
    pub open_files: Vec<String>,
    pub active_file_path: Option<String>,
    pub selected_text: Option<String>,
}
