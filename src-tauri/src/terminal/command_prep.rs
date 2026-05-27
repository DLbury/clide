/// 将 AI 命令适配到目标 PTY。Windows 本地默认已是 PowerShell PTY，直接透传即可保留 `$` 等语法。
pub fn prepare_command_for_pty(command: &str, session_type: &str) -> String {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return command.to_string();
    }

    #[cfg(windows)]
    {
        if session_type == "local" {
            // PTY 为 powershell.exe；若命令已显式调用 cmd/powershell 则原样发送
            let lower = trimmed.to_ascii_lowercase();
            if lower.starts_with("cmd ")
                || lower.starts_with("cmd.exe")
                || lower.starts_with("powershell")
                || lower.starts_with("pwsh")
            {
                return command.to_string();
            }
            return trimmed.to_string();
        }
    }

    command.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn preserves_powershell_dollar_vars_for_local_pty() {
        let cmd = "Get-WmiObject Win32_LogicalDisk | Select-Object @{N='S';E={$_.Size}}";
        let out = prepare_command_for_pty(cmd, "local");
        assert!(out.contains("$_.Size"));
        assert!(!out.contains("powershell -NoProfile"));
    }
}
