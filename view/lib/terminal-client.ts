import { isTauriRuntime } from '@/lib/tauri-env'
import type { Session, AuthConfig, JumpHostConfig } from '@/lib/types'
import { getRuntimePassword } from '@/lib/runtime-password'
import { getStoredPassword } from '@/lib/password-vault-local'
import {
  appendTerminalRecordingEvent,
  isTerminalRecording,
} from '@/lib/terminal-recording-store'

export interface TerminalConnectRequest {
  sessionId: string
  type: Session['type']
  host: string
  port?: number
  user?: string
  authMethod?: Session['authMethod']
  password?: string
  privateKeyPath?: string
  jumpHost?: JumpHostConfig
  jumpHosts?: JumpHostConfig[]
  authConfig?: AuthConfig
  // Serial specific
  serialPort?: string
  baudRate?: number
  dataBits?: number
  stopBits?: number
  parity?: 'none' | 'odd' | 'even'
}

export interface TerminalOutputEvent {
  sessionId: string
  data: string
}

export interface TerminalStatusEvent {
  sessionId: string
  status: 'connecting' | 'connected' | 'disconnected' | 'error'
  error?: string
  /** Windows 本地 PTY 实际启动的 shell（后端解析） */
  windowsShell?: 'powershell' | 'cmd'
}

export interface RemoteFileEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  permissions?: string
}

const SUPPORTED_TYPES: Session['type'][] = ['ssh', 'telnet', 'serial', 'local', 'wsl']

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
    jumpHost: session.jumpHost,
    jumpHosts: session.jumpHosts,
    authConfig: session.authConfig,
    serialPort: session.serialPort,
    baudRate: session.baudRate,
    dataBits: session.dataBits,
    stopBits: session.stopBits,
    parity: session.parity,
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
    jumpHost: session.jumpHost ?? session.jumpHosts?.[0] ?? null,
    jumpHosts: session.jumpHosts ?? (session.jumpHost ? [session.jumpHost] : null),
    serialPort: session.serialPort ?? null,
    baudRate: session.baudRate ?? null,
    dataBits: session.dataBits ?? null,
    stopBits: session.stopBits ?? null,
    parity: session.parity ?? null,
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
  if (isTerminalRecording(sessionId)) {
    appendTerminalRecordingEvent(sessionId, 'i', data)
  }
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

/** Rust 侧逻辑偏移（环形缓冲裁剪后仍有效） */
export async function getTerminalBufferLen(sessionId: string): Promise<number> {
  return invoke<number>('terminal_buffer_len', { sessionId })
}

