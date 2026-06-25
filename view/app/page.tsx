'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { Sidebar } from '@/components/terminal/sidebar'
import { ServerTabs } from '@/components/terminal/server-tabs'
import { StatusBar } from '@/components/terminal/status-bar'
import { NewSessionModal, DEFAULT_FOLDER_PLACEHOLDER } from '@/components/terminal/new-session-modal'
import { SettingsModal } from '@/components/settings/settings-modal'
import { useAiSettings } from '@/lib/ai-settings'
import {
  sendClaudeMessage,
  cancelClaudeMessage,
  detectClaude,
  isIdeBridgeReady,
  type IdeContext,
} from '@/lib/claude-client'
import { useClaudeCode } from '@/hooks/use-claude-code'
import { isTauriRuntime } from '@/lib/tauri-env'
import {
  buildRuntimeSnapshot,
  syncAppRuntime,
  registerProfileAuth,
  listenToolActivity,
  subscribeClaudeToolRequest,
  type ToolActivityEvent,
} from '@/lib/runtime-sync'
import {
  connectTerminal,
  connectTerminalSession,
  disconnectTerminal,
  writeTerminal,
  normalizeShellCommandForPty,
  listenTerminalStatus,
  listRemoteDirectory,
  readRemoteFile,
  writeRemoteFile,
  getRemoteCwd,
  getRemoteHostStats,
  type RemoteHostStats,
  onTerminalWrite,
  isTerminalBackendSupported,
} from '@/lib/terminal-client'
import {
  subscribeAllTerminalOutput,
  clearTerminalOutputBuffer,
  getTerminalOutputBuffer,
  injectAiCommandEcho,
  requestTerminalResync,
  ensureTerminalOutputListener,
} from '@/lib/terminal-stream'
import { updateIdeContext } from '@/lib/claude-client'
import { makeTerminalSessionId } from '@/lib/terminal-session'
import {
  remoteEntriesToFileTree,
  mergeRemoteChildren,
  resolveRemoteDisplayPath,
} from '@/lib/remote-file-tree'
import {
  loadFollowTerminalCwd,
  saveFollowTerminalCwd,
  loadFileRootMode,
  saveFileRootMode,
} from '@/lib/file-explorer-settings'
import {
  defaultRemoteHome,
  extractCwdFromTerminalChunk,
  parseCdTargetFromCommand,
  remotePathForListApi,
} from '@/lib/terminal-cwd'
import {
  deleteRemoteFile,
  downloadRemoteFile,
  moveRemoteFile,
  uploadFilesToRemote,
  type UploadProgress,
} from '@/lib/remote-file-transfer'
import { matchShortcutAction, isTypingTarget } from '@/lib/layout-shortcuts'
import type { SettingsTab } from '@/lib/layout-shortcuts'
import { ResizablePanel } from '@/components/layout/resizable-panel'
import { WorkbenchLayout, type WorkbenchLayoutHandle } from '@/components/layout/workbench-layout'
import { FileTree } from '@/components/layout/file-tree'
import { DeleteRemoteFileDialog } from '@/components/layout/delete-remote-file-dialog'
import { AiPane } from '@/components/layout/ai-pane'
import { AppAlertDialog, type AppAlertDialogState } from '@/components/ui/app-alert-dialog'
import { readFileContent, writeFileContent } from '@/lib/file-system'
import {
  openEditorModel,
  updateEditorContent,
  saveEditorModel,
  closeEditorModel,
  setEditorLoadedContent,
  type EditorModel,
} from '@/lib/editor-service'
import { sanitizeTerminalOutput } from '@/lib/terminal-sanitize'
import {
  buildIdeToolDirective,
  extractShellCommands,
  isRemoteConnectionRefusal,
} from '@/lib/extract-shell-command'
import { isStaleClaudeSessionError } from '@/lib/claude-session'
import {
  cancelShellToolForSession,
  executeShellToolInTab,
  registerShellToolKeepaliveTouch,
  registerShellToolPromptListener,
} from '@/lib/shell-tool-executor'
import {
  applyClaudeStreamEvent,
  applyToolActivityToMessage,
  finalizeAssistantTurn,
  messageHasRunningTools,
  messageHasTextContent,
} from '@/lib/chat-stream-parts'
// Keep import separate to avoid circular edits near large file blocks.
import { appendAssistantTextPart } from '@/lib/chat-stream-parts'
import { cn } from '@/lib/utils'
import { ensureDefaultFolder, useSessionFolders } from '@/lib/session-store'
import {
  createDefaultLocalShellSession,
  DEFAULT_LOCAL_SHELL_SESSION_ID,
  findLegacyDefaultLocalShellSession,
  isDefaultLocalShellSession,
  stripLegacyDefaultLocalSessions,
} from '@/lib/default-local-shell'
import { createInitialDesktopConnection } from '@/lib/initial-desktop-state'
import {
  authConfigFromSession,
  newSessionId,
  resolveSessionForConnect,
  sessionNeedsPasswordPrompt,
  sessionWithRuntimePassword,
  sessionAllowsDefaultKeysFallback,
  isSshAuthFailureError,
} from '@/lib/auth-config'
import { setRuntimePassword, clearRuntimePassword } from '@/lib/runtime-password'
import { setStoredPassword, getStoredPassword, removeStoredPassword } from '@/lib/password-vault-local'
import { SessionPasswordDialog } from '@/components/terminal/session-password-dialog'
import type { Session, SessionFolder, TerminalLine, FileItem, ChatMessage, SessionFormPayload } from '@/lib/types'

