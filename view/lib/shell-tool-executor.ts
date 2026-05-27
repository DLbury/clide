import { isTauriRuntime } from '@/lib/tauri-env'
import { normalizeShellCommandForPty, writeTerminal } from '@/lib/terminal-client'
import { getTerminalOutputBuffer, injectAiCommandEcho, requestTerminalResync } from '@/lib/terminal-stream'

const activeShellToolRequests = new Set<string>()
const completedShellToolRequests = new Set<string>()
const MAX_COMPLETED_SHELL_TOOL_IDS = 256

function rememberCompletedShellTool(requestId: string) {
  completedShellToolRequests.add(requestId)
  if (completedShellToolRequests.size > MAX_COMPLETED_SHELL_TOOL_IDS) {
    const first = completedShellToolRequests.values().next().value
    if (first) completedShellToolRequests.delete(first)
  }
}

export interface ShellToolRequestPayload {
  requestId: string
  terminalSessionId: string
  command: string
  waitMs?: number
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
    return
  }
  activeShellToolRequests.add(payload.requestId)
  console.log(`[ShellTool] Starting execution: ${payload.requestId}, command: ${payload.command}`)

  const { invoke } = await import('@tauri-apps/api/core')
  const waitMs = payload.waitMs ?? 8000
  const sessionId = payload.terminalSessionId
  const startLen = getTerminalOutputBuffer(sessionId).length
  console.log(`[ShellTool] Initial buffer length: ${startLen}`)

  const line = normalizeShellCommandForPty(payload.command)

  try {
    await payload.beforeExecute?.()
    requestTerminalResync(sessionId)

    injectAiCommandEcho(sessionId, payload.command)
    requestTerminalResync(sessionId)
    console.log(`[ShellTool] Writing command to terminal: ${line}`)
    await writeTerminal(sessionId, line)

    const deadline = Date.now() + waitMs
    let lastLen = startLen
    let stableTicks = 0

    console.log(`[ShellTool] Waiting for output (timeout: ${waitMs}ms)...`)
    while (Date.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 150))
      const len = getTerminalOutputBuffer(sessionId).length
      if (len === lastLen) {
        stableTicks += 1
        if (stableTicks >= 4) {
          console.log(`[ShellTool] Output stabilized after ${stableTicks} ticks`)
          break
        }
      } else {
        stableTicks = 0
        lastLen = len
      }
    }

    const output = getTerminalOutputBuffer(sessionId).slice(startLen)
    console.log(`[ShellTool] Execution completed. Output length: ${output.length}, preview: ${output.substring(0, 100)}...`)
    requestTerminalResync(sessionId)
    await invoke('complete_shell_tool_command', {
      requestId: payload.requestId,
      output: output || null,
      error: null,
    })
    rememberCompletedShellTool(payload.requestId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[ShellTool] Execution failed: ${message}`)
    await invoke('complete_shell_tool_command', {
      requestId: payload.requestId,
      output: null,
      error: message,
    })
    rememberCompletedShellTool(payload.requestId)
  } finally {
    activeShellToolRequests.delete(payload.requestId)
  }
}
