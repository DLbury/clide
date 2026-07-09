use super::{remote_fs, ConnectRequest};
use super::exec_pool::global_exec_pool;

const STATS_SCRIPT: &str = r#"LC_ALL=C
idle1=$(awk '/^cpu / {print $5+$6}' /proc/stat)
total1=$(awk '/^cpu / {idle=$5+$6; print $2+$3+$4+idle+$7+$8+$9}' /proc/stat)
sleep 1
idle2=$(awk '/^cpu / {print $5+$6}' /proc/stat)
total2=$(awk '/^cpu / {idle=$5+$6; print $2+$3+$4+idle+$7+$8+$9}' /proc/stat)
delta_total=$((total2 - total1))
delta_idle=$((idle2 - idle1))
if [ "$delta_total" -gt 0 ]; then
  cpu_pct=$(awk "BEGIN {printf \"%.1f\", 100.0 * ($delta_total - $delta_idle) / $delta_total}")
else
  cpu_pct=0
fi
mem_total_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
mem_avail_kb=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)
mem_used_kb=$((mem_total_kb - mem_avail_kb))
read -r _ disk_total disk_used _ _ _ _ <<< "$(df -P -B1 / 2>/dev/null | tail -1)"
disk_read1=$(awk '/^sda / {print $6}' /proc/diskstats 2>/dev/null || awk 'NR>2 {print $6; exit}' /proc/diskstats 2>/dev/null)
disk_write1=$(awk '/^sda / {print $10}' /proc/diskstats 2>/dev/null || awk 'NR>2 {print $10; exit}' /proc/diskstats 2>/dev/null)
net_rx1=$(awk 'NR>2 && $1!="lo:" {gsub(":","",$1); rx+=$2} END{print rx+0}' /proc/net/dev)
net_tx1=$(awk 'NR>2 && $1!="lo:" {gsub(":","",$1); tx+=$10} END{print tx+0}' /proc/net/dev)
sleep 1
disk_read2=$(awk '/^sda / {print $6}' /proc/diskstats 2>/dev/null || awk 'NR>2 {print $6; exit}' /proc/diskstats 2>/dev/null)
disk_write2=$(awk '/^sda / {print $10}' /proc/diskstats 2>/dev/null || awk 'NR>2 {print $10; exit}' /proc/diskstats 2>/dev/null)
net_rx2=$(awk 'NR>2 && $1!="lo:" {gsub(":","",$1); rx+=$2} END{print rx+0}' /proc/net/dev)
net_tx2=$(awk 'NR>2 && $1!="lo:" {gsub(":","",$1); tx+=$10} END{print tx+0}' /proc/net/dev)
disk_read_bps=$(( (disk_read2 - disk_read1) * 512 ))
disk_write_bps=$(( (disk_write2 - disk_write1) * 512 ))
net_rx_bps=$(( net_rx2 - net_rx1 ))
net_tx_bps=$(( net_tx2 - net_tx1 ))
if [ "$disk_read_bps" -lt 0 ]; then disk_read_bps=0; fi
if [ "$disk_write_bps" -lt 0 ]; then disk_write_bps=0; fi
if [ "$net_rx_bps" -lt 0 ]; then net_rx_bps=0; fi
if [ "$net_tx_bps" -lt 0 ]; then net_tx_bps=0; fi
echo "CPU_PCT=$cpu_pct"
echo "MEM_TOTAL=$((mem_total_kb * 1024))"
echo "MEM_USED=$((mem_used_kb * 1024))"
echo "DISK_TOTAL=${disk_total:-0}"
echo "DISK_USED=${disk_used:-0}"
echo "DISK_READ_BPS=$disk_read_bps"
echo "DISK_WRITE_BPS=$disk_write_bps"
echo "NET_RX_BPS=$net_rx_bps"
echo "NET_TX_BPS=$net_tx_bps"
if command -v nvidia-smi >/dev/null 2>&1; then
  gpu_line=$(nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null | head -1)
  if [ -n "$gpu_line" ]; then
    gpu_pct=$(echo "$gpu_line" | cut -d, -f1 | tr -d ' ')
    gpu_used=$(echo "$gpu_line" | cut -d, -f2 | tr -d ' ')
    gpu_total=$(echo "$gpu_line" | cut -d, -f3 | tr -d ' ')
    if [ -n "$gpu_pct" ]; then
      echo "GPU_PCT=$gpu_pct"
    fi
    if [ -n "$gpu_used" ] && [ -n "$gpu_total" ]; then
      echo "GPU_MEM_USED=$((gpu_used * 1048576))"
      echo "GPU_MEM_TOTAL=$((gpu_total * 1048576))"
    fi
  fi
