use super::{ConnectRequest};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use russh::ChannelMsg;
use std::time::Duration;

const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
const EXEC_TIMEOUT: Duration = Duration::from_secs(30);
const WRITE_TIMEOUT: Duration = Duration::from_secs(60);
const ROOT_HINT: &str =
    "请在左侧 Shell 执行 sudo -v 刷新权限，或为当前用户配置免密 sudo (NOPASSWD)。";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub size: Option<u64>,
    pub permissions: Option<String>,
}

fn ensure_ssh(request: &ConnectRequest) -> Result<(), String> {
    if request.session_type != "ssh" {
        return Err("远程文件操作仅支持 SSH 会话".to_string());
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum RemotePlatform {
    Unix,
    Windows,
}

fn validate_delete_target(platform: RemotePlatform, path: &str) -> Result<(), String> {
    let trimmed = path.trim();
    let normalized = trimmed.replace('\\', "/");
    if trimmed.is_empty()
        || trimmed.contains('\0')
        || normalized
            .split('/')
            .any(|segment| segment == "." || segment == "..")
    {
        return Err("无法删除当前目录或上级目录".to_string());
    }

    match platform {
        RemotePlatform::Unix if trimmed == "/" => Err("无法删除根目录".to_string()),
        RemotePlatform::Windows if is_windows_root_path(trimmed) => {
            Err("无法删除驱动器或网络共享根目录".to_string())
        }
        _ => Ok(()),
    }
}

fn is_windows_root_path(path: &str) -> bool {
    let normalized = path.trim().replace('\\', "/");
    let without_trailing = normalized.trim_end_matches('/');
    if without_trailing.len() == 2
        && without_trailing.as_bytes()[0].is_ascii_alphabetic()
        && without_trailing.as_bytes()[1] == b':'
    {
        return true;
    }

    let parts: Vec<_> = without_trailing
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    normalized.starts_with("//") && parts.len() == 2
}

fn normalize_path_slashes(path: &str) -> String {
    path.replace('\\', "/")
}

pub fn normalize_path_slashes_public(path: &str) -> String {
    normalize_path_slashes(path)
}

pub async fn detect_platform_public(request: &ConnectRequest) -> RemotePlatform {
    detect_platform(request).await
}

pub async fn detect_platform_name(request: &ConnectRequest) -> String {
    match detect_platform(request).await {
        RemotePlatform::Windows => "windows".to_string(),
        RemotePlatform::Unix => "unix".to_string(),
    }
}

async fn resolve_path(request: &ConnectRequest, path: &str) -> Result<String, String> {
    if path.contains(':') || path.starts_with("\\\\") {
        return Ok(normalize_path_slashes(path));
    }
    let platform = detect_platform(request).await;
    match platform {
        RemotePlatform::Windows => resolve_windows_path(request, path).await,
        RemotePlatform::Unix => {
            if path.is_empty() || path == "~" {
                return super::exec_pool::global_exec_pool()
                    .get_remote_home(request)
                    .await;
            }
            if path.starts_with("~/") {
                let home = super::exec_pool::global_exec_pool()
                    .get_remote_home(request)
                    .await?;
                return Ok(join_remote_entry_path(&home, &path[2..]));
            }
            Ok(path.to_string())
        }
    }
}

fn join_remote_entry_path(base: &str, name: &str) -> String {
    let base = normalize_path_slashes(base.trim_end_matches('/').trim_end_matches('\\'));
    if base.is_empty() {
        return normalize_path_slashes(name);
    }
    format!("{base}/{name}")
}

fn escape_powershell_single(value: &str) -> String {
    value.replace('\'', "''")
}

async fn detect_platform(request: &ConnectRequest) -> RemotePlatform {
    let cached = super::exec_pool::global_exec_pool()
        .get_platform(request)
        .await;
    if cached.is_windows() {
        RemotePlatform::Windows
    } else {
        RemotePlatform::Unix
    }
}

async fn resolve_windows_path(request: &ConnectRequest, path: &str) -> Result<String, String> {
    if path.is_empty() || path == "~" {
        let out = exec_capture(
            request,
            "powershell -NoProfile -NoLogo -NonInteractive -Command \"Write-Output $env:USERPROFILE\"",
            false,
        )
        .await?;
        let resolved = normalize_path_slashes(out.trim());
        if resolved.is_empty() {
            return Err("无法解析 Windows 用户目录".to_string());
        }
        return Ok(resolved);
    }
    if path.starts_with("~/") {
        let rest = escape_powershell_single(&path[2..]);
        let cmd = format!(
            "powershell -NoProfile -NoLogo -NonInteractive -Command \"Write-Output (Join-Path $env:USERPROFILE '{rest}')\""
        );
        let out = exec_capture(request, &cmd, false).await?;
        return Ok(normalize_path_slashes(out.trim()));
    }
    Ok(normalize_path_slashes(path))
}

fn build_windows_list_cmd(resolved_path: &str) -> String {
    let safe = escape_powershell_single(resolved_path);
    format!(
        "powershell -NoProfile -NoLogo -NonInteractive -Command \"& {{ $p = '{safe}'; if (-not (Test-Path -LiteralPath $p)) {{ Write-Error ('Path not found: ' + $p); exit 1 }}; Get-ChildItem -LiteralPath $p -Force | ForEach-Object {{ $k = if ($_.PSIsContainer) {{ 'd' }} else {{ 'f' }}; $s = if ($_.PSIsContainer) {{ 0 }} else {{ $_.Length }}; $n = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($_.Name)); Write-Output ($k + [char]9 + $s + [char]9 + '000' + [char]9 + ('b64:' + $n)) }} }}\""
    )
}

pub(crate) fn decode_listing_name(raw: &str) -> String {
    if let Some(b64) = raw.strip_prefix("b64:") {
        if let Ok(bytes) = BASE64.decode(b64.trim()) {
            if let Ok(name) = String::from_utf8(bytes) {
                return name;
            }
        }
    }
    raw.to_string()
}

async fn list_directory_windows(
    request: &ConnectRequest,
    path: &str,
) -> Result<Vec<RemoteFileEntry>, String> {
    let base = resolve_windows_path(request, path).await?;
    let cmd = build_windows_list_cmd(&base.replace('/', "\\"));
    let output = exec_capture(request, &cmd, false).await?;
    parse_directory_output(&output, &base)
}

fn escape_single_quotes(value: &str) -> String {
    value.replace('\'', "'\\''")
}

fn format_sudo_bash(inner: &str) -> String {
    let escaped = inner.replace('\'', "'\\''");
    format!("sudo -n bash -c '{escaped}'")
}

fn map_root_error(err: String, elevated: bool) -> String {
    if !elevated {
        return err;
    }
    let lower = err.to_lowercase();
    if lower.contains("password")
        || lower.contains("a terminal is required")
        || lower.contains("sorry, try again")
        || lower.contains("not allowed to execute")
        || lower.contains("no tty")
    {
        return format!("{err}\n\n{ROOT_HINT}");
    }
    err
}

async fn list_directory_unix(
    request: &ConnectRequest,
    path: String,
    elevated: bool,
) -> Result<Vec<RemoteFileEntry>, String> {
    let cmd = if path.is_empty() || path == "~" {
        "LC_ALL=C cd ~ && LC_ALL=C find . -maxdepth 1 -mindepth 1 -printf '%y\\t%s\\t%m\\t%f\\n' 2>/dev/null || LC_ALL=C ls -1F . 2>/dev/null".to_string()
    } else if path.starts_with("~/") {
        let rest = path[2..].replace('\'', "'\\''");
        format!(
            "LC_ALL=C cd ~/'{rest}' && LC_ALL=C find . -maxdepth 1 -mindepth 1 -printf '%y\\t%s\\t%m\\t%f\\n' 2>/dev/null || LC_ALL=C ls -1F . 2>/dev/null"
        )
    } else {
        let safe = path.replace('\'', "'\\''");
        format!(
            "LC_ALL=C cd '{safe}' && LC_ALL=C find . -maxdepth 1 -mindepth 1 -printf '%y\\t%s\\t%m\\t%f\\n' 2>/dev/null || LC_ALL=C ls -1F . 2>/dev/null"
        )
    };

    let output = exec_capture(request, &cmd, elevated).await?;
    let base = resolve_path(request, &path).await?;
    parse_directory_output(&output, &base)
}

pub(crate) async fn exec_capture(
    request: &ConnectRequest,
    cmd: &str,
    elevated: bool,
) -> Result<String, String> {
    let platform = detect_platform(request).await;
    let remote_cmd = if elevated && platform == RemotePlatform::Unix {
        format_sudo_bash(cmd)
    } else {
        cmd.to_string()
    };
    super::exec_pool::global_exec_pool()
        .exec_raw(request, &remote_cmd)
        .await
        .map_err(|e| map_root_error(e, elevated))
}

async fn write_bytes(
    request: &ConnectRequest,
    path: &str,
    content: &[u8],
    elevated: bool,
) -> Result<(), String> {
    if content.len() > MAX_FILE_BYTES {
        return Err(format!(
            "文件过大（{} 字节），最大支持 {} MB",
            content.len(),
            MAX_FILE_BYTES / 1024 / 1024
        ));
    }
    let platform = detect_platform(request).await;
    match platform {
        RemotePlatform::Windows => write_bytes_windows(request, path, content).await,
        RemotePlatform::Unix => write_bytes_unix(request, path, content, elevated).await,
    }
}

async fn write_bytes_unix(
    request: &ConnectRequest,
    path: &str,
    content: &[u8],
    elevated: bool,
) -> Result<(), String> {
    let session = super::exec_pool::global_exec_pool()
        .get_or_connect(request)
        .await?;
    let handle = session.lock().await;
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("无法打开 SSH 通道: {e}"))?;

    let safe = escape_single_quotes(path);
    let inner = format!("cat > '{safe}'");
    let remote_cmd = if elevated {
        format_sudo_bash(&inner)
    } else {
        inner
    };
    channel
        .exec(false, remote_cmd)
        .await
        .map_err(|e| format!("无法写入远程文件: {e}"))?;

    for chunk in content.chunks(32 * 1024) {
        channel
            .data(chunk)
            .await
            .map_err(|e| format!("写入远程文件失败: {e}"))?;
    }

    channel
        .eof()
        .await
        .map_err(|e| format!("结束远程写入失败: {e}"))?;

    loop {
        match tokio::time::timeout(WRITE_TIMEOUT, channel.wait()).await {
            Ok(Some(ChannelMsg::ExitStatus { exit_status })) => {
                if exit_status != 0 {
                    return Err(map_root_error(
                        format!("写入远程文件失败 (exit {exit_status})"),
                        elevated,
                    ));
                }
                break;
            }
            Ok(None) => break,
            Ok(Some(ChannelMsg::Data { data })) => {
                let stderr = String::from_utf8_lossy(&data);
                if !stderr.trim().is_empty() {
                    return Err(map_root_error(stderr.trim().to_string(), elevated));
                }
            }
            Ok(Some(_)) => {}
            Err(_) => return Err("写入远程文件超时".to_string()),
        }
    }

    let _ = channel.close().await;
    Ok(())
}

async fn write_bytes_windows(request: &ConnectRequest, path: &str, content: &[u8]) -> Result<(), String> {
    let b64 = BASE64.encode(content);
    let win_path = path.replace('/', "\\");
    let safe = escape_powershell_single(&win_path);
    let cmd = format!(
        "powershell -NoProfile -NoLogo -NonInteractive -Command \"& {{ $p = '{safe}'; $dir = Split-Path -Parent $p; if ($dir -and -not (Test-Path -LiteralPath $dir)) {{ New-Item -ItemType Directory -Path $dir -Force | Out-Null }}; [IO.File]::WriteAllBytes($p, [Convert]::FromBase64String('{b64}')) }}\""
    );
    exec_capture(request, &cmd, false).await?;
    Ok(())
}

async fn read_file_base64_unix(
    request: &ConnectRequest,
    resolved: &str,
    elevated: bool,
) -> Result<String, String> {
    let safe = escape_single_quotes(resolved);
    let read_cmd = format!(
        "if [ -f '{safe}' ]; then base64 -w0 '{safe}' 2>/dev/null || base64 '{safe}' 2>/dev/null | tr -d '\\n'; elif [ -d '{safe}' ]; then echo __IS_DIRECTORY__; exit 2; else echo __NOT_FOUND__; exit 1; fi"
    );
    exec_capture(request, &read_cmd, elevated)
        .await
        .map_err(|e| map_read_error(e))
}

async fn read_file_base64_windows(request: &ConnectRequest, resolved: &str) -> Result<String, String> {
    let win_path = resolved.replace('/', "\\");
    let safe = escape_powershell_single(&win_path);
    let cmd = format!(
        "powershell -NoProfile -NoLogo -NonInteractive -Command \"& {{ $p = '{safe}'; if (-not (Test-Path -LiteralPath $p)) {{ Write-Output '__NOT_FOUND__'; exit 1 }}; if ((Get-Item -LiteralPath $p).PSIsContainer) {{ Write-Output '__IS_DIRECTORY__'; exit 2 }}; [Convert]::ToBase64String([IO.File]::ReadAllBytes($p)) }}\""
    );
    exec_capture(request, &cmd, false)
        .await
        .map_err(|e| map_read_error(e))
}

fn map_read_error(e: String) -> String {
    if e.contains("__NOT_FOUND__") {
        "远程文件不存在".to_string()
    } else if e.contains("__IS_DIRECTORY__") {
        "无法打开目录，请选择文件".to_string()
    } else {
        e
    }
}

pub async fn list_directory(
    request: ConnectRequest,
    path: String,
    elevated: bool,
) -> Result<Vec<RemoteFileEntry>, String> {
    ensure_ssh(&request)?;
    let platform = detect_platform(&request).await;
    match platform {
        RemotePlatform::Windows => list_directory_windows(&request, &path).await,
        RemotePlatform::Unix => list_directory_unix(&request, path, elevated).await,
    }
}

pub async fn read_file(
    request: ConnectRequest,
    path: String,
    elevated: bool,
) -> Result<String, String> {
    ensure_ssh(&request)?;
    let platform = detect_platform(&request).await;
    let resolved = resolve_path(&request, &path).await?;
    let encoded = match platform {
        RemotePlatform::Windows => read_file_base64_windows(&request, &resolved).await?,
        RemotePlatform::Unix => read_file_base64_unix(&request, &resolved, elevated).await?,
    };
    let bytes = BASE64
        .decode(encoded.trim())
        .map_err(|e| format!("解码远程文件失败: {e}"))?;

    if bytes.len() > MAX_FILE_BYTES {
        return Err(format!(
            "文件过大（{} 字节），最大支持 {} MB",
            bytes.len(),
            MAX_FILE_BYTES / 1024 / 1024
        ));
    }

    String::from_utf8(bytes)
        .map_err(|_| "该文件不是 UTF-8 文本，暂不支持在编辑器中打开二进制文件".to_string())
}

pub async fn write_file(
    request: ConnectRequest,
    path: String,
    content: String,
    elevated: bool,
) -> Result<(), String> {
    ensure_ssh(&request)?;
    let resolved = resolve_path(&request, &path).await?;
    write_bytes(&request, &resolved, content.as_bytes(), elevated).await
}

pub async fn read_file_base64(
    request: ConnectRequest,
    path: String,
    elevated: bool,
) -> Result<String, String> {
    ensure_ssh(&request)?;
    let platform = detect_platform(&request).await;
    let resolved = resolve_path(&request, &path).await?;
    match platform {
        RemotePlatform::Windows => read_file_base64_windows(&request, &resolved).await,
        RemotePlatform::Unix => read_file_base64_unix(&request, &resolved, elevated).await,
    }
}

pub async fn write_file_base64(
    request: ConnectRequest,
    path: String,
    content_base64: String,
    elevated: bool,
) -> Result<(), String> {
    ensure_ssh(&request)?;
    let bytes = BASE64
        .decode(content_base64.trim())
        .map_err(|e| format!("无效的文件数据: {e}"))?;
    let resolved = resolve_path(&request, &path).await?;
    write_bytes(&request, &resolved, &bytes, elevated).await
}

pub async fn rename_path(
    request: ConnectRequest,
    source: String,
    new_name: String,
    elevated: bool,
) -> Result<(), String> {
    ensure_ssh(&request)?;
    let platform = detect_platform(&request).await;
    let trimmed = new_name.trim();
    if trimmed.is_empty() || trimmed.contains('/') || trimmed.contains('\\') {
        return Err("新名称不能为空或包含路径分隔符".to_string());
    }

    let src = resolve_path(&request, &source).await?;
    if platform == RemotePlatform::Windows {
        let parent = src.rfind('/').or_else(|| src.rfind('\\')).map(|i| &src[..i]).unwrap_or("");
        let dest = if parent.is_empty() {
            trimmed.to_string()
        } else {
            format!("{}/{}", parent.replace('\\', "/"), trimmed)
        };
        if src == dest {
            return Ok(());
        }
        let src_safe = escape_powershell_single(&src.replace('/', "\\"));
        let dest_safe = escape_powershell_single(&dest.replace('/', "\\"));
        let cmd = format!(
            "powershell -NoProfile -NoLogo -NonInteractive -Command \"& {{ if (-not (Test-Path -LiteralPath '{src_safe}')) {{ Write-Error NOTFOUND; exit 1 }}; if (Test-Path -LiteralPath '{dest_safe}') {{ Write-Error EXISTS; exit 2 }}; Move-Item -LiteralPath '{src_safe}' -Destination '{dest_safe}' }}\""
        );
        return exec_capture(&request, &cmd, false)
            .await
            .map(|_| ())
            .map_err(|e| {
            if e.to_lowercase().contains("notfound") {
                "源路径不存在".to_string()
            } else if e.to_lowercase().contains("exists") {
                "目标名称已存在".to_string()
            } else {
                e
            }
        });
    }

    let parent = src.rfind('/').map(|i| &src[..i]).unwrap_or("");
    let dest = if parent.is_empty() {
        format!("/{trimmed}")
    } else {
        format!("{parent}/{trimmed}")
    };

    if src == dest {
        return Ok(());
    }

    let src_safe = escape_single_quotes(&src);
    let dest_safe = escape_single_quotes(&dest);

    let cmd = format!(
        "src='{src_safe}'; dest='{dest_safe}'; \
         if [ ! -e \"$src\" ]; then echo __NOT_FOUND__; exit 1; fi; \
         if [ -e \"$dest\" ]; then echo __DEST_EXISTS__; exit 2; fi; \
         mv -- \"$src\" \"$dest\""
    );

    exec_capture(&request, &cmd, elevated).await.map_err(|e| {
        if e.contains("__NOT_FOUND__") {
            "源路径不存在".to_string()
        } else if e.contains("__DEST_EXISTS__") {
            "目标名称已存在".to_string()
        } else {
            e
        }
    })?;
    Ok(())
}

pub async fn move_path(
    request: ConnectRequest,
    source: String,
    dest_dir: String,
    elevated: bool,
) -> Result<(), String> {
    ensure_ssh(&request)?;
    let platform = detect_platform(&request).await;
    let src = resolve_path(&request, &source).await?;
    let dest = resolve_path(&request, &dest_dir).await?;

    if platform == RemotePlatform::Windows {
        let src_safe = escape_powershell_single(&src.replace('/', "\\"));
        let dest_safe = escape_powershell_single(&dest.replace('/', "\\"));
        let cmd = format!(
            "powershell -NoProfile -NoLogo -NonInteractive -Command \"& {{ if (-not (Test-Path -LiteralPath '{src_safe}')) {{ Write-Error NOTFOUND; exit 1 }}; if (-not (Test-Path -LiteralPath '{dest_safe}')) {{ Write-Error NODIR; exit 2 }}; Move-Item -LiteralPath '{src_safe}' -Destination '{dest_safe}' }}\""
        );
        return exec_capture(&request, &cmd, false)
            .await
            .map(|_| ())
            .map_err(|e| {
            if e.to_lowercase().contains("notfound") {
                "源路径不存在".to_string()
            } else if e.to_lowercase().contains("nodir") {
                "目标必须是目录".to_string()
            } else {
                e
            }
        });
    }

    let src_safe = escape_single_quotes(&src);
    let dest_safe = escape_single_quotes(&dest);

    let cmd = format!(
        "src='{src_safe}'; dest='{dest_safe}'; \
         if [ ! -e \"$src\" ]; then echo __NOT_FOUND__; exit 1; fi; \
         if [ ! -d \"$dest\" ]; then echo __DEST_NOT_DIR__; exit 2; fi; \
         case \"$dest/\" in \"$src/\"*) echo __DEST_IN_SRC__; exit 3;; esac; \
         mv -- \"$src\" \"$dest/\""
    );

    exec_capture(&request, &cmd, elevated).await.map_err(|e| {
        if e.contains("__NOT_FOUND__") {
            "源路径不存在".to_string()
        } else if e.contains("__DEST_NOT_DIR__") {
            "目标必须是目录".to_string()
        } else if e.contains("__DEST_IN_SRC__") {
            "不能移动到自身或其子目录".to_string()
        } else {
            e
        }
    })?;
    Ok(())
}

pub async fn chmod_path(
    request: ConnectRequest,
    path: String,
    mode: String,
    elevated: bool,
) -> Result<(), String> {
    ensure_ssh(&request)?;
    if detect_platform(&request).await == RemotePlatform::Windows {
        return Err("Windows 远程主机不支持 chmod".to_string());
    }

    let mode_trimmed = mode.trim();
    if mode_trimmed.is_empty() || mode_trimmed.len() > 4 || !mode_trimmed.chars().all(|c| c.is_ascii_digit()) {
        return Err("权限模式必须是 3–4 位八进制数字（如 755、644）".to_string());
    }

    let resolved = resolve_path(&request, &path).await?;
    let safe = escape_single_quotes(&resolved);
    let mode_safe = escape_single_quotes(mode_trimmed);

    let cmd = format!(
        "target='{safe}'; mode='{mode_safe}'; \
         if [ ! -e \"$target\" ]; then echo __NOT_FOUND__; exit 1; fi; \
         chmod \"$mode\" -- \"$target\""
    );

    exec_capture(&request, &cmd, elevated).await.map_err(|e| {
        if e.contains("__NOT_FOUND__") {
            "路径不存在".to_string()
        } else {
            e
        }
    })?;
    Ok(())
}

pub async fn search_files(
    request: ConnectRequest,
    base_path: String,
    query: String,
    max_depth: Option<u32>,
    elevated: bool,
) -> Result<Vec<RemoteFileEntry>, String> {
    ensure_ssh(&request)?;

    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err("搜索关键词不能为空".to_string());
    }
    if trimmed.contains('\'') || trimmed.contains('\0') {
        return Err("搜索关键词包含非法字符".to_string());
    }

    let depth = max_depth.unwrap_or(5).clamp(1, 15);
    let platform = detect_platform(&request).await;
    match platform {
        RemotePlatform::Windows => search_files_windows(&request, &base_path, trimmed, depth).await,
        RemotePlatform::Unix => search_files_unix(&request, &base_path, trimmed, depth, elevated).await,
    }
}

