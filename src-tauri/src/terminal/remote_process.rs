use super::{remote_fs, ConnectRequest};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProcess {
    pub pid: u32,
    pub user: Option<String>,
    pub cpu_percent: f64,
    pub mem_percent: f64,
    pub mem_bytes: Option<u64>,
    pub command: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePort {
    pub pid: u32,
    pub port: u16,
    pub protocol: String,
    pub address: String,
    pub command: Option<String>,
}

fn ensure_ssh(request: &ConnectRequest) -> Result<(), String> {
    if request.session_type != "ssh" {
        return Err("进程管理仅支持 SSH 会话".to_string());
    }
    Ok(())
}

fn parse_f64(value: &str) -> f64 {
    value.trim().parse::<f64>().unwrap_or(0.0)
}

fn parse_process_line_unix(line: &str) -> Option<RemoteProcess> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    // pid user pcpu pmem comm
    let mut parts = line.split_whitespace();
    let pid: u32 = parts.next()?.parse().ok()?;
    let user = parts.next().map(|s| s.to_string());
    let cpu_percent = parse_f64(parts.next()?);
    let mem_percent = parse_f64(parts.next()?);
    let command = parts.collect::<Vec<_>>().join(" ");
    if command.is_empty() {
        return None;
    }
    Some(RemoteProcess {
        pid,
        user,
        cpu_percent,
        mem_percent,
        mem_bytes: None,
        command,
    })
}

async fn list_processes_unix(request: &ConnectRequest) -> Result<Vec<RemoteProcess>, String> {
    let cmd = "ps -eo pid,user,pcpu,pmem,comm --no-headers 2>/dev/null | sort -k3 -rn | head -150";
    let output = remote_fs::exec_capture(request, cmd, false).await?;
    Ok(output
        .lines()
        .filter_map(parse_process_line_unix)
        .collect())
}

async fn list_processes_windows(request: &ConnectRequest) -> Result<Vec<RemoteProcess>, String> {
    let cmd = r#"powershell -NoProfile -NoLogo -NonInteractive -Command "& { Get-Process | Sort-Object CPU -Descending | Select-Object -First 150 | ForEach-Object { $cpu = if ($_.CPU) { [math]::Round($_.CPU,1) } else { 0 }; $ws = $_.WorkingSet64; Write-Output ($_.Id.ToString() + [char]9 + $cpu + [char]9 + $ws + [char]9 + $_.ProcessName) } }""#;
    let output = remote_fs::exec_capture(request, cmd, false).await?;
    let mut out = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 4 {
            continue;
        }
        let pid: u32 = parts[0].parse().unwrap_or(0);
        if pid == 0 {
            continue;
        }
        out.push(RemoteProcess {
            pid,
            user: None,
            cpu_percent: parse_f64(parts[1]),
            mem_percent: 0.0,
            mem_bytes: parts[2].parse().ok(),
            command: parts[3].to_string(),
        });
    }
    Ok(out)
}

pub async fn list_processes(request: ConnectRequest) -> Result<Vec<RemoteProcess>, String> {
    ensure_ssh(&request)?;
    let platform = remote_fs::detect_platform_public(&request).await;
    match platform {
        remote_fs::RemotePlatform::Windows => list_processes_windows(&request).await,
        remote_fs::RemotePlatform::Unix => list_processes_unix(&request).await,
    }
}

pub async fn kill_process(
    request: ConnectRequest,
    pid: u32,
    force: bool,
) -> Result<(), String> {
    ensure_ssh(&request)?;
    if pid == 0 {
        return Err("无效的进程 ID".to_string());
    }
    let platform = remote_fs::detect_platform_public(&request).await;
    match platform {
        remote_fs::RemotePlatform::Windows => {
            let flag = if force { " -Force" } else { "" };
            let cmd = format!(
                "powershell -NoProfile -NoLogo -NonInteractive -Command \"Stop-Process -Id {pid}{flag} -ErrorAction Stop\""
            );
            remote_fs::exec_capture(&request, &cmd, false).await?;
        }
        remote_fs::RemotePlatform::Unix => {
            let sig = if force { "-9" } else { "-15" };
            let cmd = format!("kill {sig} {pid} 2>/dev/null || kill -9 {pid}");
            remote_fs::exec_capture(&request, &cmd, false).await?;
        }
    }
    Ok(())
}

fn parse_local_addr_port(local: &str) -> Option<(String, u16)> {
    let local = local.trim();
    if local.is_empty() || local == "*" {
        return Some(("*".to_string(), 0));
    }
    if local.starts_with('[') {
        let end = local.find("]:")?;
        let addr = local[1..end].to_string();
        let port: u16 = local.get(end + 2..)?.parse().ok()?;
        return Some((addr, port));
    }
    let (addr, port_str) = local.rsplit_once(':')?;
    let port: u16 = port_str.parse().ok()?;
    Some((addr.to_string(), port))
}

fn extract_pid_from_ss_line(line: &str) -> u32 {
    if let Some(idx) = line.find("pid=") {
        let rest = &line[idx + 4..];
        rest.chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse()
            .unwrap_or(0)
    } else {
        0
    }
}