fi
exit 0
"#;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHostStats {
    pub cpu_percent: f64,
    pub mem_total_bytes: u64,
    pub mem_used_bytes: u64,
    pub disk_total_bytes: u64,
    pub disk_used_bytes: u64,
    pub gpu_mem_total_bytes: Option<u64>,
    pub gpu_mem_used_bytes: Option<u64>,
    pub gpu_percent: Option<f64>,
    pub disk_read_bps: Option<u64>,
    pub disk_write_bps: Option<u64>,
    pub net_rx_bps: Option<u64>,
    pub net_tx_bps: Option<u64>,
}

fn ensure_ssh(request: &ConnectRequest) -> Result<(), String> {
    if request.session_type != "ssh" {
        return Err("主机监控仅支持 SSH 会话".to_string());
    }
    Ok(())
}

fn parse_u64(value: &str, field: &str) -> Result<u64, String> {
    value
        .trim()
        .trim_matches(|c: char| !c.is_ascii_digit())
        .parse::<u64>()
        .map_err(|_| format!("无法解析 {field}: {value}"))
}

const STAT_KEYS: &[&str] = &[
    "CPU_PCT",
    "MEM_TOTAL",
    "MEM_USED",
    "DISK_TOTAL",
    "DISK_USED",
    "DISK_READ_BPS",
    "DISK_WRITE_BPS",
    "NET_RX_BPS",
    "NET_TX_BPS",
    "GPU_PCT",
    "GPU_MEM_USED",
    "GPU_MEM_TOTAL",
];

/// Normalize CRLF / glued stdout (some SSH hosts emit `\r` without `\n`).
fn normalize_stats_blob(output: &str) -> String {
    output
        .replace('\r', "\n")
        .replace("DISK_USED-", "DISK_USED=")
}

fn extract_stat_pairs(output: &str) -> Vec<(String, String)> {
    let normalized = normalize_stats_blob(output);
    let mut hits: Vec<(usize, &str)> = Vec::new();
    for key in STAT_KEYS {
        let needle = format!("{key}=");
        let mut start = 0usize;
        while let Some(pos) = normalized[start..].find(&needle) {
            let abs = start + pos;
            hits.push((abs, key));
            start = abs + needle.len();
        }
    }
    hits.sort_by_key(|(pos, _)| *pos);
    hits.dedup_by_key(|(pos, _)| *pos);

    let mut pairs = Vec::new();
    for (idx, (pos, key)) in hits.iter().enumerate() {
        let value_start = pos + key.len() + 1;
        let value_end = hits
            .get(idx + 1)
            .map(|(next_pos, _)| *next_pos)
            .unwrap_or(normalized.len());
        let value = normalized[value_start..value_end]
            .trim()
            .trim_end_matches(|c: char| c == '=' || c == '-' || c.is_whitespace());
        pairs.push(((*key).to_string(), value.to_string()));
    }
    pairs
}

fn parse_stats_output(output: &str) -> Result<RemoteHostStats, String> {
    let mut cpu_percent = None;
    let mut mem_total_bytes = None;
    let mut mem_used_bytes = None;
    let mut disk_total_bytes = None;
    let mut disk_used_bytes = None;
    let mut gpu_mem_total_bytes = None;
    let mut gpu_mem_used_bytes = None;
    let mut gpu_percent = None;
    let mut disk_read_bps = None;
    let mut disk_write_bps = None;
    let mut net_rx_bps = None;
    let mut net_tx_bps = None;

    for (key, value) in extract_stat_pairs(output) {
        ingest_key(
            &key,
            &value,
            &mut cpu_percent,
            &mut mem_total_bytes,
            &mut mem_used_bytes,
            &mut disk_total_bytes,
            &mut disk_used_bytes,
            &mut gpu_mem_total_bytes,
            &mut gpu_mem_used_bytes,
            &mut gpu_percent,
            &mut disk_read_bps,
            &mut disk_write_bps,
            &mut net_rx_bps,
            &mut net_tx_bps,
        )?;
    }

    Ok(RemoteHostStats {
        cpu_percent: cpu_percent.ok_or_else(|| "缺少 CPU 使用率".to_string())?,
        mem_total_bytes: mem_total_bytes.ok_or_else(|| "缺少内存总量".to_string())?,
        mem_used_bytes: mem_used_bytes.ok_or_else(|| "缺少内存已用".to_string())?,
        disk_total_bytes: disk_total_bytes.ok_or_else(|| "缺少磁盘总量".to_string())?,
        disk_used_bytes: disk_used_bytes.ok_or_else(|| "缺少磁盘已用".to_string())?,
        gpu_mem_total_bytes,
        gpu_mem_used_bytes,
        gpu_percent,
        disk_read_bps,
        disk_write_bps,
        net_rx_bps,
        net_tx_bps,
    })
}

