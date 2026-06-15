import { isTauriRuntime } from '@/lib/tauri-env'
import { normalizeShellCommandForPty } from '@/lib/terminal-client'
import { submitTerminalInput } from '@/lib/terminal-input-registry'
import { getTerminalOutputBuffer, requestTerminalResync } from '@/lib/terminal-stream'

const activeShellToolRequests = new Set<string>()
const completedShellToolRequests = new Set<string>()
const MAX_COMPLETED_SHELL_TOOL_IDS = 256
/** 同一终端短时间内相同命令只执行一次（Claude MCP 重试时会带新 requestId） */
const recentShellCommands = new Map<string, { command: string; at: number }>()
const SHELL_COMMAND_DEDUP_MS = 4000
const SHELL_COMMAND_CLEANUP_INTERVAL_MS = 60_000

function shellCommandKey(sessionId: string, command: string): string {
  return `${sessionId}\0${command.trim()}`
}

function gcRecentShellCommands() {
  const cutoff = Date.now() - SHELL_COMMAND_DEDUP_MS * 2
  for (const [key, entry] of recentShellCommands) {
    if (entry.at < cutoff) recentShellCommands.delete(key)
  }
}

// 定期清理过期条目，防止内存泄漏
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

/**
 * 检测是否出现了 shell 提示符（命令执行完成的标志）
 * 例如：user@host:path$ 或 C:\> 或 %
 * 采用高置信度模式，避免 git diff / 文件路径 / markdown 等误判
 */
