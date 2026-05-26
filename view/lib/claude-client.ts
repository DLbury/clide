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

export interface McpRegisterStatus {
  projectRoot: string
  mcpScriptExists: boolean
  projectMcpConfigReady: boolean
  claudeProjectRegistered: boolean
  ready: boolean
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

export async function detectClaude(): Promise<ClaudeDetectResult> {
  return invoke<ClaudeDetectResult>('claude_detect')
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

export async function updateIdeContext(context: IdeContext): Promise<void> {
  return invoke<void>('claude_update_context', { context })
}

export async function sendClaudeMessage(options: {
  prompt: string
  claudePath?: string
  sessionId?: string
  continueSession?: boolean
}): Promise<string> {
  return invoke<string>('claude_send_message', {
    prompt: options.prompt,
    claudePath: options.claudePath || null,
    sessionId: options.sessionId || null,
    continueSession: options.continueSession ?? false,
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
