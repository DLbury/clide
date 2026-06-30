use super::{ssh_auth, ConnectRequest};
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
enum RemotePlatform {
    Unix,
    Windows,
}

fn normalize_path_slashes(path: &str) -> String {
    path.replace('\\', "/")
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
    if let Ok(out) = exec_capture(
        request,
        "powershell -NoProfile -NoLogo -NonInteractive -Command \"if ($env:OS -eq 'Windows_NT') { Write-Output 'windows' } else { Write-Output 'unix' }\"",
        false,
    )
    .await
    {
        if out.trim().eq_ignore_ascii_case("windows") {
            return RemotePlatform::Windows;
        }
    }
    if let Ok(out) = exec_capture(
        request,
        "cmd /c \"if %OS%==Windows_NT (echo windows) else (echo unix)\"",
        false,
    )
    .await
    {
        if out.trim().eq_ignore_ascii_case("windows") {
            return RemotePlatform::Windows;
        }
    }
    RemotePlatform::Unix
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

fn resolve_remote_path(request: &ConnectRequest, path: &str) -> String {
    if path.contains(':') || path.starts_with("\\\\") {
        return normalize_path_slashes(path);
    }
    if path.is_empty() || path == "~" {
        if let Some(user) = &request.user {
            return format!("/home/{user}");
        }
        return "/".to_string();
    }
    if path.starts_with("~/") {
        if let Some(user) = &request.user {
            return format!("/home/{}/{}", user, path.trim_start_matches("~/"));
        }
        return path.trim_start_matches('~').to_string();
    }
    path.to_string()
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
    let base = resolve_remote_path(request, &path);
    parse_directory_output(&output, &base)
}

pub(crate) async fn exec_capture(
    request: &ConnectRequest,
    cmd: &str,
    elevated: bool,
) -> Result<String, String> {
    let remote_cmd = if elevated {
        format_sudo_bash(cmd)
    } else {
        cmd.to_string()
    };
    let session = ssh_auth::connect_and_auth(request).await?;
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("无法打开 SSH 通道: {e}"))?;

    channel
        .exec(true, remote_cmd)
        .await
        .map_err(|e| format!("无法执行远程命令: {e}"))?;

    let mut output = String::new();
    let mut exit_code: u32 = 0;

    loop {
        match tokio::time::timeout(EXEC_TIMEOUT, channel.wait()).await {
            Ok(Some(ChannelMsg::Data { data })) => {
                output.push_str(&String::from_utf8_lossy(&data));
            }
            Ok(Some(ChannelMsg::ExitStatus { exit_status })) => {
                exit_code = exit_status;
                break;
            }
            Ok(None) => break,
            Ok(Some(_)) => {}
            Err(_) => return Err("远程命令执行超时".to_string()),
        }
    }

    let _ = channel.close().await;

    if exit_code != 0 {
        let detail = output.trim();
        if detail.is_empty() {
            return Err(format!("远程命令失败 (exit {exit_code})"));
        }
        return Err(map_root_error(detail.to_string(), elevated));
    }

    Ok(output)
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

    let session = ssh_auth::connect_and_auth(request).await?;
    let mut channel = session
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

    let resolved = resolve_remote_path(&request, &path);
    let safe = escape_single_quotes(&resolved);

    let read_cmd = format!(
        "if [ -f '{safe}' ]; then base64 -w0 '{safe}' 2>/dev/null || base64 '{safe}' 2>/dev/null | tr -d '\\n'; elif [ -d '{safe}' ]; then echo __IS_DIRECTORY__; exit 2; else echo __NOT_FOUND__; exit 1; fi"
    );

    let encoded = exec_capture(&request, &read_cmd, elevated)
        .await
        .map_err(|e| {
            if e.contains("__NOT_FOUND__") {
                "远程文件不存在".to_string()
            } else if e.contains("__IS_DIRECTORY__") {
                "无法打开目录，请选择文件".to_string()
            } else {
                e
            }
        })?;
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

    let resolved = resolve_remote_path(&request, &path);
    write_bytes(&request, &resolved, content.as_bytes(), elevated).await
}

pub async fn read_file_base64(
    request: ConnectRequest,
    path: String,
    elevated: bool,
) -> Result<String, String> {
    ensure_ssh(&request)?;

    let resolved = resolve_remote_path(&request, &path);
    let safe = escape_single_quotes(&resolved);

    let read_cmd = format!(
        "if [ -f '{safe}' ]; then base64 -w0 '{safe}' 2>/dev/null || base64 '{safe}' 2>/dev/null | tr -d '\\n'; elif [ -d '{safe}' ]; then echo __IS_DIRECTORY__; exit 2; else echo __NOT_FOUND__; exit 1; fi"
    );

    exec_capture(&request, &read_cmd, elevated)
        .await
        .map_err(|e| {
            if e.contains("__NOT_FOUND__") {
                "远程文件不存在".to_string()
            } else if e.contains("__IS_DIRECTORY__") {
                "无法下载目录".to_string()
            } else {
                e
            }
        })
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

    let resolved = resolve_remote_path(&request, &path);
    write_bytes(&request, &resolved, &bytes, elevated).await
}

pub async fn rename_path(
    request: ConnectRequest,
    source: String,
    new_name: String,
    elevated: bool,
) -> Result<(), String> {
    ensure_ssh(&request)?;

    let trimmed = new_name.trim();
    if trimmed.is_empty() || trimmed.contains('/') {
        return Err("新名称不能为空或包含 /".to_string());
    }

    let src = resolve_remote_path(&request, &source);
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

    let src = resolve_remote_path(&request, &source);
    let dest = resolve_remote_path(&request, &dest_dir);
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

pub async fn delete_path(
    request: ConnectRequest,
    path: String,
    elevated: bool,
) -> Result<(), String> {
    ensure_ssh(&request)?;

    let resolved = resolve_remote_path(&request, &path);
    let trimmed = resolved.trim();
    if trimmed.is_empty() || trimmed == "/" {
        return Err("无法删除根目录".to_string());
    }

    let safe = escape_single_quotes(trimmed);
    let cmd = format!(
        "target='{safe}'; \
         if [ ! -e \"$target\" ]; then echo __NOT_FOUND__; exit 1; fi; \
         case \"$target\" in /|/bin|/etc|/usr|/var|/lib|/lib64|/sbin|/boot|/dev|/proc|/sys) echo __FORBIDDEN__; exit 2;; esac; \
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
                "powershell -NoProfile -NoLogo -NonInteractive -Command \"Write-Output $env:USERPROFILE\"",
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
