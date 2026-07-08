use super::provider::AiProvider;
use crate::claude::detect::{
    detect_claude_binary_with_custom, ClaudeDetectResult as ClaudeResult,
};
use crate::process_util::{command_no_window, prepare_cli_discovery_environment};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDetectResult {
    pub provider: String,
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub candidates: Vec<String>,
}

pub fn detect_ai_backend(provider: AiProvider, custom_path: Option<String>) -> AiDetectResult {
    match provider {
        AiProvider::ClaudeCode => from_claude(detect_claude_binary_with_custom(custom_path)),
        AiProvider::Codex => detect_generic_cli(
            provider,
            custom_path,
            &["CODEX_PATH"],
            &["codex"],
            &codex_extra_paths(),
        ),
        AiProvider::OpenCode => detect_generic_cli(
            provider,
            custom_path,
            &["OPENCODE_PATH"],
            &["opencode"],
            &opencode_extra_paths(),
        ),
        AiProvider::Cursor => detect_cursor(custom_path),
    }
}

fn from_claude(result: ClaudeResult) -> AiDetectResult {
    AiDetectResult {
        provider: AiProvider::ClaudeCode.as_str().to_string(),
        found: result.found,
        path: result.path,
        version: result.version,
        candidates: result.candidates,
    }
}

fn detect_generic_cli(
    provider: AiProvider,
    custom_path: Option<String>,
    env_keys: &[&str],
    which_names: &[&str],
    extra_paths: &[PathBuf],
) -> AiDetectResult {
    prepare_cli_discovery_environment();
    let mut candidates = Vec::new();

    for key in env_keys {
        if let Ok(path) = std::env::var(key) {
            let path = path.trim();
            if !path.is_empty() && PathBuf::from(path).exists() {
                candidates.push(path.to_string());
            }
        }
    }

    for path in extra_paths {
        if path.exists() {
            candidates.push(path.display().to_string());
        }
    }

    for name in which_names {
        if let Ok(path) = which::which(name) {
            candidates.push(path.display().to_string());
        }
    }

    candidates.sort();
    candidates.dedup();

    let path = resolve_custom_or_first(custom_path, &candidates);
    let version = path.as_ref().and_then(|p| read_cli_version(p));

    AiDetectResult {
        provider: provider.as_str().to_string(),
        found: path.is_some(),
        path,
        version,
        candidates,
    }
}

fn detect_cursor(custom_path: Option<String>) -> AiDetectResult {
    prepare_cli_discovery_environment();
    let mut candidates = Vec::new();

    for key in ["CURSOR_AGENT_PATH", "CURSOR_PATH"] {
        if let Ok(path) = std::env::var(key) {
            let path = path.trim();
            if !path.is_empty() && PathBuf::from(path).exists() {
                candidates.push(path.to_string());
            }
        }
    }

    #[cfg(windows)]
    let which_names = ["agent.cmd", "agent.exe", "agent", "cursor-agent.cmd", "cursor-agent.exe", "cursor-agent"];
    #[cfg(not(windows))]
    let which_names = ["agent", "cursor-agent"];

    for name in which_names {
        if let Ok(path) = which::which(name) {
            candidates.push(path.display().to_string());
        }
    }

    if let Some(home) = dirs::home_dir() {
        #[cfg(windows)]
        {
            let local = home.join(".local").join("bin");
            for name in ["agent.exe", "agent.cmd", "cursor-agent.exe"] {
                let p = local.join(name);
                if p.is_file() {
                    candidates.push(p.display().to_string());
                }
            }
        }
        #[cfg(not(windows))]
        {
            for rel in [".local/bin/agent", ".local/bin/cursor-agent"] {
                let p = home.join(rel);
                if p.is_file() {
                    candidates.push(p.display().to_string());
                }
            }
        }
    }

    candidates.sort();
    candidates.dedup();

    let path = resolve_custom_or_first(custom_path, &candidates);
    let version = path.as_ref().and_then(|p| read_cli_version(p));

    AiDetectResult {
        provider: AiProvider::Cursor.as_str().to_string(),
        found: path.is_some(),
        path,
        version,
        candidates,
    }
}

fn resolve_custom_or_first(custom_path: Option<String>, candidates: &[String]) -> Option<String> {
    if let Some(custom) = custom_path.filter(|p| !p.trim().is_empty()) {
        let custom = custom.trim();
        if PathBuf::from(custom).exists() {
            return Some(custom.replace('\\', "/"));
        }
        return None;
    }
    candidates.first().cloned()
}

fn read_cli_version(path: &str) -> Option<String> {
    let output = command_no_window(path).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next()?.trim();
    if line.is_empty() {
        None
    } else {
        Some(line.to_string())
    }
}

fn codex_extra_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = dirs::home_dir() {
        #[cfg(windows)]
        {
            paths.push(home.join(".local").join("bin").join("codex.exe"));
            paths.push(home.join("AppData").join("Roaming").join("npm").join("codex.cmd"));
            paths.push(home.join("AppData").join("Roaming").join("npm").join("codex.exe"));
        }
        #[cfg(not(windows))]
        {
            paths.push(home.join(".local").join("bin").join("codex"));
            paths.push(PathBuf::from("/opt/homebrew/bin/codex"));
            paths.push(PathBuf::from("/usr/local/bin/codex"));
        }
    }
    paths
}

fn opencode_extra_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = dirs::home_dir() {
        #[cfg(windows)]
        {
            paths.push(home.join(".local").join("bin").join("opencode.exe"));
            paths.push(home.join("AppData").join("Roaming").join("npm").join("opencode.cmd"));
            paths.push(home.join("AppData").join("Roaming").join("npm").join("opencode.exe"));
        }
        #[cfg(not(windows))]
        {
            paths.push(home.join(".local").join("bin").join("opencode"));
            paths.push(PathBuf::from("/opt/homebrew/bin/opencode"));
            paths.push(PathBuf::from("/usr/local/bin/opencode"));
        }
    }
    paths
}