async fn search_files_unix(
    request: &ConnectRequest,
    base_path: &str,
    query: &str,
    depth: u32,
    elevated: bool,
) -> Result<Vec<RemoteFileEntry>, String> {
    let base = resolve_path(request, base_path).await?;
    let safe_base = escape_single_quotes(&base);
    let safe_query = query.replace('*', "\\*").replace('?', "\\?");
    let cmd = format!(
        "base='{safe_base}'; \
         if [ ! -d \"$base\" ]; then echo __NOT_FOUND__; exit 1; fi; \
         cd \"$base\" && LC_ALL=C find . -maxdepth {depth} -iname '*{safe_query}*' 2>/dev/null | head -200 | while IFS= read -r p; do \
           rel=\"${{p#./}}\"; \
           if [ -d \"$p\" ]; then echo -e \"d\\t0\\t755\\t$rel\"; \
           elif [ -f \"$p\" ]; then sz=$(wc -c < \"$p\" 2>/dev/null | tr -d ' '); echo -e \"f\\t${{sz:-0}}\\t644\\t$rel\"; fi; \
         done"
    );

    let output = exec_capture(request, &cmd, elevated)
        .await
        .map_err(|e| {
            if e.contains("__NOT_FOUND__") {
                "搜索目录不存在".to_string()
            } else {
                e
            }
        })?;

    parse_search_output(&output, &base)
}

