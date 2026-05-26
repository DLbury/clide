import { isTauriRuntime } from '@/lib/tauri-env'
import type { Session, AuthConfig } from '@/lib/types'
import { getRuntimePassword } from '@/lib/runtime-password'
import { getStoredPassword } from '@/lib/password-vault-local'

export interface TerminalConnectRequest {
  sessionId: string
  type: Session['type']
  host: string
  port?: number
  user?: string
  authMethod?: Session['authMethod']
  password?: string
  privateKeyPath?: string
  authConfig?: AuthConfig
}

export interface TerminalOutputEvent {
  sessionId: string
  data: string
}

export interface TerminalStatusEvent {
  sessionId: string
  status: 'connecting' | 'connected' | 'disconnected' | 'error'
  error?: string
}

export interface RemoteFileEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  permissions?: string
}

const SUPPORTED_TYPES: Session['type'][] = ['ssh', 'local', 'wsl']

export function isTerminalBackendSupported(type: Session['type']): boolean {
  return isTauriRuntime() && SUPPORTED_TYPES.includes(type)
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) {
    throw new Error('终端后端仅在 Tauri 桌面版可用')
  }
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke<T>(cmd, args)
}

export function sessionToConnectRequest(session: Session): TerminalConnectRequest {
  return {
    sessionId: session.id,
    type: session.type,
    host: session.host,
    port: session.port,
    user: session.user,
    authMethod: session.authMethod,
    password: session.password,
    privateKeyPath: session.privateKeyPath,
    authConfig: session.authConfig,
  }
}

/**
 * 将 AuthConfig 转换为后端 AuthMethodType
 */
function authConfigToBackend(authConfig?: AuthConfig): Record<string, unknown> | null {
  if (!authConfig) return null

  switch (authConfig.type) {
    case 'password-env':
      return {
        passwordEnv: { envVar: authConfig.envVar || 'SSH_PASSWORD' }
      }
    case 'password-keychain':
      return {
        passwordWindowsCredential: { targetName: authConfig.keychainTarget || '' }
      }
    case 'password-plain':
      return {
        passwordPlain: { password: authConfig.plainPassword || '' }
      }
    case 'key-env':
      return {
        keyEnv: { envVar: authConfig.envVar || 'SSH_KEY_PATH' }
      }
    case 'key-path':
      return {
        keyPath: { path: authConfig.keyPath || '' }
      }
    case 'ssh-agent':
      return { sshAgent: {} }
    case 'default-keys':
      return { defaultKeys: {} }
    default:
      return null
  }
}

function sessionToInvokeRequest(session: Session) {
  const auth = authConfigToBackend(session.authConfig)

  let authMethod = session.authMethod ?? null
  let password = session.password ?? null
  let privateKeyPath = session.privateKeyPath ?? null

  const runtimePw = getRuntimePassword(session.id) ?? getStoredPassword(session.id)
  if (runtimePw) {
    authMethod = 'password'
    password = runtimePw
  }

  const cfg = session.authConfig
  if (cfg && !runtimePw) {
    switch (cfg.type) {
      case 'password-plain':
        if (cfg.plainPassword) {
          authMethod = 'password'
          password = cfg.plainPassword
        } else if (session.authMethod === 'password') {
          authMethod = 'password'
        } else {
          authMethod = 'none'
        }
        break
      case 'key-path':
        if (cfg.keyPath) {
          authMethod = 'key'
          privateKeyPath = cfg.keyPath
        }
        break
      case 'password-env':
        authMethod = 'password'
        break
      case 'key-env':
        authMethod = 'key'
        break
      case 'ssh-agent':
        authMethod = 'ssh-agent'
        break
      case 'default-keys':
        authMethod = 'none'
        break
      default:
        break
    }
  }

  return {
    sessionId: session.id,
    type: session.type,
    host: session.host,
    port: session.port ?? null,
    user: session.user ?? null,
    auth: auth ?? null,
    authMethod,
    password,
    privateKeyPath,
    envConfig: {},
  }
}

export async function connectTerminal(session: Session): Promise<void> {
  return connectTerminalSession(session, session.id)
}

/** 为指定 Shell 建立独立 PTY（与侧边栏会话配置相同，但使用独立 sessionId） */
export async function connectTerminalSession(
  session: Session,
  terminalSessionId: string
): Promise<void> {
  const request = sessionToInvokeRequest(session)
  request.sessionId = terminalSessionId
  return invoke<void>('terminal_connect', { request })
}

/** 去掉 AI/MCP 传入的多余换行；PTY 提交用单个 \r，与 xterm 回车一致 */
export function normalizeShellCommandForPty(command: string): string {
  const stripped = command.replace(/\x1b/g, '').trim()
  if (!stripped) return '\r'
  const normalized = stripped.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/, '')
  return `${normalized}\r`
}

