use std::net::IpAddr;

const INTERNAL_DOMAIN_SUFFIXES: &[&str] = &[
    ".local",
    ".internal",
    ".intranet",
    ".lan",
    ".corp",
    ".home",
    ".private",
    ".localdomain",
    ".localhost",
];

/// 浏览器仅允许访问内网 IP 与内网域名。
pub fn validate_browser_url(url: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(url).map_err(|e| format!("URL 无效: {e}"))?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err("浏览器仅支持 http/https 协议".to_string());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "URL 缺少主机名".to_string())?;
    validate_browser_host(host)
}

pub fn validate_browser_host(host: &str) -> Result<(), String> {
    let host = host.trim().trim_end_matches('.');
    if host.is_empty() {
        return Err("主机名为空".to_string());
    }

    let bare = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);

    if let Ok(ip) = bare.parse::<IpAddr>() {
        if is_internal_ip(ip) {
            return Ok(());
        }
        return Err(format!(
            "浏览器仅允许访问内网地址，禁止访问公网 IP: {host}"
        ));
    }

    let lower = bare.to_ascii_lowercase();
    if lower == "localhost" {
        return Ok(());
    }

    // 无点主机名视为内网短名（如 nginx、db01）
    if !lower.contains('.') {
        return Ok(());
    }

    for suffix in INTERNAL_DOMAIN_SUFFIXES {
        if lower.ends_with(suffix) || lower == suffix.trim_start_matches('.') {
            return Ok(());
        }
    }

    Err(format!(
        "浏览器仅允许访问内网地址和内网域名（如 *.local、*.internal、*.lan 或无点短名），禁止访问: {host}"
    ))
}

fn is_internal_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || is_cgnat_v4(v4)
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || is_ula_v6(v6)
                || is_link_local_v6(v6)
        }
    }
}

fn is_cgnat_v4(ip: std::net::Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 100 && (o[1] & 0xC0) == 64
}

fn is_ula_v6(ip: std::net::Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xfe00) == 0xfc00
}

fn is_link_local_v6(ip: std::net::Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xffc0) == 0xfe80
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_private_ipv4() {
        assert!(validate_browser_host("192.168.1.10").is_ok());
        assert!(validate_browser_host("10.0.0.5").is_ok());
        assert!(validate_browser_host("127.0.0.1").is_ok());
    }

    #[test]
    fn blocks_public_ipv4() {
        assert!(validate_browser_host("8.8.8.8").is_err());
        assert!(validate_browser_host("1.1.1.1").is_err());
    }

    #[test]
    fn allows_internal_domains() {
        assert!(validate_browser_host("svc.cluster.local").is_ok());
        assert!(validate_browser_host("app.internal").is_ok());
        assert!(validate_browser_host("nginx").is_ok());
    }

    #[test]
    fn blocks_public_domains() {
        assert!(validate_browser_host("google.com").is_err());
        assert!(validate_browser_host("baidu.com").is_err());
    }
}
