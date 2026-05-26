/** 每个 Shell 标签对应的后端终端会话 ID（独立 PTY） */
export function makeTerminalSessionId(profileSessionId: string, shellId: string): string {
  return `${profileSessionId}::${shellId}`
}

export function parseTerminalSessionId(terminalSessionId: string): {
  profileSessionId: string
  shellId: string
} | null {
  const idx = terminalSessionId.indexOf('::')
  if (idx <= 0) return null
  return {
    profileSessionId: terminalSessionId.slice(0, idx),
    shellId: terminalSessionId.slice(idx + 2),
  }
}