export async function writeTerminal(sessionId: string, data: string): Promise<void> {
  notifyTerminalWrite(sessionId, data)
  return invoke<void>('terminal_write', { sessionId, data })
}

export async function resizeTerminal(
  sessionId: string,
  cols: number,
  rows: number
): Promise<void> {
  return invoke<void>('terminal_resize', { sessionId, cols, rows })
}

export async function disconnectTerminal(sessionId: string): Promise<void> {
  return invoke<void>('terminal_disconnect', { sessionId })
}

export async function isTerminalConnected(sessionId: string): Promise<boolean> {
  return invoke<boolean>('terminal_is_connected', { sessionId })
}

export type RemoteFileOptions = {
  useRoot?: boolean
}

export async function listRemoteDirectory(
  session: Session,
  path: string,
  options?: RemoteFileOptions
): Promise<RemoteFileEntry[]> {
  return invoke<RemoteFileEntry[]>('terminal_list_directory', {
    request: sessionToInvokeRequest(session),
    path,
    useRoot: options?.useRoot ?? false,
  })
}

export async function readRemoteFile(
  session: Session,
  path: string,
  options?: RemoteFileOptions
): Promise<string> {
  return invoke<string>('terminal_read_file', {
    request: sessionToInvokeRequest(session),
    path,
    useRoot: options?.useRoot ?? false,
  })
}

export async function writeRemoteFile(
  session: Session,
  path: string,
  content: string,
  options?: RemoteFileOptions
): Promise<void> {
  return invoke<void>('terminal_write_file', {
    request: sessionToInvokeRequest(session),
    path,
    content,
    useRoot: options?.useRoot ?? false,
  })
}

export async function readRemoteFileBinary(
  session: Session,
  path: string,
  options?: RemoteFileOptions
): Promise<string> {
  return invoke<string>('terminal_read_file_binary', {
    request: sessionToInvokeRequest(session),
    path,
    useRoot: options?.useRoot ?? false,
  })
}

export async function writeRemoteFileBinary(
  session: Session,
  path: string,
  contentBase64: string,
  options?: RemoteFileOptions
): Promise<void> {
  return invoke<void>('terminal_write_file_binary', {
    request: sessionToInvokeRequest(session),
    path,
    contentBase64,
    useRoot: options?.useRoot ?? false,
  })
}

export async function getRemoteCwd(
  session: Session,
  options?: RemoteFileOptions
): Promise<string> {
  return invoke<string>('terminal_get_cwd', {
    request: sessionToInvokeRequest(session),
    useRoot: options?.useRoot ?? false,
  })
}

export async function moveRemotePath(
  session: Session,
  source: string,
  destDir: string,
  options?: RemoteFileOptions
): Promise<void> {
  return invoke<void>('terminal_move_path', {
    request: sessionToInvokeRequest(session),
    source,
    destDir,
    useRoot: options?.useRoot ?? false,
  })
}

export async function deleteRemotePath(
  session: Session,
  path: string,
  options?: RemoteFileOptions
): Promise<void> {
  return invoke<void>('terminal_delete_path', {
    request: sessionToInvokeRequest(session),
    path,
    useRoot: options?.useRoot ?? false,
  })
}

export interface RemoteHostStats {
  cpuPercent: number
  memTotalBytes: number
  memUsedBytes: number
  diskTotalBytes: number
  diskUsedBytes: number
  gpuMemTotalBytes?: number
  gpuMemUsedBytes?: number
}

export async function getRemoteHostStats(session: Session): Promise<RemoteHostStats> {
  return invoke<RemoteHostStats>('terminal_get_host_stats', {
    request: sessionToInvokeRequest(session),
  })
}

type TerminalWriteListener = (sessionId: string, data: string) => void
const terminalWriteListeners = new Set<TerminalWriteListener>()

export function onTerminalWrite(listener: TerminalWriteListener): () => void {
  terminalWriteListeners.add(listener)
  return () => terminalWriteListeners.delete(listener)
}

function notifyTerminalWrite(sessionId: string, data: string) {
  terminalWriteListeners.forEach(fn => fn(sessionId, data))
}

export async function listenTerminalOutput(
  handler: (event: TerminalOutputEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  const unlisten = await listen<TerminalOutputEvent>('terminal:output', e => {
    handler(e.payload)
  })
  return unlisten
}

export async function listenTerminalStatus(
  handler: (event: TerminalStatusEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  const unlisten = await listen<TerminalStatusEvent>('terminal:status', e => {
    handler(e.payload)
  })
  return unlisten
}
