/** 按 terminalSessionId 聚焦已挂载的 xterm（分屏 Shell 切换时使用） */

const focusHandlers = new Map<string, () => void>()

export function registerTerminalFocusHandler(
  sessionId: string,
  focus: () => void
): () => void {
  focusHandlers.set(sessionId, focus)
  return () => {
    if (focusHandlers.get(sessionId) === focus) {
      focusHandlers.delete(sessionId)
    }
  }
}

export function focusTerminalBySessionId(sessionId: string): boolean {
  const focus = focusHandlers.get(sessionId)
  if (!focus) return false
  focus()
  return true
}

export function isAnyXtermFocused(): boolean {
  const el = document.activeElement
  if (!el) return false
  return (
    el.classList.contains('xterm-helper-textarea') ||
    el.closest('.xterm') != null
  )
}
