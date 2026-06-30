use super::remote_fs::{parse_directory_output, RemoteFileEntry};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::path::PathBuf;

const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;

fn normalize_path_slashes(path: &str) -> String {
    path.replace('\\', "/")
}

fn join_entry_path(base: &str, name: &str) -> String {
    let base = normalize_path_slashes(base.trim_end_matches('/').trim_end_matches('\\'));
    if base.is_empty() {
        return normalize_path_slashes(name);
    }
    format!("{base}/{name}")
}

fn native_home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "无法解析用户主目录".to_string())
}

fn resolve_native_path(path: &str) -> Result<PathBuf, String> {
    if path.is_empty() || path == "~" {
        return native_home_dir();
    }
    if path.starts_with("~/") {
        let home = native_home_dir()?;
        return Ok(home.join(path.trim_start_matches("~/")));
    }
    Ok(PathBuf::from(path))
}

fn resolve_wsl_path(path: &str) -> Result<String, String> {
    if path.is_empty() || path == "~" {
        let out = wsl_exec("echo \"$HOME\"")?;
        let resolved = normalize_path_slashes(out.trim());
        if resolved.is_empty() {
            return Err("无法解析 WSL 用户目录".to_string());
        }
        return Ok(resolved);
    }
    if path.starts_with("~/") {
        let rest = path[2..].replace('\'', "'\\''");
        let out = wsl_exec(&format!("echo \"$HOME\"/'{rest}'"))?;
        return Ok(normalize_path_slashes(out.trim()));
    }
    Ok(normalize_path_slashes(path))
}

