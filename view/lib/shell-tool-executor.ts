import { isTauriRuntime } from '@/lib/tauri-env'
import {
  getTerminalBufferLen,
  normalizeShellCommandForPty,
  readTerminalBufferSince,
} from '@/lib/terminal-client'
import { sanitizeTerminalOutput } from '@/lib/terminal-sanitize'
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
const OUTPUT_STABLE_COMPLETE_MS = 1200

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

function compactForEchoCompare(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase()
}

function stripCommonPromptPrefix(line: string): string {
  return line
    .replace(/^PS\s+[A-Z]:\\.*?>\s*/i, '')
    .replace(/^[A-Z]:\\.*?>\s*/i, '')
    .replace(/^[^@\s]+@[^:\s]+:.*?[$#]\s*/, '')
    .replace(/^[$#%>]\s*/, '')
}

function lineLooksLikeCommandEcho(line: string, commandLine: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return true
  if (/^(PS\s+)?[A-Z]:\\.*?>\s*$/i.test(trimmed)) return true
  if (/^[^@\s]+@[^:\s]+:.*?[$#]\s*$/.test(trimmed)) return true
  if (/^[$#%>]\s*$/.test(trimmed)) return true

  const command = commandLine.replace(/\r/g, '').trim()
  const compactCommand = compactForEchoCompare(command)
  const compactLine = compactForEchoCompare(stripCommonPromptPrefix(trimmed))
  if (!compactCommand || !compactLine) return false
  if (compactLine.length < 8) return compactCommand.startsWith(compactLine)

  return compactLine === compactCommand || compactCommand.includes(compactLine)
}

function cleanShellToolOutput(output: string): string {
  return sanitizeTerminalOutput(output).replace(/\x00/g, '').trim()
}

function hasMeaningfulShellOutput(delta: string, commandLine: string): boolean {
  const cleaned = cleanShellToolOutput(delta)
  if (!cleaned) return false
  const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean)
  return lines.some(l => !lineLooksLikeCommandEcho(l, commandLine))
}

/** 长任务期间续期 Claude 静默超时，避免误杀 AI 进程 */
let shellToolKeepaliveTouch: (() => void) | null = null
export function registerShellToolKeepaliveTouch(fn: () => void): () => void {
  shellToolKeepaliveTouch = fn
  return () => {
    if (shellToolKeepaliveTouch === fn) shellToolKeepaliveTouch = null
  }
}

/** 交互提示事件：密码/passphrase/用户名等需要用户手动输入的场景 */
type InteractivePromptEvent = {
  sessionId: string
  requestId: string
  command: string
  prompt: string
}
let shellToolPromptListener: ((e: InteractivePromptEvent) => void) | null = null
const dismissedInteractivePrompts = new Set<string>()

function interactivePromptKey(sessionId: string, prompt: string): string {
  return `${sessionId}\0${prompt}`
}

/** 用户已在终端完成输入并点击「继续」后，不再重复弹出同一提示 */
export function acknowledgeInteractivePrompt(sessionId: string, prompt: string): void {
  dismissedInteractivePrompts.add(interactivePromptKey(sessionId, prompt))
}

export function clearInteractivePromptAck(sessionId: string): void {
  for (const key of dismissedInteractivePrompts) {
    if (key.startsWith(`${sessionId}\0`)) dismissedInteractivePrompts.delete(key)
  }
}
export function registerShellToolPromptListener(
  fn: (e: InteractivePromptEvent) => void
): () => void {
  shellToolPromptListener = fn
  return () => {
    if (shellToolPromptListener === fn) shellToolPromptListener = null
  }
}

/** 取消指定终端会话正在执行的 shell 工具命令（发送 Ctrl+C + abort） */
export function cancelShellToolForSession(sessionId: string): void {
  const ac = shellSessionAbort.get(sessionId)
  if (ac) ac.abort()
  void submitTerminalInput(sessionId, '\x03').catch(() => {})
}

/** 检测终端尾部是否出现交互提示（密码、passphrase、用户名等） */
const INTERACTIVE_PROMPT_RE =
  /\[sudo\]\s*password|password\s*(for|[:：])|enter\s+passphrase|username\s*[:：]|login\s*[:：]|are you sure you want to continue connecting|fingerprint|verification code|2fa|otp|press enter to continue/i

export function classifyInteractivePrompt(prompt: string): 'password' | 'confirm' | 'generic' {
  if (/password|passphrase/i.test(prompt)) return 'password'
  if (/fingerprint|continue connecting|yes\/no|are you sure/i.test(prompt)) return 'confirm'
  return 'generic'
}

function detectInteractivePrompt(tail: string): string | null {
  const cleaned = stripAnsi(tail).replace(/\x00/g, '')
  const last = cleaned.slice(-400)
  const m = INTERACTIVE_PROMPT_RE.exec(last)
  return m ? m[0] : null
}

const shellSessionAbort = new Map<string, AbortController>()
const runningShellBySession = new Map<string, string>()

export type MonitorShellResolver = (
  busySessionId: string,
  command: string
) => Promise<string | null>

let monitorShellResolver: MonitorShellResolver | null = null

export function registerMonitorShellResolver(resolver: MonitorShellResolver | null) {
  monitorShellResolver = resolver
}

export function isShellSessionRunningCommand(sessionId: string): boolean {
  const requestId = runningShellBySession.get(sessionId)
  return !!requestId && activeShellToolRequests.has(requestId)
}

export interface ShellToolRequestPayload {
  requestId: string
  terminalSessionId: string
  command: string
  waitMs?: number
  sessionType?: string
  beforeExecute?: () => Promise<void>
  /** 返回 false 时拒绝执行并通知 MCP */
  requireApproval?: () => Promise<boolean>
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

  const waitMs = payload.waitMs ?? 30_000
  let sessionId = payload.terminalSessionId

  const SAFETY_TIMEOUT_MS =
    waitMs > 0 ? Math.min(waitMs + 8_000, 300_000) : 300_000
  const useSafetyTimeout = waitMs === 0 || waitMs >= 35_000

  const line = normalizeShellCommandForPty(payload.command)

  const sessionBusy = isShellSessionRunningCommand(sessionId)
  if (sessionBusy) {
    if (monitorShellResolver) {
      try {
        const altSessionId = await monitorShellResolver(sessionId, line.trim())
        if (altSessionId && altSessionId !== sessionId) {
          console.log(
            `[ShellTool] Busy PTY ${sessionId} — redirected command to monitor shell ${altSessionId}`
          )
          sessionId = altSessionId
        } else {
          await completeShellTool(
            payload.requestId,
            null,
            '该 Shell PTY 仍有前台命令在运行，且未能自动创建监控 Shell。getTerminalContext 可读原 Shell 输出；createNewShell 可新开 PTY。',
            false
          ).catch(() => {})
          activeShellToolRequests.delete(payload.requestId)
          return
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await completeShellTool(
          payload.requestId,
          null,
          `原 Shell 繁忙且创建监控 Shell 失败: ${message}`,
          false
        ).catch(() => {})
        activeShellToolRequests.delete(payload.requestId)
        return
      }
    } else {
      await completeShellTool(
        payload.requestId,
        null,
        '该 Shell PTY 仍有前台命令在运行，无法在同一 PTY 发送第二条命令。createNewShell 可新开 Shell；应用也会在可能时自动在下方拆分监控 Shell。',
        false
      ).catch(() => {})
      activeShellToolRequests.delete(payload.requestId)
      return
    }
  } else {
    const prevAbort = shellSessionAbort.get(sessionId)
    if (prevAbort) {
      prevAbort.abort()
      await submitTerminalInput(sessionId, '\x03').catch(() => {})
      await new Promise<void>(resolve => setTimeout(resolve, 250))
    }
  }

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

  if (payload.requireApproval) {
    const approved = await payload.requireApproval()
    if (!approved) {
      await completeShellTool(
        payload.requestId,
        null,
        '用户拒绝执行此命令（敏感操作审核）',
        false
      ).catch(() => {})
      activeShellToolRequests.delete(payload.requestId)
      return
    }
  }

  const abort = new AbortController()
  shellSessionAbort.set(sessionId, abort)
  runningShellBySession.set(sessionId, payload.requestId)

  try {
    await payload.beforeExecute?.()

    const baselineOffset = await getTerminalBufferLen(sessionId)

    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('shell_tool_ack', { requestId: payload.requestId })

    await submitTerminalInput(sessionId, line)
    shellToolKeepaliveTouch?.()

    await new Promise<void>(resolve => setTimeout(resolve, 300))

    const hasTimeout = waitMs > 0
    let deadline = hasTimeout ? Date.now() + waitMs : null
    let safetyDeadline = useSafetyTimeout ? Date.now() + SAFETY_TIMEOUT_MS : null
    let lastLen = baselineOffset
    let sawNewOutput = false
    let sawMeaningfulOutput = false
    let sawPrompt = false
    let assumedCompleteFromStableOutput = false
    let promptEmitted = ''
    let lastKeepaliveTouch = Date.now()
    let stableSince = Date.now()
    const PROMPT_EXTEND_MS = 3 * 60_000

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
      if (currentLen !== lastLen) {
        lastLen = currentLen
        stableSince = Date.now()
      }

      // 1. Shell 提示符 = 唯一可靠的完成信号
      if (sawNewOutput && looksLikeShellPrompt(delta)) {
        sawPrompt = true
        await new Promise<void>(resolve => setTimeout(resolve, 200))
        break
      }

      // 2. 交互提示检测：延长等待、通知 UI、继续轮询（绝不提前 break）
      const promptHit = detectInteractivePrompt(delta)
      if (promptHit && promptEmitted !== promptHit) {
        const key = interactivePromptKey(sessionId, promptHit)
        if (!dismissedInteractivePrompts.has(key)) {
          promptEmitted = promptHit
          if (hasTimeout && deadline) deadline += PROMPT_EXTEND_MS
          if (safetyDeadline) safetyDeadline += PROMPT_EXTEND_MS
          shellToolPromptListener?.({
            sessionId,
            requestId: payload.requestId,
            command: line,
            prompt: promptHit,
          })
        }
      }

      // 3. 硬超时
      if (safetyDeadline && Date.now() >= safetyDeadline) {
        break
      }

      // 4. 兜底完成信号：部分 PowerShell/远程 shell 的提示符不稳定或被 ANSI 包裹，
      //    但输出已经停止增长。避免 MCP 一直返回 incomplete，导致 Claude 回复卡住。
      if (
        sawNewOutput &&
        !promptEmitted &&
        Date.now() - stableSince >= OUTPUT_STABLE_COMPLETE_MS &&
        (sawMeaningfulOutput || !hasTimeout)
      ) {
        assumedCompleteFromStableOutput = true
        break
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

    output = cleanShellToolOutput(output)
    const cleaned = output.trim()
    if (cleaned === line.trim()) {
      output = ''
    }
    const isTimeout = hasTimeout && deadline !== null && Date.now() >= deadline
    const onlyEchoNoResult = sawNewOutput && !sawMeaningfulOutput && !sawPrompt
    // 看到输出但从未检测到 shell 提示符 = 命令可能仍在运行
    const stillRunning =
      !assumedCompleteFromStableOutput &&
      (onlyEchoNoResult || (sawMeaningfulOutput && !sawPrompt) || (isTimeout && !sawPrompt))
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
    if (runningShellBySession.get(sessionId) === payload.requestId) {
      runningShellBySession.delete(sessionId)
    }
    if (shellSessionAbort.get(sessionId) === abort) {
      shellSessionAbort.delete(sessionId)
    }
  }
}