interface PendingPasswordConnect {
  session: Session
  connectionId: string
  shellId: string
  terminalSessionId: string
  allowDefaultKeys: boolean
  authFailureReason?: string
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} 超时（>${Math.round(timeoutMs / 1000)}s）`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

interface Shell {
  id: string
  name: string
  history: TerminalLine[]
  /** 后端独立 PTY 会话 ID */
  terminalSessionId: string
  terminalStatus?: 'connecting' | 'connected' | 'disconnected' | 'error'
  /** Shell 当前工作目录（跟随终端时更新） */
  shellCwd?: string
}

interface ServerConnection {
  id: string
  session: Session
  shells: Shell[]
  activeShellId: string
  openFiles: EditorModel[]
  activeFileId: string | null
  selectedFilePath: string | null
  aiMessages: ChatMessage[]
  aiThinking: boolean
  /** 本连接独立的 Claude Code 会话 ID（--resume） */
  claudeSessionId?: string
  /** 由 Tauri 后端驱动的真实终端 */
  terminalLive?: boolean
  /** SSH 远程目录列表 */
  remoteFiles?: FileItem[]
  remotePath?: string
}

const MAX_HISTORY_LINES = 200
const MAX_LINE_CONTENT_CHARS = 8000
const MAX_AI_MESSAGES = 120

function appendTerminalOutput(history: TerminalLine[], data: string): TerminalLine[] {
  const cleaned = sanitizeTerminalOutput(data)
  if (!cleaned) return history
  const last = history[history.length - 1]
  if (last && (last.type === 'output' || last.type === 'error')) {
    const merged = last.content + cleaned
    // 单行内容过长时截断，避免巨型日志撑爆内存
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

function setSessionStatusInFolders(
  folders: SessionFolder[],
  sessionId: string,
  status: Session['status']
): SessionFolder[] {
  return folders.map(folder => ({
    ...folder,
    sessions: folder.sessions.map(s =>
      s.id === sessionId ? { ...s, status } : s
    ),
  }))
}

function connectionSessionStatus(shells: Shell[]): Session['status'] {
  if (shells.some(s => s.terminalStatus === 'connected')) return 'connected'
  if (shells.some(s => s.terminalStatus === 'connecting')) return 'connecting'
  return 'disconnected'
}

function updateConnectionShellByTerminalId(
  conn: ServerConnection,
  terminalSessionId: string,
  updateShell: (shell: Shell) => Shell
): ServerConnection | null {
  if (!conn.shells.some(s => s.terminalSessionId === terminalSessionId)) {
    return null
  }
  const shells = conn.shells.map(s =>
    s.terminalSessionId === terminalSessionId ? updateShell(s) : s
  )
  return {
    ...conn,
    shells,
    session: { ...conn.session, status: connectionSessionStatus(shells) },
  }
}

export default function AITerminal() {
  const { settings: aiSettings, updateSettings: updateAiSettings, clearClaudeSessionId } =
    useAiSettings()
  const { folders, setFolders, loaded: foldersLoaded } = useSessionFolders()
  const [connections, setConnections] = useState<ServerConnection[]>([])
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null)
  const [isNewSessionModalOpen, setIsNewSessionModalOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('ai')
  const [showSidebar, setShowSidebar] = useState(true)
  const [showFileTree, setShowFileTree] = useState(true)
  const [showAiPane, setShowAiPane] = useState(true)
  const workbenchRef = useRef<WorkbenchLayoutHandle>(null)
  const [editingSession, setEditingSession] = useState<Session | null>(null)
  const [newSessionFolderId, setNewSessionFolderId] = useState<string | null>(null)
  const initialLocalConnectRef = useRef(false)
  const [terminalClearSignals, setTerminalClearSignals] = useState<Record<string, number>>({})
  const [toolActivities, setToolActivities] = useState<ToolActivityEvent[]>([])
  const [passwordPrompt, setPasswordPrompt] = useState<PendingPasswordConnect | null>(null)
  const [interactivePrompt, setInteractivePrompt] = useState<{
    sessionId: string
    command: string
    prompt: string
  } | null>(null)
  const interactivePromptRef = useRef(interactivePrompt)
  interactivePromptRef.current = interactivePrompt
  const [followTerminalCwd, setFollowTerminalCwd] = useState(loadFollowTerminalCwd)
  const [fileRootMode, setFileRootMode] = useState(loadFileRootMode)
  const [transferBusy, setTransferBusy] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<FileItem | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [hostStats, setHostStats] = useState<RemoteHostStats | null>(null)
  const [appAlert, setAppAlert] = useState<AppAlertDialogState>({
    open: false,
    title: '',
  })
  const followTerminalCwdRef = useRef(followTerminalCwd)
  followTerminalCwdRef.current = followTerminalCwd
  const fileRootModeRef = useRef(fileRootMode)
  fileRootModeRef.current = fileRootMode

  const remoteFileOpts = useCallback(
    () => ({ useRoot: fileRootModeRef.current }),
    []
  )
  const connectionsRef = useRef(connections)
  connectionsRef.current = connections
  const foldersRef = useRef(folders)
  foldersRef.current = folders
  const activeConnectionIdRef = useRef(activeConnectionId)
  activeConnectionIdRef.current = activeConnectionId
  const handleShellChangeRef = useRef<(shellId: string) => void>(() => {})
  const mcpShellCommandThisTurnRef = useRef(false)
  /** MCP connectServer：profileId → requestId，等待 terminal:status 后 complete_connect_tool */
  const pendingMcpConnectRef = useRef(new Map<string, string>())
  const activeAssistantIdRef = useRef<string | null>(null)
  const handleClaudeToolRequestRef = useRef<
    (payload: Record<string, unknown>) => void
  >(() => {})
  const claudeRequestsByConnectionRef = useRef<Map<string, Set<string>>>(new Map())
  /** 按 requestId 续期 Claude 静默超时（MCP/Shell 阻塞时 stdout 可能长时间无事件） */
  const claudeSilentKeepaliveRef = useRef(
    new Map<
      string,
      { touch: () => void; markLongRunning: () => void; dispose: () => void }
    >()
  )
  const keepalivePendingClaudeRequests = (connectionId: string | undefined, long = true) => {
    if (!connectionId) return
    const pending = claudeRequestsByConnectionRef.current.get(connectionId)
    if (!pending) return
    for (const rid of pending) {
      const k = claudeSilentKeepaliveRef.current.get(rid)
      if (long) k?.markLongRunning()
      else k?.touch()
    }
  }

  useEffect(() => {
    return registerShellToolKeepaliveTouch(() => {
      keepalivePendingClaudeRequests(activeConnectionIdRef.current, true)
    })
  }, [])

  useEffect(() => {
    return registerShellToolPromptListener(e => {
      setInteractivePrompt(prev =>
        prev && prev.sessionId === e.sessionId ? prev : e
      )
    })
  }, [])
  const claudeCodeRef = useRef<ReturnType<typeof useClaudeCode> | null>(null)
  const aiSettingsRef = useRef(aiSettings)
  aiSettingsRef.current = aiSettings

  // Restore initial desktop connection on client side to avoid hydration mismatch
  useEffect(() => {
    const initial = createInitialDesktopConnection()
    if (initial) {
      setConnections(initial.connections as ServerConnection[])
      setActiveConnectionId(initial.activeConnectionId)
      // PTY 连接在终端监听器就绪后由下方 AutoConnect effect 发起，避免首包丢失
    }
  }, [])

  const activeConnection = connections.find(c => c.id === activeConnectionId)
  const activeSession = activeConnection?.session

  const getIdeContext = useCallback((): IdeContext => {
    const shell = activeConnection?.shells.find(s => s.id === activeConnection?.activeShellId)
    let terminalSnippet: string | undefined
    if (shell && activeConnection) {
      if (activeConnection.terminalLive) {
        const buf = getTerminalOutputBuffer(shell.terminalSessionId)
        terminalSnippet = buf.length > 0 ? buf.slice(-12000) : undefined
      } else {
        const text = shell.history
          .slice(-30)
          .map(line => line.content)
          .join('\n')
        terminalSnippet = text || undefined
      }
    }

    const session = activeConnection?.session
    let activeSessionHost: string | undefined
    if (session) {
      if (session.type === 'ssh' || session.type === 'telnet') {
        const user = session.user ?? 'root'
        const port = session.port ? `:${session.port}` : ''
        activeSessionHost = `${user}@${session.host}${port} (${session.type})`
      } else if (session.type === 'local' || session.type === 'wsl') {
        activeSessionHost = `本机 ${session.host} (${session.type})`
      } else {
        activeSessionHost = session.host
      }
    }

    return {
      workspaceFolders: [],
      activeSessionName: activeConnection?.session.name,
      activeSessionHost,
      activeProfileId: activeConnection?.session.id,
      activeConnectionId: activeConnection?.id,
      activeShellId: activeConnection?.activeShellId,
      terminalSnippet:
        aiSettings.injectTerminalContext && terminalSnippet ? terminalSnippet : undefined,
      openFiles: activeConnection?.openFiles.map(f => f.path) ?? [],
      activeFilePath: activeConnection?.openFiles.find(f => f.id === activeConnection?.activeFileId)
        ?.path,
    }
  }, [activeConnection, aiSettings.injectTerminalContext])

  useEffect(() => {
    if (
      !activeConnection ||
      activeConnection.session.type !== 'ssh' ||
      activeConnection.session.status !== 'connected'
    ) {
      setHostStats(null)
      return
    }

    let cancelled = false
    const session = resolveSessionForConnect(activeConnection.session)
    const poll = () => {
      void getRemoteHostStats(session)
        .then(stats => {
          if (!cancelled) setHostStats(stats)
        })
        .catch(() => {})
    }

    poll()
    const timer = window.setInterval(poll, 30_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [
    activeConnection?.id,
    activeConnection?.session.type,
    activeConnection?.session.status,
  ])

  const loadRemoteFiles = useCallback(
    async (session: Session, path = '~', options?: { mergeParentPath?: string }) => {
      if (session.type !== 'ssh' || !isTauriRuntime()) return

      const resolved = resolveSessionForConnect(session)
      const displayPath = resolveRemoteDisplayPath(path, session.user)

      try {
        const entries = await listRemoteDirectory(resolved, path, remoteFileOpts())
        const children = remoteEntriesToFileTree(entries)

        setConnections(prev =>
          prev.map(conn => {
            if (conn.session.id !== session.id) return conn

            if (options?.mergeParentPath) {
              return {
                ...conn,
                remoteFiles: mergeRemoteChildren(
                  conn.remoteFiles ?? [],
                  options.mergeParentPath,
                  children
                ),
                remotePath: conn.remotePath ?? displayPath,
              }
            }

            return {
              ...conn,
              remoteFiles: children,
              remotePath: displayPath,
            }
          })
        )
      } catch {
        /* 连接断开时保留已有文件树，避免列表突然变空 */
      }
    },
    [remoteFileOpts]
  )

  const handleRemoteNavigate = useCallback(
    (path: string) => {
      if (!activeConnection || activeConnection.session.type !== 'ssh') return
      void loadRemoteFiles(activeConnection.session, path)
    },
    [activeConnection, loadRemoteFiles]
  )

  const applyShellCwd = useCallback(
    (connectionId: string, terminalSessionId: string, cwd: string) => {
      const conn = connectionsRef.current.find(c => c.id === connectionId)
      if (!conn) return
      const shell = conn.shells.find(s => s.terminalSessionId === terminalSessionId)
      if (!shell || shell.shellCwd === cwd) return

      setConnections(prev =>
        prev.map(c => {
          if (c.id !== connectionId) return c
          const shells = c.shells.map(s =>
            s.terminalSessionId === terminalSessionId ? { ...s, shellCwd: cwd } : s
          )
          const isActiveShell = c.activeShellId === shell.id
          const shouldSync =
            followTerminalCwdRef.current && isActiveShell && c.session.type === 'ssh'
          return {
            ...c,
            shells,
            ...(shouldSync
              ? {
                  remotePath: resolveRemoteDisplayPath(
                    remotePathForListApi(cwd, c.session.user),
                    c.session.user
                  ),
                }
              : {}),
          }
        })
      )

      if (
        followTerminalCwdRef.current &&
        connectionId === activeConnectionIdRef.current &&
        shell.id === conn.activeShellId &&
        conn.session.type === 'ssh'
      ) {
        void loadRemoteFiles(conn.session, remotePathForListApi(cwd, conn.session.user))
      }
    },
    [loadRemoteFiles]
  )

  const handleFollowTerminalCwdChange = useCallback((enabled: boolean) => {
    setFollowTerminalCwd(enabled)
    saveFollowTerminalCwd(enabled)
    if (!enabled || !activeConnection || activeConnection.session.type !== 'ssh') return
    const shell = activeConnection.shells.find(s => s.id === activeConnection.activeShellId)
    if (!shell || shell.terminalStatus !== 'connected') return
    void getRemoteCwd(resolveSessionForConnect(activeConnection.session), remoteFileOpts())
      .then(cwd => applyShellCwd(activeConnection.id, shell.terminalSessionId, cwd))
      .catch(() => {})
  }, [activeConnection, applyShellCwd, remoteFileOpts])

  const handleFileRootModeChange = useCallback(
    (enabled: boolean) => {
      setFileRootMode(enabled)
      saveFileRootMode(enabled)
      if (!activeConnection || activeConnection.session.type !== 'ssh') return
      void loadRemoteFiles(
        activeConnection.session,
        activeConnection.remotePath ?? '~'
      )
    },
    [activeConnection, loadRemoteFiles]
  )

  const handleRemoteUpload = useCallback(
    async (files: FileList) => {
      if (!activeConnection || activeConnection.session.type !== 'ssh') return
      const dir =
        activeConnection.remotePath ??
        resolveRemoteDisplayPath('~', activeConnection.session.user)
      setTransferBusy(true)
      setUploadProgress(null)
      try {
        const { uploaded, errors } = await uploadFilesToRemote(
          activeConnection.session,
          dir,
          files,
          remoteFileOpts(),
          setUploadProgress
        )
        if (errors.length > 0) {
          setAppAlert({
            open: true,
            title: `已上传 ${uploaded} 个文件（部分失败）`,
            description: '以下文件上传失败：',
            details: errors.join('\n'),
          })
        }
        void loadRemoteFiles(
          activeConnection.session,
          remotePathForListApi(dir, activeConnection.session.user)
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setAppAlert({
          open: true,
          title: '上传失败',
          details: message,
        })
      } finally {
        setTransferBusy(false)
        setUploadProgress(null)
      }
    },
    [activeConnection, loadRemoteFiles, remoteFileOpts]
  )

  const handleRemoteMove = useCallback(
    async (sourcePath: string, destDir: string) => {
      if (!activeConnection || activeConnection.session.type !== 'ssh') return
      setTransferBusy(true)
      try {
        await moveRemoteFile(
          activeConnection.session,
          sourcePath,
          destDir,
          remoteFileOpts()
        )
        void loadRemoteFiles(
          activeConnection.session,
          remotePathForListApi(
            activeConnection.remotePath ?? '~',
            activeConnection.session.user
          )
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setAppAlert({
          open: true,
          title: '移动失败',
          details: message,
        })
      } finally {
        setTransferBusy(false)
      }
    },
    [activeConnection, loadRemoteFiles, remoteFileOpts]
  )

  const handleRemoteDownload = useCallback(
    async (file: FileItem) => {
      if (!activeConnection || activeConnection.session.type !== 'ssh' || file.type !== 'file') {
        return
      }
      setTransferBusy(true)
      try {
        await downloadRemoteFile(activeConnection.session, file.path, remoteFileOpts())
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setAppAlert({
          open: true,
          title: '下载失败',
          details: message,
        })
      } finally {
        setTransferBusy(false)
      }
    },
    [activeConnection, remoteFileOpts]
  )

  const handleRemoteDelete = useCallback((file: FileItem) => {
    if (!activeConnection || activeConnection.session.type !== 'ssh') return
    setDeleteError(null)
    setDeleteTarget(file)
  }, [activeConnection])

  const handleConfirmRemoteDelete = useCallback(async () => {
    if (!deleteTarget || !activeConnection || activeConnection.session.type !== 'ssh') return
    setTransferBusy(true)
    setDeleteError(null)
    try {
      await deleteRemoteFile(activeConnection.session, deleteTarget.path, remoteFileOpts())
      setDeleteTarget(null)
      void loadRemoteFiles(
        activeConnection.session,
        remotePathForListApi(
          activeConnection.remotePath ?? '~',
          activeConnection.session.user
        )
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setDeleteError(message)
    } finally {
      setTransferBusy(false)
    }
  }, [deleteTarget, activeConnection, loadRemoteFiles, remoteFileOpts])

  useEffect(() => {
    if (!isTauriRuntime() || !followTerminalCwd) return
    return subscribeAllTerminalOutput(event => {
      const cwd = extractCwdFromTerminalChunk(event.data)
      if (!cwd) return
      const conn = connectionsRef.current.find(c =>
        c.shells.some(s => s.terminalSessionId === event.sessionId)
      )
      if (!conn || conn.id !== activeConnectionIdRef.current) return
      applyShellCwd(conn.id, event.sessionId, cwd)
    })
  }, [followTerminalCwd, applyShellCwd])

  useEffect(() => {
    if (!isTauriRuntime() || !followTerminalCwd) return
    return onTerminalWrite((terminalSessionId, data) => {
      if (data === '\x03') return
      const conn = connectionsRef.current.find(c =>
        c.shells.some(s => s.terminalSessionId === terminalSessionId)
      )
      if (!conn || conn.id !== activeConnectionIdRef.current || conn.session.type !== 'ssh') {
        return
      }
      const shell = conn.shells.find(s => s.terminalSessionId === terminalSessionId)
      if (!shell) return
      const home = defaultRemoteHome(conn.session.user)
      const current = shell.shellCwd ?? home
      const next = parseCdTargetFromCommand(data, current, home)
      if (next) applyShellCwd(conn.id, terminalSessionId, next)
    })
  }, [followTerminalCwd, applyShellCwd])

  const handleRemoteDirectoryExpand = useCallback(
    (item: FileItem) => {
      if (!activeConnection || activeConnection.session.type !== 'ssh') return
      if (item.type !== 'directory') return
      const hasLoadedChildren = item.children && item.children.length > 0
      if (hasLoadedChildren) return
      void loadRemoteFiles(activeConnection.session, item.path, {
        mergeParentPath: item.path,
      })
    },
    [activeConnection, loadRemoteFiles]
  )

  const claudeContextKey = `${activeConnectionId ?? ''}:${activeConnection?.activeShellId ?? ''}:${activeConnection?.session.id ?? ''}`

  useEffect(() => {
    clearClaudeSessionId()
  }, [clearClaudeSessionId])

  const claudeCode = useClaudeCode({
    enabled: aiSettings.enabled,
    claudePath: aiSettings.claudePath,
    getIdeContext,
    contextSyncKey: claudeContextKey,
  })
  claudeCodeRef.current = claudeCode

  const resetConnectionClaudeSession = useCallback(
    async (connectionId: string, options?: { clearChat?: boolean }) => {
      const pending = claudeRequestsByConnectionRef.current.get(connectionId)
      if (pending) {
        for (const requestId of pending) {
          claudeSilentKeepaliveRef.current.get(requestId)?.dispose()
          await cancelClaudeMessage(requestId).catch(() => {})
        }
        claudeRequestsByConnectionRef.current.delete(connectionId)
      }
      setConnections(prev =>
        prev.map(conn => {
          if (conn.id !== connectionId) return conn
          return {
            ...conn,
            claudeSessionId: undefined,
            aiThinking: false,
            aiMessages: options?.clearChat ? [] : conn.aiMessages,
          }
        })
      )
    },
    []
  )

  // 切换连接时清除全局 Claude session，避免新连接继承上下文
  useEffect(() => {
    if (activeConnectionId) {
      const conn = connections.find(c => c.id === activeConnectionId)
      // 如果当前连接没有 claudeSessionId，说明是新会话，不应该恢复任何会话
      if (!conn?.claudeSessionId) {
        clearClaudeSessionId()
      }
    }
  }, [activeConnectionId, connections, clearClaudeSessionId])

  const activeShellConnected =
    Boolean(
      activeConnection?.terminalLive &&
        activeConnection.shells.some(
          s =>
            s.id === activeConnection.activeShellId && s.terminalStatus === 'connected'
        )
    )

  const markShellConnecting = useCallback(
    (
      connectionId: string,
      shellId: string,
      sessionId: string,
      systemMessage?: string
    ) => {
      setConnections(prev =>
        prev.map(conn => {
          if (conn.id !== connectionId) return conn
          return {
            ...conn,
            session: { ...conn.session, status: 'connecting' },
            terminalLive: true,
            shells: conn.shells.map(shell =>
              shell.id === shellId
                ? {
                    ...shell,
                    terminalStatus: 'connecting' as const,
                    history: systemMessage
                      ? [
                          ...shell.history,
                          {
                            id: `retry-${Date.now()}`,
                            type: 'system' as const,
                            content: systemMessage,
                            timestamp: new Date(),
                          },
                        ]
                      : shell.history,
                  }
                : shell
            ),
          }
        })
      )
      setFolders(prev => setSessionStatusInFolders(prev, sessionId, 'connecting'))
    },
    [setFolders]
  )

  const offerPasswordRetryAfterAuthFailure = useCallback(
    (terminalSessionId: string, errorMessage: string) => {
      if (!isSshAuthFailureError(errorMessage)) return

      const conn = connectionsRef.current.find(c =>
        c.shells.some(s => s.terminalSessionId === terminalSessionId)
      )
      if (!conn || conn.session.type !== 'ssh') return

      const shell = conn.shells.find(s => s.terminalSessionId === terminalSessionId)
      if (!shell) return

      clearRuntimePassword(conn.session.id)

      const folderSession =
        foldersRef.current.flatMap(f => f.sessions).find(s => s.id === conn.session.id) ??
        conn.session

      setPasswordPrompt(prev => {
        if (prev?.terminalSessionId === terminalSessionId) return prev
        return {
          session: resolveSessionForConnect(folderSession),
          connectionId: conn.id,
          shellId: shell.id,
          terminalSessionId,
          allowDefaultKeys: true,
          authFailureReason: errorMessage,
        }
      })
    },
    []
  )

  // 监听 Tauri 终端输出与连接状态
  useEffect(() => {
    if (!isTauriRuntime()) return

    let unlistenOutput: (() => void) | undefined
    let unlistenStatus: (() => void) | undefined

    const setup = async () => {
      await ensureTerminalOutputListener()

      unlistenOutput = subscribeAllTerminalOutput(event => {
        setConnections(prev =>
          prev.map(conn => {
            if (conn.terminalLive) return conn
            const shell = conn.shells.find(
              s => s.terminalSessionId === event.sessionId
            )
            if (!shell) return conn
            return {
              ...conn,
              shells: conn.shells.map(s =>
                s.id === shell.id
                  ? { ...s, history: appendTerminalOutput(s.history, event.data) }
                  : s
              ),
            }
          })
        )
      })

      unlistenStatus = await listenTerminalStatus(event => {
        if (event.status === 'connected') {
          requestTerminalResync(event.sessionId)
          let connectedSession: Session | undefined
          let profileSessionId: string | undefined
          let shouldLoadRemote = false

          setConnections(prev =>
            prev.map(conn => {
              const updated = updateConnectionShellByTerminalId(
                conn,
                event.sessionId,
                shell => ({
                  ...shell,
                  terminalStatus: 'connected',
                  history: shell.history.filter(l => l.type !== 'system'),
                })
              )
              if (!updated) return conn
              connectedSession = updated.session
              profileSessionId = updated.session.id
              shouldLoadRemote =
                updated.session.type === 'ssh' && !updated.remoteFiles?.length
              return { ...updated, terminalLive: true }
            })
          )

          if (profileSessionId) {
            setFolders(prev =>
              setSessionStatusInFolders(prev, profileSessionId!, 'connected')
            )
            const connectRequestId = pendingMcpConnectRef.current.get(profileSessionId)
            if (connectRequestId) {
              pendingMcpConnectRef.current.delete(profileSessionId)
              void import('@tauri-apps/api/core')
                .then(({ invoke }) =>
                  invoke('complete_connect_tool', {
                    requestId: connectRequestId,
                    success: true,
                  })
                )
                .catch(() => {})
            }
          }
          if (shouldLoadRemote && connectedSession) {
            void loadRemoteFiles(connectedSession, '~')
          }

          const connectedConn = connectionsRef.current.find(c =>
            c.shells.some(s => s.terminalSessionId === event.sessionId)
          )
          if (
            connectedConn &&
            connectedConn.session.type === 'ssh' &&
            followTerminalCwdRef.current
          ) {
            void getRemoteCwd(
              resolveSessionForConnect(connectedConn.session),
              remoteFileOpts()
            )
              .then(cwd =>
                applyShellCwd(connectedConn.id, event.sessionId, cwd)
              )
              .catch(() => {})
          }
        } else if (event.status === 'error') {
          const message = event.error ?? '连接失败'
          let profileSessionId: string | undefined

          setConnections(prev =>
            prev.map(conn => {
              const updated = updateConnectionShellByTerminalId(
                conn,
                event.sessionId,
                shell => ({
                  ...shell,
                  terminalStatus: 'error',
                  history: [
                    ...shell.history,
                    {
                      id: `err-${Date.now()}`,
                      type: 'error' as const,
                      content: message,
                      timestamp: new Date(),
                    },
                  ],
                })
              )
              if (!updated) return conn
              profileSessionId = updated.session.id
              return updated
            })
          )

          if (profileSessionId) {
            setFolders(prev =>
              setSessionStatusInFolders(prev, profileSessionId!, 'disconnected')
            )
            const connectRequestId = pendingMcpConnectRef.current.get(profileSessionId)
            if (connectRequestId) {
              pendingMcpConnectRef.current.delete(profileSessionId)
              void import('@tauri-apps/api/core')
                .then(({ invoke }) =>
                  invoke('complete_connect_tool', {
                    requestId: connectRequestId,
                    success: false,
                    error: message,
                  })
                )
                .catch(() => {})
            }
          }
          void disconnectTerminal(event.sessionId).catch(() => {})
          offerPasswordRetryAfterAuthFailure(event.sessionId, message)
        } else if (event.status === 'disconnected') {
          let profileSessionId: string | undefined
          let disconnectedConnId: string | undefined

          setConnections(prev =>
            prev.map(conn => {
              const updated = updateConnectionShellByTerminalId(
                conn,
                event.sessionId,
                shell => ({ ...shell, terminalStatus: 'disconnected' })
              )
              if (!updated) return conn
              profileSessionId = updated.session.id
              disconnectedConnId = updated.id
              return updated
            })
          )

          if (profileSessionId) {
            setFolders(prev =>
              setSessionStatusInFolders(prev, profileSessionId!, 'disconnected')
            )
          }
          if (disconnectedConnId) {
            void resetConnectionClaudeSession(disconnectedConnId, { clearChat: true })
          }
        }
      })

      for (const conn of connectionsRef.current) {
        for (const shell of conn.shells) {
          requestTerminalResync(shell.terminalSessionId)
        }
      }
    }

    void setup()
    return () => {
      unlistenOutput?.()
      unlistenStatus?.()
    }
  }, [
    setFolders,
    loadRemoteFiles,
    offerPasswordRetryAfterAuthFailure,
    resetConnectionClaudeSession,
    applyShellCwd,
    remoteFileOpts,
  ])

  // 切换到已连接会话的标签页（不发起新连接）
  const handleSessionSelect = useCallback((session: Session) => {
    const existingConn = connections.find(c => c.session.id === session.id)
    if (existingConn) {
      setActiveConnectionId(existingConn.id)
      if (
        existingConn.session.type === 'ssh' &&
        existingConn.shells.some(s => s.terminalStatus === 'connected')
      ) {
        void loadRemoteFiles(existingConn.session, existingConn.remotePath ?? '~')
      }
    }
  }, [connections, loadRemoteFiles])

  const runBackendConnect = useCallback(
    (
      session: Session,
      connectionId: string,
      shellId: string,
      terminalSessionId: string,
      options?: { skipPasswordPrompt?: boolean }
    ) => {
      const resolved = resolveSessionForConnect(session)
      if (!options?.skipPasswordPrompt && sessionNeedsPasswordPrompt(resolved)) {
        setPasswordPrompt({
          session: resolved,
          connectionId,
          shellId,
          terminalSessionId,
          allowDefaultKeys: sessionAllowsDefaultKeysFallback(resolved),
        })
      return
    }

      const isLocalLike = resolved.type === 'local' || resolved.type === 'wsl'
      const connect = () =>
        connectTerminalSession(resolved, terminalSessionId).catch((err: Error) => {
          const message = err.message || '连接失败'
          setConnections(prev =>
            prev.map(conn => {
              if (conn.id !== connectionId) return conn
              return {
                ...conn,
                session: { ...conn.session, status: 'disconnected' },
                shells: conn.shells.map(shell =>
                  shell.id === shellId
                    ? {
                        ...shell,
                        terminalStatus: 'disconnected' as const,
                        history: [
                          ...shell.history,
                          {
                            id: `err-${Date.now()}`,
                            type: 'error' as const,
                            content: message,
                            timestamp: new Date(),
                          },
                        ],
                      }
                    : shell
                ),
              }
            })
          )
          setFolders(prev =>
            setSessionStatusInFolders(prev, session.id, 'disconnected')
          )
          offerPasswordRetryAfterAuthFailure(terminalSessionId, message)
        })

      if (isLocalLike) {
        void connect()
        return
      }

      void registerProfileAuth(resolved)
        .then(connect)
        .catch((err: Error) => {
          const message = err.message || '连接失败'
          setConnections(prev =>
            prev.map(conn => {
              if (conn.id !== connectionId) return conn
              return {
                ...conn,
                session: { ...conn.session, status: 'disconnected' },
                shells: conn.shells.map(shell =>
                  shell.id === shellId
                    ? {
                        ...shell,
                        terminalStatus: 'disconnected' as const,
                        history: [
                          ...shell.history,
                          {
                            id: `err-${Date.now()}`,
                            type: 'error' as const,
                            content: message,
                            timestamp: new Date(),
                          },
                        ],
                      }
                    : shell
                ),
              }
            })
          )
          setFolders(prev =>
            setSessionStatusInFolders(prev, session.id, 'disconnected')
          )
          offerPasswordRetryAfterAuthFailure(terminalSessionId, message)
        })
    },
    [setFolders, offerPasswordRetryAfterAuthFailure]
  )

  const cancelPendingConnect = useCallback(
    (pending: PendingPasswordConnect) => {
      setConnections(prev =>
        prev.map(conn => {
          if (conn.id !== pending.connectionId) return conn
          return {
            ...conn,
            session: { ...conn.session, status: 'disconnected' },
            shells: conn.shells.map(shell =>
              shell.id === pending.shellId
                ? {
                    ...shell,
                    terminalStatus: 'disconnected' as const,
                    history: [
                      ...shell.history,
                      {
                        id: `cancel-${Date.now()}`,
                        type: 'system' as const,
                        content: '已取消连接（未输入密码）',
                        timestamp: new Date(),
                      },
                    ],
                  }
                : shell
            ),
          }
        })
      )
      setFolders(prev =>
        setSessionStatusInFolders(prev, pending.session.id, 'disconnected')
      )
    },
    [setFolders]
  )

  const handlePasswordPromptSubmit = useCallback(
    (password: string) => {
      if (!passwordPrompt) return
      const { session, connectionId, shellId, terminalSessionId } = passwordPrompt
      setRuntimePassword(session.id, password)
      setStoredPassword(session.id, password)
      setPasswordPrompt(null)
      markShellConnecting(
        connectionId,
        shellId,
        session.id,
        passwordPrompt.authFailureReason
          ? '正在使用新密码重新连接...'
          : '正在连接...'
      )
      runBackendConnect(
        sessionWithRuntimePassword(session, password),
        connectionId,
        shellId,
        terminalSessionId,
        { skipPasswordPrompt: true }
      )
    },
    [passwordPrompt, runBackendConnect, markShellConnecting]
  )

  const handlePasswordPromptUseDefaultKeys = useCallback(() => {
    if (!passwordPrompt) return
    const { session, connectionId, shellId, terminalSessionId } = passwordPrompt
    setPasswordPrompt(null)
    markShellConnecting(connectionId, shellId, session.id, '正在使用默认密钥连接...')
    runBackendConnect(session, connectionId, shellId, terminalSessionId, {
      skipPasswordPrompt: true,
    })
  }, [passwordPrompt, runBackendConnect, markShellConnecting])

  const handlePasswordPromptOpenChange = useCallback(
    (open: boolean) => {
      if (!open && passwordPrompt) {
        cancelPendingConnect(passwordPrompt)
        setPasswordPrompt(null)
      }
    },
    [passwordPrompt, cancelPendingConnect]
  )

  // 连接会话（仅由「连接」按钮等显式操作触发）
  const handleSessionConnect = useCallback((session: Session) => {
  const folderSession =
    folders.flatMap(f => f.sessions).find(s => s.id === session.id) ?? session
    const existingConn = connections.find(c => c.session.id === folderSession.id)
    if (existingConn) {
      setActiveConnectionId(existingConn.id)
      const shellConnected = existingConn.shells.some(
        s => s.terminalStatus === 'connected'
      )
      if (shellConnected) {
        if (existingConn.session.type === 'ssh') {
          void loadRemoteFiles(existingConn.session, existingConn.remotePath ?? '~')
        }
        return
      }

      // 仅重置 AI 思考状态，不清除对话历史和 session ID
      void resetConnectionClaudeSession(existingConn.id, { clearChat: false })

      if (!isTerminalBackendSupported(folderSession.type)) return

      const activeShell =
        existingConn.shells.find(s => s.id === existingConn.activeShellId) ??
        existingConn.shells[0]
      if (!activeShell) return

      setConnections(prev =>
        prev.map(conn => {
          if (conn.id !== existingConn.id) return conn
          return {
            ...conn,
            session: { ...conn.session, status: 'connecting' },
            terminalLive: true,
            shells: conn.shells.map(shell =>
              shell.id === activeShell.id
                ? {
                    ...shell,
                    terminalStatus: 'connecting' as const,
                    history: [
                      ...shell.history,
                      {
                        id: `reconnect-${Date.now()}`,
                        type: 'system' as const,
                        content: `正在重新连接 ${folderSession.name}...`,
                        timestamp: new Date(),
                      },
                    ],
                  }
                : shell
            ),
          }
        })
      )
      setFolders(prev =>
        setSessionStatusInFolders(prev, folderSession.id, 'connecting')
      )
      runBackendConnect(
        folderSession,
        existingConn.id,
        activeShell.id,
        activeShell.terminalSessionId
      )
      return
    }

    const shellId = `shell-${Date.now()}`
    const terminalSessionId = makeTerminalSessionId(folderSession.id, shellId)
    const connectionId = `conn-${Date.now()}`
    const useBackend = isTerminalBackendSupported(folderSession.type)

    const initialHistory: TerminalLine[] = useBackend
      ? [
          {
            id: `${Date.now()}`,
            type: 'system',
            content: `正在连接 ${folderSession.name}（${folderSession.type.toUpperCase()}）...`,
            timestamp: new Date(),
          },
        ]
      : [
          { id: `${Date.now()}`, type: 'system', content: `已打开会话 ${folderSession.name}`, timestamp: new Date() },
          {
            id: `${Date.now()}-1`,
            type: 'system',
            content: `协议: ${folderSession.type.toUpperCase()} | 地址: ${folderSession.host}${folderSession.port ? ':' + folderSession.port : ''}${folderSession.user ? ` | 用户: ${folderSession.user}` : ''}`,
            timestamp: new Date(),
          },
          {
            id: `${Date.now()}-2`,
            type: 'system',
            content: isTauriRuntime()
              ? `协议「${folderSession.type}」的真实连接尚未支持，当前支持 SSH、本地终端、WSL。`
              : '请使用 Tauri 桌面版（npm run dev:tauri）以建立真实连接。',
            timestamp: new Date(),
          },
    ]

    const newConnection: ServerConnection = {
      id: connectionId,
      session: { ...folderSession, status: useBackend ? 'connecting' : 'connected' },
      shells: [
        {
          id: shellId,
          name: 'Shell 1',
          history: initialHistory,
          terminalSessionId,
          terminalStatus: useBackend ? 'connecting' : undefined,
        },
      ],
      activeShellId: shellId,
      openFiles: [],
      activeFileId: null,
      selectedFilePath: null,
      aiMessages: [],
      aiThinking: false,
      terminalLive: useBackend,
    }

    setConnections(prev => [...prev, newConnection])
    setActiveConnectionId(connectionId)

    setFolders(prev =>
      setSessionStatusInFolders(prev, folderSession.id, useBackend ? 'connecting' : 'connected')
    )

    if (useBackend) {
      runBackendConnect(folderSession, connectionId, shellId, terminalSessionId)
    }
  }, [connections, folders, setFolders, loadRemoteFiles, runBackendConnect, resetConnectionClaudeSession])

  const pushRuntimeSnapshot = useCallback(() => {
    if (!isTauriRuntime()) return
    const folderProfiles = folders.flatMap(f => f.sessions)
    const connProfiles = connections
      .map(c => c.session)
      .filter(s => !folderProfiles.some(p => p.id === s.id))
    const snapshot = buildRuntimeSnapshot({
      folders: [{ id: '__runtime__', name: '', sessions: [...folderProfiles, ...connProfiles], isExpanded: true }],
      connections: connections.map(c => ({
        id: c.id,
        session: c.session,
        activeShellId: c.activeShellId,
        shells: c.shells.map(s => ({
          id: s.id,
          name: s.name,
          terminalSessionId: s.terminalSessionId,
          terminalStatus: s.terminalStatus,
        })),
      })),
      activeConnectionId,
    })
    void syncAppRuntime(snapshot).catch(err => console.error('sync_app_runtime failed', err))
    void updateIdeContext(getIdeContext()).catch(err => console.error('claude_update_context failed', err))
  }, [folders, connections, activeConnectionId, getIdeContext])

  // 焦点/连接变化时立即同步；其它状态防抖
  useEffect(() => {
    pushRuntimeSnapshot()
  }, [activeConnectionId, activeConnection?.activeShellId, pushRuntimeSnapshot])

  useEffect(() => {
    if (!isTauriRuntime()) return
    const timer = window.setTimeout(() => pushRuntimeSnapshot(), 400)
    return () => window.clearTimeout(timer)
  }, [folders, connections, pushRuntimeSnapshot])

  // 启动后恢复本机已存密码（仅 SSH，延迟执行不阻塞首屏）
  useEffect(() => {
    if (!foldersLoaded || !isTauriRuntime()) return
    let cancelled = false
    let batchTimer: number | null = null
    const warmupTimer = window.setTimeout(() => {
      const sshSessions = folders.flatMap(f => f.sessions).filter(s => s.type === 'ssh')
      let index = 0
      const runNext = () => {
        if (cancelled || index >= sshSessions.length) return
        const session = sshSessions[index++]
        const stored = getStoredPassword(session.id)
        if (stored) {
          setRuntimePassword(session.id, stored)
        }
        void registerProfileAuth(resolveSessionForConnect(session))
        batchTimer = window.setTimeout(runNext, 120)
      }
      runNext()
    }, 2500)
    return () => {
      cancelled = true
      window.clearTimeout(warmupTimer)
      if (batchTimer !== null) {
        window.clearTimeout(batchTimer)
      }
    }
  }, [folders, foldersLoaded])

  // 桌面版：首屏已有默认连接，监听器就绪后再发起 PTY 连接
  useEffect(() => {
    if (!isTauriRuntime() || initialLocalConnectRef.current) return

    let cancelled = false
    const timers: ReturnType<typeof setTimeout>[] = []

    const tryConnect = (): boolean => {
      if (initialLocalConnectRef.current || cancelled) return true
      const conn = connectionsRef.current.find(c => isDefaultLocalShellSession(c.session))
      if (!conn) return false
      const shell = conn.shells[0]
      if (!shell) return false
      if (shell.terminalStatus === 'connected') {
        initialLocalConnectRef.current = true
        return true
      }
      initialLocalConnectRef.current = true
      console.log('[AutoConnect] Spawning local shell PTY:', shell.terminalSessionId)
      runBackendConnect(conn.session, conn.id, shell.id, shell.terminalSessionId, {
        skipPasswordPrompt: true,
      })
      return true
    }

    void (async () => {
      await ensureTerminalOutputListener()
      if (cancelled) return
      if (tryConnect()) return
      for (const ms of [50, 200, 500, 1000, 2000]) {
        timers.push(
          setTimeout(() => {
            if (!initialLocalConnectRef.current) tryConnect()
          }, ms)
        )
      }
    })()

    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
    }
  }, [runBackendConnect])

  // 无标签且非桌面预置连接时，补开本地 Shell
  useEffect(() => {
    if (!isTauriRuntime() || !foldersLoaded) return
    if (connectionsRef.current.length > 0) return
    const sessions = folders.flatMap(f => f.sessions)
    const legacy = findLegacyDefaultLocalShellSession(sessions)
    const localSession =
      sessions.find(s => s.id === DEFAULT_LOCAL_SHELL_SESSION_ID) ??
      (legacy
        ? { ...legacy, id: DEFAULT_LOCAL_SHELL_SESSION_ID }
        : createDefaultLocalShellSession())
    handleSessionConnect(localSession)
  }, [foldersLoaded, folders, handleSessionConnect])

  // 切换连接标签时刷新该会话的远程文件树
  useEffect(() => {
    if (!activeConnection) return
    if (activeConnection.session.type !== 'ssh' || !isTauriRuntime()) return
    if (!activeConnection.shells.some(s => s.terminalStatus === 'connected')) return
    void loadRemoteFiles(activeConnection.session, activeConnection.remotePath ?? '~')
  }, [activeConnectionId, loadRemoteFiles])

  // Close a connection
  const handleConnectionClose = useCallback((connectionId: string) => {
    const conn = connections.find(c => c.id === connectionId)

    void resetConnectionClaudeSession(connectionId, { clearChat: true })

    if (conn?.terminalLive) {
      for (const shell of conn.shells) {
        void disconnectTerminal(shell.terminalSessionId).catch(() => {})
        clearTerminalOutputBuffer(shell.terminalSessionId)
      }
    }
    
    setConnections(prev => prev.filter(c => c.id !== connectionId))
    
    if (connectionId === activeConnectionId) {
      const remaining = connections.filter(c => c.id !== connectionId)
      setActiveConnectionId(remaining.length > 0 ? remaining[0].id : null)
    }

    if (conn) {
      setFolders(prev =>
        setSessionStatusInFolders(prev, conn.session.id, 'disconnected')
      )
    }
  }, [connections, activeConnectionId, setFolders, resetConnectionClaudeSession])

  // Handle terminal command (mock mode + AI inject; live xterm handles keyboard directly)
  const handleCommand = useCallback((shellId: string, command: string) => {
    if (!activeConnectionId) return

    const conn = connections.find(c => c.id === activeConnectionId)
    if (!conn) return

      const shell = conn.shells.find(s => s.id === shellId)
    if (!shell) return

      if (command === 'clear') {
      if (conn.terminalLive && shell.terminalStatus === 'connected') {
        setTerminalClearSignals(prev => ({
          ...prev,
          [shell.terminalSessionId]: (prev[shell.terminalSessionId] ?? 0) + 1,
        }))
        return
      }
      setConnections(prev =>
        prev.map(c =>
          c.id !== activeConnectionId
            ? c
            : {
                ...c,
                shells: c.shells.map(s =>
                  s.id === shellId ? { ...s, history: [] } : s
                ),
              }
        )
      )
      return
    }

    if (conn.terminalLive && shell.terminalStatus === 'connected') {
      if (
        followTerminalCwdRef.current &&
        conn.session.type === 'ssh' &&
        command !== '\x03' &&
        command !== 'clear'
      ) {
        const home = defaultRemoteHome(conn.session.user)
        const current = shell.shellCwd ?? home
        const next = parseCdTargetFromCommand(command, current, home)
        if (next) applyShellCwd(activeConnectionId, shell.terminalSessionId, next)
      }
      const payload =
        command === '\x03' ? '\x03' : normalizeShellCommandForPty(command)
      void writeTerminal(shell.terminalSessionId, payload).catch((err: Error) => {
        setConnections(current =>
          current.map(c => {
            if (c.id !== activeConnectionId) return c
        return {
              ...c,
              shells: c.shells.map(s =>
                s.id === shellId
                  ? {
                      ...s,
                      history: [
                        ...s.history,
                        {
                          id: `err-${Date.now()}`,
                          type: 'error' as const,
                          content: err.message || '发送命令失败',
                          timestamp: new Date(),
                        },
                      ],
                    }
                  : s
              ),
            }
          })
        )
      })
      return
      }

      const inputLine: TerminalLine = {
        id: `${Date.now()}`,
        type: 'input',
        content: command,
      timestamp: new Date(),
      }

      const outputLine: TerminalLine = {
        id: `${Date.now()}-out`,
      type: 'system',
      content: conn.session.status === 'connecting'
        ? '正在连接，请稍候...'
        : '终端未连接或当前协议不支持真实连接。',
      timestamp: new Date(),
    }

    setConnections(prev =>
      prev.map(c =>
        c.id !== activeConnectionId
          ? c
          : {
              ...c,
              shells: c.shells.map(s =>
          s.id === shellId 
                  ? { ...s, history: [...s.history, inputLine, outputLine] }
                  : s
              ),
            }
      )
    )
  }, [activeConnectionId, connections, applyShellCwd])

  const handleAiExecuteCommand = useCallback(
    (command: string) => {
      if (!activeConnection) return
      const shell = activeConnection.shells.find(
        s => s.id === activeConnection.activeShellId
      )
      workbenchRef.current?.focusTerminal()
      handleCommand(activeConnection.activeShellId, command)
    },
    [activeConnection, handleCommand]
  )

  // Shell management
  const handleNewShell = useCallback(() => {
    if (!activeConnectionId) return

    const conn = connections.find(c => c.id === activeConnectionId)
    if (!conn) return
      
    const shellId = `shell-${Date.now()}`
      const shellNum = conn.shells.length + 1
    const terminalSessionId = makeTerminalSessionId(conn.session.id, shellId)
    const useBackend = conn.terminalLive

      const newShell: Shell = {
      id: shellId,
        name: `Shell ${shellNum}`,
      history: useBackend
        ? [
            {
              id: `${Date.now()}`,
              type: 'system',
              content: `正在连接 ${conn.session.name}（Shell ${shellNum}）...`,
              timestamp: new Date(),
            },
          ]
        : [],
      terminalSessionId,
      terminalStatus: useBackend ? 'connecting' : undefined,
    }

    setConnections(prev =>
      prev.map(c => {
        if (c.id !== activeConnectionId) return c
      return {
          ...c,
          shells: [...c.shells, newShell],
          activeShellId: shellId,
          session: useBackend
            ? { ...c.session, status: connectionSessionStatus([...c.shells, newShell]) }
            : c.session,
        }
      })
    )

    if (useBackend) {
      connectTerminalSession(conn.session, terminalSessionId).catch((err: Error) => {
        const message = err.message || '连接失败'
        setConnections(prev =>
          prev.map(c => {
            if (c.id !== activeConnectionId) return c
            return {
              ...c,
              shells: c.shells.map(s =>
                s.id === shellId
                  ? {
                      ...s,
                      terminalStatus: 'error',
                      history: [
                        ...s.history,
                        {
                          id: `err-${Date.now()}`,
                          type: 'error' as const,
                          content: message,
                          timestamp: new Date(),
                        },
                      ],
                    }
                  : s
              ),
              session: { ...c.session, status: 'disconnected' },
            }
          })
        )
      })
    }
  }, [activeConnectionId, connections])

  // 为指定连接创建新 Shell（供 AI 调用）
  const handleNewShellForConnection = useCallback((connectionId: string, customName?: string) => {
    const conn = connections.find(c => c.id === connectionId)
    if (!conn) return

    const shellId = `shell-${Date.now()}`
    const shellNum = conn.shells.length + 1
    const terminalSessionId = makeTerminalSessionId(conn.session.id, shellId)
    const useBackend = conn.terminalLive
    const shellName = customName || `Shell ${shellNum}`

    const newShell: Shell = {
      id: shellId,
      name: shellName,
      history: useBackend
        ? [
            {
              id: `${Date.now()}`,
              type: 'system',
              content: `正在连接 ${conn.session.name}（${shellName}）...`,
              timestamp: new Date(),
            },
          ]
        : [],
      terminalSessionId,
      terminalStatus: useBackend ? 'connecting' : undefined,
    }

    setConnections(prev =>
      prev.map(c => {
        if (c.id !== connectionId) return c
        return {
          ...c,
          shells: [...c.shells, newShell],
          activeShellId: shellId,
          session: useBackend
            ? { ...c.session, status: connectionSessionStatus([...c.shells, newShell]) }
            : c.session,
        }
      })
    )

    if (useBackend) {
      connectTerminalSession(conn.session, terminalSessionId).catch((err: Error) => {
        const message = err.message || '连接失败'
        setConnections(prev =>
          prev.map(c => {
            if (c.id !== connectionId) return c
            return {
              ...c,
              shells: c.shells.map(s =>
                s.id === shellId
                  ? {
                      ...s,
                      terminalStatus: 'error',
                      history: [
                        ...s.history,
                        {
                          id: `${Date.now()}`,
                          type: 'error' as const,
                          content: message,
                          timestamp: new Date(),
                        },
                      ],
                    }
                  : s
              ),
              session: { ...c.session, status: 'disconnected' },
            }
          })
        )
      })
    }
  }, [connections])

  const handleCloseShell = useCallback((shellId: string) => {
    if (!activeConnectionId) return

    const conn = connections.find(c => c.id === activeConnectionId)
    const closing = conn?.shells.find(s => s.id === shellId)

    if (conn?.terminalLive && closing) {
      void disconnectTerminal(closing.terminalSessionId).catch(() => {})
      clearTerminalOutputBuffer(closing.terminalSessionId)
    }

    setConnections(prev => prev.map(c => {
      if (c.id !== activeConnectionId) return c
      if (c.shells.length <= 1) return c

      const newShells = c.shells.filter(s => s.id !== shellId)
      return {
        ...c,
        shells: newShells,
        activeShellId: c.activeShellId === shellId ? newShells[0].id : c.activeShellId,
        session: { ...c.session, status: connectionSessionStatus(newShells) },
      }
    }))
  }, [activeConnectionId, connections])

  const handleShellChange = useCallback((shellId: string) => {
    if (!activeConnectionId) return

    setConnections(prev => prev.map(conn => {
      if (conn.id !== activeConnectionId) return conn
      if (conn.activeShellId === shellId) return conn
      return { ...conn, activeShellId: shellId }
    }))
  }, [activeConnectionId])
  handleShellChangeRef.current = handleShellChange

  const focusShellByTerminalId = useCallback((terminalSessionId: string): Promise<void> => {
    return new Promise(resolve => {
      const conn = connectionsRef.current.find(c =>
        c.shells.some(s => s.terminalSessionId === terminalSessionId)
      )
      if (!conn) {
        resolve()
        return
      }
      const shell = conn.shells.find(s => s.terminalSessionId === terminalSessionId)
      if (!shell) {
        resolve()
        return
      }
      if (conn.id !== activeConnectionIdRef.current) {
        setActiveConnectionId(conn.id)
      }
      if (conn.activeShellId !== shell.id) {
        handleShellChangeRef.current(shell.id)
      }
      window.requestAnimationFrame(() => {
        workbenchRef.current?.activateShellById(shell.id)
        workbenchRef.current?.focusTerminal()
        window.setTimeout(() => resolve(), 120)
      })
    })
  }, [])

  // File management — VS Code editor model pattern
  const handleFileSelect = useCallback((file: FileItem) => {
    if (!activeConnectionId || file.type === 'directory') return
    setConnections(prev => prev.map(conn => 
      conn.id === activeConnectionId ? { ...conn, selectedFilePath: file.path } : conn
    ))
  }, [activeConnectionId])

  const handleFileOpen = useCallback(
    async (file: FileItem) => {
    if (!activeConnectionId || file.type === 'directory') return

      const conn = connections.find(c => c.id === activeConnectionId)
      if (!conn) return

      const isRemote = conn.session.type === 'ssh' && isTauriRuntime()
      const existing = conn.openFiles.find(f => f.path === file.path)

      if (existing) {
        setConnections(prev =>
          prev.map(c =>
            c.id !== activeConnectionId
              ? c
              : {
                  ...c,
                  activeFileId: existing.id,
                  selectedFilePath: file.path,
                }
          )
        )
        return
      }

      const placeholder = isRemote ? '正在加载远程文件…' : readFileContent(file.path)

      setConnections(prev =>
        prev.map(c => {
          if (c.id !== activeConnectionId) return c
          const { models, activeId } = openEditorModel(c.openFiles, file.path, placeholder)
          return {
            ...c,
            openFiles: models,
            activeFileId: activeId,
            selectedFilePath: file.path,
          }
        })
      )

      if (!isRemote) return

      try {
        const content = await readRemoteFile(conn.session, file.path, remoteFileOpts())
        setConnections(prev =>
          prev.map(c =>
            c.id !== activeConnectionId
              ? c
              : { ...c, openFiles: setEditorLoadedContent(c.openFiles, file.path, content) }
          )
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : '加载失败'
        setConnections(prev =>
          prev.map(c =>
            c.id !== activeConnectionId
              ? c
              : {
                  ...c,
                  openFiles: setEditorLoadedContent(
                    c.openFiles,
                    file.path,
                    `# 无法加载远程文件\n# 路径: ${file.path}\n#\n# ${message}`
                  ),
                }
          )
        )
      }
    },
    [activeConnectionId, connections, remoteFileOpts]
  )

  const handleFileSave = useCallback(
    async (file: { id: string; path: string; content: string }) => {
    if (!activeConnectionId) return

      const conn = connections.find(c => c.id === activeConnectionId)
      const isRemote = conn?.session.type === 'ssh' && isTauriRuntime()

      try {
        if (isRemote && conn) {
          await writeRemoteFile(conn.session, file.path, file.content, remoteFileOpts())
        } else {
          writeFileContent(file.path, file.content)
        }
        setConnections(prev =>
          prev.map(c =>
            c.id !== activeConnectionId
              ? c
              : { ...c, openFiles: saveEditorModel(c.openFiles, file.id) }
          )
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : '保存失败'
        setAppAlert({
          open: true,
          title: '保存失败',
          details: `保存远程文件失败：${message}`,
        })
      }
    },
    [activeConnectionId, connections, remoteFileOpts]
  )

  const handleFileClose = useCallback((fileId: string) => {
    if (!activeConnectionId) return

    setConnections(prev => prev.map(conn => {
      if (conn.id !== activeConnectionId) return conn
      const { models, activeId } = closeEditorModel(conn.openFiles, fileId, conn.activeFileId)
      return { ...conn, openFiles: models, activeFileId: activeId }
    }))
  }, [activeConnectionId])

  const handleFileChange = useCallback((fileId: string, content: string) => {
    if (!activeConnectionId) return

    setConnections(prev => prev.map(conn => {
      if (conn.id !== activeConnectionId) return conn
      return { ...conn, openFiles: updateEditorContent(conn.openFiles, fileId, content) }
    }))
  }, [activeConnectionId])

  const handleActiveFileChange = useCallback((fileId: string) => {
    if (!activeConnectionId) return

    setConnections(prev => prev.map(conn => {
      if (conn.id !== activeConnectionId) return conn
      if (conn.activeFileId === fileId) return conn
      const file = conn.openFiles.find(f => f.id === fileId)
      return {
        ...conn,
        activeFileId: fileId,
        selectedFilePath: file?.path ?? conn.selectedFilePath,
      }
    }))
  }, [activeConnectionId])

  const handleFileSaveById = useCallback(
    async (fileId: string) => {
    if (!activeConnectionId) return

      const conn = connections.find(c => c.id === activeConnectionId)
      const file = conn?.openFiles.find(f => f.id === fileId)
      if (!file || !conn) return

      const isRemote = conn.session.type === 'ssh' && isTauriRuntime()

      try {
        if (isRemote) {
          await writeRemoteFile(conn.session, file.path, file.content, remoteFileOpts())
        } else {
          writeFileContent(file.path, file.content)
        }
        setConnections(prev =>
          prev.map(c =>
            c.id === activeConnectionId
              ? { ...c, openFiles: saveEditorModel(c.openFiles, fileId) }
              : c
          )
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : '保存失败'
        setAppAlert({
          open: true,
          title: '保存失败',
          details: `保存远程文件失败：${message}`,
        })
      }
    },
    [activeConnectionId, connections, remoteFileOpts]
  )

  const showAiUnavailable = useCallback((assistantId: string) => {
    const hint =
      aiSettings.backend === 'claude-code'
        ? '请使用 Tauri 桌面版（npm run dev:tauri）并安装 Claude Code CLI。'
        : '请在设置（Ctrl+,）中配置云端 API Key 与模型。'

    setConnections(prev =>
      prev.map(conn => {
        if (conn.id !== activeConnectionId) return conn
        return {
          ...conn,
          aiMessages: conn.aiMessages.map(m =>
            m.id === assistantId ? { ...m, content: hint } : m
          ),
          aiThinking: false,
        }
      })
    )
  }, [activeConnectionId, aiSettings.backend])

  const handleAiMessage = useCallback(
    async (message: string) => {
      if (!activeConnectionId || !aiSettings.enabled) return

      const assistantId = `msg-${Date.now()}-ai`
      activeAssistantIdRef.current = assistantId

      setConnections(prev =>
        prev.map(conn => {
      if (conn.id !== activeConnectionId) return conn

      const userMsg: ChatMessage = {
        id: `msg-${Date.now()}`,
        role: 'user',
        content: message,
            timestamp: new Date(),
          }

          const assistantMsg: ChatMessage = {
            id: assistantId,
            role: 'assistant',
            content: '',
            timestamp: new Date(),
          }

          return {
            ...conn,
            aiMessages: (() => {
              const next = [...conn.aiMessages, userMsg, assistantMsg]
              return next.length > MAX_AI_MESSAGES ? next.slice(next.length - MAX_AI_MESSAGES) : next
            })(),
            aiThinking: true,
          }
        })
      )

      const useClaudeCodeBackend = isTauriRuntime()

      if (useClaudeCodeBackend) {
        try {
          if (claudeCode.streamListenError) {
            throw new Error(claudeCode.streamListenError)
          }
          const detected = await detectClaude(aiSettings.claudePath || undefined).catch(
            () => claudeCode.detected
          )
          if (!detected?.found) {
            const logHint = claudeCode.lastDiag ? `\n${claudeCode.lastDiag}` : ''
            throw new Error(
              `未检测到 Claude Code CLI。请先安装并登录（npm i -g @anthropic-ai/claude-code），或在设置中填写 claude 路径。${logHint}`
            )
          }
          await claudeCode.ensureStreamReady()
          const bridgeStatus = await claudeCode.ensureBridgeReady()
          const mcpStatus = await claudeCode.ensureMcpReady()
          const ctx = getIdeContext()
          let prompt = message
          if (aiSettings.systemPrompt.trim()) {
            prompt = `${aiSettings.systemPrompt.trim()}\n\n${prompt}`
          }
          const bridgeReady = isIdeBridgeReady(bridgeStatus)
          const mcpReady = mcpStatus?.ready ?? claudeCode.mcpStatus?.ready ?? false
          const ideToolsReady = bridgeReady && mcpReady
          prompt += buildIdeToolDirective({
            activeProfileId: ctx.activeProfileId,
            activeSessionHost: ctx.activeSessionHost,
            bridgeConnected: ideToolsReady,
            terminalConnected: activeShellConnected,
          })
          if (bridgeReady && !mcpReady) {
            prompt +=
              '\n\n[AI Terminal] IDE 桥接在跑，但 MCP stdio（aiterm）未就绪：请确认已安装 Node.js，并在侧栏点击重试 MCP 注册；未就绪时不要声称缺少 runShellCommand。'
          }
          if (aiSettings.injectTerminalContext && activeConnection) {
            if (ctx.terminalSnippet) {
              prompt = `当前会话: ${ctx.activeSessionName ?? 'unknown'} (${ctx.activeSessionHost ?? '-'})\n\n最近终端输出:\n\`\`\`\n${ctx.terminalSnippet}\n\`\`\`\n\n用户: ${prompt}`
            } else {
              prompt = `当前会话: ${ctx.activeSessionName ?? 'unknown'} (${ctx.activeSessionHost ?? '-'})\n\n用户: ${prompt}`
            }
          }

          let assistantAccumulated = ''
          let staleRetried = false

          const registerHandler = (requestId: string) => {
            const SILENT_DEFAULT_MS = 180_000
            // 工具返回后 Claude 还要做一轮模型生成（纯静默），此窗口必须覆盖该间隔。
            // 此前误设为 45s（短于默认值），导致带工具的请求在工具完成后被误判为“无响应”取消。
            const SILENT_LONG_MS = 180_000
            let silentTimer: ReturnType<typeof setTimeout> | null = null
            let silentTimeoutMs = SILENT_DEFAULT_MS
            let sawStreamingText = false
            let bufferedResultText = ''
            const disposeSilentKeepalive = () => {
              if (silentTimer) clearTimeout(silentTimer)
              silentTimer = null
              clearSettleTimer()
              claudeSilentKeepaliveRef.current.delete(requestId)
            }
            const armSilentTimeout = () => {
              if (silentTimer) clearTimeout(silentTimer)
              silentTimer = setTimeout(() => {
                disposeSilentKeepalive()
                void cancelClaudeMessage(requestId).catch(() => {})
                setConnections(prev =>
                  prev.map(conn => {
        if (conn.id !== activeConnectionId) return conn
                    return {
                      ...conn,
                      aiMessages: conn.aiMessages.map(m => {
                        if (m.id !== assistantId) return m
                        const finalized = finalizeAssistantTurn(m)
                        return {
                          ...finalized,
                          content:
                            finalized.content ||
                            'Claude 请求长时间无响应，已自动取消。请重试一次；若持续出现请检查 Claude CLI 登录状态。',
                        }
                      }),
                      aiThinking: false,
                    }
                  })
                )
                activeAssistantIdRef.current = null
                const pending = claudeRequestsByConnectionRef.current.get(activeConnectionId)
                pending?.delete(requestId)
              }, silentTimeoutMs)
            }
            const markLongRunning = () => {
              silentTimeoutMs = SILENT_LONG_MS
              armSilentTimeout()
            }
            claudeSilentKeepaliveRef.current.set(requestId, {
              touch: armSilentTimeout,
              markLongRunning,
              dispose: disposeSilentKeepalive,
            })
            armSilentTimeout()
            let sawReasoning = false
            let settleTimer: ReturnType<typeof setTimeout> | null = null
            const clearSettleTimer = () => {
              if (settleTimer) clearTimeout(settleTimer)
              settleTimer = null
            }
            const armSettleTimer = () => {
              clearSettleTimer()
              settleTimer = setTimeout(() => {
                settleTimer = null
                const pendingSet = claudeRequestsByConnectionRef.current.get(activeConnectionId)
                if (pendingSet && pendingSet.size > 1) return
                setConnections(prev =>
                  prev.map(conn => {
                    if (conn.id !== activeConnectionId || !conn.aiThinking) return conn
                    const msg = conn.aiMessages.find(m => m.id === assistantId)
                    if (!msg || !messageHasTextContent(msg) || messageHasRunningTools(msg)) {
                      return conn
                    }
                    pendingSet?.delete(requestId)
                    const stillPending = Boolean(
                      pendingSet && pendingSet.size > 0
                    )
                    return {
                      ...conn,
                      aiMessages: conn.aiMessages.map(m =>
                        m.id === assistantId ? finalizeAssistantTurn(m) : m
                      ),
                      aiThinking: stillPending,
                    }
                  })
                )
                if (
                  !claudeRequestsByConnectionRef.current.get(activeConnectionId)?.size
                ) {
                  activeAssistantIdRef.current = null
                }
              }, 3500)
            }
            claudeCode.registerStreamHandler(requestId, event => {
              armSilentTimeout()
              armSettleTimer()
              let streamText: string | undefined
              // 任意 aiterm MCP 工具调用后禁用「从回复文本提取命令」的回退，避免与 MCP 重复执行
              if (event.eventType === 'tool_start' && event.toolName) {
                const tn = event.toolName
                if (
                  tn.startsWith('mcp__aiterm__') ||
                  tn === 'runShellCommand' ||
                  tn === 'getFocusedServer' ||
                  tn === 'listActiveConnections' ||
                  tn === 'connectServer'
                ) {
                  mcpShellCommandThisTurnRef.current = true
                  markLongRunning()
                }
              }
              if (event.eventType === 'tool_result' && event.toolName) {
                const tn = event.toolName
                if (
                  tn.startsWith('mcp__aiterm__') ||
                  tn === 'runShellCommand' ||
                  tn === 'getFocusedServer' ||
                  tn === 'listActiveConnections' ||
                  tn === 'connectServer'
                ) {
                  mcpShellCommandThisTurnRef.current = true
                  markLongRunning()
                }
              }
              if (event.eventType === 'reasoning_delta' || event.reasoning) {
                sawReasoning = true
              }
              if (event.text) {
                if (
                  event.eventType === 'stream_event' ||
                  event.eventType === 'stderr' ||
                  event.eventType === 'process_error'
                ) {
                  sawStreamingText = true
                  streamText = event.text
                } else if (event.eventType === 'result') {
                  bufferedResultText = event.text
                  // 无增量 delta 时也要立刻显示正文，不能等到 done
                  if (event.text && !sawStreamingText) {
                    sawStreamingText = true
                    streamText = event.text
                  }
                }
              }

              if (streamText) {
                assistantAccumulated += streamText
              }

              setConnections(prev =>
                prev.map(conn => {
                  if (conn.id !== activeConnectionId) return conn
                  return {
                    ...conn,
                    aiMessages: conn.aiMessages.map(m => {
                      if (m.id !== assistantId) return m
                      let updated = applyClaudeStreamEvent(m, event)
                      if (streamText) {
                        updated = { ...updated, content: updated.content + streamText }
                        updated = appendAssistantTextPart(updated, streamText)
                      }
                      return updated
                    }),
                  }
                })
              )

              const staleText = [event.text, event.error, assistantAccumulated]
                .filter(Boolean)
                .join('\n')
              if (
                !staleRetried &&
                (event.eventType === 'session_error' ||
                  isStaleClaudeSessionError(staleText))
              ) {
                staleRetried = true
                clearClaudeSessionId()
                assistantAccumulated = ''
                disposeSilentKeepalive()
                const stalePending = claudeRequestsByConnectionRef.current.get(activeConnectionId)
                stalePending?.delete(requestId)
                void cancelClaudeMessage(requestId).catch(() => {})
                setConnections(prev =>
                  prev.map(conn =>
                    conn.id === activeConnectionId
                      ? { ...conn, claudeSessionId: undefined }
                      : conn
                  )
                )
                void sendClaudeTurn(undefined)
                return
              }

              if (event.done) {
                // If Claude only emitted a final result (no streaming deltas), append it once here.
                const resultDup =
                  bufferedResultText &&
                  assistantAccumulated &&
                  assistantAccumulated.includes(bufferedResultText.trim())
                if (!sawStreamingText && bufferedResultText && !assistantAccumulated && !resultDup) {
                  assistantAccumulated = bufferedResultText
                  setConnections(prev =>
                    prev.map(conn => {
                      if (conn.id !== activeConnectionId) return conn
                      return {
                        ...conn,
                        aiMessages: conn.aiMessages.map(m => {
                          if (m.id !== assistantId) return m
                          let updated = m
                          updated = { ...updated, content: updated.content + bufferedResultText }
                          updated = appendAssistantTextPart(updated, bufferedResultText)
                          return updated
                        }),
                      }
                    })
                  )
                }
                disposeSilentKeepalive()
                const pending = claudeRequestsByConnectionRef.current.get(activeConnectionId)
                pending?.delete(requestId)
                const stillPending = Boolean(pending && pending.size > 0)

                if (event.sessionId) {
                  setConnections(prev =>
                    prev.map(conn =>
                      conn.id === activeConnectionId
                        ? { ...conn, claudeSessionId: event.sessionId }
                        : conn
                    )
                  )
                }
                const fallbackCmds = extractShellCommands(assistantAccumulated)
                const shouldAutoRun =
                  !stillPending &&
                  !event.error &&
                  !mcpShellCommandThisTurnRef.current &&
                  activeShellConnected &&
                  fallbackCmds.length > 0 &&
                  (aiSettings.autoExecuteCommands ||
                    isRemoteConnectionRefusal(assistantAccumulated))
                if (shouldAutoRun) {
                  for (const cmd of fallbackCmds) {
                    handleAiExecuteCommand(cmd)
                  }
                  if (isRemoteConnectionRefusal(assistantAccumulated)) {
                    setConnections(prev =>
                      prev.map(conn => {
                        if (conn.id !== activeConnectionId) return conn
                        return {
                          ...conn,
                          aiMessages: conn.aiMessages.map(m =>
                            m.id === assistantId
                              ? {
                                  ...m,
                                  content:
                                    `${m.content}\n\n[AI Terminal] 已在左侧 Shell 执行上述命令（MCP 未调用时的回退）。请在设置中确认桥接已连接；理想情况应使用 runShellCommand 工具。`,
                                }
                              : m
                          ),
                        }
                      })
                    )
                  }
                }
                const diag = claudeCode.lastDiag ? `\n\n诊断: ${claudeCode.lastDiag}` : ''
                const logHint =
                  '可在 %LOCALAPPDATA%\\com.dlbury.clide\\logs\\clide.log 查看详细日志（若存在）。'
                setConnections(prev =>
                  prev.map(conn => {
                    if (conn.id !== activeConnectionId) return conn
                    return {
                      ...conn,
                      aiMessages: conn.aiMessages.map(m => {
                        if (m.id !== assistantId) return m
                        let updated = finalizeAssistantTurn(m)
                        if (event.error && !updated.content.trim()) {
                          updated = {
                            ...updated,
                            content: updated.content || `Claude Code 错误: ${event.error}`,
                          }
                        } else if (
                          !event.error &&
                          !assistantAccumulated.trim() &&
                          !bufferedResultText?.trim() &&
                          !sawStreamingText &&
                          !updated.content.trim() &&
                          !sawReasoning
                        ) {
                          updated = {
                            ...updated,
                            content:
                              updated.content ||
                              `Claude 已结束但未返回任何内容。请确认已安装并登录 Claude Code CLI，且设置中的路径正确。${logHint}${diag}`,
                          }
                        }
                        return updated
                      }),
                      aiThinking: stillPending,
                    }
                  })
                )
                if (!stillPending) {
                  activeAssistantIdRef.current = null
                }
              }
            })
          }

          const sendClaudeTurn = async (resumeSessionId?: string) => {
            mcpShellCommandThisTurnRef.current = false
            setConnections(prev =>
              prev.map(conn => {
                if (conn.id !== activeConnectionId) return conn
                return {
                  ...conn,
                  aiMessages: conn.aiMessages.map(m =>
                    m.id === assistantId
                      ? {
                          ...m,
                          content: '',
                          reasoning: '',
                          tools: [],
                          tasks: [],
                          timestamp: new Date(),
                        }
                      : m
                  ),
                  aiThinking: true,
                }
              })
            )
            const requestId = crypto.randomUUID()
            registerHandler(requestId)
            let pending = claudeRequestsByConnectionRef.current.get(activeConnectionId)
            if (!pending) {
              pending = new Set()
              claudeRequestsByConnectionRef.current.set(activeConnectionId, pending)
            }
            pending.add(requestId)
            try {
              await withTimeout(
                sendClaudeMessage({
                  prompt,
                  claudePath: aiSettings.claudePath || undefined,
                  sessionId: resumeSessionId,
                  continueSession: false,
                  requestId,
                }),
                45000,
                '发送 Claude 请求'
              )
            } catch (err) {
              const set = claudeRequestsByConnectionRef.current.get(activeConnectionId)
              set?.delete(requestId)
              throw err
            }
          }

          const connForSession = connectionsRef.current.find(c => c.id === activeConnectionId)
          await sendClaudeTurn(connForSession?.claudeSessionId)
        } catch (err) {
          const errorText = err instanceof Error ? err.message : String(err)
          setConnections(prev =>
            prev.map(conn => {
              if (conn.id !== activeConnectionId) return conn
              return {
                ...conn,
                aiMessages: conn.aiMessages.map(m =>
                  m.id === assistantId ? { ...m, content: errorText } : m
                ),
                aiThinking: false,
              }
            })
          )
        }
        return
      }

      showAiUnavailable(assistantId)
    },
    [
      activeConnection,
      activeConnectionId,
      aiSettings.backend,
      aiSettings.claudePath,
      aiSettings.enabled,
      aiSettings.injectTerminalContext,
      aiSettings.autoExecuteCommands,
      aiSettings.systemPrompt,
      claudeCode,
      activeShellConnected,
      clearClaudeSessionId,
      getIdeContext,
      handleAiExecuteCommand,
      showAiUnavailable,
    ]
  )

  const handleClearAiChat = useCallback(() => {
    if (!activeConnectionId) return
    void resetConnectionClaudeSession(activeConnectionId, { clearChat: true })
  }, [activeConnectionId, resetConnectionClaudeSession])

  const handleStopAiMessage = useCallback(() => {
    if (!activeConnectionId) return
    const pending = claudeRequestsByConnectionRef.current.get(activeConnectionId)
    if (!pending || pending.size === 0) return
    const assistantId = activeAssistantIdRef.current
    for (const requestId of pending) {
      claudeSilentKeepaliveRef.current.get(requestId)?.dispose()
      void cancelClaudeMessage(requestId).catch(() => {})
    }
    claudeRequestsByConnectionRef.current.delete(activeConnectionId)
    activeAssistantIdRef.current = null
    setConnections(prev =>
      prev.map(conn => {
        if (conn.id !== activeConnectionId) return conn
        return {
          ...conn,
          aiMessages: conn.aiMessages.map(m =>
            m.id === assistantId ? finalizeAssistantTurn(m) : m
          ),
          aiThinking: false,
        }
      })
    )
  }, [activeConnectionId])

  const handleAiSidebarToggle = useCallback(() => {
    setShowAiPane(v => !v)
  }, [])

  const openSettings = useCallback((tab: SettingsTab = 'ai') => {
    setSettingsTab(tab)
    setIsSettingsOpen(true)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return
      const action = matchShortcutAction(event)
      if (!action) return

      event.preventDefault()

      switch (action) {
        case 'toggle-sidebar':
          setShowSidebar(v => !v)
          break
        case 'toggle-explorer':
          setShowFileTree(v => !v)
          break
        case 'toggle-ai':
          setShowAiPane(v => !v)
          break
        case 'focus-terminal':
          workbenchRef.current?.focusTerminal()
          break
        case 'focus-editor':
          workbenchRef.current?.focusEditor()
          break
        case 'split-editor-right':
          workbenchRef.current?.splitEditor('right')
          break
        case 'split-editor-below':
          workbenchRef.current?.splitEditor('below')
          break
        case 'open-settings':
          openSettings('ai')
          break
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openSettings])

  const handleCreateSession = useCallback((payload: SessionFormPayload) => {
    const { session: sessionData, folderId } = payload
    const newSession: Session = {
      ...sessionData,
      id: newSessionId(),
      status: 'disconnected',
      lastActive: new Date(),
    }

    if (isTauriRuntime()) {
      const pw =
        sessionData.authConfig?.plainPassword ??
        sessionData.password
      if (pw) {
        setRuntimePassword(newSession.id, pw)
        setStoredPassword(newSession.id, pw)
      }
      void registerProfileAuth(resolveSessionForConnect(newSession))
    }

    setFolders(prev => {
      const updated = ensureDefaultFolder([...prev])
      const targetId =
        folderId === DEFAULT_FOLDER_PLACEHOLDER ? updated[0]?.id : folderId
      let targetFolderIndex = targetId ? updated.findIndex(f => f.id === targetId) : 0
      if (targetFolderIndex < 0) targetFolderIndex = 0
      
      updated[targetFolderIndex] = {
        ...updated[targetFolderIndex],
        sessions: [...updated[targetFolderIndex].sessions, newSession],
      }
      return updated
    })

    setNewSessionFolderId(null)
  }, [setFolders])

  const handleCreateFolder = useCallback((name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return

    setFolders(prev => {
      let folderName = trimmed
      if (prev.some(f => f.name === folderName)) {
        let index = 2
        while (prev.some(f => f.name === `${trimmed} ${index}`)) {
          index += 1
        }
        folderName = `${trimmed} ${index}`
      }

      return [
        ...prev,
        {
          id: `folder-${Date.now()}`,
          name: folderName,
          sessions: [],
          isExpanded: true,
        },
      ]
    })
  }, [])

  const handleRenameFolder = useCallback((folderId: string, name: string) => {
    setFolders(prev => prev.map(f => (f.id === folderId ? { ...f, name } : f)))
  }, [])

  const handleDeleteFolder = useCallback((folderId: string) => {
    setFolders(prev => prev.filter(f => f.id !== folderId))
  }, [])

  const handleDeleteSession = useCallback((sessionId: string) => {
    removeStoredPassword(sessionId)
    const conn = connections.find(c => c.session.id === sessionId)
    if (conn) handleConnectionClose(conn.id)
    setFolders(prev =>
      prev.map(f => ({
        ...f,
        sessions: f.sessions.filter(s => s.id !== sessionId),
      }))
    )
  }, [connections, handleConnectionClose])

  const handleEditSession = useCallback((session: Session) => {
    setEditingSession(session)
    setIsNewSessionModalOpen(true)
  }, [])

  const handleUpdateSession = useCallback((payload: { session: Session; folderId: string }) => {
    const { session: updated, folderId } = payload

    setFolders(prev => {
      const withoutSession = prev.map(f => ({
        ...f,
        sessions: f.sessions.filter(s => s.id !== updated.id),
      }))

      const next = ensureDefaultFolder(withoutSession)
      const targetId =
        folderId === DEFAULT_FOLDER_PLACEHOLDER ? next[0]?.id : folderId
      const targetIndex = targetId ? next.findIndex(f => f.id === targetId) : 0
      const index = targetIndex >= 0 ? targetIndex : 0

      next[index] = {
        ...next[index],
        sessions: [...next[index].sessions, updated],
      }
      return next
    })

    setConnections(prev =>
      prev.map(c => (c.session.id === updated.id ? { ...c, session: updated } : c))
    )
    if (isTauriRuntime()) {
      const pw = updated.authConfig?.plainPassword ?? updated.password
      if (pw) {
        setRuntimePassword(updated.id, pw)
        setStoredPassword(updated.id, pw)
      }
      void registerProfileAuth(resolveSessionForConnect(updated))
    }
    setEditingSession(null)
  }, [setFolders])

  const handleDisconnectSession = useCallback((sessionId: string) => {
    const conn = connections.find(c => c.session.id === sessionId)
    if (conn) handleConnectionClose(conn.id)
  }, [connections, handleConnectionClose])

  handleClaudeToolRequestRef.current = (payload: Record<string, unknown>) => {
    const tool = payload.tool as string | undefined
    if (
      tool === 'runShellCommand' ||
      tool === 'connectServer' ||
      tool === 'disconnectServer' ||
      tool === 'createNewShell' ||
      tool === 'getTerminalContext' ||
      tool === 'listRemoteFiles' ||
      tool === 'readRemoteFile'
    ) {
      mcpShellCommandThisTurnRef.current = true
      keepalivePendingClaudeRequests(activeConnectionIdRef.current, true)
    }
    if (tool === 'connectServer' && typeof payload.profileId === 'string') {
      const profileId = payload.profileId
      if (typeof payload.requestId === 'string') {
        pendingMcpConnectRef.current.set(profileId, payload.requestId)
        // 130s 后若仍未收到 terminal:status 事件，主动超时清理（Rust 侧 120s 超时）
        const rid = payload.requestId
        setTimeout(() => {
          if (pendingMcpConnectRef.current.get(profileId) === rid) {
            pendingMcpConnectRef.current.delete(profileId)
            import('@tauri-apps/api/core')
              .then(({ invoke }) =>
                invoke('complete_connect_tool', {
                  requestId: rid,
                  success: false,
                  error: '前端超时：130s 内未收到连接状态变更事件',
                })
              )
              .catch(() => {})
          }
        }, 130_000)
      }
      const session = foldersRef.current
        .flatMap(f => f.sessions)
        .find(s => s.id === profileId)
      if (!session) {
        if (typeof payload.requestId === 'string') {
          pendingMcpConnectRef.current.delete(profileId)
          void import('@tauri-apps/api/core')
            .then(({ invoke }) =>
              invoke('complete_connect_tool', {
                requestId: payload.requestId as string,
                success: false,
                error: `未找到会话 profileId=${profileId}`,
              })
            )
            .catch(() => {})
        }
      } else {
        const existingConn = connectionsRef.current.find(c => c.session.id === profileId)
        const alreadyConnected = existingConn?.shells.some(
          s => s.terminalStatus === 'connected'
        )
        if (alreadyConnected && typeof payload.requestId === 'string') {
          pendingMcpConnectRef.current.delete(profileId)
          void import('@tauri-apps/api/core')
            .then(({ invoke }) =>
              invoke('complete_connect_tool', {
                requestId: payload.requestId as string,
                success: true,
              })
            )
            .catch(() => {})
        } else {
          handleSessionConnect(session)
        }
      }
    }
    if (tool === 'disconnectServer' && typeof payload.profileId === 'string') {
      handleDisconnectSession(payload.profileId)
    }
    if (tool === 'createNewShell' && typeof payload.connectionId === 'string') {
      const connectionId = payload.connectionId as string
      const shellName = payload.shellName as string | undefined
      // 切换到对应连接，然后创建新 shell
      const conn = connectionsRef.current.find(c => c.id === connectionId)
      if (conn) {
        // 切换到该连接
        if (conn.id !== activeConnectionIdRef.current) {
          setActiveConnectionId(conn.id)
        }
        // 延迟创建 shell，确保连接已激活
        window.setTimeout(() => {
          handleNewShellForConnection(connectionId, shellName)
        }, 300)
      }
    }
    if (
      tool === 'runShellCommand' &&
      typeof payload.terminalSessionId === 'string'
    ) {
      const terminalSessionId = payload.terminalSessionId as string
      if (typeof payload.requestId === 'string' && typeof payload.command === 'string') {
        console.log(`[MCP] Executing shell command: ${payload.command}, requestId: ${payload.requestId}`)
        void executeShellToolInTab({
          requestId: payload.requestId as string,
          terminalSessionId,
          command: payload.command as string,
          waitMs: typeof payload.waitMs === 'number' ? payload.waitMs : undefined,
          sessionType:
            typeof payload.sessionType === 'string' ? payload.sessionType : undefined,
          beforeExecute: async () => {
            console.log(`[MCP] Focusing shell before execute: ${terminalSessionId}`)
            await focusShellByTerminalId(terminalSessionId)
          },
        }).catch(err => {
          console.error(`[MCP] Shell command execution failed:`, err)
        })
      } else {
        console.error(`[MCP] Invalid payload for runShellCommand:`, payload)
        if (typeof payload.requestId === 'string') {
          void import('@tauri-apps/api/core')
            .then(({ invoke }) =>
              invoke('complete_shell_tool_command', {
                requestId: payload.requestId as string,
                output: null,
                error: 'runShellCommand 参数不完整（缺少 requestId 或 command）',
              })
            )
            .catch(() => {})
        }
      }
    }
  }

  useEffect(() => {
    if (!isTauriRuntime()) return

    let unlistenActivity: (() => void) | undefined

    void listenToolActivity(event => {
      setToolActivities(prev => [event, ...prev].slice(0, 50))
      if (event.kind === 'shell_command') {
        if (event.status === 'running' || event.status === 'completed' || event.status === 'error') {
          keepalivePendingClaudeRequests(activeConnectionIdRef.current, true)
        }
        // 命令完成/出错时自动清除交互提示横幅
        if (
          (event.status === 'completed' || event.status === 'error') &&
          interactivePromptRef.current &&
          event.terminalSessionId === interactivePromptRef.current.sessionId
        ) {
          setInteractivePrompt(null)
        }
      }
      const assistantId = activeAssistantIdRef.current
      const connId = activeConnectionIdRef.current
      if (assistantId && connId) {
        setConnections(prev =>
          prev.map(conn => {
            if (conn.id !== connId) return conn
            return {
              ...conn,
              aiMessages: conn.aiMessages.map(m =>
                m.id === assistantId ? applyToolActivityToMessage(m, event) : m
              ),
            }
          })
        )
      }
    }).then(fn => {
      unlistenActivity = fn
    })

    const unsubscribeToolRequest = subscribeClaudeToolRequest(payload => {
      handleClaudeToolRequestRef.current(payload)
    })

    return () => {
      unlistenActivity?.()
      unsubscribeToolRequest()
    }
  }, [])

  const handleNewSessionInFolder = useCallback((folderId: string) => {
    setNewSessionFolderId(folderId)
    setEditingSession(null)
    setIsNewSessionModalOpen(true)
  }, [])

  const handleCloseOtherTabs = useCallback((connectionId: string) => {
    connections
      .filter(c => c.id !== connectionId)
      .forEach(c => handleConnectionClose(c.id))
    setActiveConnectionId(connectionId)
  }, [connections, handleConnectionClose])

  const handleCloseAllTabs = useCallback(() => {
    connections.forEach(c => handleConnectionClose(c.id))
  }, [connections, handleConnectionClose])

  const handleReconnectTab = useCallback((connectionId: string) => {
    const conn = connections.find(c => c.id === connectionId)
    if (!conn?.terminalLive) return

    setConnections(prev =>
      prev.map(c =>
        c.id === connectionId
          ? {
              ...c,
              session: { ...c.session, status: 'connecting' },
              shells: c.shells.map(s => ({ ...s, terminalStatus: 'connecting' as const })),
            }
          : c
      )
    )

    for (const shell of conn.shells) {
      runBackendConnect(
        conn.session,
        connectionId,
        shell.id,
        shell.terminalSessionId
      )
    }
  }, [connections, runBackendConnect])

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-background">
      <AppAlertDialog
        state={appAlert}
        onOpenChange={open => setAppAlert(prev => ({ ...prev, open }))}
      />
      {/* Server Connection Tabs */}
      <ServerTabs
        connections={connections}
        activeConnectionId={activeConnectionId}
        onTabClick={setActiveConnectionId}
        onTabClose={handleConnectionClose}
        onCloseOtherTabs={handleCloseOtherTabs}
        onCloseAllTabs={handleCloseAllTabs}
        onReconnectTab={handleReconnectTab}
        onOpenSettings={() => openSettings('ai')}
      />

      {/* Main Layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Server List */}
        <div
          className={cn(
            'shrink-0 overflow-hidden transition-[width] duration-200 border-r border-sidebar-border',
            showSidebar ? 'w-64' : 'w-0'
          )}
        >
        <Sidebar
          folders={folders}
            onSessionSelect={handleSessionSelect}
            onSessionConnect={handleSessionConnect}
            onNewSession={() => {
              setEditingSession(null)
              setNewSessionFolderId(null)
              setIsNewSessionModalOpen(true)
            }}
            onNewSessionInFolder={handleNewSessionInFolder}
            onCreateFolder={handleCreateFolder}
            onRenameFolder={handleRenameFolder}
            onDeleteFolder={handleDeleteFolder}
            onEditSession={handleEditSession}
            onDeleteSession={handleDeleteSession}
            onDisconnectSession={handleDisconnectSession}
          activeSessionId={activeSession?.id}
        />
        </div>

        {/* Center + Right Content */}
        {activeConnection ? (
          <ResizablePanel
            direction="horizontal"
            defaultSizes={[75, 25]}
            minSizes={[50, 15]}
            panelVisible={[true, showAiPane]}
            className="flex-1"
          >
            <ResizablePanel
              direction="horizontal"
              defaultSizes={[22, 78]}
              minSizes={[18, 40]}
              panelVisible={[showFileTree, true]}
              className="min-w-0 h-full"
            >
              <FileTree
                key={activeConnection.id}
                files={activeConnection.remoteFiles ?? []}
                currentPath={activeConnection.remotePath}
                remoteMode={activeConnection.session.type === 'ssh'}
                remoteUser={activeConnection.session.user}
                selectedPath={activeConnection.selectedFilePath}
                followTerminalCwd={followTerminalCwd}
                onFollowTerminalCwdChange={handleFollowTerminalCwdChange}
                terminalCwd={
                  activeConnection.shells.find(
                    s => s.id === activeConnection.activeShellId
                  )?.shellCwd
                }
                transferBusy={transferBusy}
                uploadProgress={uploadProgress}
                fileRootMode={fileRootMode}
                onFileRootModeChange={handleFileRootModeChange}
                onUpload={handleRemoteUpload}
                onMove={handleRemoteMove}
                onDownload={handleRemoteDownload}
                onDelete={handleRemoteDelete}
                onFileOpen={handleFileOpen}
                onFileSelect={handleFileSelect}
                onNavigate={handleRemoteNavigate}
                onDirectoryExpand={handleRemoteDirectoryExpand}
                onRefresh={() => {
                  if (activeConnection.session.type === 'ssh') {
                    void loadRemoteFiles(
                      activeConnection.session,
                      activeConnection.remotePath ?? '~'
                    )
                  }
                }}
              />
              <WorkbenchLayout
                ref={workbenchRef}
                connectionId={activeConnection.id}
                session={activeConnection.session}
                  shells={activeConnection.shells}
                  activeShellId={activeConnection.activeShellId}
                openFiles={activeConnection.openFiles}
                activeFileId={activeConnection.activeFileId}
                terminalLive={activeConnection.terminalLive}
                clearSignals={Object.fromEntries(
                  activeConnection.shells.map(s => [
                    s.terminalSessionId,
                    terminalClearSignals[s.terminalSessionId] ?? 0,
                  ])
                )}
                  onShellChange={handleShellChange}
                  onNewShell={handleNewShell}
                  onCloseShell={handleCloseShell}
                  onCommand={handleCommand}
                onFileChange={handleFileChange}
                onFileSave={handleFileSaveById}
                onFileClose={handleFileClose}
                onActiveFileChange={handleActiveFileChange}
              />
            </ResizablePanel>

            <AiPane
              messages={activeConnection.aiMessages}
              isThinking={activeConnection.aiThinking}
              aiEnabled={aiSettings.enabled}
              modelLabel={
                aiSettings.enabled
                  ? claudeCode.detected?.found
                    ? `Claude Code${claudeCode.detected.version ? ` · ${claudeCode.detected.version}` : ''}`
                    : 'Claude Code（未安装）'
                  : undefined
              }
              bridgeStatus={
                claudeCode.bridge
                  ? {
                      running: claudeCode.bridge.running,
                      connected: claudeCode.bridge.connected,
                      hasClient: claudeCode.bridge.hasClient,
                      port: claudeCode.bridge.port,
                      lockFile: claudeCode.bridge.lockFile,
                      workspaceFolders: claudeCode.bridge.workspaceFolders,
                    }
                  : undefined
              }
              mcpStatus={claudeCode.mcpStatus}
              mcpRegisterError={claudeCode.mcpRegisterError}
              mcpRegistering={claudeCode.mcpRegistering}
              streamListenError={claudeCode.streamListenError}
              lastDiag={claudeCode.lastDiag}
              onRetryMcpRegister={() => void claudeCode.retryMcpRegister()}
              onSendMessage={handleAiMessage}
              onStopMessage={handleStopAiMessage}
              onExecuteCommand={handleAiExecuteCommand}
              onClearChat={handleClearAiChat}
              claudePath={aiSettings.claudePath || undefined}
              interactivePrompt={interactivePrompt}
              onPromptDismiss={() => setInteractivePrompt(null)}
              onPromptCancel={sid => {
                cancelShellToolForSession(sid)
                setInteractivePrompt(null)
              }}
            />
          </ResizablePanel>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm px-6 text-center">
            暂无打开的连接。请在左侧选择会话并点击「连接」，或新建会话。
          </div>
        )}
      </div>

      {/* Status Bar */}
      <StatusBar
        session={activeSession}
        hostStats={hostStats}
        aiSidebarVisible={showAiPane}
        aiThinking={activeConnection?.aiThinking}
        onAiSidebarToggle={handleAiSidebarToggle}
      />

      <NewSessionModal
        isOpen={isNewSessionModalOpen}
        onClose={() => {
          setIsNewSessionModalOpen(false)
          setEditingSession(null)
          setNewSessionFolderId(null)
        }}
        folders={folders}
        defaultFolderId={newSessionFolderId}
        editSession={editingSession}
        editSessionFolderId={
          editingSession
            ? folders.find(f => f.sessions.some(s => s.id === editingSession.id))?.id ?? null
            : null
        }
        onCreateSession={handleCreateSession}
        onUpdateSession={handleUpdateSession}
      />

      <SessionPasswordDialog
        open={passwordPrompt !== null}
        session={passwordPrompt?.session ?? null}
        allowDefaultKeys={passwordPrompt?.allowDefaultKeys ?? false}
        authFailureReason={passwordPrompt?.authFailureReason}
        onOpenChange={handlePasswordPromptOpenChange}
        onSubmit={handlePasswordPromptSubmit}
        onUseDefaultKeys={handlePasswordPromptUseDefaultKeys}
      />

      <SettingsModal
        open={isSettingsOpen}
        onOpenChange={setIsSettingsOpen}
        activeTab={settingsTab}
        aiSettings={aiSettings}
        onSaveAiSettings={updateAiSettings}
      />

      <DeleteRemoteFileDialog
        file={deleteTarget}
        open={deleteTarget !== null}
        busy={transferBusy}
        error={deleteError}
        onOpenChange={open => {
          if (!open && !transferBusy) {
            setDeleteTarget(null)
            setDeleteError(null)
          }
        }}
        onConfirm={() => void handleConfirmRemoteDelete()}
      />
    </div>
  )
}