async fn search_files_windows(
    request: &ConnectRequest,
    base_path: &str,
    query: &str,
    depth: u32,
) -> Result<Vec<RemoteFileEntry>, String> {
    let base = resolve_windows_path(request, base_path).await?;
    let safe_base = escape_powershell_single(&base.replace('/', "\\"));
    let safe_query = escape_powershell_single(query);
    // PowerShell -Depth 0 等价于 find -maxdepth 1（仅直接子项），故减一换算
    let ps_depth = depth.saturating_sub(1);
    let cmd = format!(
        "powershell -NoProfile -NoLogo -NonInteractive -Command \"& {{ \
         $root = '{safe_base}'; \
         if (-not (Test-Path -LiteralPath $root)) {{ Write-Error 'NOTFOUND'; exit 1 }}; \
         Get-ChildItem -LiteralPath $root -Recurse -Depth {ps_depth} -Force -ErrorAction SilentlyContinue | \
         Where-Object {{ $_.Name -like '*{safe_query}*' }} | \
         Select-Object -First 200 | ForEach-Object {{ \
           $k = if ($_.PSIsContainer) {{ 'd' }} else {{ 'f' }}; \
           $rel = $_.FullName.Substring($root.Length).TrimStart('\\','/'); \
           $s = if ($_.PSIsContainer) {{ 0 }} else {{ $_.Length }}; \
           Write-Output ($k + [char]9 + $s + [char]9 + '000' + [char]9 + $rel) \
         }} }}\""
    );

    let output = exec_capture(request, &cmd, false).await.map_err(|e| {
        if e.to_lowercase().contains("notfound") {
            "搜索目录不存在".to_string()
        } else {
            e
        }
    })?;

    parse_search_output(&output, &base.replace('\\', "/"))
}