fn wsl_exec(cmd: &str) -> Result<String, String> {
    let output = std::process::Command::new("wsl.exe")
        .args(["-e", "bash", "-lc", cmd])
        .output()
        .map_err(|e| format!("无法执行 WSL 命令: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = format!("{stderr}{stdout}").trim().to_string();
        if detail.is_empty() {
            return Err("WSL 命令失败".to_string());
        }
        return Err(detail);
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn build_wsl_list_cmd(path: &str) -> String {
    let list_body = r#"find . -maxdepth 1 -mindepth 1 -print0 | while IFS= read -r -d '' f; do bn=$(basename "$f"); if [ -d "$f" ]; then k=d; s=0; else k=f; s=$(stat -c%s "$f" 2>/dev/null || echo 0); fi; b64=$(printf '%s' "$bn" | base64 -w0 2>/dev/null || printf '%s' "$bn" | base64 | tr -d '\n'); printf '%s\t%s\t000\tb64:%s\n' "$k" "$s" "$b64"; done"#;
    if path.is_empty() || path == "~" {
        format!("LC_ALL=C.UTF-8 cd ~ && {list_body}")
    } else if path.starts_with("~/") {
        let rest = path[2..].replace('\'', "'\\''");
        format!("LC_ALL=C.UTF-8 cd ~/'{rest}' && {list_body}")
    } else {
        let safe = path.replace('\'', "'\\''");
        format!("LC_ALL=C.UTF-8 cd '{safe}' && {list_body}")
    }
}

#[cfg(windows)]
fn dir_entry_name(entry: &std::fs::DirEntry) -> String {
    use std::os::windows::ffi::OsStrExt;
    String::from_utf16_lossy(&entry.file_name().encode_wide().collect::<Vec<_>>())
}

#[cfg(not(windows))]
fn dir_entry_name(entry: &std::fs::DirEntry) -> String {
    entry.file_name().to_string_lossy().into_owned()
}

fn list_directory_native(path: &str) -> Result<Vec<RemoteFileEntry>, String> {
    let base_path = resolve_native_path(path)?;
    let metadata = std::fs::metadata(&base_path)
        .map_err(|e| format!("无法访问目录 {}: {e}", base_path.display()))?;
    if !metadata.is_dir() {
        return Err(format!("不是目录: {}", base_path.display()));
    }

    let base = normalize_path_slashes(&base_path.to_string_lossy());
    let mut entries = Vec::new();

    for entry in std::fs::read_dir(&base_path).map_err(|e| format!("读取目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("读取目录项失败: {e}"))?;
        let name = dir_entry_name(&entry);
        if name == "." || name == ".." {
            continue;
        }
        let meta = entry.metadata().ok();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = meta
            .as_ref()
            .and_then(|m| if m.is_file() { Some(m.len()) } else { None });
        entries.push(RemoteFileEntry {
            name: name.clone(),
            path: join_entry_path(&base, &name),
            entry_type: if is_dir {
                "directory".to_string()
            } else {
                "file".to_string()
            },
            size,
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

fn list_directory_wsl(path: &str) -> Result<Vec<RemoteFileEntry>, String> {
    let cmd = build_wsl_list_cmd(path);
    let output = wsl_exec(&cmd)?;
    let base = resolve_wsl_path(path)?;
    parse_directory_output(&output, &base)
}

fn read_file_native(path: &str) -> Result<String, String> {
    let file_path = resolve_native_path(path)?;
    let metadata = std::fs::metadata(&file_path)
        .map_err(|e| format!("无法读取文件 {}: {e}", file_path.display()))?;
    if metadata.is_dir() {
        return Err("无法打开目录，请选择文件".to_string());
    }
    if metadata.len() as usize > MAX_FILE_BYTES {
        return Err(format!(
            "文件过大（{} 字节），最大支持 {} MB",
            metadata.len(),
            MAX_FILE_BYTES / 1024 / 1024
        ));
    }
    let bytes = std::fs::read(&file_path).map_err(|e| format!("读取文件失败: {e}"))?;
    String::from_utf8(bytes)
        .map_err(|_| "该文件不是 UTF-8 文本，暂不支持在编辑器中打开二进制文件".to_string())
}

fn write_file_native(path: &str, content: &str) -> Result<(), String> {
    if content.len() > MAX_FILE_BYTES {
        return Err(format!(
            "文件过大（{} 字节），最大支持 {} MB",
            content.len(),
            MAX_FILE_BYTES / 1024 / 1024
        ));
    }
    let file_path = resolve_native_path(path)?;
    if let Some(parent) = file_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
    }
    std::fs::write(&file_path, content.as_bytes()).map_err(|e| format!("写入文件失败: {e}"))
}

fn read_file_wsl(path: &str) -> Result<String, String> {
    let resolved = resolve_wsl_path(path)?;
    let safe = resolved.replace('\'', "'\\''");
    let cmd = format!(
        "if [ -f '{safe}' ]; then base64 -w0 '{safe}' 2>/dev/null || base64 '{safe}' 2>/dev/null | tr -d '\\n'; elif [ -d '{safe}' ]; then echo __IS_DIRECTORY__; exit 2; else echo __NOT_FOUND__; exit 1; fi"
    );
    let encoded = wsl_exec(&cmd).map_err(|e| {
        if e.contains("__NOT_FOUND__") {
            "文件不存在".to_string()
        } else if e.contains("__IS_DIRECTORY__") {
            "无法打开目录，请选择文件".to_string()
        } else {
            e
        }
    })?;
    let bytes = BASE64
        .decode(encoded.trim())
        .map_err(|e| format!("解码文件失败: {e}"))?;
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

fn write_file_wsl(path: &str, content: &str) -> Result<(), String> {
    if content.len() > MAX_FILE_BYTES {
        return Err(format!(
            "文件过大（{} 字节），最大支持 {} MB",
            content.len(),
            MAX_FILE_BYTES / 1024 / 1024
        ));
    }
    let resolved = resolve_wsl_path(path)?;
    let safe = resolved.replace('\'', "'\\''");
    let encoded = BASE64.encode(content.as_bytes());
    let cmd = format!("base64 -d > '{safe}'");

    let mut child = std::process::Command::new("wsl.exe")
        .args(["-e", "bash", "-lc", &cmd])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动 WSL 写入: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        stdin
            .write_all(encoded.as_bytes())
            .map_err(|e| format!("写入 WSL stdin 失败: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("等待 WSL 写入失败: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = format!("{stderr}{stdout}").trim().to_string();
        if detail.is_empty() {
            return Err("WSL 写入失败".to_string());
        }
        return Err(detail);
    }
    Ok(())
}

pub async fn list_directory(
    session_type: &str,
    path: String,
) -> Result<Vec<RemoteFileEntry>, String> {
    match session_type {
        "wsl" => tokio::task::spawn_blocking(move || list_directory_wsl(&path))
            .await
            .map_err(|e| format!("WSL 列表任务失败: {e}"))?,
        "local" => tokio::task::spawn_blocking(move || list_directory_native(&path))
            .await
            .map_err(|e| format!("本地列表任务失败: {e}"))?,
        _ => Err(format!("不支持的会话类型: {session_type}")),
    }
}

pub async fn read_file(session_type: &str, path: String) -> Result<String, String> {
    match session_type {
        "wsl" => tokio::task::spawn_blocking(move || read_file_wsl(&path))
            .await
            .map_err(|e| format!("WSL 读取任务失败: {e}"))?,
        "local" => tokio::task::spawn_blocking(move || read_file_native(&path))
            .await
            .map_err(|e| format!("本地读取任务失败: {e}"))?,
        _ => Err(format!("不支持的会话类型: {session_type}")),
    }
}

pub async fn write_file(session_type: &str, path: String, content: String) -> Result<(), String> {
    match session_type {
        "wsl" => tokio::task::spawn_blocking(move || write_file_wsl(&path, &content))
            .await
            .map_err(|e| format!("WSL 写入任务失败: {e}"))?,
        "local" => tokio::task::spawn_blocking(move || write_file_native(&path, &content))
            .await
            .map_err(|e| format!("本地写入任务失败: {e}"))?,
        _ => Err(format!("不支持的会话类型: {session_type}")),
    }
}

pub async fn get_home_dir(session_type: &str) -> Result<String, String> {
    match session_type {
        "wsl" => tokio::task::spawn_blocking(|| resolve_wsl_path("~"))
            .await
            .map_err(|e| format!("WSL 主目录任务失败: {e}"))?,
        "local" => tokio::task::spawn_blocking(|| {
            let home = native_home_dir()?;
            Ok(normalize_path_slashes(&home.to_string_lossy()))
        })
        .await
        .map_err(|e| format!("本地主目录任务失败: {e}"))?,
        _ => Err(format!("不支持的会话类型: {session_type}")),
    }
}
