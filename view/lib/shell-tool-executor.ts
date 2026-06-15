import { isTauriRuntime } from '@/lib/tauri-env'
import {
  getTerminalBufferLen,
  normalizeShellCommandForPty,
  readTerminalBufferSince,
} from '@/lib/terminal-client'
import { submitTerminalInput } from '@/lib/terminal-input-registry'
import { requestTerminalResync } from '@/lib/terminal-stream'

const activeShellToolRequests = new Set<string>()
const completedShellToolRequests = new Set<string>()
const MAX_COMPLETED_SHELL_TOOL_IDS = 256
/** 同一终端短时间内相同命令只执行一次（Claude MCP 重试时会带新 requestId） */
const recentShellCommands = new Map<string, { command: string; at: number }>()
const SHELL_COMMAND_DEDUP_MS = 4000
const SHELL_COMMAND_CLEANUP_INTERVAL_MS = 60_000
const KEEPALIVE_TOUCH_INTERVAL_MS = 5000

function shellCommandKey(sessionId: string, command: string): string {
  return `${sessionId}\0${command.trim()}`
}

function gcRecentShellCommands() {
  const cutoff = Date.now() - SHELL_COMMAND_DEDUP_MS * 2
  for (const [key, entry] of recentShellCommands) {
    if (entry.at < cutoff) recentShellCommands.delete(key)
  }
}

let _shellCmdCleanupTimer: ReturnType<typeof setInterval> | null = null
function ensureShellCmdCleanup() {
  if (_shellCmdCleanupTimer) return
  _shellCmdCleanupTimer = setInterval(gcRecentShellCommands, SHELL_COMMAND_CLEANUP_INTERVAL_MS)
}

async function completeShellTool(
  requestId: string,
  output: string | null,
  error: string | null,
  timedOut = false
): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('complete_shell_tool_command', {
    requestId,
    output,
    error,
    timedOut,
  })
}

function rememberCompletedShellTool(requestId: string) {
  completedShellToolRequests.add(requestId)
  if (completedShellToolRequests.size > MAX_COMPLETED_SHELL_TOOL_IDS) {
    const first = completedShellToolRequests.values().next().value
    if (first) completedShellToolRequests.delete(first)
  }
}