fn parse_search_output(output: &str, base: &str) -> Result<Vec<RemoteFileEntry>, String> {
    let mut entries = Vec::new();
    let base_norm = base.trim_end_matches('/');

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() || !line.contains('\t') {
            continue;
        }
        let parts: Vec<&str> = line.splitn(4, '\t').collect();
        if parts.len() < 4 {
            continue;
        }
        let kind = parts[0];
        let size = parts[1].parse::<u64>().ok();
        let mode = parts[2];
        let rel = parts[3].trim_start_matches("./").replace('\\', "/");
        if rel.is_empty() || rel == "." {
            continue;
        }
        let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
        let entry_type = if kind == "d" { "directory" } else { "file" };
        let permissions = mode_to_permissions(mode, entry_type == "directory");
        entries.push(RemoteFileEntry {
            name,
            path: join_remote_entry_path(base_norm, &rel),
            entry_type: entry_type.to_string(),
            size: if entry_type == "file" { size } else { None },
            permissions: Some(permissions),
        });
    }

    entries.sort_by(|a, b| a.path.len().cmp(&b.path.len()));
    Ok(entries)
}

pub async fn create_directory(
    request: ConnectRequest,
    dir_path: String,
    folder_name: String,
    elevated: bool,
) -> Result<(), String> {
    ensure_ssh(&request)?;

    let trimmed = folder_name.trim();
    if trimmed.is_empty() || trimmed.contains('/') || trimmed.contains('\\') {
        return Err("文件夹名称不能为空或包含路径分隔符".to_string());
    }

    let platform = detect_platform(&request).await;
    match platform {
        RemotePlatform::Windows => {
            let base = resolve_windows_path(&request, &dir_path).await?;
            let full = join_remote_entry_path(&base, trimmed);
            let safe = escape_powershell_single(&full.replace('/', "\\"));
            let cmd = format!(
                "powershell -NoProfile -NoLogo -NonInteractive -Command \"& {{ $p = '{safe}'; if (Test-Path -LiteralPath $p) {{ Write-Output __DEST_EXISTS__; exit 2 }}; New-Item -ItemType Directory -Path $p -Force | Out-Null }}\""
            );
            exec_capture(&request, &cmd, elevated).await.map_err(|e| {
                if e.contains("__DEST_EXISTS__") {
                    "文件夹已存在".to_string()
                } else {
                    e
                }
            })?;
        }
        RemotePlatform::Unix => {
            let base = resolve_path(&request, &dir_path).await?;
            let full = join_remote_entry_path(&base, trimmed);
            let safe = escape_single_quotes(&full);
            let cmd = format!(
                "target='{safe}'; \
                 if [ -e \"$target\" ]; then echo __DEST_EXISTS__; exit 2; fi; \
                 mkdir -p -- \"$target\""
            );
            exec_capture(&request, &cmd, elevated).await.map_err(|e| {
                if e.contains("__DEST_EXISTS__") {
                    "文件夹已存在".to_string()
                } else {
                    e
                }
            })?;
        }
    }
    Ok(())
}

