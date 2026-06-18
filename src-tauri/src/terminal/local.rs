use super::channels::TerminalChannels;
use super::output_emit;
use super::ConnectRequest;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalStatusEvent {
    session_id: String,
    status: String,
    error: Option<String>,
}

/// 解析 System32 下的可执行文件绝对路径，避免 GUI 子系统下 PATH 不含 System32 的极端情况
fn resolve_system_exe(name: &str) -> Result<PathBuf, String> {
    // 1. 先尝试 PATH 直接解析（dev 或正常 PATH 时生效）
    if let Ok(path) = which::which(name) {
        return Ok(path);
    }
    // 2. 回退到 %SystemRoot%\System32\<name>
    let system_root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .ok_or_else(|| format!("无法定位 SystemRoot 以解析 {name}"))?;
    let candidate = system_root.join("System32").join(name);
    if candidate.is_file() {
        return Ok(candidate);
    }
    Err(format!("找不到可执行文件 {name}（PATH 和 System32 均未找到）"))
}

/// Windows 下按优先级解析 PowerShell：pwsh (PS7+) → Windows PowerShell 5.1 → cmd
fn resolve_windows_shell() -> Result<PathBuf, String> {
    // PowerShell 7+ (跨平台版本，通常装在独立目录)
    if let Ok(p) = which::which("pwsh.exe") {
        return Ok(p);
    }
    if let Ok(p) = which::which("pwsh") {
        return Ok(p);
    }
    // Windows PowerShell 5.1（System32\WindowsPowerShell\v1.0\）
    if let Some(root) = std::env::var_os("SystemRoot") {
        let ps5 = PathBuf::from(&root)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        if ps5.is_file() {
            return Ok(ps5);
        }
    }
    // PATH 中查找
    if let Ok(p) = which::which("powershell.exe") {
        return Ok(p);
    }
    // 最后回退到 cmd
    resolve_system_exe("cmd.exe")
}

pub fn spawn_local_pty(
    app: AppHandle,
    request: ConnectRequest,
    abort: Arc<AtomicBool>,
) -> Result<TerminalChannels, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 32,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("无法创建 PTY: {e}"))?;

    let master: Arc<Mutex<Box<dyn MasterPty + Send>>> = Arc::new(Mutex::new(pair.master));

    let cmd = match request.session_type.as_str() {
        "wsl" => {
            let wsl_path = resolve_system_exe("wsl.exe")?;
            let mut c = CommandBuilder::new(wsl_path);
            c.args(["--", "bash", "-l"]);
            c
        }
        _ => {
            if cfg!(windows) {
                let shell_path = resolve_windows_shell()?;
                tracing::info!(
                    "Local shell resolved: {} (session={})",
                    shell_path.display(),
                    request.sessionId
                );
                let program_str = shell_path.to_string_lossy().to_lowercase();
                let is_powershell =
                    program_str.contains("powershell") || program_str.ends_with("pwsh.exe");
                let mut c = CommandBuilder::new(shell_path);
                if is_powershell {
                    c.args(["-NoLogo", "-NoProfile"]);
                }
                c.set_controlling_tty(false);
                c
            } else {
                let mut c = CommandBuilder::new("bash");
                c.args(["-l"]);
                c
            }
        }
    };

    let _child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("无法启动本地 Shell: {e}"))?;

    let reader = master
        .lock()
        .try_clone_reader()
        .map_err(|e| format!("无法读取 PTY: {e}"))?;
    let writer = master
        .lock()
        .take_writer()
        .map_err(|e| format!("无法写入 PTY: {e}"))?;

    let (write_tx, write_rx) = mpsc::channel::<Vec<u8>>();
    let (resize_tx, resize_rx) = mpsc::channel::<(u16, u16)>();
    let session_id = request.sessionId.clone();
    let abort_reader = abort.clone();
    let abort_writer = abort.clone();
    let abort_resize = abort.clone();
    let master_resize = master.clone();

    std::thread::spawn(move || {
        while !abort_resize.load(Ordering::Relaxed) {
            match resize_rx.recv_timeout(Duration::from_millis(200)) {
                Ok((cols, rows)) => {
                    let _ = master_resize.lock().resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    std::thread::spawn(move || {
        let mut writer = writer;
        while !abort_writer.load(Ordering::Relaxed) {
            match write_rx.recv_timeout(Duration::from_millis(200)) {
                Ok(data) => {
                    if writer.write_all(&data).is_err() {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    std::thread::spawn(move || {
        run_pty_reader(app, session_id, reader, abort_reader);
    });

    Ok(TerminalChannels { write_tx, resize_tx })
}

fn run_pty_reader(
    app: AppHandle,
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    abort: Arc<AtomicBool>,
) {
    let emit_status = |status: &str, error: Option<String>| {
        let _ = app.emit(
            "terminal:status",
            TerminalStatusEvent {
                session_id: session_id.clone(),
                status: status.to_string(),
                error,
            },
        );
    };

    // 先报 connecting，等实际有数据流过再报 connected
    emit_status("connecting", None);

    let mut buf = [0u8; 8192];
    let mut connected_emitted = false;
    loop {
        if abort.load(Ordering::Relaxed) {
            emit_status("disconnected", None);
            break;
        }

        match reader.read(&mut buf) {
            Ok(0) => {
                // 如果从未收到任何输出就 EOF，说明 shell 启动后立即退出
                if !connected_emitted {
                    emit_status(
                        "error",
                        Some(
                            "Shell 启动后立即退出，未产生任何输出。请检查系统 Shell 是否可用。"
                                .to_string(),
                        ),
                    );
                } else {
                    emit_status("disconnected", None);
                }
                break;
            }
            Ok(n) => {
                if !connected_emitted {
                    connected_emitted = true;
                    emit_status("connected", None);
                }
                let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                output_emit::append_and_emit(&app, &session_id, &text);
            }
            Err(e) => {
                emit_status("error", Some(format!("读取 PTY 输出失败: {e}")));
                break;
            }
        }
    }
}
