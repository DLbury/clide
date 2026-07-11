use crate::browser_policy;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserNewWindowPayload {
    parent_label: String,
    url: String,
}

/// 在主窗口内创建一个嵌入式子 WebView 作为浏览器标签。
///
/// SOCKS5 代理属于 WebView 环境级配置，因此每个代理 WebView 都使用独立数据目录。
#[tauri::command]
pub async fn browser_webview_open(
    app: AppHandle,
    window_label: String,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    proxy_url: Option<String>,
    data_dir_key: Option<String>,
) -> Result<(), String> {
    use tauri::webview::{NewWindowResponse, WebviewBuilder};
    use tauri::{LogicalPosition, LogicalSize, Url, WebviewUrl};

    let window = app
        .get_window(&window_label)
        .ok_or_else(|| format!("窗口不存在: {window_label}"))?;
    browser_policy::validate_browser_url(&url)?;
    let target = Url::parse(&url).map_err(|e| format!("URL 无效: {e}"))?;

    let dir_key = data_dir_key.as_deref().unwrap_or(&label);
    let data_dir = app
        .path()
        .app_cache_dir()
        .ok()
        .map(|base| base.join("browser-webviews").join(sanitize_dir(dir_key)));

    if let Some(ref dir) = data_dir {
        let _ = std::fs::create_dir_all(dir);
    }

    let parent_label = label.clone();
    let app_for_popup = app.clone();
    let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(target)).on_new_window(
        move |popup_url, _features| {
            if browser_policy::validate_browser_url(popup_url.as_str()).is_err() {
                return NewWindowResponse::Deny;
            }
            let payload = BrowserNewWindowPayload {
                parent_label: parent_label.clone(),
                url: popup_url.to_string(),
            };
            if let Err(err) = app_for_popup.emit("browser-new-window", payload) {
                tracing::warn!("browser-new-window emit failed: {err}");
            }
            NewWindowResponse::Deny
        },
    );

    if let Some(dir) = data_dir {
        builder = builder.data_directory(dir);
    }
    if let Some(proxy) = proxy_url.filter(|p| !p.is_empty()) {
        let proxy_url = Url::parse(&proxy).map_err(|e| format!("代理 URL 无效: {e}"))?;
        builder = builder.proxy_url(proxy_url);
    }

    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| format!("创建 WebView 失败: {e}"))?;
    Ok(())
}

fn sanitize_dir(label: &str) -> String {
    label
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}
