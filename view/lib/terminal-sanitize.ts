/** 清理 PTY/SSH 输出中的 ANSI 控制序列，便于在简易终端 UI 中显示 */
export function sanitizeTerminalOutput(text: string): string {
  return (
    text
      .replace(/\x1b\[[0-9:;<=>?]*[!-~]/g, '')
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
      .replace(/\x1b[^[\]]/g, '')
      .replace(/\r(?!\n)/g, '\n')
      .replace(/\x08+/g, '')
  )
}

export function appendSanitizedOutput(current: string, chunk: string): string {
  return current + sanitizeTerminalOutput(chunk)
}