pub async fn delete_path(
    request: ConnectRequest,
    path: String,
    elevated: bool,
) -> Result<(), String> {
    ensure_ssh(&request)?;
    let platform = detect_platform(&request).await;
    let resolved = resolve_path(&request, &path).await?;
    let trimmed = resolved.trim();
    validate_delete_target(platform, trimmed)?;

    if platform == RemotePlatform::Windows {
        let safe = escape_powershell_single(&trimmed.replace('/', "\\"));
        let cmd = format!(
            "powershell -NoProfile -NoLogo -NonInteractive -Command \"& {{ $target = [System.IO.Path]::GetFullPath('{safe}'); if (-not (Test-Path -LiteralPath $target)) {{ Write-Error NOTFOUND; exit 1 }}; $target = $target.TrimEnd('\\'); $root = [System.IO.Path]::GetPathRoot($target); if ($root -and $target -eq $root.TrimEnd('\\')) {{ Write-Error FORBIDDEN; exit 2 }}; $protected = @($env:SystemRoot, $env:ProgramFiles, $env:ProgramData, ${{env:ProgramFiles(x86)}}) | Where-Object {{ $_ }}; if ($protected | Where-Object {{ $systemPath = [System.IO.Path]::GetFullPath($_).TrimEnd('\\'); $target -ieq $systemPath -or $target.StartsWith($systemPath + '\\', [System.StringComparison]::OrdinalIgnoreCase) }}) {{ Write-Error FORBIDDEN; exit 2 }}; Remove-Item -LiteralPath $target -Recurse -Force }}\""
        );
        return exec_capture(&request, &cmd, false)
            .await
            .map(|_| ())
            .map_err(|e| {
            if e.to_lowercase().contains("notfound") {
                "路径不存在".to_string()
            } else if e.contains("FORBIDDEN") {
                "无法删除系统关键路径".to_string()
            } else {
                e
            }
        });
    }

    let safe = escape_single_quotes(trimmed);
    let cmd = format!(
        "target='{safe}'; \
         if [ ! -e \"$target\" ]; then echo __NOT_FOUND__; exit 1; fi; \
         parent=$(dirname -- \"$target\") || exit 1; name=$(basename -- \"$target\") || exit 1; \
         parent=$(cd -P -- \"$parent\" && pwd) || exit 1; target=\"$parent/$name\"; \
         case \"$target\" in /|/bin|/bin/*|/etc|/etc/*|/usr|/usr/*|/var|/var/*|/lib|/lib/*|/lib64|/lib64/*|/sbin|/sbin/*|/boot|/boot/*|/dev|/dev/*|/proc|/proc/*|/sys|/sys/*) echo __FORBIDDEN__; exit 2;; esac; \
         rm -rf -- \"$target\""
    );

    exec_capture(&request, &cmd, elevated).await.map_err(|e| {
        if e.contains("__NOT_FOUND__") {
            "路径不存在".to_string()
        } else if e.contains("__FORBIDDEN__") {
            "无法删除系统关键路径".to_string()
        } else {
            e
        }
    })?;
    Ok(())
}

