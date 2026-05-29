/** 从助手回复中提取可执行的 Shell 命令（用于自动执行回退） */
export function extractShellCommands(text: string): string[] {
  const commands: string[] = []
  const seen = new Set<string>()

  const add = (raw: string) => {
    const line = raw.trim().replace(/^\$\s+/, '')
    if (!line || line.startsWith('#') || seen.has(line)) return
    seen.add(line)
    commands.push(line)
  }

  for (const match of text.matchAll(/```(?:bash|sh|shell|zsh)?\s*\n([\s\S]*?)```/gi)) {
    for (const line of match[1].split('\n')) add(line)
  }

  for (const line of text.split('\n')) {
    if (/^\$\s+\S/.test(line.trim())) add(line)
  }

  return commands.slice(0, 5)
}

/** 模型未调 MCP/IDE 工具却声称无法执行时 */
export function isRemoteConnectionRefusal(text: string): boolean {
  return /无法直接连接|不能直连|无法连接(?:到)?(?:该|此)?服务器|MCP\s*工具.*受限|无法远程执行|cannot connect directly|mcp.*(?:restricted|unavailable)/i.test(
    text
  )
}

export function buildIdeToolDirective(input: {
  activeProfileId?: string
  activeSessionHost?: string
  bridgeConnected?: boolean
  terminalConnected?: boolean
}): string {
  if (!input.bridgeConnected) {
    return `

[AI Terminal] IDE 桥接未就绪：请确认 Clide 已启动、AI 已启用，且侧栏显示「IDE 桥接 · 已就绪」。未就绪时不要使用本机 Bash，也不要声称无法远程执行。`
  }

  if (!input.terminalConnected) {
    const pid = input.activeProfileId
    return `

[AI Terminal] 桥接已连接，但 SSH 终端尚未连接。必须先调用 MCP connectServer${pid ? `(profileId="${pid}")` : ''}，成功后再 runShellCommand。禁止回复「无法直接连接」并只粘贴 bash 命令块。`
  }

  const host = input.activeSessionHost ?? '未知'
  const pid = input.activeProfileId
  if (!pid) {
    return `

[AI Terminal] 桥接已连接。远程命令必须调用 MCP 工具 mcp__aiterm__runShellCommand（不要用 Skill、不要用 Bash）：先 mcp__aiterm__getFocusedServer 取 profileId（注意：profileId 不是服务器名字、不是 host、不是 shellId），再执行；禁止只写步骤。`
  }
  return `

[AI Terminal] 当前焦点: ${host}，profileId="${pid}"，终端已连接。必须调用 MCP 工具 mcp__aiterm__runShellCommand（禁止 Skill/Bash），profileId="${pid}"，用工具返回的 output 作答。`
}