function looksLikeShellPrompt(output: string): boolean {
  const cleanOutput = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][0-9;]*\x07/g, '').replace(/\x00/g, '')

  const lines = cleanOutput.split('\n').filter(l => l.trim())
  if (lines.length === 0) return false

  const lastLine = lines[lines.length - 1].trim()
  if (lastLine.length > 120) return false

  // bash/zsh: user@host:path$ 或 user@host:path#
  if (/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+:.*[$#]\s?$/.test(lastLine)) return true

  // Windows cmd: C:\Users\path>
  if (/^[A-Z]:\\.*>\s?$/.test(lastLine)) return true

  // PowerShell: PS C:\path>
  if (/^PS\s+[A-Z]:\\.*>\s?$/.test(lastLine)) return true

  // 极短提示符：单独一行只有 $、#、%、> （可选尾部空格）
  if (/^[$#%>]\s?$/.test(lastLine)) return true

  // 路径结尾的提示符：/path/to/dir$ 或 C:\dir# 或 ~$
  if (/^[~/\\A-Z]:.*[$#]\s?$/.test(lastLine) && lastLine.length <= 80) return true

  return false
}

function stripAnsi(output: string): string {
  return output
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][0-9;]*\x07/g, '')
    .replace(/\x00/g, '')
}

/** 终端输出是否包含命令回显以外的实质内容 */
function hasMeaningfulShellOutput(delta: string, commandLine: string): boolean {
  const cleaned = stripAnsi(delta).trim()
  const cmd = commandLine.trim()
  if (!cleaned) return false
  const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean)
  const beyondEcho = lines.filter(l => l !== cmd).join('\n').trim()
  return beyondEcho.length > 0
}

/** 同一终端上一条 AI shell 命令仍在等待时，新命令先发送 Ctrl+C 打断 */
const runningShellBySession = new Map<string, string>()

export interface ShellToolRequestPayload {
  requestId: string
  terminalSessionId: string
  command: string
  waitMs?: number
  sessionType?: string
  /** 执行前等待左侧 Shell 标签切换完成 */
  beforeExecute?: () => Promise<void>
}

/**
 * 在左侧 Shell 标签中执行命令（与手动输入同路径），并将输出回传给 Rust MCP 工具。
 */
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
  console.log(`[ShellTool] Starting execution: ${payload.requestId}, command: ${payload.command}`)

  const isSerial = payload.sessionType === 'serial'
  // 不再强制限制 waitMs 上限，由调用方决定；0 表示无限等待
  const waitMs = payload.waitMs ?? 30_000
  const stableTarget = isSerial ? 3 : 8
  const sessionId = payload.terminalSessionId

  // 长命令：在 Rust 侧超时前略早返回部分输出，避免 MCP 调用被 Claude 内置超时打断
  const SAFETY_TIMEOUT_MS =
    waitMs > 0 ? Math.min(waitMs + 8_000, 300_000) : 120_000
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
    return
  }
  recentShellCommands.set(cmdKey, { command: line.trim(), at: Date.now() })
  ensureShellCmdCleanup()
  gcRecentShellCommands()

  try {
    await payload.beforeExecute?.()

    const prevRequestId = runningShellBySession.get(sessionId)
    if (prevRequestId && prevRequestId !== payload.requestId) {
      console.log(`[ShellTool] Interrupting previous command on ${sessionId}: ${prevRequestId}`)
      await submitTerminalInput(sessionId, '\x03')
      await new Promise<void>(resolve => setTimeout(resolve, 300))
    }
    runningShellBySession.set(sessionId, payload.requestId)

    // 先记录写入前缓冲位置，避免快命令在 submit 后瞬间输出导致被漏掉
    const baselineLen = getTerminalOutputBuffer(sessionId).length

    console.log(`[ShellTool] Acking request: ${payload.requestId}`)
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('shell_tool_ack', { requestId: payload.requestId })
    console.log(`[ShellTool] Ack sent successfully`)

    console.log(`[ShellTool] Writing command via xterm path: ${line}`)
    await submitTerminalInput(sessionId, line)
    console.log(`[ShellTool] Command submitted successfully`)

    console.log(`[ShellTool] Baseline buffer length before write: ${baselineLen}`)

    // 初始等待，让命令有时间执行并产生输出
    await new Promise<void>(resolve => setTimeout(resolve, 300))

    const hasTimeout = waitMs > 0
    const deadline = hasTimeout ? Date.now() + waitMs : null
    const safetyDeadline = useSafetyTimeout ? Date.now() + SAFETY_TIMEOUT_MS : null
    let lastLen = getTerminalOutputBuffer(sessionId).length
    let stableTicks = 0
    let sawNewOutput = false
    let sawMeaningfulOutput = false

    console.log(`[ShellTool] Waiting for output${hasTimeout ? ` (timeout: ${waitMs}ms)` : ' (no timeout)'}${useSafetyTimeout ? `, safety cutoff: ${SAFETY_TIMEOUT_MS}ms` : ''}...`)

    while (hasTimeout ? Date.now() < deadline! : true) {
      await new Promise<void>(resolve => setTimeout(resolve, 150))
      const buf = getTerminalOutputBuffer(sessionId)
      const len = buf.length
      const delta = buf.slice(baselineLen)
      if (!sawNewOutput && len > baselineLen) sawNewOutput = true
      if (!sawMeaningfulOutput && hasMeaningfulShellOutput(delta, line)) {
        sawMeaningfulOutput = true
      }

      // 检测提示符出现（命令执行完成的标志）
      if (sawNewOutput && looksLikeShellPrompt(delta)) {
        // 看到提示符了，再等一小会儿确保稳定
        await new Promise<void>(resolve => setTimeout(resolve, 200))
        console.log(`[ShellTool] Shell prompt detected, command completed`)
        break
      }

      // 安全超时检查：在 Claude Code MCP 超时前主动返回
      if (safetyDeadline && Date.now() >= safetyDeadline) {
        console.log(`[ShellTool] Safety timeout reached (${SAFETY_TIMEOUT_MS}ms), returning partial output`)
        break
      }

      if (len === lastLen) {
        // 仅有命令回显、尚无实质输出时不判稳，避免长任务被误判为空输出
        if (sawMeaningfulOutput) stableTicks += 1
        if (sawMeaningfulOutput && stableTicks >= stableTarget) {
          console.log(`[ShellTool] Output stabilized after ${stableTicks} ticks`)
          break
        }
      } else {
        stableTicks = 0
        lastLen = len
      }
    }

    let output = getTerminalOutputBuffer(sessionId).slice(baselineLen)
    if (!output.trim()) {
      // 最后再拉一次，给极快命令一点尾部刷新的时间
      await new Promise<void>(resolve => setTimeout(resolve, 180))
      requestTerminalResync(sessionId)
      output = getTerminalOutputBuffer(sessionId).slice(baselineLen)
    }
    // 某些 PTY 会先回显命令再输出结果；若仅有回显，做一次轻量清理
    const cleaned = stripAnsi(output).trim()
    if (cleaned === line.trim()) {
      output = ''
    }
    const isTimeout = hasTimeout && deadline !== null && Date.now() >= deadline
    const onlyEchoNoResult = sawNewOutput && !sawMeaningfulOutput && !looksLikeShellPrompt(output)
    const stillRunning = onlyEchoNoResult || (isTimeout && !sawMeaningfulOutput)
    const finalOutput = output || (stillRunning ? '' : '(无输出)')

    if (isTimeout || stillRunning) {
      console.log(`[ShellTool] Execution still running or timed out. Length: ${output.length}, onlyEcho: ${onlyEchoNoResult}`)
    } else {
      console.log(`[ShellTool] Execution completed. Output length: ${output.length}, preview: ${output.substring(0, 100)}...`)
    }

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
  }
}
