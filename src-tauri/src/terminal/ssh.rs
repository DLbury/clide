use super::channels::TerminalChannels;
use super::output_emit;
use super::ConnectRequest;
use russh::ChannelMsg;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
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

pub fn spawn_ssh(
    app: AppHandle,
    request: ConnectRequest,
    abort: Arc<AtomicBool>,
) -> Result<TerminalChannels, String> {
    let (write_tx, write_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let (resize_tx, resize_rx) = std::sync::mpsc::channel::<(u16, u16)>();
    let session_id = request.sessionId.clone();

    tauri::async_runtime::spawn(async move {
        let result =
            run_ssh_session(app.clone(), request, write_rx, resize_rx, abort.clone()).await;
        super::unregister_terminal_session(&app, &session_id);
        if let Err(error) = result {
            let _ = app.emit(
                "terminal:status",
                TerminalStatusEvent {
                    session_id,
                    status: "error".to_string(),
                    error: Some(error),
                },
            );
        }
    });

    Ok(TerminalChannels {
        write_tx,
        resize_tx,
    })
}

async fn run_ssh_session(
    app: AppHandle,
    request: ConnectRequest,
    write_rx: Receiver<Vec<u8>>,
    resize_rx: Receiver<(u16, u16)>,
    abort: Arc<AtomicBool>,
) -> Result<(), String> {
    let session_id = request.sessionId.clone();

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

    let session = super::ssh_auth::connect_and_auth(&request, &session_id).await?;

    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("无法打开 SSH 通道: {e}"))?;

    channel
        .request_pty(false, "xterm-256color", 120, 32, 0, 0, &[])
        .await
        .map_err(|e| format!("无法请求 PTY: {e}"))?;
    channel
        .request_shell(false)
        .await
        .map_err(|e| format!("无法启动 Shell: {e}"))?;

    emit_status("connected", None);

    loop {
        if abort.load(Ordering::Relaxed) {
            let _ = channel.close().await;
            output_emit::flush_session(&app, &session_id);
            super::ssh_jump::release_jump_for_owner(&request, &session_id);
            emit_status("disconnected", None);
            break;
        }

        while let Ok((cols, rows)) = resize_rx.try_recv() {
            let _ = channel.window_change(cols as u32, rows as u32, 0, 0).await;
        }

        while let Ok(data) = write_rx.try_recv() {
            channel
                .data(&data[..])
                .await
                .map_err(|e| format!("写入 SSH 通道失败: {e}"))?;
        }

        match tokio::time::timeout(Duration::from_millis(100), channel.wait()).await {
            Ok(Some(ChannelMsg::Data { ref data })) => {
                let text = String::from_utf8_lossy(data).into_owned();
                output_emit::append_and_emit(&app, &session_id, &text);
            }
            Ok(Some(ChannelMsg::ExitStatus { .. })) | Ok(None) => {
                output_emit::flush_session(&app, &session_id);
                super::ssh_jump::release_jump_for_owner(&request, &session_id);
                emit_status("disconnected", None);
                break;
            }
            Ok(Some(_)) => {}
            Err(_) => continue,
        }
    }

    Ok(())
}
