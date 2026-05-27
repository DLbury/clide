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

[AI Terminal] IDE 桥接未就绪：请确认 npm run dev:tauri 已启动，且 AI 侧栏显示「已连接」（不仅是「启动中」）。`
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

[AI Terminal] 桥接已连接。远程命令必须调用 IDE 工具 runShellCommand（不要用 mcp__aiterm__ 前缀）：先 getFocusedServer 取 profileId（注意：profileId 不是服务器名字、不是 host、不是 shellId），再执行；禁止只写步骤，禁止本机 Bash。`
  }
  return `

[AI Terminal] 当前焦点: ${host}，profileId="${pid}"，终端已连接。必须调用 IDE 工具 runShellCommand，profileId="${pid}"（不要改成会话名/host/shellId），用工具返回的 output 作答。禁止说「无法直接连接」、禁止只给 bash 代码块、禁止本机 Bash。`
}
