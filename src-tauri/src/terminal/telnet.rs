use super::channels::TerminalChannels;
use super::output_emit;
use super::ConnectRequest;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalStatusEvent {
    session_id: String,
    status: String,
    error: Option<String>,
}

pub fn spawn_telnet(
    app: AppHandle,
    request: ConnectRequest,
    abort: Arc<AtomicBool>,
) -> Result<TerminalChannels, String> {
    let (write_tx, write_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let (resize_tx, resize_rx) = std::sync::mpsc::channel::<(u16, u16)>();
    let session_id = request.sessionId.clone();

    tauri::async_runtime::spawn(async move {
        let result =
            run_telnet_session(app.clone(), request, write_rx, resize_rx, abort.clone()).await;
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

    Ok(TerminalChannels { write_tx, resize_tx })
}

async fn run_telnet_session(
    app: AppHandle,
    request: ConnectRequest,
    write_rx: Receiver<Vec<u8>>,
    _resize_rx: Receiver<(u16, u16)>,
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

    let port = request.port.unwrap_or(23);
    let addr = format!("{}:{}", request.host, port);
    let mut stream = TcpStream::connect(&addr)
        .await
        .map_err(|e| format!("无法连接 Telnet {addr}: {e}"))?;

    emit_status("connected", None);

    let mut pending = TelnetPending::default();
    let mut buf = [0u8; 8192];

    loop {
        if abort.load(Ordering::Relaxed) {
            emit_status("disconnected", None);
            break;
        }

        // Drain pending writes
        while let Ok(data) = write_rx.try_recv() {
            if data.is_empty() {
                continue;
            }
            stream
                .write_all(&data)
                .await
                .map_err(|e| format!("写入 Telnet 失败: {e}"))?;
        }

        // Read socket with short timeout to keep abort responsive
        match tokio::time::timeout(Duration::from_millis(60), stream.read(&mut buf)).await {
            Ok(Ok(0)) => {
                emit_status("disconnected", None);
                break;
            }
            Ok(Ok(n)) => {
                let (text_bytes, response_bytes) = process_telnet_chunk(&mut pending, &buf[..n]);

                if !response_bytes.is_empty() {
                    let _ = stream.write_all(&response_bytes).await;
                }

                if !text_bytes.is_empty() {
                    let text = String::from_utf8_lossy(&text_bytes).into_owned();
                    output_emit::append_and_emit(&app, &session_id, &text);
                }
            }
            Ok(Err(e)) => {
                emit_status("error", Some(format!("读取 Telnet 输出失败: {e}")));
                break;
            }
            Err(_) => continue,
        }
    }

    Ok(())
}

#[derive(Default)]
struct TelnetPending {
    // partial IAC sequence buffer
    iac_buf: Vec<u8>,
    // whether we are inside subnegotiation (SB ... IAC SE)
    in_sb: bool,
}

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;

fn process_telnet_chunk(pending: &mut TelnetPending, input: &[u8]) -> (Vec<u8>, Vec<u8>) {
    let mut out = Vec::with_capacity(input.len());
    let mut resp = Vec::new();

    // append any previously buffered bytes
    if !pending.iac_buf.is_empty() {
        let mut merged = Vec::with_capacity(pending.iac_buf.len() + input.len());
        merged.extend_from_slice(&pending.iac_buf);
        merged.extend_from_slice(input);
        pending.iac_buf.clear();
        return process_telnet_chunk(pending, &merged);
    }

    let mut i = 0usize;
    while i < input.len() {
        let b = input[i];

        if pending.in_sb {
            // swallow until IAC SE
            if b == IAC {
                if i + 1 >= input.len() {
                    pending.iac_buf.push(IAC);
                    break;
                }
                let next = input[i + 1];
                if next == SE {
                    pending.in_sb = false;
                    i += 2;
                    continue;
                }
            }
            i += 1;
            continue;
        }

        if b != IAC {
            out.push(b);
            i += 1;
            continue;
        }

        // b == IAC
        if i + 1 >= input.len() {
            pending.iac_buf.push(IAC);
            break;
        }

        let cmd = input[i + 1];

        // Escaped 255 => literal 255
        if cmd == IAC {
            out.push(IAC);
            i += 2;
            continue;
        }

        if cmd == SB {
            pending.in_sb = true;
            i += 2;
            continue;
        }

        // Negotiation commands: DO/DONT/WILL/WONT <opt>
        if cmd == DO || cmd == DONT || cmd == WILL || cmd == WONT {
            if i + 2 >= input.len() {
                pending.iac_buf.extend_from_slice(&input[i..]);
                break;
            }
            let opt = input[i + 2];
            // Default stance: refuse most options to keep device happy.
            // - DO -> WONT (we won't perform)
            // - WILL -> DONT (please don't)
            // - DONT/WONT -> ignore
            match cmd {
                DO => resp.extend_from_slice(&[IAC, WONT, opt]),
                WILL => resp.extend_from_slice(&[IAC, DONT, opt]),
                _ => {}
            }
            i += 3;
            continue;
        }

        // Other 2-byte IAC commands; skip
        i += 2;
    }

    (out, resp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telnet_filters_iac_negotiation() {
        let mut pending = TelnetPending::default();
        // IAC WILL 1 should trigger IAC DONT 1 response.
        let (out, resp) = process_telnet_chunk(&mut pending, &[IAC, WILL, 1]);
        assert!(out.is_empty());
        assert_eq!(resp, vec![IAC, DONT, 1]);
    }

    #[test]
    fn telnet_passes_plain_text() {
        let mut pending = TelnetPending::default();
        let (out, resp) = process_telnet_chunk(&mut pending, b"hello\r\n");
        assert_eq!(out, b"hello\r\n");
        assert!(resp.is_empty());
    }
}

