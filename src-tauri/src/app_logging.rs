use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

struct LogFile(Arc<Mutex<File>>);

impl Write for LogFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.lock().unwrap().flush()
    }
}

impl Write for &'_ LogFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.lock().unwrap().flush()
    }
}

/// 初始化 tracing：写入应用日志目录（打包版 GUI 无控制台，日志在文件中）。
pub fn init(app: &AppHandle) -> Option<PathBuf> {
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    let log_path = resolve_log_file(app);
    if let Some(path) = log_path.as_ref() {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(file) = OpenOptions::new().create(true).append(true).open(path) {
            let writer = Arc::new(LogFile(Arc::new(Mutex::new(file))));
            tracing_subscriber::fmt()
                .with_env_filter(env_filter)
                .with_ansi(false)
                .with_writer(writer)
                .init();
            tracing::info!("Clide logging to {}", path.display());
            return Some(path.clone());
        }
    }

    tracing_subscriber::fmt().with_env_filter(env_filter).init();
    tracing::warn!("Clide file logging unavailable; using stderr only");
    None
}

fn resolve_log_file(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = app.path().app_log_dir() {
        return Some(dir.join("clide.log"));
    }
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("logs").join("clide.log"))
}

pub fn log_file_path(app: &AppHandle) -> Option<String> {
    resolve_log_file(app).map(|p| p.display().to_string())
}

/// 将 MCP / Claude 诊断信息写入日志（便于打包版排查「无响应」）。
pub fn log_diag(label: &str, detail: &str) {
    tracing::warn!(target: "clide.diag", "{label}: {detail}");
}