export async function readTerminalBufferSince(
  sessionId: string,
  offset: number
): Promise<string> {
  return invoke<string>('terminal_buffer_read_since', { sessionId, offset })
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

export type { RemoteShellPlatform } from '@/lib/terminal-cwd'
import type { RemoteShellPlatform } from '@/lib/terminal-cwd'

export async function detectRemotePlatform(session: Session): Promise<RemoteShellPlatform> {
  const label = await invoke<string>('terminal_detect_platform', {
    request: sessionToInvokeRequest(session),
  })
  return label === 'windows' ? 'windows' : 'unix'
}

export async function listLocalDirectory(
  sessionType: 'local' | 'wsl',
  path: string
): Promise<RemoteFileEntry[]> {
  return invoke<RemoteFileEntry[]>('local_list_directory', {
    sessionType,
    path,
  })
}

export async function readLocalFile(
  sessionType: 'local' | 'wsl',
  path: string
): Promise<string> {
  return invoke<string>('local_read_file', { sessionType, path })
}

export async function writeLocalFile(
  sessionType: 'local' | 'wsl',
  path: string,
  content: string
): Promise<void> {
  return invoke<void>('local_write_file', { sessionType, path, content })
}

export async function getLocalHomeDir(sessionType: 'local' | 'wsl'): Promise<string> {
  return invoke<string>('local_get_home_dir', { sessionType })
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

export async function renameRemotePath(
  session: Session,
  source: string,
  newName: string,
  options?: RemoteFileOptions
): Promise<void> {
  return invoke<void>('terminal_rename_path', {
    request: sessionToInvokeRequest(session),
    source,
    newName,
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

export async function createRemoteDirectory(
  session: Session,
  dirPath: string,
  folderName: string,
  options?: RemoteFileOptions
): Promise<void> {
  return invoke<void>('terminal_create_directory', {
    request: sessionToInvokeRequest(session),
    dirPath,
    folderName,
    useRoot: options?.useRoot ?? false,
  })
}

export async function searchRemoteFiles(
  session: Session,
  basePath: string,
  query: string,
  options?: RemoteFileOptions & { maxDepth?: number }
): Promise<RemoteFileEntry[]> {
  return invoke<RemoteFileEntry[]>('terminal_search_files', {
    request: sessionToInvokeRequest(session),
    basePath,
    query,
    maxDepth: options?.maxDepth ?? 5,
    useRoot: options?.useRoot ?? false,
  })
}

export async function chmodRemotePath(
  session: Session,
  path: string,
  mode: string,
  options?: RemoteFileOptions
): Promise<void> {
  return invoke<void>('terminal_chmod_path', {
    request: sessionToInvokeRequest(session),
    path,
    mode,
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
  gpuPercent?: number
  diskReadBps?: number
  diskWriteBps?: number
  netRxBps?: number
  netTxBps?: number
  loadAvg1?: number
  loadAvg5?: number
  loadAvg15?: number
  uptimeSecs?: number
  swapTotalBytes?: number
  swapUsedBytes?: number
  memBuffersBytes?: number
  memCachedBytes?: number
  cpuCores?: number
  hostname?: string
  processCount?: number
}

export async function exportTerminalBuffer(sessionId: string): Promise<string> {
  return invoke<string>('terminal_export_buffer', { sessionId })
}

export async function getRemoteHostStats(session: Session): Promise<RemoteHostStats> {
  return invoke<RemoteHostStats>('terminal_get_host_stats', {
    request: sessionToInvokeRequest(session),
  })
}

export interface RemoteProcess {
  pid: number
  user?: string
  cpuPercent: number
  memPercent: number
  memBytes?: number
  command: string
}

export async function listRemoteProcesses(session: Session): Promise<RemoteProcess[]> {
  return invoke<RemoteProcess[]>('terminal_list_processes', {
    request: sessionToInvokeRequest(session),
  })
}

export async function killRemoteProcess(
  session: Session,
  pid: number,
  force = false
): Promise<void> {
  return invoke<void>('terminal_kill_process', {
    request: sessionToInvokeRequest(session),
    pid,
    force,
  })
}

export interface RemotePort {
  pid: number
  port: number
  protocol: string
  address: string
  command?: string
}

export async function listRemotePorts(session: Session): Promise<RemotePort[]> {
  return invoke<RemotePort[]>('terminal_list_ports', {
    request: sessionToInvokeRequest(session),
  })
}

export async function killRemotePort(
  session: Session,
  port: number,
  protocol: string
): Promise<void> {
  return invoke<void>('terminal_kill_port', {
    request: sessionToInvokeRequest(session),
    port,
    protocol,
  })
}

type TerminalWriteListener = (sessionId: string, data: string) => void
const terminalWriteListeners = new Set<TerminalWriteListener>()

export function onTerminalWrite(listener: TerminalWriteListener): () => void {
  terminalWriteListeners.add(listener)
  return () => terminalWriteListeners.delete(listener)
}

function notifyTerminalWrite(sessionId: string, data: string) {
  terminalWriteListeners.forEach(fn => {
    try {
      fn(sessionId, data)
    } catch (err) {
      console.error('terminal write listener failed', err)
    }
  })
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
