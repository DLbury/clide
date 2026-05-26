/** Claude Code 返回的会话 ID 已失效（被清理或换了工作目录） */
export function isStaleClaudeSessionError(text: string): boolean {
  const t = text.toLowerCase()
  return (
    t.includes('no conversation found') ||
    t.includes('conversation not found') ||
    t.includes('invalid session')
  )
}
