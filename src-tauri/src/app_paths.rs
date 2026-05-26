use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Bundled MCP scripts + app-local MCP config directory.
#[derive(Debug, Clone)]
pub struct McpBundlePaths {
    pub scripts_dir: PathBuf,
    pub launcher_script: PathBuf,
    pub stdio_script: PathBuf,
    pub config_dir: PathBuf,
    pub mcp_config_file: PathBuf,
}

impl McpBundlePaths {
    pub fn resolve(app: &AppHandle) -> Result<Self, String> {
        let scripts_dir = resolve_scripts_dir(app)?;
        let launcher_script = scripts_dir.join("run-aiterm-mcp.mjs");
        let stdio_script = scripts_dir.join("aiterm-mcp-stdio.mjs");

        if !launcher_script.is_file() {
            return Err(format!(
                "未找到 MCP 启动脚本: {}",
                launcher_script.display()
            ));
        }

        let config_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
        std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;

        let mcp_config_file = config_dir.join(".mcp.json");

        Ok(Self {
            scripts_dir,
            launcher_script,
            stdio_script,
            config_dir,
            mcp_config_file,
        })
    }

    pub fn display_root(&self) -> String {
        self.config_dir.display().to_string()
    }
}

fn resolve_scripts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("scripts");
        if bundled.join("run-aiterm-mcp.mjs").is_file() {
            return Ok(bundled);
        }
    }

    // Development: src-tauri/../scripts
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts");
    if dev.join("run-aiterm-mcp.mjs").is_file() {
        return Ok(dev);
    }

    // Installed binary next to resources (fallback)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sibling = dir.join("scripts");
            if sibling.join("run-aiterm-mcp.mjs").is_file() {
                return Ok(sibling);
            }
            let resources = dir.join("resources").join("scripts");
            if resources.join("run-aiterm-mcp.mjs").is_file() {
                return Ok(resources);
            }
        }
    }

    Err("未找到 MCP 脚本目录（scripts/run-aiterm-mcp.mjs）".to_string())
}

pub fn path_to_js_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
