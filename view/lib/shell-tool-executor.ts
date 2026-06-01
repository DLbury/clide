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

function shellCommandKey(sessionId: string, command: string): string {
  return `${sessionId}\0${command.trim()}`
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
 * 例如：user@host:path$ 或 C:\> 或 % 结尾
 */
function looksLikeShellPrompt(output: string): boolean {
  // 移除 ANSI 转义序列
  const cleanOutput = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][0-9;]*\x07/g, '').replace(/\x00/g, '')

  // 获取最后几行
  const lines = cleanOutput.split('\n').filter(l => l.trim())
  if (lines.length === 0) return false

  const lastLine = lines[lines.length - 1].trim()
  if (lastLine.length > 200) return false

  // 检测常见提示符结尾
  if (/[$#%>]$/.test(lastLine)) return true

  // 检测 user@host 模式 (user@host:path$)
  if (/@.*:.*[$#%]/.test(lastLine)) return true

  // 检测 Windows cmd/ps (C:\> 或 PS C:\>)
  if (/^[A-Z]:\\/.test(lastLine) || lastLine.startsWith('PS ')) return true

  return false
}

function stripAnsi(output: string): string {
  return output
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][0-9;]*\x07/g, '')
    .replace(/\x00/g, '')
}

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
  const stableTarget = isSerial ? 2 : 4
  const sessionId = payload.terminalSessionId

  // Claude Code MCP 工具调用的内置超时约 60 秒（实测可能更短）
  // 为避免被 Claude Code 超时中断，我们在 45 秒时主动返回临时结果
  const SAFETY_TIMEOUT_MS = 45_000
  const useSafetyTimeout = waitMs === 0 || waitMs > SAFETY_TIMEOUT_MS

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

  try {
    await payload.beforeExecute?.()
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

    console.log(`[ShellTool] Waiting for output${hasTimeout ? ` (timeout: ${waitMs}ms)` : ' (no timeout)'}${useSafetyTimeout ? `, safety cutoff: ${SAFETY_TIMEOUT_MS}ms` : ''}...`)

    while (hasTimeout ? Date.now() < deadline! : true) {
      await new Promise<void>(resolve => setTimeout(resolve, 150))
      const buf = getTerminalOutputBuffer(sessionId)
      const len = buf.length
      const delta = buf.slice(baselineLen)
      if (!sawNewOutput && len > baselineLen) sawNewOutput = true

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
        // 没有任何新增输出时不提前判稳，避免快命令竞态返回空
        if (sawNewOutput) stableTicks += 1
        if (sawNewOutput && stableTicks >= stableTarget) {
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
    const finalOutput = output || '(无输出)'

    if (isTimeout) {
      console.log(`[ShellTool] Execution timed out but returning collected output. Length: ${output.length}`)
    } else {
      console.log(`[ShellTool] Execution completed. Output length: ${output.length}, preview: ${output.substring(0, 100)}...`)
    }

    await completeShellTool(payload.requestId, finalOutput, null, isTimeout)
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
  }
}
