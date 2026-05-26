'use client'

import { useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react'
import { Sidebar } from '@/components/terminal/sidebar'
import { ServerTabs } from '@/components/terminal/server-tabs'
import { StatusBar } from '@/components/terminal/status-bar'
import { NewSessionModal, DEFAULT_FOLDER_PLACEHOLDER } from '@/components/terminal/new-session-modal'
import { SettingsModal } from '@/components/settings/settings-modal'
import { useAiSettings } from '@/lib/ai-settings'
import { sendClaudeMessage, cancelClaudeMessage, type IdeContext } from '@/lib/claude-client'
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
import { executeShellToolInTab } from '@/lib/shell-tool-executor'
import {
  applyClaudeStreamEvent,
  applyToolActivityToMessage,
} from '@/lib/chat-stream-parts'
import { cn } from '@/lib/utils'
import { ensureDefaultFolder, useSessionFolders } from '@/lib/session-store'
import {
  createDefaultLocalShellSession,
  DEFAULT_LOCAL_SHELL_SESSION_ID,
  findLegacyDefaultLocalShellSession,
  stripLegacyDefaultLocalSessions,
} from '@/lib/default-local-shell'
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

function appendTerminalOutput(history: TerminalLine[], data: string): TerminalLine[] {
  const cleaned = sanitizeTerminalOutput(data)
  if (!cleaned) return history
  const last = history[history.length - 1]
  if (last && (last.type === 'output' || last.type === 'error')) {
    return [
      ...history.slice(0, -1),
      { ...last, content: last.content + cleaned },
    ]
  }
  return [
    ...history,
    {
      id: `out-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: 'output' as const,
      content: cleaned,
      timestamp: new Date(),
    },
  ]
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
  const autoLocalShellRef = useRef(false)
  const [terminalClearSignals, setTerminalClearSignals] = useState<Record<string, number>>({})
  const [toolActivities, setToolActivities] = useState<ToolActivityEvent[]>([])
  const [passwordPrompt, setPasswordPrompt] = useState<PendingPasswordConnect | null>(null)
  const [followTerminalCwd, setFollowTerminalCwd] = useState(loadFollowTerminalCwd)
  const [fileRootMode, setFileRootMode] = useState(loadFileRootMode)
  const [transferBusy, setTransferBusy] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<FileItem | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [hostStats, setHostStats] = useState<RemoteHostStats | null>(null)
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
  const activeAssistantIdRef = useRef<string | null>(null)
  const handleClaudeToolRequestRef = useRef<
    (payload: Record<string, unknown>) => void
  >(() => {})
  const claudeRequestsByConnectionRef = useRef<Map<string, Set<string>>>(new Map())
  const claudeCodeRef = useRef<ReturnType<typeof useClaudeCode> | null>(null)
  const aiSettingsRef = useRef(aiSettings)
  aiSettingsRef.current = aiSettings

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
          window.alert(`已上传 ${uploaded} 个文件。\n\n失败:\n${errors.join('\n')}`)
        }
        void loadRemoteFiles(
          activeConnection.session,
          remotePathForListApi(dir, activeConnection.session.user)
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        window.alert(`上传失败: ${message}`)
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
        window.alert(`移动失败: ${message}`)
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
        window.alert(`下载失败: ${message}`)
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
          }
          if (shouldLoadRemote && connectedSession) {
            void loadRemoteFiles(connectedSession, '~')
          }

          const connectedConn = connectionsRef.current.find(c =>
            c.shells.some(s => s.terminalSessionId === event.sessionId)
          )
          if (
            connectedConn &&
            aiSettingsRef.current.enabled &&
            aiSettingsRef.current.backend === 'claude-code'
          ) {
            void claudeCodeRef.current?.restartBridge().catch(console.error)
          }
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

      void registerProfileAuth(resolved)
        .then(() => connectTerminalSession(resolved, terminalSessionId))
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

      void resetConnectionClaudeSession(existingConn.id, { clearChat: true })

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
    const snapshot = buildRuntimeSnapshot({
      folders,
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

  // 启动后恢复本机已存密码并注册到 Rust vault
  useEffect(() => {
    if (!foldersLoaded || !isTauriRuntime()) return
    for (const session of folders.flatMap(f => f.sessions)) {
      const stored = getStoredPassword(session.id)
      if (stored) {
        setRuntimePassword(session.id, stored)
      }
      void registerProfileAuth(resolveSessionForConnect(session))
    }
  }, [folders, foldersLoaded])

  // 启动时显示并聚焦主窗口（避免仅出现在任务栏）
  useEffect(() => {
    if (!isTauriRuntime()) return
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      const win = getCurrentWindow()
      void win.show()
      void win.unminimize()
      void win.setFocus()
    })
  }, [])

  // 无打开标签时自动连接本地 Shell（不写入侧边栏会话列表）
  useLayoutEffect(() => {
    if (!foldersLoaded) return
    if (connections.length > 0) {
      autoLocalShellRef.current = false
      return
    }
    if (autoLocalShellRef.current) return
    autoLocalShellRef.current = true

    const sessions = folders.flatMap(f => f.sessions)
    const legacy = findLegacyDefaultLocalShellSession(sessions)
    const localSession =
      sessions.find(s => s.id === DEFAULT_LOCAL_SHELL_SESSION_ID) ??
      (legacy
        ? { ...legacy, id: DEFAULT_LOCAL_SHELL_SESSION_ID }
        : createDefaultLocalShellSession())

    const timer = window.setTimeout(() => {
      handleSessionConnect(localSession)
    }, 200)
    return () => window.clearTimeout(timer)
  }, [foldersLoaded, connections.length, folders, handleSessionConnect])

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
      if (
        shell &&
        activeConnection.terminalLive &&
        shell.terminalStatus === 'connected'
      ) {
        injectAiCommandEcho(shell.terminalSessionId, command)
      }
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

  const focusShellByTerminalId = useCallback((terminalSessionId: string) => {
    const conn = connectionsRef.current.find(c =>
      c.shells.some(s => s.terminalSessionId === terminalSessionId)
    )
    if (!conn) return
    const shell = conn.shells.find(s => s.terminalSessionId === terminalSessionId)
    if (!shell) return
    if (conn.id !== activeConnectionIdRef.current) {
      setActiveConnectionId(conn.id)
    }
    if (conn.activeShellId !== shell.id) {
      handleShellChangeRef.current(shell.id)
    }
    window.setTimeout(() => workbenchRef.current?.focusTerminal(), 80)
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
        window.alert(`保存远程文件失败：${message}`)
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
        window.alert(`保存远程文件失败：${message}`)
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
            aiMessages: [...conn.aiMessages, userMsg, assistantMsg],
            aiThinking: true,
          }
        })
      )

      const useClaudeCodeBackend = isTauriRuntime()

      if (useClaudeCodeBackend) {
        try {
          const ctx = getIdeContext()
          let prompt = message
          if (aiSettings.systemPrompt.trim()) {
            prompt = `${aiSettings.systemPrompt.trim()}\n\n${prompt}`
          }
          prompt += buildIdeToolDirective({
            activeProfileId: ctx.activeProfileId,
            activeSessionHost: ctx.activeSessionHost,
            bridgeConnected: Boolean(claudeCode.bridge?.running),
            terminalConnected: activeShellConnected,
          })
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
            claudeCode.registerStreamHandler(requestId, event => {
              const streamText =
                event.text &&
                event.eventType === 'stream_event'
                  ? event.text
                  : undefined

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
                const pending = claudeRequestsByConnectionRef.current.get(activeConnectionId)
                pending?.delete(requestId)

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
                  !mcpShellCommandThisTurnRef.current &&
                  activeShellConnected &&
                  fallbackCmds.length > 0 &&
                  (aiSettings.autoExecuteCommands ||
                    isRemoteConnectionRefusal(assistantAccumulated))
                if (!event.error && shouldAutoRun) {
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
                if (event.error) {
                  setConnections(prev =>
                    prev.map(conn => {
                      if (conn.id !== activeConnectionId) return conn
                      return {
                        ...conn,
                        aiMessages: conn.aiMessages.map(m =>
                          m.id === assistantId
                            ? {
                                ...m,
                                content: m.content || `Claude Code 错误: ${event.error}`,
                              }
                            : m
                        ),
                        aiThinking: false,
                      }
                    })
                  )
                } else {
                  setConnections(prev =>
                    prev.map(conn =>
                      conn.id === activeConnectionId ? { ...conn, aiThinking: false } : conn
                    )
                  )
                }
                activeAssistantIdRef.current = null
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
            const requestId = await sendClaudeMessage({
              prompt,
              claudePath: aiSettings.claudePath || undefined,
              sessionId: resumeSessionId,
              continueSession: false,
            })
            let pending = claudeRequestsByConnectionRef.current.get(activeConnectionId)
            if (!pending) {
              pending = new Set()
              claudeRequestsByConnectionRef.current.set(activeConnectionId, pending)
            }
            pending.add(requestId)
            registerHandler(requestId)
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
    if (tool === 'connectServer' && typeof payload.profileId === 'string') {
      const session = foldersRef.current
        .flatMap(f => f.sessions)
        .find(s => s.id === payload.profileId)
      if (session) handleSessionConnect(session)
    }
    if (tool === 'disconnectServer' && typeof payload.profileId === 'string') {
      handleDisconnectSession(payload.profileId)
    }
    if (
      tool === 'runShellCommand' &&
      typeof payload.requestId === 'string' &&
      typeof payload.terminalSessionId === 'string' &&
      typeof payload.command === 'string'
    ) {
      mcpShellCommandThisTurnRef.current = true
      const terminalSessionId = payload.terminalSessionId as string
      focusShellByTerminalId(terminalSessionId)
      void executeShellToolInTab({
        requestId: payload.requestId as string,
        terminalSessionId,
        command: payload.command as string,
        waitMs: typeof payload.waitMs === 'number' ? payload.waitMs : undefined,
      })
    }
  }

  useEffect(() => {
    if (!isTauriRuntime()) return

    let unlistenActivity: (() => void) | undefined

    void listenToolActivity(event => {
      setToolActivities(prev => [event, ...prev].slice(0, 50))
      const assistantId = activeAssistantIdRef.current
      const connId = activeConnectionIdRef.current
      if (assistantId && connId) {
        setConnections(prev =>
          prev.map(conn => {
            if (conn.id !== connId) return conn
            return {
              ...conn,
              aiMessages: conn.aiMessages.map(m =>
                m.id === assistantId
                  ? applyToolActivityToMessage(m, event, Date.now())
                  : m
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
              onSendMessage={handleAiMessage}
              onExecuteCommand={handleAiExecuteCommand}
              onClearChat={handleClearAiChat}
              claudePath={aiSettings.claudePath || undefined}
            />
          </ResizablePanel>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            正在打开本地终端…
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