pub async fn get_cwd(request: ConnectRequest, elevated: bool) -> Result<String, String> {
    ensure_ssh(&request)?;
    let platform = detect_platform(&request).await;
    let output = match platform {
        RemotePlatform::Windows => {
            exec_capture(
                &request,
                "powershell -NoProfile -NoLogo -NonInteractive -Command \"(Get-Location).ProviderPath\"",
                false,
            )
            .await?
        }
        RemotePlatform::Unix => exec_capture(&request, "pwd", elevated).await?,
    };
    let cwd = normalize_path_slashes(output.trim());
    if cwd.is_empty() {
        return Err("无法获取远程工作目录".to_string());
    }
    Ok(cwd)
}

pub(crate) fn parse_directory_output(
    output: &str,
    base_path: &str,
) -> Result<Vec<RemoteFileEntry>, String> {
    let mut entries = Vec::new();
    let base = base_path.trim_end_matches('/');

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        if line.contains('\t') {
            let parts: Vec<&str> = line.splitn(4, '\t').collect();
            if parts.len() < 4 {
                continue;
            }
            let kind = parts[0];
            let size = parts[1].parse::<u64>().ok();
            let mode = parts[2];
            let name = decode_listing_name(parts[3]);
            if name.is_empty() || name == "." || name == ".." {
                continue;
            }
            let entry_type = if kind == "d" { "directory" } else { "file" };
            let permissions = mode_to_permissions(mode, entry_type == "directory");
            entries.push(RemoteFileEntry {
                name: name.clone(),
                path: join_remote_entry_path(base, &name),
                entry_type: entry_type.to_string(),
                size: if entry_type == "file" { size } else { None },
                permissions: Some(permissions),
            });
            continue;
        }

        let mut name = line.to_string();
        let is_dir = name.ends_with('/');
        if is_dir {
            name.pop();
        }
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        entries.push(RemoteFileEntry {
            name: name.clone(),
            path: join_remote_entry_path(base, &name),
            entry_type: if is_dir {
                "directory".to_string()
            } else {
                "file".to_string()
            },
            size: None,
            permissions: None,
        });
    }

    entries.sort_by(|a, b| {
        if a.entry_type != b.entry_type {
            return if a.entry_type == "directory" {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        a.name.to_lowercase().cmp(&b.name.to_lowercase())
    });

    Ok(entries)
}

fn mode_to_permissions(mode: &str, is_dir: bool) -> String {
    if let Ok(bits) = u32::from_str_radix(mode, 8) {
        let mut s = String::new();
        s.push(if is_dir { 'd' } else { '-' });
        for shift in [6, 3, 0] {
            s.push(if bits & (1 << (shift + 2)) != 0 {
                'r'
            } else {
                '-'
            });
            s.push(if bits & (1 << (shift + 1)) != 0 {
                'w'
            } else {
                '-'
            });
            s.push(match (bits >> shift) & 7 {
                7 | 6 | 5 | 3 => 'x',
                2 | 1 => 'w',
                _ => '-',
            });
        }
        return s;
    }
    if is_dir {
        "drwxr-xr-x".to_string()
    } else {
        "-rw-r--r--".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unix_root_and_relative_navigation() {
        assert!(validate_delete_target(RemotePlatform::Unix, "/").is_err());
        assert!(validate_delete_target(RemotePlatform::Unix, ".").is_err());
        assert!(validate_delete_target(RemotePlatform::Unix, "..").is_err());
        assert!(validate_delete_target(RemotePlatform::Unix, "/tmp/..").is_err());
    }

    #[test]
    fn rejects_windows_volume_and_share_roots() {
        assert!(validate_delete_target(RemotePlatform::Windows, "C:\\").is_err());
        assert!(validate_delete_target(RemotePlatform::Windows, "C:/").is_err());
        assert!(validate_delete_target(RemotePlatform::Windows, "\\\\server\\share").is_err());
    }

    #[test]
    fn allows_non_root_delete_targets() {
        assert!(validate_delete_target(RemotePlatform::Unix, "/tmp/archive").is_ok());
        assert!(validate_delete_target(RemotePlatform::Windows, "C:\\Users\\name\\archive").is_ok());
    }
}
