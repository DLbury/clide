use std::path::{Path, PathBuf};
use tauri::path::BaseDirectory;
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
            tracing::warn!(
                "MCP launcher script not found (startup continues): {}",
                launcher_script.display()
            );
        } else {
            tracing::info!("MCP launcher script found: {}", launcher_script.display());
        }

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

    /// Fallback paths used when MCP resources are unavailable at startup.
    /// This keeps the window opening; MCP status will show as not-ready until scripts are found.
    pub fn fallback(app: &AppHandle) -> Self {
        let config_dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir().join("clide"));
        let _ = std::fs::create_dir_all(&config_dir);
        let scripts_dir = app
            .path()
            .resource_dir()
            .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| std::env::temp_dir()));
        let launcher_script = scripts_dir.join("run-aiterm-mcp.mjs");
        let stdio_script = scripts_dir.join("aiterm-mcp-stdio.mjs");
        let mcp_config_file = config_dir.join(".mcp.json");
        Self {
            scripts_dir,
            launcher_script,
            stdio_script,
            config_dir,
            mcp_config_file,
        }
    }

    pub fn display_root(&self) -> String {
        self.config_dir.display().to_string()
    }
}

fn resolve_scripts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // 1. Tauri resource resolver (matches tauri.conf.json > bundle > resources paths)
    const RESOURCE_CANDIDATES: &[&str] = &[
        "scripts/run-aiterm-mcp.mjs",
        "../scripts/run-aiterm-mcp.mjs",
        "run-aiterm-mcp.mjs",
    ];
    for rel in RESOURCE_CANDIDATES {
        if let Ok(path) = app.path().resolve(rel, BaseDirectory::Resource) {
            if path.is_file() {
                if let Some(dir) = path.parent() {
                    tracing::info!(
                        "Using MCP scripts from resource resolve({rel}): {}",
                        dir.display()
                    );
                    return Ok(dir.to_path_buf());
                }
            }
        }
    }

    // 2. Manual scan under resource_dir (Linux .deb: /usr/lib/<app>; list resources use _up_/scripts)
    if let Ok(resource_dir) = app.path().resource_dir() {
        let scan_dirs = [
            resource_dir.clone(),
            resource_dir.join("scripts"),
            resource_dir.join("_up_").join("scripts"),
        ];
        for dir in scan_dirs {
            if dir.join("run-aiterm-mcp.mjs").is_file() {
                tracing::info!("Using bundled resources dir: {}", dir.display());
                return Ok(dir);
            }
        }
    }

    // 3. Development: src-tauri/../scripts
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts");
    if dev.join("run-aiterm-mcp.mjs").is_file() {
        tracing::info!("Using dev scripts dir: {}", dev.display());
        return Ok(dev);
    }

    // 4. Installed binary layout (platform-specific fallbacks)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let product = app
                .config()
                .product_name
                .clone()
                .unwrap_or_else(|| "Clide".to_string());
            let mut candidates = vec![
                dir.to_path_buf(),
                dir.join("scripts"),
                // Linux .deb: /usr/bin/<bin> + /usr/lib/<productName>/scripts
                dir.join("../lib").join(&product),
                // macOS .app: Contents/MacOS/<bin> + Contents/Resources/scripts
                dir.join("../Resources"),
                dir.join("../Resources").join("scripts"),
                // Windows: resources next to exe
                dir.join("resources"),
                dir.join("resources").join("scripts"),
            ];
            candidates.push(dir.join("../Resources").join("_up_").join("scripts"));
            candidates.push(
                dir.join("../lib")
                    .join(&product)
                    .join("_up_")
                    .join("scripts"),
            );

            for candidate in candidates {
                if candidate.join("run-aiterm-mcp.mjs").is_file() {
                    tracing::info!("Using exe-relative scripts dir: {}", candidate.display());
                    return Ok(candidate);
                }
            }
        }
    }

    tracing::error!("MCP scripts directory not found in any location");
    Err("未找到 MCP 脚本目录（scripts/run-aiterm-mcp.mjs）".to_string())
}

pub fn path_to_js_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
