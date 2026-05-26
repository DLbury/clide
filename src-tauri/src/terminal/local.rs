use super::channels::TerminalChannels;
use super::output_buffer;
use super::ConnectRequest;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputEvent {
    session_id: String,
    data: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalStatusEvent {
    session_id: String,
    status: String,
    error: Option<String>,
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
            let mut c = CommandBuilder::new("wsl.exe");
            c.args(["--", "bash", "-l"]);
            c
        }
        _ => {
            if cfg!(windows) {
                let mut c = CommandBuilder::new("powershell.exe");
                c.args(["-NoLogo"]);
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

    emit_status("connected", None);

    let mut buf = [0u8; 8192];
    loop {
        if abort.load(Ordering::Relaxed) {
            emit_status("disconnected", None);
            break;
        }

        match reader.read(&mut buf) {
            Ok(0) => {
                emit_status("disconnected", None);
                break;
            }
            Ok(n) => {
                let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                output_buffer::append_terminal_output(&session_id, &text);
                let _ = app.emit(
                    "terminal:output",
                    TerminalOutputEvent {
                        session_id: session_id.clone(),
                        data: text,
                    },
                );
            }
            Err(e) => {
                emit_status("error", Some(format!("读取 PTY 输出失败: {e}")));
                break;
            }
        }
    }
}
