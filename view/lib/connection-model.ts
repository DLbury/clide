import type { EditorModel } from '@/lib/editor-service'
import type { ConnectedServerBrief } from '@/lib/extract-shell-command'
import { connectionSessionStatus } from '@/lib/connection-status'
import { sanitizeTerminalOutput } from '@/lib/terminal-sanitize'
import { getTerminalOutputBuffer } from '@/lib/terminal-stream'
import type { RemoteShellPlatform } from '@/lib/terminal-client'
import type { ChatMessage, FileItem, Session, SessionFolder, TerminalLine } from '@/lib/types'

export interface Shell {
  id: string
  name: string
  history: TerminalLine[]
  terminalSessionId: string
  terminalStatus?: 'connecting' | 'connected' | 'disconnected' | 'error'
  shellCwd?: string
}

export interface BrowserTab {
  id: string
  title: string
  url: string
  webviewLabel: string
  tunnelId?: string
}

export interface SyncGroupMember {
  sourceConnectionId: string
  session: Session
}

export interface ServerConnection {
  id: string
  session: Session
  shells: Shell[]
  activeShellId: string
  openFiles: EditorModel[]
  activeFileId: string | null
  selectedFilePath: string | null
  aiMessages: ChatMessage[]
  aiThinking: boolean
  claudeSessionId?: string
  terminalLive?: boolean
  remoteFiles?: FileItem[]
  remotePath?: string
  remotePlatform?: RemoteShellPlatform
  remoteFileError?: string | null
  browserTabs?: BrowserTab[]
  activeBrowserTabId?: string | null
  monitorOpen?: boolean
  isSyncGroup?: boolean
  syncMembers?: SyncGroupMember[]
}

const MAX_HISTORY_LINES = 200
const MAX_LINE_CONTENT_CHARS = 8000
const MAX_AI_MESSAGES = 120

export function trimAgentMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.length > MAX_AI_MESSAGES
    ? messages.slice(messages.length - MAX_AI_MESSAGES)
    : messages
}

export function formatSessionHost(session: Session): string {
  if (session.type === 'ssh' || session.type === 'telnet') {
    const user = session.user ?? 'root'
    const port = session.port ? `:${session.port}` : ''
    return `${user}@${session.host}${port} (${session.type})`
  }
  if (session.type === 'local' || session.type === 'wsl') {
    return `本机 ${session.host} (${session.type})`
  }
  return session.host
}

export function connectionTerminalConnected(conn: ServerConnection): boolean {
  return conn.shells.some(shell => shell.terminalStatus === 'connected')
}

export function buildConnectedServerBriefs(
  connections: ServerConnection[],
  activeConnectionId: string | null
): ConnectedServerBrief[] {
  return connections
    .filter(connection => !connection.isSyncGroup)
    .map(connection => ({
      profileId: connection.session.id,
      name: connection.session.name,
      host: formatSessionHost(connection.session),
      terminalConnected: connectionTerminalConnected(connection),
      isFocused: connection.id === activeConnectionId,
    }))
}

export function terminalSnippetForConnection(conn: ServerConnection): string | undefined {
  const shell = conn.shells.find(item => item.id === conn.activeShellId) ?? conn.shells[0]
  if (!shell) return undefined
  if (conn.terminalLive) {
    const buffer = getTerminalOutputBuffer(shell.terminalSessionId)
    return buffer.length > 0 ? buffer.slice(-8000) : undefined
  }
  const text = shell.history
    .slice(-20)
    .map(line => line.content)
    .join('\n')
  return text || undefined
}

export function buildRuntimeSyncKey(
  folders: { id: string; isExpanded: boolean; sessions: { id: string; status: string }[] }[],
  connections: ServerConnection[],
  activeConnectionId: string | null
): string {
  const folderPart = folders
    .map(
      folder =>
        `${folder.id}:${folder.isExpanded ? 1 : 0}:${folder.sessions
          .map(session => `${session.id}:${session.status}`)
          .join(',')}`
    )
    .join('|')
  const connectionPart = connections
    .map(connection =>
      [
        connection.id,
        connection.activeShellId,
        connection.session.id,
        connection.session.status,
        connection.shells
          .map(shell => `${shell.id}:${shell.terminalSessionId}:${shell.terminalStatus ?? ''}`)
          .join(';'),
      ].join(':')
    )
    .join('|')
  return `${folderPart}#${connectionPart}#${activeConnectionId ?? ''}`
}

export function appendTerminalOutput(history: TerminalLine[], data: string): TerminalLine[] {
  const cleaned = sanitizeTerminalOutput(data)
  if (!cleaned) return history
  const last = history[history.length - 1]
  if (last && (last.type === 'output' || last.type === 'error')) {
    const merged = last.content + cleaned
    const content =
      merged.length > MAX_LINE_CONTENT_CHARS
        ? merged.slice(merged.length - MAX_LINE_CONTENT_CHARS)
        : merged
    const next = [...history.slice(0, -1), { ...last, content }]
    return next.length > MAX_HISTORY_LINES ? next.slice(next.length - MAX_HISTORY_LINES) : next
  }
  const appended = [
    ...history,
    {
      id: `out-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: 'output' as const,
      content: cleaned,
      timestamp: new Date(),
    },
  ]
  return appended.length > MAX_HISTORY_LINES
    ? appended.slice(appended.length - MAX_HISTORY_LINES)
    : appended
}

export function setSessionStatusInFolders(
  folders: SessionFolder[],
  sessionId: string,
  status: Session['status']
): SessionFolder[] {
  return folders.map(folder => ({
    ...folder,
    sessions: folder.sessions.map(session =>
      session.id === sessionId ? { ...session, status } : session
    ),
  }))
}

export function updateConnectionShellByTerminalId(
  conn: ServerConnection,
  terminalSessionId: string,
  updateShell: (shell: Shell) => Shell
): ServerConnection | null {
  if (!conn.shells.some(shell => shell.terminalSessionId === terminalSessionId)) {
    return null
  }
  const shells = conn.shells.map(shell =>
    shell.terminalSessionId === terminalSessionId ? updateShell(shell) : shell
  )
  return {
    ...conn,
    shells,
    session: { ...conn.session, status: connectionSessionStatus(shells) },
  }
}