fn parse_ss_line(line: &str, protocol: &str) -> Option<RemotePort> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let mut parts = line.split_whitespace();
    parts.next()?; // state
    parts.next()?; // recv-q
    parts.next()?; // send-q
    let local = parts.next()?;
    let (address, port) = parse_local_addr_port(local)?;
    if port == 0 {
        return None;
    }
    let pid = extract_pid_from_ss_line(line);
    Some(RemotePort {
        pid,
        port,
        protocol: protocol.to_string(),
        address,
        command: None,
    })
}

fn parse_lsof_line(line: &str) -> Option<RemotePort> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let mut parts = line.split_whitespace();
    let command = parts.next().map(|s| s.to_string());
    let pid: u32 = parts.next()?.parse().ok()?;
    parts.next()?; // user
    parts.next()?; // fd
    let proto = parts.next()?.to_lowercase();
    parts.next()?; // device
    parts.next()?; // size/off
    parts.next()?; // node
    let name = parts.next()?;
    let protocol = if proto.contains("udp") {
        "udp"
    } else {
        "tcp"
    };
    let addr_port = name.rsplit_once(':')?;
    let port: u16 = addr_port.1.parse().ok()?;
    let address = addr_port.0.trim_start_matches('*');
    Some(RemotePort {
        pid,
        port,
        protocol: protocol.to_string(),
        address: if address.is_empty() {
            "*".to_string()
        } else {
            address.to_string()
        },
        command,
    })
}

async fn list_ports_unix(request: &ConnectRequest) -> Result<Vec<RemotePort>, String> {
    let mut ports = Vec::new();
    if let Ok(tcp) = remote_fs::exec_capture(request, "ss -H -tlnp 2>/dev/null", false).await {
        for line in tcp.lines() {
            if let Some(p) = parse_ss_line(line, "tcp") {
                ports.push(p);
            }
        }
    }
    if ports.is_empty() {
        if let Ok(udp) = remote_fs::exec_capture(request, "ss -H -ulnp 2>/dev/null", false).await {
            for line in udp.lines() {
                if let Some(p) = parse_ss_line(line, "udp") {
                    ports.push(p);
                }
            }
        }
    } else if let Ok(udp) = remote_fs::exec_capture(request, "ss -H -ulnp 2>/dev/null", false).await {
        for line in udp.lines() {
            if let Some(p) = parse_ss_line(line, "udp") {
                ports.push(p);
            }
        }
    }

    if !ports.is_empty() {
        ports.sort_by_key(|p| p.port);
        ports.dedup_by(|a, b| {
            a.port == b.port && a.protocol == b.protocol && a.address == b.address
        });
        return Ok(ports.into_iter().take(500).collect());
    }

    let lsof_cmd = "lsof -nP -iTCP -sTCP:LISTEN -iUDP 2>/dev/null | tail -n +2 | head -500";
    let output = remote_fs::exec_capture(request, lsof_cmd, false).await?;
    Ok(output.lines().filter_map(parse_lsof_line).collect())
}

async fn list_ports_windows(request: &ConnectRequest) -> Result<Vec<RemotePort>, String> {
    let cmd = r#"powershell -NoProfile -NoLogo -NonInteractive -Command "& { Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object -First 300 | ForEach-Object { Write-Output ($_.OwningProcess.ToString() + [char]9 + $_.LocalPort.ToString() + [char]9 + $_.LocalAddress) } }""#;
    let output = remote_fs::exec_capture(request, cmd, false).await?;
    let mut out = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let pid: u32 = parts[0].parse().unwrap_or(0);
        let port: u16 = parts[1].parse().unwrap_or(0);
        if port == 0 {
            continue;
        }
        out.push(RemotePort {
            pid,
            port,
            protocol: "tcp".to_string(),
            address: parts[2].to_string(),
            command: None,
        });
    }
    Ok(out)
}

pub async fn kill_port(
    request: ConnectRequest,
    port: u16,
    protocol: &str,
) -> Result<(), String> {
    ensure_ssh(&request)?;
    if port == 0 {
        return Err("无效的端口号".to_string());
    }
    let platform = remote_fs::detect_platform_public(&request).await;
    match platform {
        remote_fs::RemotePlatform::Windows => {
            let cmd = format!(
                r#"powershell -NoProfile -NoLogo -NonInteractive -Command "& {{ Get-NetTCPConnection -LocalPort {port} -ErrorAction SilentlyContinue | ForEach-Object {{ Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }} }}"#
            );
            remote_fs::exec_capture(&request, &cmd, false).await?;
        }
        remote_fs::RemotePlatform::Unix => {
            let proto = if protocol.eq_ignore_ascii_case("udp") {
                "udp"
            } else {
                "tcp"
            };
            let cmd = format!(
                "fuser -k {port}/{proto} 2>/dev/null || lsof -ti {proto}:{port} 2>/dev/null | while read pid; do kill -15 \"$pid\" 2>/dev/null; done"
            );
            remote_fs::exec_capture(&request, &cmd, false).await?;
        }
    }
    Ok(())
}

pub async fn list_ports(request: ConnectRequest) -> Result<Vec<RemotePort>, String> {
    ensure_ssh(&request)?;
    let platform = remote_fs::detect_platform_public(&request).await;
    match platform {
        remote_fs::RemotePlatform::Windows => list_ports_windows(&request).await,
        remote_fs::RemotePlatform::Unix => list_ports_unix(&request).await,
    }
}
