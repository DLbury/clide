import type { TerminalOutputEvent } from '@/lib/terminal-client'
import { listenTerminalOutput } from '@/lib/terminal-client'

type OutputHandler = (event: TerminalOutputEvent) => void

const subscribers = new Map<string, Set<OutputHandler>>()
const outputBuffers = new Map<string, string>()
const droppedChars = new Map<string, number>()
/** 每个会话保留的滚动缓冲上限（与 Rust 侧 512KB 对齐，减少截断导致的全屏重绘） */
const MAX_BUFFER_CHARS = 512 * 1024

let listenerPromise: Promise<() => void> | null = null
let listenerRefCount = 0
let globalUnlistenFn: (() => void) | null = null

function appendToBuffer(sessionId: string, data: string) {
  let buf = outputBuffers.get(sessionId) ?? ''
  let dropped = droppedChars.get(sessionId) ?? 0
  buf += data
  if (buf.length > MAX_BUFFER_CHARS) {
    const trim = buf.length - MAX_BUFFER_CHARS
    buf = buf.slice(trim)
    dropped += trim
  }
  outputBuffers.set(sessionId, buf)
  droppedChars.set(sessionId, dropped)
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
  droppedChars.delete(sessionId)
}

const resyncHandlers = new Set<(sessionId: string) => void>()

/** 将 xterm 追赶到输出缓冲末尾；仅在缓冲被截断时才 clear 重绘，避免打断 PSReadLine */
export function requestTerminalResync(sessionId: string): void {
  resyncHandlers.forEach(handler => handler(sessionId))
}

export function onTerminalResync(handler: (sessionId: string) => void): () => void {
  resyncHandlers.add(handler)
  return () => resyncHandlers.delete(handler)
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

/** 确保 Tauri terminal:output 全局监听已注册（连接 PTY 前必须 await） */
export async function ensureTerminalOutputListener(): Promise<void> {
  await ensureGlobalListener()
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
