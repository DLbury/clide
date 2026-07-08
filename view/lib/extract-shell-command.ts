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

export interface ConnectedServerBrief {
  profileId: string
  name: string
  host: string
  terminalConnected: boolean
  isFocused: boolean
}

export function buildIdeToolDirective(input: {
  activeProfileId?: string
  activeSessionHost?: string
  bridgeConnected?: boolean
  terminalConnected?: boolean
  connections?: ConnectedServerBrief[]
}): string {
  if (!input.bridgeConnected) {
    return `

[Clide] IDE 桥接未就绪。侧栏显示「IDE 桥接 · 已就绪」后，方可通过 MCP 服务器 \`aiterm\` 操作远程 PTY。`
  }

  const connections = input.connections ?? []
  const connectedCount = connections.filter(c => c.terminalConnected).length

  const connectionList =
    connections.length > 0
      ? connections
          .map(c => {
            const flags = [
              c.terminalConnected ? '终端已连接' : '终端未连接',
              c.isFocused ? 'UI 焦点' : null,
            ]
              .filter(Boolean)
              .join(' · ')
            return `- profileId="${c.profileId}" · ${c.name} · ${c.host} · ${flags}`
          })
          .join('\n')
      : ''

  const contextBlock = connectionList
    ? `

[Clide] 当前打开的连接：
${connectionList}`
    : ''

  const multiHint =
    connectedCount > 1
      ? `

[Clide] 多连接：${connectedCount} 个终端已连接。runShellCommand 需指定目标 profileId（来自 listActiveConnections / listServerProfiles；不要用 host、显示名或 shellId 代替）。跨服务器操作不会切换 UI 焦点；终端已连接时不要重复 connectServer。getFocusedServer 仅表示 UI 焦点。`
      : ''

  if (!input.terminalConnected && connectedCount === 0) {
    const pid = input.activeProfileId
    return `${contextBlock}${multiHint}

[Clide] 焦点连接${pid ? ` (profileId="${pid}")` : ''} 的 SSH 终端尚未连接。connectServer 可建立连接后再执行 Shell 命令。`
  }

  const pid = input.activeProfileId
  const host = input.activeSessionHost ?? '未知'
  const focusHint = pid
    ? connectedCount > 1
      ? `UI 焦点：${host}，profileId="${pid}"（其它服务器请用其 profileId）。`
      : `UI 焦点：${host}，profileId="${pid}"，终端已连接。`
    : '未检测到焦点连接；listActiveConnections 可列出当前标签。'

  return `${contextBlock}${multiHint}

[Clide] ${focusHint} 远程 Shell 操作走 MCP \`aiterm\` 工具（真实 PTY，与用户左侧终端相同）。`
}

/** 多连接时注入各终端最近输出；单连接时与旧行为一致 */
export function buildMultiTerminalContextPrefix(input: {
  connections: Array<{
    name: string
    host: string
    snippet?: string
  }>
}): string {
  const withSnippet = input.connections.filter(c => c.snippet?.trim())
  if (withSnippet.length === 0) return ''
  if (withSnippet.length === 1) {
    const c = withSnippet[0]
    return `当前会话: ${c.name} (${c.host})\n\n最近终端输出:\n\`\`\`\n${c.snippet}\n\`\`\`\n\n`
  }
  const blocks = withSnippet
    .map(
      c =>
        `### ${c.name} (${c.host})\n\`\`\`\n${c.snippet}\n\`\`\``
    )
    .join('\n\n')
  return `以下为多连接终端最近输出（按服务器分组）：\n\n${blocks}\n\n`
}
