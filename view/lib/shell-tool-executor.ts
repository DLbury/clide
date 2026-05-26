import { isTauriRuntime } from '@/lib/tauri-env'
import { normalizeShellCommandForPty, writeTerminal } from '@/lib/terminal-client'
import { getTerminalOutputBuffer, injectAiCommandEcho } from '@/lib/terminal-stream'

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
    return
  }
  activeShellToolRequests.add(payload.requestId)

  const { invoke } = await import('@tauri-apps/api/core')
  const waitMs = payload.waitMs ?? 8000
  const sessionId = payload.terminalSessionId
  const startLen = getTerminalOutputBuffer(sessionId).length

  const line = normalizeShellCommandForPty(payload.command)

  try {
    injectAiCommandEcho(sessionId, payload.command)
    await writeTerminal(sessionId, line)

    const deadline = Date.now() + waitMs
    let lastLen = startLen
    let stableTicks = 0

    while (Date.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 150))
      const len = getTerminalOutputBuffer(sessionId).length
      if (len === lastLen) {
        stableTicks += 1
        if (stableTicks >= 4) break
      } else {
        stableTicks = 0
        lastLen = len
      }
    }

    const output = getTerminalOutputBuffer(sessionId).slice(startLen)
    await invoke('complete_shell_tool_command', {
      requestId: payload.requestId,
      output: output || null,
      error: null,
    })
    rememberCompletedShellTool(payload.requestId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
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
