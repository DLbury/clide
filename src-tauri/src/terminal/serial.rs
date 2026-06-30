use super::channels::TerminalChannels;
use super::output_emit;
use super::ConnectRequest;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_serial::{DataBits, FlowControl, Parity, SerialPortBuilderExt, StopBits};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalStatusEvent {
    session_id: String,
    status: String,
    error: Option<String>,
}

pub fn spawn_serial(
    app: AppHandle,
    request: ConnectRequest,
    abort: Arc<AtomicBool>,
) -> Result<TerminalChannels, String> {
    let (write_tx, write_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let (resize_tx, resize_rx) = std::sync::mpsc::channel::<(u16, u16)>();
    let session_id = request.sessionId.clone();

    tauri::async_runtime::spawn(async move {
        let result =
            run_serial_session(app.clone(), request, write_rx, resize_rx, abort.clone()).await;
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

async fn run_serial_session(
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

    let port = request
        .serial_port
        .clone()
        .or_else(|| (!request.host.is_empty()).then(|| request.host.clone()))
        .ok_or_else(|| "缺少 serialPort".to_string())?;

    let baud_rate = request.baud_rate.unwrap_or(115_200);

    let mut builder = tokio_serial::new(port.clone(), baud_rate)
        .data_bits(parse_data_bits(request.data_bits))
        .stop_bits(parse_stop_bits(request.stop_bits))
        .parity(parse_parity(request.parity.as_deref()))
        .flow_control(FlowControl::None);

    // Low-ish timeout so reads unblock in a timely fashion.
    builder = builder.timeout(Duration::from_millis(200));

    let mut serial = builder
        .open_native_async()
        .map_err(|e| format!("无法打开串口 {port} @ {baud_rate}: {e}"))?;

    emit_status("connected", None);

    let mut buf = [0u8; 8192];
    loop {
        if abort.load(Ordering::Relaxed) {
            emit_status("disconnected", None);
            break;
        }

        while let Ok(data) = write_rx.try_recv() {
            if data.is_empty() {
                continue;
            }
            serial
                .write_all(&data)
                .await
                .map_err(|e| format!("写入串口失败: {e}"))?;
        }

        match tokio::time::timeout(Duration::from_millis(60), serial.read(&mut buf)).await {
            Ok(Ok(0)) => {
                // No bytes; continue
            }
            Ok(Ok(n)) => {
                let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                output_emit::append_and_emit(&app, &session_id, &text);
            }
            Ok(Err(e)) => {
                emit_status("error", Some(format!("读取串口输出失败: {e}")));
                break;
            }
            Err(_) => continue,
        }
    }

    Ok(())
}

fn parse_parity(p: Option<&str>) -> Parity {
    match p.unwrap_or("none") {
        "odd" => Parity::Odd,
        "even" => Parity::Even,
        _ => Parity::None,
    }
}

fn parse_data_bits(bits: Option<u8>) -> DataBits {
    match bits.unwrap_or(8) {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        _ => DataBits::Eight,
    }
}

fn parse_stop_bits(bits: Option<u8>) -> StopBits {
    match bits.unwrap_or(1) {
        2 => StopBits::Two,
        _ => StopBits::One,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parity_parses_values() {
        assert!(matches!(parse_parity(Some("none")), Parity::None));
        assert!(matches!(parse_parity(Some("odd")), Parity::Odd));
        assert!(matches!(parse_parity(Some("even")), Parity::Even));
        assert!(matches!(parse_parity(Some("unknown")), Parity::None));
    }

    #[test]
    fn data_bits_parses_values() {
        assert!(matches!(parse_data_bits(Some(7)), DataBits::Seven));
        assert!(matches!(parse_data_bits(Some(8)), DataBits::Eight));
        assert!(matches!(parse_data_bits(Some(5)), DataBits::Five));
        assert!(matches!(parse_data_bits(None), DataBits::Eight));
    }
}
