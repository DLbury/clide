/**
 * 将 MCP/AI 命令经左侧 xterm 所在标签写入（与手动输入同路径），
 * 而不是仅调用后端 terminal_write 而 xterm 无感知。
 */
import { writeTerminal } from '@/lib/terminal-client'
import { requestTerminalResync } from '@/lib/terminal-stream'

export type TerminalInputHandler = (data: string) => Promise<void>

const handlers = new Map<string, TerminalInputHandler>()

export function registerTerminalInputHandler(
  sessionId: string,
  handler: TerminalInputHandler
): () => void {
  handlers.set(sessionId, handler)
  return () => {
    if (handlers.get(sessionId) === handler) {
      handlers.delete(sessionId)
    }
  }
}

export function hasTerminalInputHandler(sessionId: string): boolean {
  return handlers.has(sessionId)
}

/** 优先走已挂载的 LiveTerminal；否则回退到 invoke terminal_write */
export async function submitTerminalInput(sessionId: string, data: string): Promise<void> {
  const handler = handlers.get(sessionId)
  if (handler) {
    console.log(`[TerminalInput] Using registered handler for ${sessionId}`)
    await handler(data)
    return
  }
  console.log(`[TerminalInput] No handler, falling back to writeTerminal for ${sessionId}`)
  await writeTerminal(sessionId, data)
  requestTerminalResync(sessionId)
}
