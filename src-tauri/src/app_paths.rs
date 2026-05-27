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
        tracing::info!("MCP scripts directory resolved: {}", scripts_dir.display());

        let launcher_script = scripts_dir.join("run-aiterm-mcp.mjs");
        let stdio_script = scripts_dir.join("aiterm-mcp-stdio.mjs");

        if !launcher_script.is_file() {
            tracing::error!("MCP launcher script not found: {}", launcher_script.display());
            return Err(format!(
                "未找到 MCP 启动脚本: {}",
                launcher_script.display()
            ));
        }
        tracing::info!("MCP launcher script found: {}", launcher_script.display());

        if !stdio_script.is_file() {
            tracing::warn!("MCP stdio script not found: {}", stdio_script.display());
        } else {
            tracing::info!("MCP stdio script found: {}", stdio_script.display());
        }

        let config_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
        std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
        tracing::info!("MCP config directory: {}", config_dir.display());

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
    // 1. 首先尝试 bundled resources (文件直接放在根目录)
    if let Ok(resource_dir) = app.path().resource_dir() {
        // 检查是否直接包含脚本文件
        let launcher = resource_dir.join("run-aiterm-mcp.mjs");
        let stdio = resource_dir.join("aiterm-mcp-stdio.mjs");
        if launcher.is_file() {
            tracing::info!("Using bundled resources dir: {}", resource_dir.display());
            return Ok(resource_dir);
        }

        // 检查 scripts 子目录
        let bundled = resource_dir.join("scripts");
        tracing::debug!("Checking bundled scripts dir: {}", bundled.display());
        if bundled.join("run-aiterm-mcp.mjs").is_file() {
            tracing::info!("Using bundled scripts dir: {}", bundled.display());
            return Ok(bundled);
        }
    }

    // 2. Development: src-tauri/../scripts
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts");
    tracing::debug!("Checking dev scripts dir: {}", dev.display());
    if dev.join("run-aiterm-mcp.mjs").is_file() {
        tracing::info!("Using dev scripts dir: {}", dev.display());
        return Ok(dev);
    }

    // 3. Installed binary next to resources (fallback)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // 检查同级目录
            let launcher = dir.join("run-aiterm-mcp.mjs");
            if launcher.is_file() {
                tracing::info!("Using exe dir: {}", dir.display());
                return Ok(dir.to_path_buf());
            }

            let sibling = dir.join("scripts");
            tracing::debug!("Checking sibling scripts dir: {}", sibling.display());
            if sibling.join("run-aiterm-mcp.mjs").is_file() {
                tracing::info!("Using sibling scripts dir: {}", sibling.display());
                return Ok(sibling);
            }
            let resources = dir.join("resources").join("scripts");
            tracing::debug!("Checking resources scripts dir: {}", resources.display());
            if resources.join("run-aiterm-mcp.mjs").is_file() {
                tracing::info!("Using resources scripts dir: {}", resources.display());
                return Ok(resources);
            }
        }
    }

    tracing::error!("MCP scripts directory not found in any location");
    Err("未找到 MCP 脚本目录（scripts/run-aiterm-mcp.mjs）".to_string())
}

pub fn path_to_js_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
