import type { TerminalOutputEvent } from '@/lib/terminal-client'
import { listenTerminalOutput } from '@/lib/terminal-client'

type OutputHandler = (event: TerminalOutputEvent) => void

const subscribers = new Map<string, Set<OutputHandler>>()
const outputBuffers = new Map<string, string>()
/** 每个会话保留的滚动缓冲上限（多 Shell 标签共享同一 session 时回放） */
const MAX_BUFFER_CHARS = 512 * 1024

let listenerPromise: Promise<() => void> | null = null
let listenerRefCount = 0
let globalUnlistenFn: (() => void) | null = null

function appendToBuffer(sessionId: string, data: string) {
  let buf = outputBuffers.get(sessionId) ?? ''
  buf += data
  if (buf.length > MAX_BUFFER_CHARS) {
    buf = buf.slice(buf.length - MAX_BUFFER_CHARS)
  }
  outputBuffers.set(sessionId, buf)
}

function dispatch(event: TerminalOutputEvent) {
  appendToBuffer(event.sessionId, event.data)
  subscribers.get('__all__')?.forEach(handler => handler(event))
  subscribers.get(event.sessionId)?.forEach(handler => handler(event))
}

/** 获取会话至今的终端输出，供新建/切换 Shell 标签时回放 */
export function getTerminalOutputBuffer(sessionId: string): string {
  return outputBuffers.get(sessionId) ?? ''
}

export function clearTerminalOutputBuffer(sessionId: string): void {
  outputBuffers.delete(sessionId)
}

/** 向前端 xterm 注入显示文本（与 Tauri terminal:output 效果一致） */
export function injectTerminalOutput(sessionId: string, data: string): void {
  dispatch({ sessionId, data })
}

/** 在 xterm 中显示 AI/MCP 即将执行的命令 */
export function injectAiCommandEcho(sessionId: string, command: string): void {
  const safe = command.replace(/\x1b/g, '').trim()
  if (!safe) return
  injectTerminalOutput(
    sessionId,
    `\r\n\x1b[90m[Claude Code]\x1b[0m \x1b[36m$ ${safe}\x1b[0m`
  )
}

/** 订阅所有会话的终端输出（供 page 等非 xterm 场景使用） */
export function subscribeAllTerminalOutput(handler: OutputHandler): () => void {
  return subscribeTerminalOutput('__all__', handler)
}

async function ensureGlobalListener(): Promise<() => void> {
  if (!listenerPromise) {
    listenerPromise = listenTerminalOutput(dispatch).then(unlisten => {
      globalUnlistenFn = unlisten
      return unlisten
    })
  }
  return listenerPromise
}

/** 单例终端输出订阅，避免多个 LiveTerminal 重复注册 Tauri 监听器 */
export function subscribeTerminalOutput(
  sessionId: string,
  handler: OutputHandler
): () => void {
  listenerRefCount += 1
  void ensureGlobalListener()

  let set = subscribers.get(sessionId)
  if (!set) {
    set = new Set()
    subscribers.set(sessionId, set)
  }
  set.add(handler)

  return () => {
    set!.delete(handler)
    if (set!.size === 0) {
      subscribers.delete(sessionId)
    }
    listenerRefCount -= 1
    // 当所有订阅者都取消订阅时，停止全局监听器
    if (listenerRefCount === 0) {
      globalUnlistenFn?.()
      globalUnlistenFn = null
      listenerPromise = null
    }
  }
}
