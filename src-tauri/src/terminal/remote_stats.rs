use super::{ConnectRequest, remote_fs};

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
echo "CPU_PCT=$cpu_pct"
echo "MEM_TOTAL=$((mem_total_kb * 1024))"
echo "MEM_USED=$((mem_used_kb * 1024))"
echo "DISK_TOTAL=${disk_total:-0}"
echo "DISK_USED=${disk_used:-0}"
if command -v nvidia-smi >/dev/null 2>&1; then
  gpu_line=$(nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null | head -1)
  if [ -n "$gpu_line" ]; then
    gpu_used=$(echo "$gpu_line" | cut -d, -f1 | tr -d ' ')
    gpu_total=$(echo "$gpu_line" | cut -d, -f2 | tr -d ' ')
    if [ -n "$gpu_used" ] && [ -n "$gpu_total" ]; then
      echo "GPU_MEM_USED=$((gpu_used * 1048576))"
      echo "GPU_MEM_TOTAL=$((gpu_total * 1048576))"
    fi
  fi
fi
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
        .parse::<u64>()
        .map_err(|_| format!("无法解析 {field}: {value}"))
}

fn parse_stats_output(output: &str) -> Result<RemoteHostStats, String> {
    let mut cpu_percent = None;
    let mut mem_total_bytes = None;
    let mut mem_used_bytes = None;
    let mut disk_total_bytes = None;
    let mut disk_used_bytes = None;
    let mut gpu_mem_total_bytes = None;
    let mut gpu_mem_used_bytes = None;

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key {
            "CPU_PCT" => {
                cpu_percent = Some(
                    value
                        .trim()
                        .parse::<f64>()
                        .map_err(|_| format!("无法解析 CPU 使用率: {value}"))?,
                );
            }
            "MEM_TOTAL" => mem_total_bytes = Some(parse_u64(value, "内存总量")?),
            "MEM_USED" => mem_used_bytes = Some(parse_u64(value, "内存已用")?),
            "DISK_TOTAL" => disk_total_bytes = Some(parse_u64(value, "磁盘总量")?),
            "DISK_USED" => disk_used_bytes = Some(parse_u64(value, "磁盘已用")?),
            "GPU_MEM_TOTAL" => gpu_mem_total_bytes = Some(parse_u64(value, "显存总量")?),
            "GPU_MEM_USED" => gpu_mem_used_bytes = Some(parse_u64(value, "显存已用")?),
            _ => {}
        }
    }

    Ok(RemoteHostStats {
        cpu_percent: cpu_percent.ok_or_else(|| "缺少 CPU 使用率".to_string())?,
        mem_total_bytes: mem_total_bytes.ok_or_else(|| "缺少内存总量".to_string())?,
        mem_used_bytes: mem_used_bytes.ok_or_else(|| "缺少内存已用".to_string())?,
        disk_total_bytes: disk_total_bytes.ok_or_else(|| "缺少磁盘总量".to_string())?,
        disk_used_bytes: disk_used_bytes.ok_or_else(|| "缺少磁盘已用".to_string())?,
        gpu_mem_total_bytes,
        gpu_mem_used_bytes,
    })
}

pub async fn get_host_stats(request: ConnectRequest) -> Result<RemoteHostStats, String> {
    ensure_ssh(&request)?;
    let cmd = format!("bash -s <<'__CLIDE_STATS__'\n{STATS_SCRIPT}\n__CLIDE_STATS__");
    let output = remote_fs::exec_capture(&request, &cmd, false).await?;
    parse_stats_output(&output)
}
