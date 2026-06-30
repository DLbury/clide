use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::{
    connect_async, tungstenite::client::IntoClientRequest, tungstenite::http::HeaderValue,
    tungstenite::Message,
};

/// 桥接就绪后由本进程建立 WebSocket 保活连接（不反复拉起 Claude CLI，避免空跑 API）。
pub fn start_keepalive_loop(
    port: u16,
    auth_token: String,
    shutdown: Arc<AtomicBool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;

        while !shutdown.load(Ordering::SeqCst) {
            match run_keepalive_session(port, &auth_token, shutdown.clone()).await {
                Ok(()) => tracing::debug!("IDE bridge keepalive session ended"),
                Err(err) => tracing::warn!("IDE bridge keepalive failed: {err}"),
            }

            if shutdown.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    })
}

async fn run_keepalive_session(
    port: u16,
    auth_token: &str,
    shutdown: Arc<AtomicBool>,
) -> Result<(), String> {
    let url = format!("ws://127.0.0.1:{port}");
    let mut request = url
        .into_client_request()
        .map_err(|e| format!("构建 WebSocket 请求失败: {e}"))?;

    request.headers_mut().insert(
        "x-claude-code-ide-authorization",
        HeaderValue::from_str(auth_token).map_err(|e| format!("无效 auth token: {e}"))?,
    );

    let (ws, _) = connect_async(request)
        .await
        .map_err(|e| format!("连接 IDE 桥接 WebSocket 失败: {e}"))?;

    tracing::info!("IDE bridge keepalive connected on 127.0.0.1:{port}");

    let (mut write, mut read) = ws.split();

    let init = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "aiterm-keepalive", "version": "0.1.0" }
        }
    });
    write
        .send(Message::Text(init.to_string().into()))
        .await
        .map_err(|e| format!("发送 initialize 失败: {e}"))?;

    let mut handshake_done = false;
    let mut ping = tokio::time::interval(Duration::from_secs(25));
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        if shutdown.load(Ordering::SeqCst) {
            let _ = write.send(Message::Close(None)).await;
            break;
        }

        tokio::select! {
            _ = ping.tick() => {
                if write.send(Message::Ping(vec![].into())).await.is_err() {
                    break;
                }
            }
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = write.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Text(_))) if !handshake_done => {
                        handshake_done = true;
                        let initialized = serde_json::json!({
                            "jsonrpc": "2.0",
                            "method": "notifications/initialized"
                        });
                        if write
                            .send(Message::Text(initialized.to_string().into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Some(Err(e)) => {
                        return Err(format!("WebSocket 读取错误: {e}"));
                    }
                    _ => {}
                }
            }
        }
    }

    Ok(())
}
