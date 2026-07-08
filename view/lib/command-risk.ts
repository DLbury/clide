export type CommandRiskLevel = 'safe' | 'destructive' | 'critical'

export interface CommandRiskAssessment {
  level: CommandRiskLevel
  requiresApproval: boolean
  /** 面向用户的功能说明 */
  summary: string
  reasons: string[]
}

type RiskRule = {
  level: CommandRiskLevel
  summary: string
  reason: string
  test: (cmd: string, normalized: string) => boolean
}

const RULES: RiskRule[] = [
  {
    level: 'critical',
    summary: '递归强制删除文件或目录（通常不可恢复）',
    reason: '检测到 rm -rf / del /s / Remove-Item -Recurse 等递归删除',
    test: (_cmd, n) =>
      /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r|\brm\s+-rf\b|\brm\s+-fr\b/.test(n) ||
      /\bdel\s+\/f\s+\/s\b|\bdel\s+\/s\s+\/f\b/.test(n) ||
      /remove-item\s+.*(-recurse|-force)/i.test(n) ||
      /\brd\s+\/s\s+\/q\b/.test(n),
  },
  {
    level: 'critical',
    summary: '清空磁盘或覆写块设备（不可恢复）',
    reason: '检测到 dd / mkfs / format 等磁盘操作',
    test: (_cmd, n) =>
      /\bdd\s+if=/.test(n) ||
      /\bmkfs\b/.test(n) ||
      /\bformat\s+[a-z]:/i.test(n) ||
      /\bshred\b/.test(n) ||
      /\bwipefs\b/.test(n),
  },
  {
    level: 'critical',
    summary: '关机或重启系统',
    reason: '检测到 shutdown / reboot / poweroff 等',
    test: (_cmd, n) =>
      /\b(shutdown|reboot|poweroff|halt|init\s+0|init\s+6)\b/.test(n) ||
      /\bstop-computer\b/i.test(n) ||
      /\brestart-computer\b/i.test(n),
  },
  {
    level: 'critical',
    summary: '丢弃 Git 未提交更改或重写历史（难以恢复）',
    reason: '检测到 git reset --hard / git clean -fd 等',
    test: (_cmd, n) =>
      /\bgit\s+reset\s+--hard\b/.test(n) ||
      /\bgit\s+clean\s+-[a-z]*f/.test(n) ||
      /\bgit\s+push\s+--force\b/.test(n) ||
      /\bgit\s+branch\s+-[dD]\s/.test(n),
  },
  {
    level: 'critical',
    summary: '删除数据库或表（通常不可恢复）',
    reason: '检测到 DROP / TRUNCATE 等 SQL',
    test: (_cmd, n) =>
      /\bdrop\s+(database|table|schema)\b/i.test(n) ||
      /\btruncate\s+table\b/i.test(n),
  },
  {
    level: 'destructive',
    summary: '删除文件或目录',
    reason: '检测到 rm / del / unlink / Remove-Item 等',
    test: (_cmd, n) =>
      /\brm\b/.test(n) ||
      /\bdel\b/.test(n) ||
      /\bunlink\b/.test(n) ||
      /\bremove-item\b/i.test(n) ||
      /\brmdir\b/.test(n),
  },
  {
    level: 'destructive',
    summary: '强制终止进程',
    reason: '检测到 kill -9 / Stop-Process -Force 等',
    test: (_cmd, n) =>
      /\bkill\s+-9\b/.test(n) ||
      /\bkill\s+-KILL\b/.test(n) ||
      /\bstop-process\b.*-force/i.test(n) ||
      /\btaskkill\s+\/f\b/i.test(n),
  },
  {
    level: 'destructive',
    summary: '停止或禁用系统服务',
    reason: '检测到 systemctl stop/disable 等',
    test: (_cmd, n) =>
      /\bsystemctl\s+(stop|disable|mask)\b/.test(n) ||
      /\bservice\s+\S+\s+stop\b/.test(n),
  },
  {
    level: 'destructive',
    summary: '删除 Docker 容器或镜像',
    reason: '检测到 docker rm / docker rmi / docker system prune 等',
    test: (_cmd, n) =>
      /\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm)\b/.test(n) ||
      /\bdocker\s+compose\s+down\s+.*(-v|--volumes)/.test(n),
  },
  {
    level: 'destructive',
    summary: '覆盖写入文件（可能丢失原内容）',
    reason: '检测到重定向覆写或 tee 覆盖',
    test: (cmd, n) =>
      />\s*[^\s&|]+/.test(cmd) ||
      /\btee\s+/.test(n) ||
      /\bsp\s+.*\s+/.test(n),
  },
  {
    level: 'destructive',
    summary: '修改关键文件权限（安全风险）',
    reason: '检测到 chmod 777 / chown 等',
    test: (_cmd, n) =>
      /\bchmod\s+777\b/.test(n) ||
      /\bchmod\s+-R\s+777\b/.test(n) ||
      /\bchown\s+-R\s+root\b/.test(n),
  },
  {
    level: 'destructive',
    summary: '移动或重命名可能覆盖现有文件',
    reason: '检测到 mv / move / ren 等',
    test: (_cmd, n) =>
      /\bmv\b/.test(n) ||
      /\bmove-item\b/i.test(n) ||
      /\bren\b/.test(n) ||
      /\brename-item\b/i.test(n),
  },
]

function normalizeCommand(command: string): string {
  return command
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function assessCommandRisk(command: string): CommandRiskAssessment {
  const trimmed = command.trim()
  if (!trimmed) {
    return {
      level: 'safe',
      requiresApproval: false,
      summary: '空命令',
      reasons: [],
    }
  }

  const normalized = normalizeCommand(trimmed)
  const reasons: string[] = []
  let level: CommandRiskLevel = 'safe'
  let summary = '执行 Shell 命令'

  for (const rule of RULES) {
    if (!rule.test(trimmed, normalized)) continue
    reasons.push(rule.reason)
    if (rule.level === 'critical') {
      level = 'critical'
      summary = rule.summary
      break
    }
    // critical 分支已 break，走到这里 level 只可能是 safe/destructive
    if (rule.level === 'destructive') {
      level = 'destructive'
      summary = rule.summary
    }
  }

  return {
    level,
    requiresApproval: level === 'destructive' || level === 'critical',
    summary,
    reasons,
  }
}

export function shouldRequireCommandApproval(
  command: string,
  enabled: boolean
): CommandRiskAssessment & { requiresApproval: boolean } {
  const assessment = assessCommandRisk(command)
  if (!enabled) {
    return { ...assessment, requiresApproval: false }
  }
  return assessment
}

export type CommandApprovalSource = 'mcp' | 'fallback' | 'manual'

export function sourceLabel(source: CommandApprovalSource): string {
  switch (source) {
    case 'mcp':
      return 'AI 通过 MCP 工具'
    case 'fallback':
      return 'AI 回复文本自动执行（回退）'
    case 'manual':
      return '手动点击执行'
  }
}

export function assessDisconnectRisk(sessionLabel: string): CommandRiskAssessment {
  return {
    level: 'destructive',
    requiresApproval: true,
    summary: `断开与「${sessionLabel}」的终端连接`,
    reasons: ['AI 请求 disconnectServer，断开后需重新连接才能操作该服务器'],
  }
}