#[allow(clippy::too_many_arguments)]
fn ingest_key(
    key: &str,
    value: &str,
    cpu_percent: &mut Option<f64>,
    mem_total_bytes: &mut Option<u64>,
    mem_used_bytes: &mut Option<u64>,
    disk_total_bytes: &mut Option<u64>,
    disk_used_bytes: &mut Option<u64>,
    gpu_mem_total_bytes: &mut Option<u64>,
    gpu_mem_used_bytes: &mut Option<u64>,
    gpu_percent: &mut Option<f64>,
    disk_read_bps: &mut Option<u64>,
    disk_write_bps: &mut Option<u64>,
    net_rx_bps: &mut Option<u64>,
    net_tx_bps: &mut Option<u64>,
) -> Result<(), String> {
    match key {
        "CPU_PCT" => {
            *cpu_percent = Some(
                value
                    .trim()
                    .parse::<f64>()
                    .map_err(|_| format!("无法解析 CPU 使用率: {value}"))?,
            );
        }
        "MEM_TOTAL" => *mem_total_bytes = Some(parse_u64(value, "内存总量")?),
        "MEM_USED" => *mem_used_bytes = Some(parse_u64(value, "内存已用")?),
        "DISK_TOTAL" => *disk_total_bytes = Some(parse_u64(value, "磁盘总量")?),
        "DISK_USED" => *disk_used_bytes = Some(parse_u64(value, "磁盘已用")?),
        "GPU_MEM_TOTAL" => *gpu_mem_total_bytes = Some(parse_u64(value, "显存总量")?),
        "GPU_MEM_USED" => *gpu_mem_used_bytes = Some(parse_u64(value, "显存已用")?),
        "GPU_PCT" => {
            *gpu_percent = Some(
                value
                    .trim()
                    .parse::<f64>()
                    .map_err(|_| format!("无法解析 GPU 使用率: {value}"))?,
            );
        }
        "DISK_READ_BPS" => *disk_read_bps = Some(parse_u64(value, "磁盘读速率")?),
        "DISK_WRITE_BPS" => *disk_write_bps = Some(parse_u64(value, "磁盘写速率")?),
        "NET_RX_BPS" => *net_rx_bps = Some(parse_u64(value, "网络接收速率")?),
        "NET_TX_BPS" => *net_tx_bps = Some(parse_u64(value, "网络发送速率")?),
        _ => {}
    }
    Ok(())
}

pub async fn get_host_stats(request: ConnectRequest) -> Result<RemoteHostStats, String> {
    ensure_ssh(&request)?;
    if global_exec_pool().get_platform(&request).await.is_windows() {
        return Err("远程资源监控暂不支持 Windows SSH 主机".into());
    }
    let uname = remote_fs::exec_capture(&request, "uname -s 2>/dev/null || echo Unknown", false)
        .await
        .unwrap_or_default();
    if uname.trim().eq_ignore_ascii_case("Darwin") {
        return Err("远程资源监控暂不支持 macOS SSH 主机（依赖 Linux /proc）".into());
    }
    let cmd = format!("bash -s <<'__CLIDE_STATS__'\n{STATS_SCRIPT}\n__CLIDE_STATS__");
    let output = match remote_fs::exec_capture(&request, &cmd, false).await {
        Ok(out) => out,
        Err(err) => {
            // Some hosts return non-zero exit while still printing metrics on stdout.
            if err.contains("CPU_PCT=") || err.contains("MEM_TOTAL=") {
                err
            } else {
                return Err(err);
            }
        }
    };
    parse_stats_output(&output)
}

#[cfg(test)]
mod tests {
    use super::parse_stats_output;

    #[test]
    fn parses_glued_crlf_stats_blob() {
        let raw = "CPU_PCT=0.2 MEM_TOTAL=128526344192 MEM_USED=118732886016DISK_TOTAL=4030802149376 DISK_USED-1806357651456 DISK_READ_BPS=0DISK_WRITE_BPS=0 NET_RX_BPS=422 NET_TX_BPS=325 GPU_PCT=0";
        let stats = parse_stats_output(raw).expect("should parse glued output");
        assert!((stats.cpu_percent - 0.2).abs() < f64::EPSILON);
        assert_eq!(stats.mem_total_bytes, 128_526_344_192);
        assert_eq!(stats.mem_used_bytes, 118_732_886_016);
        assert_eq!(stats.disk_total_bytes, 4_030_802_149_376);
        assert_eq!(stats.disk_used_bytes, 1_806_357_651_456);
        assert_eq!(stats.net_rx_bps, Some(422));
        assert_eq!(stats.net_tx_bps, Some(325));
    }
}