function looksLikeShellPrompt(output: string): boolean {
  const cleanOutput = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][0-9;]*\x07/g, '').replace(/\x00/g, '')

  const lines = cleanOutput.split('\n').filter(l => l.trim())
  if (lines.length === 0) return false

  const lastLine = lines[lines.length - 1].trim()
  if (lastLine.length > 120) return false

  if (/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+:.*[$#]\s?$/.test(lastLine)) return true
  if (/^[A-Z]:\\.*>\s?$/.test(lastLine)) return true
  if (/^PS\s+[A-Z]:\\.*>\s?$/.test(lastLine)) return true
  if (/^[$#%>]\s?$/.test(lastLine)) return true
  if (/^[~/\\A-Z]:.*[$#]\s?$/.test(lastLine) && lastLine.length <= 80) return true

  return false
}

function stripAnsi(output: string): string {
  return output
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][0-9;]*\x07/g, '')
    .replace(/\x00/g, '')
}

function hasMeaningfulShellOutput(delta: string, commandLine: string): boolean {
  const cleaned = stripAnsi(delta).trim()
  const cmd = commandLine.trim()
  if (!cleaned) return false
  const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean)
  const beyondEcho = lines.filter(l => l !== cmd).join('\n').trim()
  return beyondEcho.length > 0
}

/** 长任务期间续期 Claude 静默超时，避免误杀 AI 进程 */
let shellToolKeepaliveTouch: (() => void) | null = null
export function registerShellToolKeepaliveTouch(fn: () => void): () => void {
  shellToolKeepaliveTouch = fn
  return () => {
    if (shellToolKeepaliveTouch === fn) shellToolKeepaliveTouch = null
  }
}

const shellSessionAbort = new Map<string, AbortController>()

export interface ShellToolRequestPayload {
  requestId: string
  terminalSessionId: string
  command: string
  waitMs?: number
  sessionType?: string
  beforeExecute?: () => Promise<void>
}

export async function executeShellToolInTab(
  payload: ShellToolRequestPayload
): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error('Shell 工具仅 Tauri 桌面版可用')
  }

  if (
    activeShellToolRequests.has(payload.requestId) ||
    completedShellToolRequests.has(payload.requestId)
  ) {
    console.log(`[ShellTool] Skipping duplicate request: ${payload.requestId}`)
    await completeShellTool(
      payload.requestId,
      null,
      '检测到重复的 runShellCommand 请求，已忽略重复执行',
      false
    ).catch(() => {})
    return
  }
  activeShellToolRequests.add(payload.requestId)

  const isSerial = payload.sessionType === 'serial'
  const waitMs = payload.waitMs ?? 30_000
  const stableTarget = isSerial ? 3 : 8
  const sessionId = payload.terminalSessionId

  const SAFETY_TIMEOUT_MS =
    waitMs > 0 ? Math.min(waitMs + 8_000, 300_000) : 300_000
  const useSafetyTimeout = waitMs === 0 || waitMs >= 35_000

  const line = normalizeShellCommandForPty(payload.command)
  const cmdKey = shellCommandKey(sessionId, line)
  const recent = recentShellCommands.get(cmdKey)
  if (recent && Date.now() - recent.at < SHELL_COMMAND_DEDUP_MS) {
    console.log(`[ShellTool] Skipping duplicate command within ${SHELL_COMMAND_DEDUP_MS}ms: ${line}`)
    await completeShellTool(
      payload.requestId,
      null,
      '短时间内重复的相同命令已跳过（请使用上一次 runShellCommand 的输出）',
      false
    ).catch(() => {})
    activeShellToolRequests.delete(payload.requestId)
    return
  }
  recentShellCommands.set(cmdKey, { command: line.trim(), at: Date.now() })
  ensureShellCmdCleanup()
  gcRecentShellCommands()

  const abort = new AbortController()
  const prevAbort = shellSessionAbort.get(sessionId)
  if (prevAbort) {
    prevAbort.abort()
    await submitTerminalInput(sessionId, '\x03').catch(() => {})
    await new Promise<void>(resolve => setTimeout(resolve, 250))
  }
  shellSessionAbort.set(sessionId, abort)

  try {
    await payload.beforeExecute?.()

    const baselineOffset = await getTerminalBufferLen(sessionId)

    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('shell_tool_ack', { requestId: payload.requestId })

    await submitTerminalInput(sessionId, line)
    shellToolKeepaliveTouch?.()

    await new Promise<void>(resolve => setTimeout(resolve, 300))

    const hasTimeout = waitMs > 0
    const deadline = hasTimeout ? Date.now() + waitMs : null
    const safetyDeadline = useSafetyTimeout ? Date.now() + SAFETY_TIMEOUT_MS : null
    let lastLen = baselineOffset
    let stableTicks = 0
    let sawNewOutput = false
    let sawMeaningfulOutput = false
    let lastKeepaliveTouch = Date.now()

    while (!abort.signal.aborted && (hasTimeout ? Date.now() < deadline! : true)) {
      await new Promise<void>(resolve => setTimeout(resolve, 150))
      if (abort.signal.aborted) break

      if (Date.now() - lastKeepaliveTouch >= KEEPALIVE_TOUCH_INTERVAL_MS) {
        shellToolKeepaliveTouch?.()
        lastKeepaliveTouch = Date.now()
      }

      const delta = await readTerminalBufferSince(sessionId, baselineOffset)
      const currentLen = baselineOffset + delta.length
      if (!sawNewOutput && delta.length > 0) sawNewOutput = true
      if (!sawMeaningfulOutput && hasMeaningfulShellOutput(delta, line)) {
        sawMeaningfulOutput = true
      }

      if (sawNewOutput && looksLikeShellPrompt(delta)) {
        await new Promise<void>(resolve => setTimeout(resolve, 200))
        break
      }

      if (safetyDeadline && Date.now() >= safetyDeadline) {
        break
      }

      if (currentLen === lastLen) {
        if (sawMeaningfulOutput) stableTicks += 1
        if (sawMeaningfulOutput && stableTicks >= stableTarget) {
          break
        }
      } else {
        stableTicks = 0
        lastLen = currentLen
      }
    }

    if (abort.signal.aborted) {
      await completeShellTool(
        payload.requestId,
        null,
        '同终端新命令已启动，上一条命令等待已取消',
        true
      ).catch(() => {})
      rememberCompletedShellTool(payload.requestId)
      return
    }

    let output = await readTerminalBufferSince(sessionId, baselineOffset)
    if (!output.trim()) {
      await new Promise<void>(resolve => setTimeout(resolve, 180))
      requestTerminalResync(sessionId)
      output = await readTerminalBufferSince(sessionId, baselineOffset)
    }

    const cleaned = stripAnsi(output).trim()
    if (cleaned === line.trim()) {
      output = ''
    }
    const isTimeout = hasTimeout && deadline !== null && Date.now() >= deadline
    const onlyEchoNoResult = sawNewOutput && !sawMeaningfulOutput && !looksLikeShellPrompt(output)
    const stillRunning = onlyEchoNoResult || (isTimeout && !sawMeaningfulOutput)
    const finalOutput = output || (stillRunning ? '' : '(无输出)')

    await completeShellTool(payload.requestId, finalOutput, null, isTimeout || stillRunning)
    rememberCompletedShellTool(payload.requestId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('未知 shell tool 请求')) {
      console.debug(`[ShellTool] Ignoring stale completion for request: ${payload.requestId}`)
    } else {
      console.error(`[ShellTool] Execution failed: ${message}`)
    }
    await completeShellTool(payload.requestId, null, message, false).catch(() => {})
    rememberCompletedShellTool(payload.requestId)
  } finally {
    activeShellToolRequests.delete(payload.requestId)
    if (shellSessionAbort.get(sessionId) === abort) {
      shellSessionAbort.delete(sessionId)
    }
  }
}
