import { isTauriRuntime } from '@/lib/tauri-env'

export interface ClaudeDetectResult {
  found: boolean
  path?: string
  version?: string
  candidates: string[]
}

export interface BridgeStatus {
  running: boolean
  port: number
  lockFile: string
  ideName: string
  connected: boolean
  hasClient?: boolean
  workspaceFolders: string[]
}

/** 与侧栏「已就绪」一致：WebSocket 服务在跑且 connected */
export function isIdeBridgeReady(status: BridgeStatus | null | undefined): boolean {
  return Boolean(status?.running && status?.connected)
}

export interface McpRegisterStatus {
  projectRoot: string
  mcpScriptExists: boolean
  projectMcpConfigReady: boolean
  claudeProjectRegistered: boolean
  ready: boolean
  runtimeToolsReady?: boolean
  runtimeToolCount?: number
  runtimeError?: string | null
}

export interface IdeContext {
  workspaceFolders: string[]
  activeSessionName?: string
  activeSessionHost?: string
  activeProfileId?: string
  activeConnectionId?: string
  activeShellId?: string
  terminalSnippet?: string
  openFiles: string[]
  activeFilePath?: string
  selectedText?: string
}

export interface ClaudeStreamEvent {
  requestId: string
  eventType: string
  text?: string
  sessionId?: string
  done: boolean
  error?: string
  reasoning?: string
  toolId?: string
  toolName?: string
  toolInput?: unknown
  toolOutput?: string
  toolError?: string
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) {
    throw new Error('Claude Code 集成仅在 Tauri 桌面版可用')
  }
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke<T>(cmd, args)
}

export async function detectClaude(claudePath?: string): Promise<ClaudeDetectResult> {
  return invoke<ClaudeDetectResult>('claude_detect', { claudePath: claudePath || null })
}

export async function startClaudeBridge(
  workspaceFolders: string[],
  claudePath?: string
): Promise<BridgeStatus> {
  return invoke<BridgeStatus>('claude_start_bridge', {
    workspaceFolders,
    claudePath: claudePath || null,
  })
}

export async function stopClaudeBridge(): Promise<void> {
  return invoke<void>('claude_stop_bridge')
}

export async function getClaudeBridgeStatus(): Promise<BridgeStatus | null> {
  return invoke<BridgeStatus | null>('claude_bridge_status')
}

export async function getClaudeMcpStatus(claudePath?: string): Promise<McpRegisterStatus> {
  return invoke<McpRegisterStatus>('claude_mcp_status', {
    claudePath: claudePath || null,
  })
}

export async function registerClaudeMcp(claudePath?: string): Promise<McpRegisterStatus> {
  return invoke<McpRegisterStatus>('claude_register_mcp', {
    claudePath: claudePath || null,
  })
}

/** 等待 MCP stdio 能列出工具（发送首条 AI 消息前调用，减少 Claude 拿不到工具的概率） */
export async function waitClaudeMcpTools(timeoutMs = 10_000): Promise<number> {
  return invoke<number>('claude_wait_mcp_tools', { timeoutMs })
}

export async function updateIdeContext(context: IdeContext): Promise<void> {
  return invoke<void>('claude_update_context', { context })
}

export async function sendClaudeMessage(options: {
  prompt: string
  claudePath?: string
  sessionId?: string
  continueSession?: boolean
  /** 由前端预生成并先注册 stream handler，避免 spawn 后事件早于注册 */
  requestId?: string
}): Promise<string> {
  return invoke<string>('claude_send_message', {
    prompt: options.prompt,
    claudePath: options.claudePath || null,
    sessionId: options.sessionId || null,
    continueSession: options.continueSession ?? false,
    requestId: options.requestId || null,
  })
}

export async function cancelClaudeMessage(requestId: string): Promise<void> {
  return invoke<void>('claude_cancel_message', { requestId })
}

export async function cancelAllClaudeMessages(): Promise<void> {
  return invoke<void>('claude_cancel_all_messages')
}

export async function restartClaudeBridge(
  workspaceFolders: string[] = [],
  claudePath?: string
): Promise<BridgeStatus> {
  await stopClaudeBridge()
  return startClaudeBridge(workspaceFolders, claudePath)
}

export async function listenClaudeStream(
  handler: (event: ClaudeStreamEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  const unlisten = await listen<ClaudeStreamEvent>('claude:stream', e => {
    handler(e.payload)
  })
  return unlisten
}

export async function listenBridgeConnected(handler: () => void): Promise<() => void> {
  if (!isTauriRuntime()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  const unlisten = await listen('claude:bridge-connected', () => handler())
  return unlisten
}

export async function getClaudeLogFilePath(): Promise<string | null> {
  if (!isTauriRuntime()) return null
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<string | null>('claude_log_file_path')
}

export interface ClaudeDiagEvent {
  kind: string
  message: string
}

export async function listenClaudeDiag(
  handler: (event: ClaudeDiagEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  const unlisten = await listen<ClaudeDiagEvent>('claude:diag', e => handler(e.payload))
  return unlisten
}
