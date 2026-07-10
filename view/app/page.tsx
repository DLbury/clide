'use client'

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { Sidebar } from '@/components/terminal/sidebar'
import { ServerTabs } from '@/components/terminal/server-tabs'
import { StatusBar } from '@/components/terminal/status-bar'
import { CommandHistoryDialog } from '@/components/terminal/command-history-dialog'
import { MultiServerSyncDialog, type SyncServerTarget } from '@/components/terminal/multi-server-sync-dialog'
import { NewSessionModal, DEFAULT_FOLDER_PLACEHOLDER } from '@/components/terminal/new-session-modal'
import { SettingsModal } from '@/components/settings/settings-modal'
import { useAiSettings, getActiveCliPath, withActiveCliPath } from '@/lib/ai-settings'
import { getBackendMeta } from '@/lib/ai-backends'
import {
  sendClaudeMessage,
  detectClaude,
  isIdeBridgeReady,
  type IdeContext,
  type ClaudeStreamEvent,
} from '@/lib/claude-client'
import { sendAiMessage, detectAiBackend, cancelAiMessage } from '@/lib/ai-client'
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
  createRemoteDirectory,
  searchRemoteFiles,
  chmodRemotePath,
  listLocalDirectory,
  readLocalFile,
  writeLocalFile,
  getLocalHomeDir,
  getRemoteCwd,
  detectRemotePlatform,
  getRemoteHostStats,
  type RemoteHostStats,
  type RemoteShellPlatform,
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
import { registerSyncGroup, unregisterSyncGroup } from '@/lib/terminal-sync-group'
import { makeTerminalSessionId, parseTerminalSessionId } from '@/lib/terminal-session'
import {
  remoteEntriesToFileTree,
  mergeRemoteChildren,
  replaceRemoteChildrenAt,
  resolveRemoteDisplayPath,
  isWindowsRemotePath,
} from '@/lib/remote-file-tree'
import {
  type ChatHistorySummary,
} from '@/lib/chat-history-store'
import {
  loadFollowTerminalCwd,
  saveFollowTerminalCwd,
  loadFileRootMode,
  saveFileRootMode,
} from '@/lib/file-explorer-settings'
import {
  loadSidebarVisible,
  saveSidebarVisible,
  loadFileTreeVisible,
  saveFileTreeVisible,
  loadAiPaneVisible,
  saveAiPaneVisible,
} from '@/lib/panel-layout-settings'
import {
  shellHomeDir,
  extractCwdFromTerminalChunk,
  parseCdTargetFromCommand,
  remotePathForListApi,
  consumeTerminalInputLine,
  formatShellCdCommand,
  setWindowsShellFlavor,
  getWindowsShellFlavor,
  detectWindowsShellFlavorFromOutput,
  usesWindowsShellCommands,
} from '@/lib/terminal-cwd'
import {
  deleteRemoteFile,
  downloadRemoteFile,
  moveRemoteFile,
  renameRemoteFile,
  uploadFilesToRemote,
  type UploadProgress,
} from '@/lib/remote-file-transfer'
import { getParentPath } from '@/lib/file-utils'
import { joinRemotePath } from '@/lib/terminal-cwd'
import { submitTerminalInput } from '@/lib/terminal-input-registry'
import {
  appendHostStatsSample,
  type HostStatsSample,
} from '@/lib/host-stats-history'
import { matchShortcutAction, isTypingTarget } from '@/lib/layout-shortcuts'
import type { SettingsTab } from '@/lib/layout-shortcuts'
import { ResizablePanel } from '@/components/layout/resizable-panel'
import { WorkbenchLayout, type WorkbenchLayoutHandle } from '@/components/layout/workbench-layout'
import {
  listLayoutSnapshots,
  saveLayoutSnapshot,
  deleteLayoutSnapshot,
  resolveShellCwdForSnapshot,
  probeShellCwds,
  resolveSnapshotFileTreePath,
  snapshotPathForFileTreeLoad,
  dockviewHasMonitorPanel,
  type ServerLayoutSnapshot,
} from '@/lib/layout-snapshots'
import {
  connectionSessionStatus,
  foldersNeedStatusSync,
  mergeFolderSessionStatuses,
} from '@/lib/connection-status'
import { listTunnels, stopTunnel, stopSocksForProfile } from '@/lib/tunnel-client'
import { tabTitleFromUrl } from '@/lib/browser-address'
import { makeBrowserWebviewLabel } from '@/lib/tauri-child-webview'
import { FileTree } from '@/components/layout/file-tree'
import { CollapsiblePanelRail } from '@/components/layout/collapsible-panel-rail'
import { Server, FolderTree } from 'lucide-react'
import { DeleteRemoteFileDialog } from '@/components/layout/delete-remote-file-dialog'
import { AiPane } from '@/components/layout/ai-pane'
import { AppAlertDialog, type AppAlertDialogState } from '@/components/ui/app-alert-dialog'
import { UpdateAvailableDialog } from '@/components/settings/update-available-dialog'
import {
  checkForAppUpdate,
  loadAutoCheckUpdates,
  type UpdateCheckResult,
} from '@/lib/app-updater'
import { readFileContent, writeFileContent } from '@/lib/file-system'
import {
  openEditorModel,
  updateEditorContent,
  saveEditorModel,
  closeEditorModel,
  setEditorLoadedContent,
  createEditorModel,
  type EditorModel,
} from '@/lib/editor-service'
import { sanitizeTerminalOutput } from '@/lib/terminal-sanitize'
import {
  buildIdeToolDirective,
  buildMultiTerminalContextPrefix,
  extractShellCommands,
  isRemoteConnectionRefusal,
  type ConnectedServerBrief,
} from '@/lib/extract-shell-command'
import { aiSendQueueKey, runAiSendQueued } from '@/lib/ai-send-queue'
import { useAgentThreads } from '@/hooks/use-agent-threads'
import { ThreadsDrawer } from '@/components/layout/threads-drawer'
import {
  requestCommandApproval,
  resolveCommandApproval,
  subscribeCommandApproval,
  type PendingCommandApproval,
} from '@/lib/command-approval-bridge'
import {
  assessDisconnectRisk,
  shouldRequireCommandApproval,
  type CommandApprovalSource,
} from '@/lib/command-risk'
import { deriveThreadTitle } from '@/lib/agent-thread-store'
import { isClaudeCliNoise, isStaleClaudeSessionError } from '@/lib/claude-session'
import {
  cancelShellToolForSession,
  executeShellToolInTab,
  registerMonitorShellResolver,
  registerShellToolKeepaliveTouch,
  registerShellToolPromptListener,
  acknowledgeInteractivePrompt,
} from '@/lib/shell-tool-executor'
import {
  applyClaudeStreamEvent,
  applyToolActivityToMessage,
  assistantTextContent,
  finalizeAssistantTurn,
  messageHasRunningTools,
  messageHasTextContent,
  appendAssistantTextPart,
  syncAssistantContentFromParts,
} from '@/lib/chat-stream-parts'
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

interface BrowserTab {
  id: string
  title: string
  url: string
  webviewLabel: string
  tunnelId?: string
}

interface SyncGroupMember {
  sourceConnectionId: string
  session: Session
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
  /** SSH 远程 Shell 平台（Linux / Windows OpenSSH） */
  remotePlatform?: RemoteShellPlatform
  remoteFileError?: string | null
  browserTabs?: BrowserTab[]
  activeBrowserTabId?: string | null
  monitorOpen?: boolean
  /** 多机同步输入虚拟标签 */
  isSyncGroup?: boolean
  syncMembers?: SyncGroupMember[]
}

const MAX_HISTORY_LINES = 200
const MAX_LINE_CONTENT_CHARS = 8000
const MAX_AI_MESSAGES = 120

function trimAgentMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.length > MAX_AI_MESSAGES
    ? messages.slice(messages.length - MAX_AI_MESSAGES)
    : messages
}

function formatSessionHost(session: Session): string {
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

function connectionTerminalConnected(conn: ServerConnection): boolean {
  return conn.shells.some(s => s.terminalStatus === 'connected')
}

function buildConnectedServerBriefs(
  connections: ServerConnection[],
  activeConnectionId: string | null
): ConnectedServerBrief[] {
  return connections
    .filter(c => !c.isSyncGroup)
    .map(conn => ({
    profileId: conn.session.id,
    name: conn.session.name,
    host: formatSessionHost(conn.session),
    terminalConnected: connectionTerminalConnected(conn),
    isFocused: conn.id === activeConnectionId,
  }))
}

function terminalSnippetForConnection(conn: ServerConnection): string | undefined {
  const shell = conn.shells.find(s => s.id === conn.activeShellId) ?? conn.shells[0]
  if (!shell) return undefined
  if (conn.terminalLive) {
    const buf = getTerminalOutputBuffer(shell.terminalSessionId)
    return buf.length > 0 ? buf.slice(-8000) : undefined
  }
  const text = shell.history
    .slice(-20)
    .map(line => line.content)
    .join('\n')
  return text || undefined
}

/** 仅含影响 MCP/runtime 同步的字段，避免 AI 流式更新触发后端快照 */
function buildRuntimeSyncKey(
  folders: { id: string; isExpanded: boolean; sessions: { id: string; status: string }[] }[],
  connections: ServerConnection[],
  activeConnectionId: string | null
): string {
  const folderPart = folders
    .map(
      f =>
        `${f.id}:${f.isExpanded ? 1 : 0}:${f.sessions.map(s => `${s.id}:${s.status}`).join(',')}`
    )
    .join('|')
  const connPart = connections
    .map(c =>
      [
        c.id,
        c.activeShellId,
        c.session.id,
        c.session.status,
        c.shells.map(s => `${s.id}:${s.terminalSessionId}:${s.terminalStatus ?? ''}`).join(';'),
      ].join(':')
    )
    .join('|')
  return `${folderPart}#${connPart}#${activeConnectionId ?? ''}`
}

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
  const {
    threads: agentThreads,
    threadsRef: agentThreadsRef,
    activeThreadId,
    activeThreadIdRef,
    activeThread,
    patchActiveThread,
    patchThread,
    setThreadStatus,
    createNewThread,
    selectThread,
    clearThread,
    updateThreadTitleFromMessages,
  } = useAgentThreads()
  const { folders, setFolders, loaded: foldersLoaded } = useSessionFolders()
  const [connections, setConnections] = useState<ServerConnection[]>([])
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null)
  const [isNewSessionModalOpen, setIsNewSessionModalOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('ai')
  const [showSidebar, setShowSidebar] = useState(loadSidebarVisible)
  const [showFileTree, setShowFileTree] = useState(loadFileTreeVisible)
  const [showAiPane, setShowAiPane] = useState(loadAiPaneVisible)
  const [threadsDrawerOpen, setThreadsDrawerOpen] = useState(false)
  const [commandApprovalPending, setCommandApprovalPending] =
    useState<PendingCommandApproval | null>(null)
  const [commandApprovalResolved, setCommandApprovalResolved] = useState<{
    request: PendingCommandApproval
    approved: boolean
  } | null>(null)
  const commandApprovalResolvedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
  const [hostStatsHistory, setHostStatsHistory] = useState<HostStatsSample[]>([])
  const [hostStatsError, setHostStatsError] = useState<string | null>(null)
  const [multiServerSyncOpen, setMultiServerSyncOpen] = useState(false)
  const [commandHistoryOpen, setCommandHistoryOpen] = useState(false)
  const [appAlert, setAppAlert] = useState<AppAlertDialogState>({
    open: false,
    title: '',
  })
  const [updatePrompt, setUpdatePrompt] = useState<UpdateCheckResult | null>(null)
  const [updatePromptOpen, setUpdatePromptOpen] = useState(false)
  const followTerminalCwdRef = useRef(followTerminalCwd)
  followTerminalCwdRef.current = followTerminalCwd
  const fileRootModeRef = useRef(fileRootMode)
  fileRootModeRef.current = fileRootMode
  const pendingLayoutShellCwdRef = useRef(new Map<string, string>())
  const layoutRestorePendingRef = useRef(false)
  const cwdPollTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const cwdFileTreeLoadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastFileTreeLoadRef = useRef({ connectionId: '', path: '' })
  const loadRemoteInFlightRef = useRef(new Set<string>())

  const treePathKey = useCallback((path: string) => {
    const p = path.replace(/\\/g, '/').replace(/\/+$/, '')
    return p || '~'
  }, [])
  const terminalInputLineBuffersRef = useRef(new Map<string, string>())
  const [layoutSnapshotsVersion, setLayoutSnapshotsVersion] = useState(0)
  const [pendingLayoutRestore, setPendingLayoutRestore] = useState<{
    token: number
    dockview: unknown
  } | null>(null)

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
  /** 每个对话当前进行中的 assistant 消息 id（支持后台并行对话） */
  const assistantByThreadRef = useRef(new Map<string, string>())
  /** requestId → 所属对话与 assistant，供 stream / 工具回调路由 */
  const requestMetaRef = useRef(
    new Map<string, { threadId: string; assistantId: string; mcpShellUsed?: boolean }>()
  )
  const handleClaudeToolRequestRef = useRef<
    (payload: Record<string, unknown>) => void
  >(() => {})
  const claudeRequestsByThreadRef = useRef<Map<string, Set<string>>>(new Map())
  /** 按 requestId 续期 Claude 静默超时（MCP/Shell 阻塞时 stdout 可能长时间无事件） */
  const claudeSilentKeepaliveRef = useRef(
    new Map<
      string,
      { touch: () => void; markLongRunning: () => void; dispose: () => void }
    >()
  )
  const keepalivePendingClaudeRequests = (threadId: string | undefined, long = true) => {
    if (!threadId) return
    const pending = claudeRequestsByThreadRef.current.get(threadId)
    if (!pending) return
    for (const rid of pending) {
      const k = claudeSilentKeepaliveRef.current.get(rid)
      if (long) k?.markLongRunning()
      else k?.touch()
    }
  }

  useEffect(() => {
    return registerShellToolKeepaliveTouch(() => {
      for (const tid of claudeRequestsByThreadRef.current.keys()) {
        keepalivePendingClaudeRequests(tid, true)
      }
    })
  }, [])

  useEffect(() => {
    return registerShellToolPromptListener(e => {
      setInteractivePrompt(prev =>
        prev && prev.sessionId === e.sessionId ? prev : e
      )
      const connId = activeConnectionIdRef.current
      if (!connId) return
      setConnections(prev =>
        prev.map(c => (c.id === connId ? { ...c, aiThinking: true } : c))
      )
      keepalivePendingClaudeRequests(connId, true)
    })
  }, [])
  const claudeCodeRef = useRef<ReturnType<typeof useClaudeCode> | null>(null)
  const aiSettingsRef = useRef(aiSettings)
  aiSettingsRef.current = aiSettings

  useEffect(() => subscribeCommandApproval(setCommandApprovalPending), [])

  const flashCommandApprovalResolved = useCallback(
    (request: PendingCommandApproval, approved: boolean) => {
      if (commandApprovalResolvedTimerRef.current) {
        clearTimeout(commandApprovalResolvedTimerRef.current)
      }
      setCommandApprovalResolved({ request, approved })
      commandApprovalResolvedTimerRef.current = setTimeout(() => {
        setCommandApprovalResolved(null)
        commandApprovalResolvedTimerRef.current = null
      }, 4000)
    },
    []
  )

  const handleApproveCommand = useCallback(
    (id: string) => {
      if (commandApprovalPending?.id !== id) return
      flashCommandApprovalResolved(commandApprovalPending, true)
      resolveCommandApproval(id, true)
    },
    [commandApprovalPending, flashCommandApprovalResolved]
  )

  const handleDenyCommand = useCallback(
    (id: string) => {
      if (commandApprovalPending?.id !== id) return
      flashCommandApprovalResolved(commandApprovalPending, false)
      resolveCommandApproval(id, false)
    },
    [commandApprovalPending, flashCommandApprovalResolved]
  )

  const requestCommandApprovalIfNeededRef = useRef<
    (command: string, source: CommandApprovalSource, context?: string) => Promise<boolean>
  >(() => Promise.resolve(true))

  const requestCommandApprovalIfNeeded = useCallback(
    async (command: string, source: CommandApprovalSource, context?: string) => {
      const assessment = shouldRequireCommandApproval(
        command,
        aiSettings.requireCommandApproval
      )
      if (!assessment.requiresApproval) return true
      return requestCommandApproval({
        command,
        assessment,
        source,
        context,
      })
    },
    [aiSettings.requireCommandApproval]
  )
  requestCommandApprovalIfNeededRef.current = requestCommandApprovalIfNeeded

  // Restore initial desktop connection on client side to avoid hydration mismatch
  useEffect(() => {
    const initial = createInitialDesktopConnection()
    if (initial) {
      setConnections(initial.connections as ServerConnection[])
      setActiveConnectionId(initial.activeConnectionId)
      // PTY 连接在终端监听器就绪后由下方 AutoConnect effect 发起，避免首包丢失
    }
  }, [])

  useEffect(() => {
    saveSidebarVisible(showSidebar)
  }, [showSidebar])

  useEffect(() => {
    saveFileTreeVisible(showFileTree)
  }, [showFileTree])

  useEffect(() => {
    saveAiPaneVisible(showAiPane)
  }, [showAiPane])

  const sidebarFolders = useMemo(
    () => mergeFolderSessionStatuses(folders, connections),
    [folders, connections]
  )

  useEffect(() => {
    setFolders(prev => {
      if (!foldersNeedStatusSync(prev, connections)) return prev
      return mergeFolderSessionStatuses(prev, connections)
    })
  }, [connections, setFolders])

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
    const activeSessionHost = session ? formatSessionHost(session) : undefined

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
      setHostStatsHistory([])
      return
    }

    let cancelled = false
    const session = resolveSessionForConnect(activeConnection.session)
    const poll = () => {
      void getRemoteHostStats(session)
        .then(stats => {
          if (!cancelled) {
            setHostStats(stats)
            setHostStatsError(null)
            setHostStatsHistory(prev => appendHostStatsSample(prev, stats))
          }
        })
        .catch(err => {
          if (!cancelled) {
            setHostStatsError(err instanceof Error ? err.message : String(err))
          }
        })
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
    async (
      session: Session,
      path = '~',
      options?: {
        mergeParentPath?: string
        refreshInPlace?: boolean
        connectionId?: string
      }
    ) => {
      if (!isTauriRuntime()) return
      const isSsh = session.type === 'ssh'
      const isLocalBrowser = session.type === 'local' || session.type === 'wsl'
      if (!isSsh && !isLocalBrowser) return

      const targetConnectionId =
        options?.connectionId ??
        connectionsRef.current.find(
          c => c.id === activeConnectionIdRef.current && c.session.id === session.id
        )?.id ??
        connectionsRef.current.find(c => c.session.id === session.id)?.id

      const flightKey = `${session.id}::${treePathKey(path)}`
      if (loadRemoteInFlightRef.current.has(flightKey)) return
      if (targetConnectionId) {
        const last = lastFileTreeLoadRef.current
        const conn = connectionsRef.current.find(c => c.id === targetConnectionId)
        if (
          last.connectionId === targetConnectionId &&
          treePathKey(path) === '~' &&
          last.path &&
          last.path !== '~' &&
          (conn?.remoteFiles?.length ?? 0) > 0
        ) {
          return
        }
      }
      loadRemoteInFlightRef.current.add(flightKey)

      const resolved = isSsh ? resolveSessionForConnect(session) : session
      let displayPath = isSsh
        ? resolveRemoteDisplayPath(path, session.user)
        : path.replace(/\\/g, '/')

      try {
        const entries = isSsh
          ? await listRemoteDirectory(resolved, path, remoteFileOpts())
          : await listLocalDirectory(session.type as 'local' | 'wsl', path)
        const children = remoteEntriesToFileTree(entries)

        if (entries.length > 0) {
          const firstPath = entries[0].path.replace(/\\/g, '/')
          const slash = firstPath.lastIndexOf('/')
          if (slash > 0) {
            displayPath = firstPath.slice(0, slash)
          }
        } else if (path === '~' || !path) {
          if (isSsh) {
            const cwd = await getRemoteCwd(resolved, remoteFileOpts()).catch(() => null)
            if (cwd) displayPath = cwd.replace(/\\/g, '/')
          } else {
            const home = await getLocalHomeDir(session.type as 'local' | 'wsl').catch(() => null)
            if (home) displayPath = home.replace(/\\/g, '/')
          }
        } else if (isWindowsRemotePath(path)) {
          displayPath = path.replace(/\\/g, '/')
        }

        const canonicalPath = treePathKey(displayPath)

        setConnections(prev =>
          prev.map(conn => {
            const isTarget = targetConnectionId
              ? conn.id === targetConnectionId
              : conn.session.id === session.id
            if (!isTarget) return conn

            const patch = {
              remotePath: canonicalPath,
              remoteFileError: null as string | null,
            }

            if (options?.mergeParentPath) {
              return {
                ...conn,
                ...patch,
                remoteFiles: mergeRemoteChildren(
                  conn.remoteFiles ?? [],
                  options.mergeParentPath,
                  children
                ),
              }
            }

            if (options?.refreshInPlace && conn.remoteFiles?.length) {
              return {
                ...conn,
                ...patch,
                remoteFiles: replaceRemoteChildrenAt(
                  conn.remoteFiles,
                  canonicalPath,
                  children
                ),
              }
            }

            return {
              ...conn,
              ...patch,
              remoteFiles: children,
            }
          })
        )

        if (targetConnectionId) {
          lastFileTreeLoadRef.current = {
            connectionId: targetConnectionId,
            path: canonicalPath,
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('loadRemoteFiles failed', message)
        if (targetConnectionId) {
          setConnections(prev =>
            prev.map(conn => {
              if (conn.id !== targetConnectionId) return conn
              const patch: Partial<typeof conn> = { remoteFileError: message }
              if (options?.mergeParentPath) {
                return {
                  ...conn,
                  ...patch,
                  remoteFiles: mergeRemoteChildren(
                    conn.remoteFiles ?? [],
                    options.mergeParentPath,
                    []
                  ),
                }
              }
              return { ...conn, ...patch }
            })
          )
        }
      } finally {
        loadRemoteInFlightRef.current.delete(flightKey)
      }
    },
    [remoteFileOpts, treePathKey]
  )

  const handleRemoteNavigate = useCallback(
    (path: string) => {
      if (!activeConnection) return
      const t = activeConnection.session.type
      if (t !== 'ssh' && t !== 'local' && t !== 'wsl') return
      void loadRemoteFiles(activeConnection.session, path, {
        connectionId: activeConnection.id,
      })
    },
    [activeConnection, loadRemoteFiles]
  )

  const applyShellCwd = useCallback(
    (connectionId: string, terminalSessionId: string, cwd: string) => {
      const conn = connectionsRef.current.find(c => c.id === connectionId)
      if (!conn) return
      const shell = conn.shells.find(s => s.terminalSessionId === terminalSessionId)
      if (!shell) return

      const isActiveShell = conn.activeShellId === shell.id
      const canSyncTree =
        followTerminalCwdRef.current &&
        isActiveShell &&
        (conn.session.type === 'ssh' ||
          conn.session.type === 'local' ||
          conn.session.type === 'wsl')

      const cwdUnchanged = shell.shellCwd === cwd
      let treeSynced = false
      if (canSyncTree && cwdUnchanged && conn.remotePath) {
        const targetDisplay = resolveSnapshotFileTreePath(
          conn.session,
          cwd,
          conn.remotePath
        )
        treeSynced =
          !!targetDisplay &&
          treePathKey(targetDisplay) === treePathKey(conn.remotePath) &&
          (conn.remoteFiles?.length ?? 0) > 0
      }
      if (cwdUnchanged && (!canSyncTree || treeSynced)) return

      const nextRemotePath = canSyncTree
        ? resolveSnapshotFileTreePath(conn.session, cwd, conn.remotePath)
        : undefined

      setConnections(prev =>
        prev.map(c => {
          if (c.id !== connectionId) return c
          const shells = c.shells.map(s =>
            s.terminalSessionId === terminalSessionId ? { ...s, shellCwd: cwd } : s
          )
          return {
            ...c,
            shells,
            ...(canSyncTree && nextRemotePath ? { remotePath: nextRemotePath } : {}),
          }
        })
      )

      if (!canSyncTree || connectionId !== activeConnectionIdRef.current) return

      const listPath = snapshotPathForFileTreeLoad(conn.session, cwd)
      lastFileTreeLoadRef.current = { connectionId, path: '' }
      if (cwdFileTreeLoadTimerRef.current) {
        clearTimeout(cwdFileTreeLoadTimerRef.current)
      }
      cwdFileTreeLoadTimerRef.current = setTimeout(() => {
        cwdFileTreeLoadTimerRef.current = null
        void loadRemoteFiles(conn.session, listPath, { connectionId })
      }, 150)
    },
    [loadRemoteFiles, treePathKey]
  )

  const scheduleCwdPoll = useCallback(
    (connectionId: string, terminalSessionId: string) => {
      const existing = cwdPollTimersRef.current.get(terminalSessionId)
      if (existing) clearTimeout(existing)
      const timer = setTimeout(() => {
        cwdPollTimersRef.current.delete(terminalSessionId)
        const conn = connectionsRef.current.find(c => c.id === connectionId)
        if (!conn || conn.id !== activeConnectionIdRef.current) return
        const sessionType = conn.session.type
        if (sessionType !== 'ssh' && sessionType !== 'local' && sessionType !== 'wsl') {
          return
        }
        const shell = conn.shells.find(s => s.terminalSessionId === terminalSessionId)
        if (!shell || shell.id !== conn.activeShellId) return
        if (!followTerminalCwdRef.current) return
        const buf = getTerminalOutputBuffer(terminalSessionId)
        const cwd = extractCwdFromTerminalChunk(buf.slice(-8192))
        if (cwd) applyShellCwd(connectionId, terminalSessionId, cwd)
      }, 400)
      cwdPollTimersRef.current.set(terminalSessionId, timer)
    },
    [applyShellCwd]
  )

  const handleFollowTerminalCwdChange = useCallback((enabled: boolean) => {
    setFollowTerminalCwd(enabled)
    saveFollowTerminalCwd(enabled)
    if (!enabled || !activeConnection) return
    const sessionType = activeConnection.session.type
    if (sessionType !== 'ssh' && sessionType !== 'local' && sessionType !== 'wsl') return
    const shell = activeConnection.shells.find(s => s.id === activeConnection.activeShellId)
    if (!shell || shell.terminalStatus !== 'connected') return
    if (sessionType === 'ssh') {
      void getRemoteCwd(resolveSessionForConnect(activeConnection.session), remoteFileOpts())
        .then(cwd => applyShellCwd(activeConnection.id, shell.terminalSessionId, cwd))
        .catch(() => {})
    } else if (shell.shellCwd) {
      applyShellCwd(activeConnection.id, shell.terminalSessionId, shell.shellCwd)
    }
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

  const handleRemoteRename = useCallback(
    async (file: FileItem, newName: string) => {
      if (!activeConnection || activeConnection.session.type !== 'ssh') return
      setTransferBusy(true)
      try {
        await renameRemoteFile(activeConnection.session, file.path, newName, remoteFileOpts())
        void loadRemoteFiles(
          activeConnection.session,
          remotePathForListApi(
            activeConnection.remotePath ?? '~',
            activeConnection.session.user
          )
        )
      } catch (err) {
        console.error(err)
      } finally {
        setTransferBusy(false)
      }
    },
    [activeConnection, loadRemoteFiles, remoteFileOpts]
  )

  const handleOpenInTerminal = useCallback(
    (path: string, isDirectory: boolean) => {
      if (!activeConnectionId) return
      const conn = connectionsRef.current.find(c => c.id === activeConnectionId)
      if (!conn) return
      const shell = conn.shells.find(s => s.id === conn.activeShellId)
      if (!shell || shell.terminalStatus !== 'connected') return
      const cdPath = isDirectory ? path : getParentPath(path)
      void writeTerminal(
        shell.terminalSessionId,
        normalizeShellCommandForPty(
          formatShellCdCommand(
            cdPath,
            conn.session.type,
            conn.remotePlatform,
            shell.terminalSessionId
          )
        )
      ).catch(() => {})
    },
    [activeConnectionId]
  )

  const handleCreateRemoteFile = useCallback(
    async (dirPath: string, fileName: string) => {
      if (!activeConnection || activeConnection.session.type !== 'ssh') return
      setTransferBusy(true)
      try {
        const remotePath = joinRemotePath(dirPath, fileName)
        await writeRemoteFile(activeConnection.session, remotePath, '', remoteFileOpts())
        void loadRemoteFiles(
          activeConnection.session,
          remotePathForListApi(
            activeConnection.remotePath ?? '~',
            activeConnection.session.user
          )
        )
      } catch (err) {
        console.error(err)
      } finally {
        setTransferBusy(false)
      }
    },
    [activeConnection, loadRemoteFiles, remoteFileOpts]
  )

  const handleCreateRemoteFolder = useCallback(
    async (dirPath: string, folderName: string) => {
      if (!activeConnection || activeConnection.session.type !== 'ssh') return
      setTransferBusy(true)
      try {
        await createRemoteDirectory(
          activeConnection.session,
          remotePathForListApi(dirPath, activeConnection.session.user),
          folderName,
          remoteFileOpts()
        )
        void loadRemoteFiles(
          activeConnection.session,
          activeConnection.remotePath ?? '~'
        )
      } catch (err) {
        console.error(err)
      } finally {
        setTransferBusy(false)
      }
    },
    [activeConnection, loadRemoteFiles, remoteFileOpts]
  )

  const handleRemoteSearch = useCallback(
    async (query: string) => {
      if (!activeConnection || activeConnection.session.type !== 'ssh') return []
      const base = remotePathForListApi(
        activeConnection.remotePath ?? '~',
        activeConnection.session.user
      )
      const entries = await searchRemoteFiles(
        activeConnection.session,
        base,
        query,
        { ...remoteFileOpts(), maxDepth: 8 }
      )
      return remoteEntriesToFileTree(entries)
    },
    [activeConnection, remoteFileOpts]
  )

  const handleRemoteChmod = useCallback(
    async (item: FileItem, mode: string) => {
      if (!activeConnection || activeConnection.session.type !== 'ssh') return
      setTransferBusy(true)
      try {
        await chmodRemotePath(activeConnection.session, item.path, mode, remoteFileOpts())
        void loadRemoteFiles(
          activeConnection.session,
          activeConnection.remotePath ?? '~'
        )
      } catch (err) {
        console.error(err)
      } finally {
        setTransferBusy(false)
      }
    },
    [activeConnection, loadRemoteFiles, remoteFileOpts]
  )

  const activeTerminalSessionIds = useMemo(() => {
    if (!activeConnection) return []
    return activeConnection.shells
      .map(s => s.terminalSessionId)
      .filter((id): id is string => Boolean(id))
  }, [activeConnection])

  const handleRunHistoryCommand = useCallback(
    (commandOrSessionId: string, maybeCommand?: string) => {
      const sessionId = maybeCommand ? commandOrSessionId : undefined
      const command = maybeCommand ?? commandOrSessionId
      const conn = sessionId
        ? connectionsRef.current.find(c =>
            c.shells.some(s => s.terminalSessionId === sessionId)
          )
        : connectionsRef.current.find(c => c.id === activeConnectionIdRef.current)
      const shell = sessionId
        ? conn?.shells.find(s => s.terminalSessionId === sessionId)
        : conn?.shells.find(s => s.id === conn?.activeShellId)
      if (!shell?.terminalSessionId) return
      void submitTerminalInput(shell.terminalSessionId, `\x15${command}\n`)
    },
    []
  )

  const syncServerTargets = useMemo((): SyncServerTarget[] => {
    return connections
      .filter(
        c =>
          !c.isSyncGroup &&
          connectionTerminalConnected(c) &&
          (c.session.type === 'ssh' ||
            c.session.type === 'local' ||
            c.session.type === 'wsl')
      )
      .map(c => ({
        connectionId: c.id,
        name: c.session.name,
        hostLabel: formatSessionHost(c.session),
        session: c.session,
      }))
  }, [connections])

  useEffect(() => {
    if (!isTauriRuntime()) return
    return subscribeAllTerminalOutput(event => {
      if (!getWindowsShellFlavor(event.sessionId)) {
        const conn = connectionsRef.current.find(c =>
          c.shells.some(s => s.terminalSessionId === event.sessionId)
        )
        if (
          conn &&
          usesWindowsShellCommands(conn.session.type, conn.remotePlatform)
        ) {
          const flavor = detectWindowsShellFlavorFromOutput(
            getTerminalOutputBuffer(event.sessionId)
          )
          if (flavor) setWindowsShellFlavor(event.sessionId, flavor)
        }
      }

      const cwd = extractCwdFromTerminalChunk(event.data)
      if (!cwd) return
      const conn = connectionsRef.current.find(c =>
        c.shells.some(s => s.terminalSessionId === event.sessionId)
      )
      if (!conn) return
      applyShellCwd(conn.id, event.sessionId, cwd)
    })
  }, [applyShellCwd])

  useEffect(() => {
    if (!isTauriRuntime()) return
    return onTerminalWrite((terminalSessionId, data) => {
      const conn = connectionsRef.current.find(c =>
        c.shells.some(s => s.terminalSessionId === terminalSessionId)
      )
      if (!conn) return
      const sessionType = conn.session.type
      if (sessionType !== 'ssh' && sessionType !== 'local' && sessionType !== 'wsl') {
        return
      }
      const shell = conn.shells.find(s => s.terminalSessionId === terminalSessionId)
      if (!shell) return
      const home = shellHomeDir(sessionType, {
        user: conn.session.user,
        remotePath: conn.remotePath,
        remotePlatform: conn.remotePlatform,
      })
      const current = shell.shellCwd ?? home

      const completedLine = consumeTerminalInputLine(
        terminalInputLineBuffersRef.current,
        terminalSessionId,
        data
      )
      if (completedLine === null) return

      const trimmed = completedLine.trim()
      if (!trimmed || trimmed === 'clear') return

      const next = parseCdTargetFromCommand(trimmed, current, home)
      if (next) {
        applyShellCwd(conn.id, terminalSessionId, next)
      } else if (shell.id === conn.activeShellId && followTerminalCwdRef.current) {
        scheduleCwdPoll(conn.id, terminalSessionId)
      }
    })
  }, [applyShellCwd, scheduleCwdPoll])

  const handleRemoteDirectoryExpand = useCallback(
    (item: FileItem) => {
      if (!activeConnection) return
      const t = activeConnection.session.type
      if (t !== 'ssh' && t !== 'local' && t !== 'wsl') return
      if (item.type !== 'directory') return
      const hasLoadedChildren = item.children !== undefined
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
    bridgeEnabled: aiSettings.backend === 'claude-code' || aiSettings.backend === 'cursor',
    claudePath: getActiveCliPath(aiSettings),
    getIdeContext,
    contextSyncKey: claudeContextKey,
  })
  claudeCodeRef.current = claudeCode

  const resetConnectionClaudeSession = useCallback(
    async (_connectionId: string, _options?: { clearChat?: boolean }) => {
      /* Agent 会话已迁至 AgentThread，连接断开不再清 AI 聊天 */
    },
    []
  )

  const stopThreadAgent = useCallback(
    async (threadId: string) => {
      const pending = claudeRequestsByThreadRef.current.get(threadId)
      if (pending) {
        for (const requestId of pending) {
          claudeSilentKeepaliveRef.current.get(requestId)?.dispose()
          requestMetaRef.current.delete(requestId)
          await cancelAiMessage(aiSettings.backend, requestId).catch(() => {})
        }
        claudeRequestsByThreadRef.current.delete(threadId)
      }
      assistantByThreadRef.current.delete(threadId)
      if (activeThreadIdRef.current === threadId) {
        activeAssistantIdRef.current = null
      }
      setThreadStatus(threadId, 'stopped')
    },
    [setThreadStatus, aiSettings.backend]
  )

  // AgentThread 持久化由 useAgentThreads 负责

  // 切换连接时不再重置全局 Claude session（Agent 会话按 threadId 隔离）

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
      let nextStatus: Session['status'] = 'connecting'
      setConnections(prev =>
        prev.map(conn => {
          if (conn.id !== connectionId) return conn
          const shells = conn.shells.map(shell =>
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
          )
          nextStatus = connectionSessionStatus(shells)
          return {
            ...conn,
            shells,
            session: { ...conn.session, status: nextStatus },
            terminalLive: true,
          }
        })
      )
      setFolders(prev => setSessionStatusInFolders(prev, sessionId, nextStatus))
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
        const prev = connectionsRef.current
        const targetConn = prev.find(
          conn =>
            !conn.terminalLive &&
            conn.shells.some(s => s.terminalSessionId === event.sessionId)
        )
        if (!targetConn) return

        const shell = targetConn.shells.find(s => s.terminalSessionId === event.sessionId)!
        const nextHistory = appendTerminalOutput(shell.history, event.data)
        if (nextHistory === shell.history) return

        setConnections(current => {
          let changed = false
          const next = current.map(conn => {
            if (conn.id !== targetConn.id) return conn
            changed = true
            return {
              ...conn,
              shells: conn.shells.map(s =>
                s.id === shell.id ? { ...s, history: nextHistory } : s
              ),
            }
          })
          return changed ? next : current
        })
      })

      unlistenStatus = await listenTerminalStatus(event => {
        if (event.status === 'connected') {
          if (event.windowsShell) {
            setWindowsShellFlavor(event.sessionId, event.windowsShell)
          }
          requestTerminalResync(event.sessionId)
          let connectedSession: Session | undefined
          let profileSessionId: string | undefined
          let nextSessionStatus: Session['status'] | undefined
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
              nextSessionStatus = updated.session.status
              shouldLoadRemote =
                (updated.session.type === 'ssh' ||
                  updated.session.type === 'local' ||
                  updated.session.type === 'wsl') &&
                !updated.remoteFiles?.length &&
                !layoutRestorePendingRef.current
              return { ...updated, terminalLive: true }
            })
          )

          if (profileSessionId && nextSessionStatus) {
            setFolders(prev =>
              setSessionStatusInFolders(prev, profileSessionId!, nextSessionStatus!)
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
            const conn = connectionsRef.current.find(c =>
              c.shells.some(s => s.terminalSessionId === event.sessionId)
            )
            if (conn) {
              void loadRemoteFiles(connectedSession, '~', { connectionId: conn.id })
            }
          }

          const connectedConn = connectionsRef.current.find(c =>
            c.shells.some(s => s.terminalSessionId === event.sessionId)
          )
          const pendingLayoutCwd = pendingLayoutShellCwdRef.current.get(event.sessionId)
          if (pendingLayoutCwd && connectedConn) {
            pendingLayoutShellCwdRef.current.delete(event.sessionId)
            window.setTimeout(() => {
              void writeTerminal(
                event.sessionId,
                normalizeShellCommandForPty(
                  formatShellCdCommand(
                    pendingLayoutCwd,
                    connectedConn.session.type,
                    connectedConn.remotePlatform,
                    event.sessionId
                  )
                )
              ).catch(() => {})
              applyShellCwd(connectedConn.id, event.sessionId, pendingLayoutCwd)
            }, 400)
          } else if (connectedConn) {
            if (connectedConn.session.type === 'ssh' && !connectedConn.remotePlatform) {
              void detectRemotePlatform(resolveSessionForConnect(connectedConn.session))
                .then(platform => {
                  setConnections(prev =>
                    prev.map(c =>
                      c.id === connectedConn.id ? { ...c, remotePlatform: platform } : c
                    )
                  )
                })
                .catch(() => {})
            }
            if (connectedConn.session.type === 'ssh') {
              void getRemoteCwd(
                resolveSessionForConnect(connectedConn.session),
                remoteFileOpts()
              )
                .then(cwd => applyShellCwd(connectedConn.id, event.sessionId, cwd))
                .catch(() => {})
            } else if (
              connectedConn.session.type === 'local' ||
              connectedConn.session.type === 'wsl'
            ) {
              void getLocalHomeDir(connectedConn.session.type)
                .then(home => applyShellCwd(connectedConn.id, event.sessionId, home))
                .catch(() => {})
            }
          }
        } else if (event.status === 'error') {
          const message = event.error ?? '连接失败'
          let profileSessionId: string | undefined
          let nextSessionStatus: Session['status'] | undefined

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
              nextSessionStatus = updated.session.status
              return updated
            })
          )

          if (profileSessionId && nextSessionStatus) {
            setFolders(prev =>
              setSessionStatusInFolders(prev, profileSessionId!, nextSessionStatus!)
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
          setWindowsShellFlavor(event.sessionId, undefined)
          let profileSessionId: string | undefined
          let nextSessionStatus: Session['status'] | undefined
          let disconnectedConnId: string | undefined

          setConnections(prev =>
            prev.map(conn => {
              const updated = updateConnectionShellByTerminalId(
                conn,
                event.sessionId,
                shell => ({
                  ...shell,
                  terminalStatus: 'disconnected',
                  history: [
                    ...shell.history,
                    {
                      id: `disc-${Date.now()}`,
                      type: 'system' as const,
                      content: '连接已断开 — 点击「重新连接」恢复',
                      timestamp: new Date(),
                    },
                  ],
                })
              )
              if (!updated) return conn
              profileSessionId = updated.session.id
              nextSessionStatus = updated.session.status
              disconnectedConnId = updated.id
              return updated
            })
          )

          if (profileSessionId && nextSessionStatus) {
            setFolders(prev =>
              setSessionStatusInFolders(prev, profileSessionId!, nextSessionStatus!)
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

  const handleStartMultiServerSync = useCallback(
    (sourceConnectionIds: string[]) => {
      if (sourceConnectionIds.length < 2) return

      const members = sourceConnectionIds
        .map(id => connectionsRef.current.find(c => c.id === id))
        .filter(
          (c): c is ServerConnection =>
            !!c &&
            !c.isSyncGroup &&
            connectionTerminalConnected(c) &&
            (c.session.type === 'ssh' ||
              c.session.type === 'local' ||
              c.session.type === 'wsl')
        )
      if (members.length < 2) return

      const syncConnectionId = `sync-${Date.now()}`
      const syncProfileId = `sync-profile-${syncConnectionId}`
      const syncMembers: SyncGroupMember[] = members.map(m => ({
        sourceConnectionId: m.id,
        session: m.session,
      }))

      const shells: Shell[] = members.map((member, index) => {
        const shellId = `sync-shell-${index}-${Date.now()}`
        return {
          id: shellId,
          name: member.session.name,
          history: [
            {
              id: `sync-${Date.now()}-${index}`,
              type: 'system' as const,
              content: `同步终端 → ${member.session.name}`,
              timestamp: new Date(),
            },
          ],
          terminalSessionId: makeTerminalSessionId(syncProfileId, shellId),
          terminalStatus: 'connecting' as const,
        }
      })

      registerSyncGroup(
        syncConnectionId,
        shells.map(s => s.terminalSessionId)
      )

      const newConnection: ServerConnection = {
        id: syncConnectionId,
        session: {
          id: syncProfileId,
          name: `多机同步 (${members.length})`,
          host: 'sync',
          type: 'local',
          status: 'connecting',
          lastActive: new Date(),
        },
        shells,
        activeShellId: shells[0].id,
        openFiles: [],
        activeFileId: null,
        selectedFilePath: null,
        aiMessages: [],
        aiThinking: false,
        terminalLive: true,
        browserTabs: [],
        activeBrowserTabId: null,
        monitorOpen: false,
        isSyncGroup: true,
        syncMembers,
      }

      setConnections(prev => [...prev, newConnection])
      setActiveConnectionId(syncConnectionId)

      for (let i = 0; i < shells.length; i++) {
        runBackendConnect(
          syncMembers[i].session,
          syncConnectionId,
          shells[i].id,
          shells[i].terminalSessionId
        )
      }
    },
    [runBackendConnect]
  )

  const handleSaveLayoutSnapshot = useCallback(async (sessionId: string, name: string) => {
    const conn = connectionsRef.current.find(
      c => c.session.id === sessionId && c.id === activeConnectionIdRef.current
    )
    if (!conn) return
    const dockview = workbenchRef.current?.captureLayout()
    if (!dockview) return

    let remotePlatform = conn.remotePlatform
    if (conn.session.type === 'ssh' && !remotePlatform) {
      remotePlatform = await detectRemotePlatform(
        resolveSessionForConnect(conn.session)
      ).catch(() => undefined)
      if (remotePlatform) {
        setConnections(prev =>
          prev.map(c => (c.id === conn.id ? { ...c, remotePlatform } : c))
        )
      }
    }

    const probed = await probeShellCwds(
      conn.shells.map(s => ({
        id: s.id,
        terminalSessionId: s.terminalSessionId,
        terminalStatus: s.terminalStatus,
        shellCwd: s.shellCwd,
      })),
      conn.session.type,
      writeTerminal,
      remotePlatform ?? conn.remotePlatform
    )

    // 探测结果写回，便于后续切换 Shell / 文件树跟随使用
    if (probed.size > 0) {
      setConnections(prev =>
        prev.map(c => {
          if (c.id !== conn.id) return c
          return {
            ...c,
            shells: c.shells.map(s => {
              const cwd = probed.get(s.id)
              return cwd ? { ...s, shellCwd: cwd } : s
            }),
          }
        })
      )
    }

    const fresh = connectionsRef.current.find(c => c.id === conn.id) ?? conn
    const shellCwds = new Map<string, string | undefined>()
    for (const s of fresh.shells) {
      shellCwds.set(
        s.id,
        probed.get(s.id) ??
          resolveShellCwdForSnapshot(s, { terminalLive: fresh.terminalLive })
      )
    }

    const activeShellId = fresh.activeShellId
    const activeCwd = shellCwds.get(activeShellId)
    const snapshotRemotePath = resolveSnapshotFileTreePath(
      fresh.session,
      activeCwd,
      fresh.remotePath
    )
    const snapshot: ServerLayoutSnapshot = {
      id: `layout-${Date.now()}`,
      name,
      profileId: sessionId,
      savedAt: new Date().toISOString(),
      remotePath: snapshotRemotePath,
      activeShellId: fresh.activeShellId,
      activeFileId: fresh.activeFileId,
      activeBrowserTabId: fresh.activeBrowserTabId ?? null,
      shells: fresh.shells.map(s => ({
        id: s.id,
        name: s.name,
        cwd: shellCwds.get(s.id),
      })),
      openFiles: fresh.openFiles.map(f => ({ id: f.id, path: f.path })),
      browserTabs: (fresh.browserTabs ?? []).map(t => ({
        id: t.id,
        title: t.title,
        url: t.url,
        webviewLabel: t.webviewLabel,
      })),
      monitorOpen: fresh.monitorOpen ?? false,
      dockview,
    }
    saveLayoutSnapshot(snapshot)
    setLayoutSnapshotsVersion(v => v + 1)
  }, [])

  const applyLayoutSnapshotToConnection = useCallback(
    (
      conn: ServerConnection,
      snapshot: ServerLayoutSnapshot,
      options?: { connect?: boolean }
    ) => {
      const useBackend = isTerminalBackendSupported(conn.session.type)
      const shouldConnect = (options?.connect ?? conn.terminalLive) && useBackend

      layoutRestorePendingRef.current = true
      pendingLayoutShellCwdRef.current.clear()
      for (const s of snapshot.shells) {
        if (s.cwd) {
          pendingLayoutShellCwdRef.current.set(
            makeTerminalSessionId(conn.session.id, s.id),
            s.cwd
          )
        }
      }

      for (const oldShell of conn.shells) {
        const kept = snapshot.shells.some(s => s.id === oldShell.id)
        if (!kept && (shouldConnect || conn.terminalLive)) {
          void disconnectTerminal(oldShell.terminalSessionId).catch(() => {})
          clearTerminalOutputBuffer(oldShell.terminalSessionId)
        }
      }

      if (shouldConnect) {
        for (const s of snapshot.shells) {
          const oldShell = conn.shells.find(o => o.id === s.id)
          if (oldShell?.terminalStatus === 'connected') {
            void disconnectTerminal(oldShell.terminalSessionId).catch(() => {})
            clearTerminalOutputBuffer(oldShell.terminalSessionId)
          }
        }
      }

      const restoredShells: Shell[] = snapshot.shells.map(s => ({
        id: s.id,
        name: s.name,
        history: [],
        terminalSessionId: makeTerminalSessionId(conn.session.id, s.id),
        terminalStatus: shouldConnect ? 'connecting' : undefined,
        shellCwd: s.cwd,
      }))

      const restoredFiles = snapshot.openFiles.map(f =>
        createEditorModel(f.path, '正在加载…', { id: f.id })
      )

      const restoredBrowserTabs: BrowserTab[] = snapshot.browserTabs.map(b => ({
        id: b.id,
        title: b.title,
        url: b.url,
        webviewLabel: b.webviewLabel,
      }))

      const activeShellSnapshot = snapshot.shells.find(s => s.id === snapshot.activeShellId)
      const restoredRemotePath = resolveSnapshotFileTreePath(
        conn.session,
        activeShellSnapshot?.cwd,
        snapshot.remotePath
      )

      setConnections(prev =>
        prev.map(c =>
          c.id !== conn.id
            ? c
            : {
                ...c,
                shells: restoredShells,
                activeShellId: snapshot.activeShellId ?? restoredShells[0]?.id ?? c.activeShellId,
                openFiles: restoredFiles,
                activeFileId: snapshot.activeFileId ?? null,
                browserTabs: restoredBrowserTabs,
                activeBrowserTabId: snapshot.activeBrowserTabId ?? null,
                monitorOpen:
                  snapshot.monitorOpen ??
                  dockviewHasMonitorPanel(snapshot.dockview),
                remotePath: restoredRemotePath ?? c.remotePath,
                terminalLive: shouldConnect ? true : c.terminalLive,
                session: {
                  ...c.session,
                  status: shouldConnect ? 'connecting' : c.session.status,
                },
              }
        )
      )

      if (shouldConnect) {
        setFolders(prev => setSessionStatusInFolders(prev, conn.session.id, 'connecting'))
      }

      setPendingLayoutRestore({ token: Date.now(), dockview: snapshot.dockview })

      if (shouldConnect) {
        for (const s of restoredShells) {
          runBackendConnect(conn.session, conn.id, s.id, s.terminalSessionId)
        }
      }

      if (
        restoredRemotePath &&
        (conn.session.type === 'ssh' ||
          conn.session.type === 'local' ||
          conn.session.type === 'wsl')
      ) {
        void loadRemoteFiles(
          conn.session,
          snapshotPathForFileTreeLoad(conn.session, restoredRemotePath)
        )
      }

      for (const f of snapshot.openFiles) {
        const loadPromise =
          conn.session.type === 'ssh'
            ? readRemoteFile(conn.session, f.path, remoteFileOpts())
            : conn.session.type === 'local' || conn.session.type === 'wsl'
              ? readLocalFile(conn.session.type, f.path)
              : Promise.resolve(readFileContent(f.path))
        void loadPromise
          .then(content => {
            setConnections(prev =>
              prev.map(c =>
                c.id !== conn.id
                  ? c
                  : { ...c, openFiles: setEditorLoadedContent(c.openFiles, f.path, content) }
              )
            )
          })
          .catch(() => {})
      }
    },
    [loadRemoteFiles, remoteFileOpts, runBackendConnect, setFolders]
  )

  const handleLoadLayoutSnapshot = useCallback(
    (sessionId: string, snapshot: ServerLayoutSnapshot) => {
      if (snapshot.profileId !== sessionId) return
      const folderSession = foldersRef.current
        .flatMap(f => f.sessions)
        .find(s => s.id === sessionId)
      if (!folderSession) return

      let conn = connectionsRef.current.find(c => c.session.id === sessionId)
      if (!conn) {
        if (!isTerminalBackendSupported(folderSession.type)) return
        const placeholderShellId = `shell-${Date.now()}`
        const connectionId = `conn-${Date.now()}`
        conn = {
          id: connectionId,
          session: { ...folderSession, status: 'connecting' },
          shells: [
            {
              id: placeholderShellId,
              name: 'Shell 1',
              history: [],
              terminalSessionId: makeTerminalSessionId(folderSession.id, placeholderShellId),
              terminalStatus: 'connecting',
            },
          ],
          activeShellId: placeholderShellId,
          openFiles: [],
          activeFileId: null,
          selectedFilePath: null,
          aiMessages: [],
          aiThinking: false,
          terminalLive: true,
          browserTabs: [],
          activeBrowserTabId: null,
          monitorOpen: false,
        }
        setConnections(prev => [...prev, conn!])
        setFolders(prev => setSessionStatusInFolders(prev, sessionId, 'connecting'))
      }

      const connId = conn.id
      setActiveConnectionId(connId)

      requestAnimationFrame(() => {
        const current = connectionsRef.current.find(c => c.id === connId)
        if (!current) return
        applyLayoutSnapshotToConnection(current, snapshot, { connect: true })
      })
    },
    [applyLayoutSnapshotToConnection, setFolders]
  )

  const handleDeleteLayoutSnapshot = useCallback((sessionId: string, snapshotId: string) => {
    deleteLayoutSnapshot(sessionId, snapshotId)
    setLayoutSnapshotsVersion(v => v + 1)
  }, [])

  const canSaveLayoutSnapshot = useCallback((sessionId: string) => {
    return connectionsRef.current.some(
      c => c.session.id === sessionId && c.id === activeConnectionIdRef.current
    )
  }, [])

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

  // 连接会话（侧边栏「连接」或 MCP connectServer）
  const handleSessionConnect = useCallback((
    session: Session,
    options?: { activate?: boolean }
  ) => {
  const activate = options?.activate !== false
  const folderSession =
    folders.flatMap(f => f.sessions).find(s => s.id === session.id) ?? session
    const existingConn = connections.find(c => c.session.id === folderSession.id)
    if (existingConn) {
      if (activate) {
        setActiveConnectionId(existingConn.id)
      }
      const shellConnected = existingConn.shells.some(
        s => s.terminalStatus === 'connected'
      )
      if (shellConnected) {
        setFolders(prev =>
          setSessionStatusInFolders(prev, folderSession.id, 'connected')
        )
        if (activate && existingConn.session.type === 'ssh') {
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
          const shells = conn.shells.map(shell =>
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
          )
          return {
            ...conn,
            shells,
            session: { ...conn.session, status: connectionSessionStatus(shells) },
            terminalLive: true,
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
      browserTabs: [],
      activeBrowserTabId: null,
      monitorOpen: false,
    }

    setConnections(prev => [...prev, newConnection])
    if (activate) {
      setActiveConnectionId(connectionId)
    }

    setFolders(prev =>
      setSessionStatusInFolders(prev, folderSession.id, useBackend ? 'connecting' : 'connected')
    )

    if (useBackend) {
      runBackendConnect(folderSession, connectionId, shellId, terminalSessionId)
    }
  }, [connections, folders, setFolders, loadRemoteFiles, runBackendConnect, resetConnectionClaudeSession])

  const syncRuntimeToBackend = useCallback(() => {
    if (!isTauriRuntime()) return
    const folderProfiles = folders.flatMap(f => f.sessions)
    const connProfiles = connections
      .filter(c => !c.isSyncGroup)
      .map(c => c.session)
      .filter(s => !folderProfiles.some(p => p.id === s.id))
    const snapshot = buildRuntimeSnapshot({
      folders: [{ sessions: [...folderProfiles, ...connProfiles] }],
      connections: connections
        .filter(c => !c.isSyncGroup)
        .map(c => ({
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
  }, [folders, connections, activeConnectionId])

  const pushIdeContext = useCallback(() => {
    if (!isTauriRuntime()) return
    void updateIdeContext(getIdeContext()).catch(err => console.error('claude_update_context failed', err))
  }, [getIdeContext])

  const runtimeSyncKey = useMemo(
    () => buildRuntimeSyncKey(folders, connections, activeConnectionId),
    [folders, connections, activeConnectionId]
  )

  // 焦点/连接变化时立即同步 runtime + IDE 上下文
  useEffect(() => {
    syncRuntimeToBackend()
    pushIdeContext()
  }, [activeConnectionId, activeConnection?.activeShellId, syncRuntimeToBackend, pushIdeContext])

  // 文件夹/终端状态变化时防抖同步（忽略 AI 消息等无关 connections 更新）
  useEffect(() => {
    if (!isTauriRuntime()) return
    const timer = window.setTimeout(() => syncRuntimeToBackend(), 1000)
    return () => window.clearTimeout(timer)
  }, [runtimeSyncKey, syncRuntimeToBackend])

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

  useEffect(() => {
    if (!isTauriRuntime() || !loadAutoCheckUpdates()) return
    const timer = window.setTimeout(() => {
      void checkForAppUpdate()
        .then(result => {
          if (result.available) {
            setUpdatePrompt(result)
            setUpdatePromptOpen(true)
          }
        })
        .catch(() => {})
    }, 4000)
    return () => window.clearTimeout(timer)
  }, [])

  // 切换连接标签时刷新该会话的文件树（已有缓存则跳过）
  useEffect(() => {
    lastFileTreeLoadRef.current = { connectionId: '', path: '' }
  }, [activeConnectionId])

  useEffect(() => {
    if (!activeConnection || !activeConnectionId) return
    const t = activeConnection.session.type
    if (t !== 'ssh' && t !== 'local' && t !== 'wsl') return
    if (!isTauriRuntime()) return
    if (!activeConnection.shells.some(s => s.terminalStatus === 'connected')) return
    const path = activeConnection.remotePath ?? '~'
    const key = treePathKey(path)
    const last = lastFileTreeLoadRef.current
    if (
      !followTerminalCwdRef.current &&
      last.connectionId === activeConnectionId &&
      last.path === key &&
      (activeConnection.remoteFiles?.length ?? 0) > 0
    ) {
      return
    }
    void loadRemoteFiles(activeConnection.session, path, {
      connectionId: activeConnectionId,
    })
  }, [activeConnectionId, activeConnection?.remotePath, activeConnection?.session, loadRemoteFiles, treePathKey])

  // Close a connection
  const handleConnectionClose = useCallback((connectionId: string) => {
    const conn = connections.find(c => c.id === connectionId)

    if (conn?.isSyncGroup) {
      unregisterSyncGroup(connectionId)
    }

    void resetConnectionClaudeSession(connectionId, { clearChat: true })

    if (conn?.terminalLive) {
      for (const shell of conn.shells) {
        void disconnectTerminal(shell.terminalSessionId).catch(() => {})
        clearTerminalOutputBuffer(shell.terminalSessionId)
      }
    }

    if (conn && isTauriRuntime() && !conn.isSyncGroup) {
      for (const tab of conn.browserTabs ?? []) {
        if (tab.tunnelId) void stopTunnel(tab.tunnelId).catch(() => {})
      }
      void listTunnels(conn.session.id).then(tunnels => {
        for (const t of tunnels) void stopTunnel(t.id).catch(() => {})
      })
      void stopSocksForProfile(conn.session.id).catch(() => {})
    }
    
    setConnections(prev => prev.filter(c => c.id !== connectionId))
    
    if (connectionId === activeConnectionId) {
      const remaining = connections.filter(c => c.id !== connectionId)
      setActiveConnectionId(remaining.length > 0 ? remaining[0].id : null)
    }

    if (conn && !conn.isSyncGroup) {
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
        const home = shellHomeDir(conn.session.type, {
          user: conn.session.user,
          remotePath: conn.remotePath,
          remotePlatform: conn.remotePlatform,
        })
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

  const executeCommandInActiveShell = useCallback(
    (command: string) => {
      if (!activeConnection) return
      workbenchRef.current?.focusTerminal()
      handleCommand(activeConnection.activeShellId, command)
    },
    [activeConnection, handleCommand]
  )

  const handleAiExecuteCommand = useCallback(
    async (command: string) => {
      if (!activeConnection) return
      const ctx = `${activeConnection.session.name} (${formatSessionHost(activeConnection.session)})`
      const ok = await requestCommandApprovalIfNeeded(command, 'manual', ctx)
      if (!ok) return
      executeCommandInActiveShell(command)
    },
    [activeConnection, requestCommandApprovalIfNeeded, executeCommandInActiveShell]
  )

  // Shell management
  const handleNewShell = useCallback(() => {
    if (!activeConnectionId) return

    const conn = connections.find(c => c.id === activeConnectionId)
    if (!conn || conn.isSyncGroup) return
      
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

  // 为指定连接创建新 Shell（供 AI / 用户调用）
  const createShellForConnection = useCallback(
    async (
      connectionId: string,
      options?: {
        customName?: string
        referenceShellId?: string
        splitBelow?: boolean
        activate?: boolean
        /** false = MCP/后台操作，不切换顶部服务器标签 */
        activateConnection?: boolean
      }
    ): Promise<{ shellId: string; terminalSessionId: string }> => {
      const conn = connectionsRef.current.find(c => c.id === connectionId)
      if (!conn) {
        throw new Error('连接不存在')
      }

      const shouldActivateConnection = options?.activateConnection !== false
      if (shouldActivateConnection && connectionId !== activeConnectionIdRef.current) {
        setActiveConnectionId(connectionId)
        await new Promise<void>(resolve => window.setTimeout(resolve, 120))
      }

      if (options?.referenceShellId && options.splitBelow) {
        workbenchRef.current?.prepareShellPlacement(options.referenceShellId, 'below')
      }

      const shellId = `shell-${Date.now()}`
      const shellNum = conn.shells.length + 1
      const terminalSessionId = makeTerminalSessionId(conn.session.id, shellId)
      const useBackend = conn.terminalLive
      const shellName = options?.customName || `Shell ${shellNum}`
      const activate = options?.activate !== false

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
            activeShellId: activate ? shellId : c.activeShellId,
            session: useBackend
              ? { ...c.session, status: connectionSessionStatus([...c.shells, newShell]) }
              : c.session,
          }
        })
      )

      if (useBackend) {
        await connectTerminalSession(conn.session, terminalSessionId).catch((err: Error) => {
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
          throw err
        })

        await new Promise<void>((resolve, reject) => {
          const started = Date.now()
          const tick = () => {
            const current = connectionsRef.current.find(c => c.id === connectionId)
            const shell = current?.shells.find(s => s.terminalSessionId === terminalSessionId)
            if (shell?.terminalStatus === 'connected') {
              resolve()
              return
            }
            if (shell?.terminalStatus === 'error') {
              reject(new Error('Shell 连接失败'))
              return
            }
            if (Date.now() - started > 20_000) {
              reject(new Error('Shell 连接超时'))
              return
            }
            window.setTimeout(tick, 120)
          }
          tick()
        })
      }

      return { shellId, terminalSessionId }
    },
    []
  )

  const handleNewShellForConnection = useCallback(
    (
      connectionId: string,
      customName?: string,
      options?: { referenceShellId?: string; splitBelow?: boolean; activate?: boolean; activateConnection?: boolean }
    ) => {
      void createShellForConnection(connectionId, {
        customName,
        referenceShellId: options?.referenceShellId,
        splitBelow: options?.splitBelow,
        activate: options?.activate,
        activateConnection: options?.activateConnection,
      }).catch(err => {
        console.error('[Shell] create failed', err)
      })
    },
    [createShellForConnection]
  )

  useEffect(() => {
    registerMonitorShellResolver(async (busySessionId, _command) => {
      const parsed = parseTerminalSessionId(busySessionId)
      if (!parsed) return null

      const conn = connectionsRef.current.find(c => c.session.id === parsed.profileSessionId)
      if (!conn) return null

      const { terminalSessionId } = await createShellForConnection(conn.id, {
        customName: '进度查看',
        referenceShellId: parsed.shellId,
        splitBelow: true,
        activate: false,
        activateConnection: false,
      })
      return terminalSessionId
    })
    return () => registerMonitorShellResolver(null)
  }, [createShellForConnection])

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

  const appendBrowserTab = useCallback(
    (connectionId: string, tab: BrowserTab) => {
      if (connectionId !== activeConnectionIdRef.current) {
        setActiveConnectionId(connectionId)
      }
      setConnections(prev =>
        prev.map(c =>
          c.id !== connectionId
            ? c
            : {
                ...c,
                browserTabs: [...(c.browserTabs ?? []), tab],
                activeBrowserTabId: tab.id,
              }
        )
      )
    },
    []
  )

  const handleCloseBrowserTab = useCallback(
    (tabId: string) => {
      if (!activeConnectionId) return
      const conn = connections.find(c => c.id === activeConnectionId)
      const tab = conn?.browserTabs?.find(t => t.id === tabId)
      if (tab?.tunnelId && isTauriRuntime()) {
        void stopTunnel(tab.tunnelId).catch(() => {})
      }
      setConnections(prev =>
        prev.map(c => {
          if (c.id !== activeConnectionId) return c
          const browserTabs = (c.browserTabs ?? []).filter(t => t.id !== tabId)
          const activeBrowserTabId =
            c.activeBrowserTabId === tabId
              ? (browserTabs[browserTabs.length - 1]?.id ?? null)
              : (c.activeBrowserTabId ?? null)
          return { ...c, browserTabs, activeBrowserTabId }
        })
      )
    },
    [activeConnectionId, connections]
  )

  const handleBrowserUrlChange = useCallback(
    (tabId: string, url: string, tunnelId?: string) => {
      if (!activeConnectionId) return
      setConnections(prev =>
        prev.map(c => {
          if (c.id !== activeConnectionId) return c
          return {
            ...c,
            browserTabs: (c.browserTabs ?? []).map(t =>
              t.id === tabId
                ? {
                    ...t,
                    url,
                    title: tabTitleFromUrl(url),
                    tunnelId: tunnelId ?? t.tunnelId,
                  }
                : t
            ),
          }
        })
      )
    },
    [activeConnectionId]
  )

  const handleNewBrowser = useCallback(() => {
    if (!activeConnectionId || !isTauriRuntime()) return
    const conn = connectionsRef.current.find(c => c.id === activeConnectionIdRef.current)
    if (!conn) return
    const tabId = crypto.randomUUID()
    appendBrowserTab(conn.id, {
      id: tabId,
      title: '浏览器',
      url: '',
      webviewLabel: makeBrowserWebviewLabel(tabId),
    })
  }, [activeConnectionId, appendBrowserTab])

  const handleOpenMonitor = useCallback(() => {
    if (!activeConnectionId) return
    const conn = connectionsRef.current.find(c => c.id === activeConnectionIdRef.current)
    if (!conn || conn.session.type !== 'ssh') return
    setConnections(prev =>
      prev.map(c => (c.id === activeConnectionId ? { ...c, monitorOpen: true } : c))
    )
    window.requestAnimationFrame(() => {
      workbenchRef.current?.focusMonitorPanel()
    })
  }, [activeConnectionId])

  const handleCloseMonitor = useCallback(() => {
    if (!activeConnectionId) return
    setConnections(prev =>
      prev.map(c => (c.id === activeConnectionId ? { ...c, monitorOpen: false } : c))
    )
  }, [activeConnectionId])

  const handleShellChange = useCallback((shellId: string) => {
    if (!activeConnectionId) return

    const connBefore = connectionsRef.current.find(c => c.id === activeConnectionId)
    const targetShell = connBefore?.shells.find(s => s.id === shellId)
    const sessionType = connBefore?.session.type

    setConnections(prev =>
      prev.map(conn => {
        if (conn.id !== activeConnectionId) return conn
        if (conn.activeShellId === shellId) return conn

        const shouldSyncTree =
          followTerminalCwdRef.current &&
          targetShell?.shellCwd &&
          (sessionType === 'ssh' ||
            sessionType === 'local' ||
            sessionType === 'wsl')

        const remotePath = shouldSyncTree
          ? resolveSnapshotFileTreePath(
              conn.session,
              targetShell.shellCwd,
              conn.remotePath
            )
          : conn.remotePath

        return {
          ...conn,
          activeShellId: shellId,
          ...(shouldSyncTree && remotePath ? { remotePath } : {}),
        }
      })
    )

    if (
      connBefore &&
      targetShell?.shellCwd &&
      followTerminalCwdRef.current &&
      (sessionType === 'ssh' || sessionType === 'local' || sessionType === 'wsl')
    ) {
      void loadRemoteFiles(
        connBefore.session,
        snapshotPathForFileTreeLoad(connBefore.session, targetShell.shellCwd),
        { connectionId: activeConnectionId }
      )
    }
  }, [activeConnectionId, loadRemoteFiles])
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
        workbenchRef.current?.focusTerminal(shell.id)
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
      const isLocalBrowser =
        (conn.session.type === 'local' || conn.session.type === 'wsl') && isTauriRuntime()
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

      const placeholder = isRemote || isLocalBrowser ? '正在加载文件…' : readFileContent(file.path)

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

      if (!isRemote && !isLocalBrowser) return

      try {
        const content = isRemote
          ? await readRemoteFile(conn.session, file.path, remoteFileOpts())
          : await readLocalFile(conn.session.type as 'local' | 'wsl', file.path)
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
      const isLocalBrowser =
        conn?.session.type === 'local' || conn?.session.type === 'wsl'
          ? isTauriRuntime()
          : false

      try {
        if (isRemote && conn) {
          await writeRemoteFile(conn.session, file.path, file.content, remoteFileOpts())
        } else if (isLocalBrowser && conn) {
          await writeLocalFile(
            conn.session.type as 'local' | 'wsl',
            file.path,
            file.content
          )
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
      const isLocalBrowser =
        (conn.session.type === 'local' || conn.session.type === 'wsl') && isTauriRuntime()

      try {
        if (isRemote) {
          await writeRemoteFile(conn.session, file.path, file.content, remoteFileOpts())
        } else if (isLocalBrowser) {
          await writeLocalFile(
            conn.session.type as 'local' | 'wsl',
            file.path,
            file.content
          )
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
  const handleFileSaveByIdRef = useRef(handleFileSaveById)
  handleFileSaveByIdRef.current = handleFileSaveById

  const showAiUnavailable = useCallback((threadId: string, assistantId: string) => {
    const meta = getBackendMeta(aiSettings.backend)
    const hint = isTauriRuntime()
      ? `未检测到 ${meta.label} CLI，请在设置中配置路径或安装对应工具。`
      : `请使用 Tauri 桌面版（npm run dev:tauri）以启用 ${meta.label} 集成。`

    patchThread(threadId, t => ({
      ...t,
      status: 'idle',
      messages: t.messages.map(m =>
        m.id === assistantId ? { ...m, content: hint } : m
      ),
    }))
  }, [aiSettings.backend, patchThread])

  const handleAiMessage = useCallback(
    async (message: string) => {
      const turnThreadId = activeThreadIdRef.current
      if (!turnThreadId || !aiSettings.enabled) return

      const assistantId = `msg-${Date.now()}-ai`
      assistantByThreadRef.current.set(turnThreadId, assistantId)
      if (activeThreadIdRef.current === turnThreadId) {
        activeAssistantIdRef.current = assistantId
      }

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

      patchThread(turnThreadId, t => ({
        ...t,
        status: 'running',
        title: deriveThreadTitle([...t.messages, userMsg], t.title),
        messages: trimAgentMessages([...t.messages, userMsg, assistantMsg]),
      }))

      const useCliBackend = isTauriRuntime()
      const isClaudeBackend = aiSettings.backend === 'claude-code'
      const activeCliPath = getActiveCliPath(aiSettings)

      if (useCliBackend) {
        try {
          if (claudeCode.streamListenError) {
            throw new Error(claudeCode.streamListenError)
          }
          const detected = isClaudeBackend
            ? await detectClaude(activeCliPath || undefined).catch(() => claudeCode.detected)
            : await detectAiBackend(aiSettings.backend, activeCliPath || undefined)
          if (!detected?.found) {
            const logHint = claudeCode.lastDiag ? `\n${claudeCode.lastDiag}` : ''
            const label = getBackendMeta(aiSettings.backend).label
            throw new Error(
              `未检测到 ${label} CLI。请在设置中填写路径或安装对应 CLI。${logHint}`
            )
          }
          await claudeCode.ensureStreamReady()
          const ctx = getIdeContext()
          const allConnections = connectionsRef.current
          const serverBriefs = buildConnectedServerBriefs(allConnections, activeConnectionId)
          const anyTerminalConnected = serverBriefs.some(c => c.terminalConnected)
          let prompt = message
          if (aiSettings.systemPrompt.trim()) {
            prompt = `${aiSettings.systemPrompt.trim()}\n\n${prompt}`
          }
          if (isClaudeBackend || aiSettings.backend === 'cursor') {
            const bridgeStatus = await claudeCode.ensureBridgeReady()
            const mcpStatus = isClaudeBackend ? await claudeCode.ensureMcpReady() : null
            const bridgeReady = isIdeBridgeReady(bridgeStatus)
            const mcpReady = isClaudeBackend
              ? (mcpStatus?.ready ?? claudeCode.mcpStatus?.ready ?? false)
              : bridgeReady
            const ideToolsReady = bridgeReady && mcpReady
            prompt += buildIdeToolDirective({
              activeProfileId: ctx.activeProfileId,
              activeSessionHost: ctx.activeSessionHost,
              bridgeConnected: ideToolsReady,
              terminalConnected: activeShellConnected || anyTerminalConnected,
              connections: serverBriefs,
            })
            if (isClaudeBackend && bridgeReady && !mcpReady) {
              prompt +=
                '\n\n[AI Terminal] IDE 桥接在跑，但 MCP stdio（aiterm）未就绪：请确认已安装 Node.js，并在侧栏点击重试 MCP 注册；未就绪时不要声称缺少 runShellCommand。'
            }
            if (aiSettings.backend === 'cursor' && bridgeReady) {
              prompt +=
                '\n\n[AI Terminal] Cursor Agent 应通过 MCP 工具 aiterm（如 mcp__aiterm__runShellCommand）执行 Shell，不要只用内置终端猜测结果。'
            }
          }
          if (aiSettings.injectTerminalContext && allConnections.length > 0) {
            const contextConnections = allConnections
              .filter(c => connectionTerminalConnected(c))
              .map(c => ({
                name: c.session.name,
                host: formatSessionHost(c.session),
                snippet: terminalSnippetForConnection(c),
              }))
            const multiPrefix = buildMultiTerminalContextPrefix({
              connections: contextConnections,
            })
            if (multiPrefix) {
              prompt = `${multiPrefix}用户: ${prompt}`
            } else if (activeConnection) {
              prompt = `当前会话: ${ctx.activeSessionName ?? 'unknown'} (${ctx.activeSessionHost ?? '-'})\n\n用户: ${prompt}`
            }
          }

          let assistantAccumulated = ''
          let staleRetried = false

          const registerHandler = (requestId: string) => {
            const turnAssistantId = assistantId
            requestMetaRef.current.set(requestId, {
              threadId: turnThreadId,
              assistantId: turnAssistantId,
            })
            let mcpShellCommandThisTurn = false
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
              flushStreamUi()
              claudeCode.unregisterStreamHandler(requestId)
              claudeSilentKeepaliveRef.current.delete(requestId)
              requestMetaRef.current.delete(requestId)
            }
            const armSilentTimeout = () => {
              if (silentTimer) clearTimeout(silentTimer)
              silentTimer = setTimeout(() => {
                disposeSilentKeepalive()
                void cancelAiMessage(aiSettings.backend, requestId).catch(() => {})
                patchThread(turnThreadId, t => ({
                  ...t,
                  status: 'idle',
                  messages: t.messages.map(m => {
                    if (m.id !== turnAssistantId) return m
                    const finalized = finalizeAssistantTurn(m)
                    return {
                      ...finalized,
                      content:
                        finalized.content ||
                        'Claude 请求长时间无响应，已自动取消。请重试一次；若持续出现请检查 Claude CLI 登录状态。',
                    }
                  }),
                }))
                if (assistantByThreadRef.current.get(turnThreadId) === turnAssistantId) {
                  assistantByThreadRef.current.delete(turnThreadId)
                }
                if (activeAssistantIdRef.current === turnAssistantId) {
                  activeAssistantIdRef.current = null
                }
                const pending = claudeRequestsByThreadRef.current.get(turnThreadId)
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
            let streamUiRaf: number | null = null
            let pendingStreamEvent: ClaudeStreamEvent | null = null
            let pendingStreamText = ''

            const applyAssistantStreamUi = (
              event: ClaudeStreamEvent,
              textChunk?: string
            ) => {
              try {
                patchThread(turnThreadId, t => {
                  let matched = false
                  const messages = t.messages.map(m => {
                    if (m.id !== turnAssistantId) return m
                    matched = true
                    let updated = applyClaudeStreamEvent(m, event)
                    if (textChunk) {
                      updated = appendAssistantTextPart(updated, textChunk)
                    }
                    return updated
                  })
                  if (!matched) return t
                  return { ...t, messages }
                })
              } catch (err) {
                console.error('applyAssistantStreamUi failed', err, event)
              }
            }

            const flushStreamUi = () => {
              if (streamUiRaf != null) {
                cancelAnimationFrame(streamUiRaf)
                streamUiRaf = null
              }
              if (!pendingStreamEvent) return
              const event = pendingStreamEvent
              const text = pendingStreamText
              pendingStreamEvent = null
              pendingStreamText = ''
              applyAssistantStreamUi(event, text || undefined)
            }

            const queueStreamUi = (event: ClaudeStreamEvent, textChunk?: string) => {
              pendingStreamEvent = event
              if (textChunk) pendingStreamText += textChunk
              if (streamUiRaf != null) return
              streamUiRaf = requestAnimationFrame(() => {
                streamUiRaf = null
                flushStreamUi()
              })
            }

            const clearSettleTimer = () => {
              if (settleTimer) clearTimeout(settleTimer)
              settleTimer = null
            }
            const armSettleTimer = () => {
              clearSettleTimer()
              settleTimer = setTimeout(() => {
                settleTimer = null
                if (interactivePromptRef.current) return
                const pendingSet = claudeRequestsByThreadRef.current.get(turnThreadId)
                if (pendingSet && pendingSet.size > 0) {
                  // 仍有进行中的 Claude 请求，不改变 aiThinking
                }
                patchThread(turnThreadId, t => {
                  if (t.status !== 'running') return t
                  const msg = t.messages.find(m => m.id === turnAssistantId)
                  if (!msg || !messageHasTextContent(msg) || messageHasRunningTools(msg)) {
                    return t
                  }
                  return {
                    ...t,
                    messages: t.messages.map(m =>
                      m.id === turnAssistantId ? finalizeAssistantTurn(m) : m
                    ),
                  }
                })
              }, 3500)
            }
            claudeCode.registerStreamHandler(requestId, event => {
              armSilentTimeout()
              armSettleTimer()
              let streamText: string | undefined
              // 任意 aiterm MCP 工具调用后禁用「从回复文本提取命令」的回退，避免与 MCP 重复执行
              const markMcpShellThisTurn = () => {
                mcpShellCommandThisTurn = true
                const meta = requestMetaRef.current.get(requestId)
                if (meta) meta.mcpShellUsed = true
                markLongRunning()
              }
              if (event.eventType === 'tool_start' && event.toolName) {
                const tn = event.toolName
                if (
                  tn.startsWith('mcp__aiterm__') ||
                  tn === 'runShellCommand' ||
                  tn === 'getFocusedServer' ||
                  tn === 'listActiveConnections' ||
                  tn === 'connectServer'
                ) {
                  markMcpShellThisTurn()
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
                  markMcpShellThisTurn()
                }
              }
              if (event.eventType === 'reasoning_delta' || event.reasoning) {
                sawReasoning = true
              }
              if (event.text && !isClaudeCliNoise(event.text)) {
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

              const needsImmediateUi =
                event.eventType === 'tool_start' ||
                event.eventType === 'tool_result' ||
                event.done ||
                event.eventType === 'session_error' ||
                event.eventType === 'process_error' ||
                event.eventType === 'stderr' ||
                event.eventType === 'reasoning_delta' ||
                Boolean(event.reasoning)
              const isTextStreamDelta =
                Boolean(streamText) && event.eventType === 'stream_event'

              if (needsImmediateUi || !isTextStreamDelta) {
                flushStreamUi()
                applyAssistantStreamUi(event, streamText)
              } else {
                queueStreamUi(event, streamText)
              }

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
                const stalePending = claudeRequestsByThreadRef.current.get(turnThreadId)
                stalePending?.delete(requestId)
                void cancelAiMessage(aiSettings.backend, requestId).catch(() => {})
                patchThread(turnThreadId, t => ({
                  ...t,
                  backendSessionId: undefined,
                }))
                void sendClaudeTurn(undefined)
                return
              }

              if (event.done) {
                flushStreamUi()
                // If Claude only emitted a final result (no streaming deltas), append it once here.
                const resultDup =
                  bufferedResultText &&
                  assistantAccumulated &&
                  assistantAccumulated.includes(bufferedResultText.trim())
                if (!sawStreamingText && bufferedResultText && !assistantAccumulated && !resultDup) {
                  assistantAccumulated = bufferedResultText
                  patchThread(turnThreadId, t => ({
                    ...t,
                    messages: t.messages.map(m => {
                      if (m.id !== turnAssistantId) return m
                      let updated = appendAssistantTextPart(m, bufferedResultText)
                      return syncAssistantContentFromParts(updated)
                    }),
                  }))
                }
                disposeSilentKeepalive()
                const pending = claudeRequestsByThreadRef.current.get(turnThreadId)
                pending?.delete(requestId)
                const stillPending = Boolean(pending && pending.size > 0)

                if (event.sessionId) {
                  patchThread(turnThreadId, t => ({
                    ...t,
                    backendSessionId: event.sessionId,
                  }))
                }
                const fallbackCmds = extractShellCommands(assistantAccumulated)
                const shouldAutoRun =
                  !stillPending &&
                  !event.error &&
                  !mcpShellCommandThisTurn &&
                  activeShellConnected &&
                  fallbackCmds.length > 0 &&
                  (aiSettings.autoExecuteCommands ||
                    isRemoteConnectionRefusal(assistantAccumulated))
                if (shouldAutoRun) {
                  const conn = activeConnection
                  const ctx = conn
                    ? `${conn.session.name} (${formatSessionHost(conn.session)})`
                    : undefined
                  void (async () => {
                    for (const cmd of fallbackCmds) {
                      const ok = await requestCommandApprovalIfNeeded(cmd, 'fallback', ctx)
                      if (ok) executeCommandInActiveShell(cmd)
                    }
                  })()
                  if (isRemoteConnectionRefusal(assistantAccumulated)) {
                    patchThread(turnThreadId, t => ({
                      ...t,
                      messages: t.messages.map(m =>
                        m.id === turnAssistantId
                          ? {
                              ...m,
                              content:
                                `${m.content}\n\n[AI Terminal] 已在左侧 Shell 执行上述命令（MCP 未调用时的回退）。请在设置中确认桥接已连接；理想情况应使用 runShellCommand 工具。`,
                            }
                          : m
                      ),
                    }))
                  }
                }
                const diag = claudeCode.lastDiag ? `\n\n诊断: ${claudeCode.lastDiag}` : ''
                const logHint =
                  '可在 %LOCALAPPDATA%\\com.dlbury.clide\\logs\\clide.log 查看详细日志（若存在）。'
                patchThread(turnThreadId, t => ({
                  ...t,
                  status: stillPending ? 'running' : 'idle',
                  messages: t.messages.map(m => {
                    if (m.id !== turnAssistantId) return m
                    let updated = finalizeAssistantTurn(m)
                    if (event.error && !(updated.content ?? '').trim()) {
                      updated = {
                        ...updated,
                        content: updated.content || `Claude Code 错误: ${event.error}`,
                      }
                    } else if (
                      !event.error &&
                      !assistantAccumulated.trim() &&
                      !bufferedResultText?.trim() &&
                      !sawStreamingText &&
                      !(updated.content ?? '').trim() &&
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
                }))
                if (!stillPending) {
                  if (assistantByThreadRef.current.get(turnThreadId) === turnAssistantId) {
                    assistantByThreadRef.current.delete(turnThreadId)
                  }
                  if (activeAssistantIdRef.current === turnAssistantId) {
                    activeAssistantIdRef.current = null
                  }
                }
              }
            })
          }

          const sendClaudeTurn = async (resumeSessionId?: string) => {
            patchThread(turnThreadId, t => ({
              ...t,
              status: 'running',
              messages: t.messages.map(m =>
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
            }))
            const requestId = crypto.randomUUID()
            registerHandler(requestId)
            let pending = claudeRequestsByThreadRef.current.get(turnThreadId)
            if (!pending) {
              pending = new Set()
              claudeRequestsByThreadRef.current.set(turnThreadId, pending)
            }
            pending.add(requestId)
            const queueKey = aiSendQueueKey(aiSettings.backend, turnThreadId)
            try {
              await runAiSendQueued(queueKey, () =>
                withTimeout(
                  isClaudeBackend
                    ? sendClaudeMessage({
                        prompt,
                        claudePath: activeCliPath || undefined,
                        sessionId: resumeSessionId,
                        continueSession: false,
                        requestId,
                        threadId: turnThreadId,
                      })
                    : sendAiMessage({
                        provider: aiSettings.backend,
                        prompt,
                        cliPath: activeCliPath || undefined,
                        sessionId: resumeSessionId,
                        requestId,
                        connectionKey: turnThreadId,
                        threadId: turnThreadId,
                      }),
                  45000,
                  `发送 ${getBackendMeta(aiSettings.backend).label} 请求`
                )
              )
            } catch (err) {
              claudeRequestsByThreadRef.current.get(turnThreadId)?.delete(requestId)
              requestMetaRef.current.delete(requestId)
              throw err
            }
          }

          const threadForSession = agentThreadsRef.current.find(t => t.id === turnThreadId)
          await sendClaudeTurn(threadForSession?.backendSessionId)
        } catch (err) {
          const errorText = err instanceof Error ? err.message : String(err)
          patchThread(turnThreadId, t => ({
            ...t,
            status: 'idle',
            messages: t.messages.map(m =>
              m.id === assistantId ? { ...m, content: errorText } : m
            ),
          }))
        }
        return
      }

      showAiUnavailable(turnThreadId, assistantId)
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
      executeCommandInActiveShell,
      requestCommandApprovalIfNeeded,
      showAiUnavailable,
      agentThreadsRef,
      patchThread,
    ]
  )

  const handleRegenerateMessage = useCallback(
    (assistantMessageId: string) => {
      const threadId = activeThreadIdRef.current
      if (!threadId || !aiSettings.enabled) return
      const thread = agentThreads.find(t => t.id === threadId)
      if (!thread || thread.status === 'running') return
      const idx = thread.messages.findIndex(m => m.id === assistantMessageId)
      if (idx <= 0) return
      let userIdx = idx - 1
      while (userIdx >= 0 && thread.messages[userIdx].role !== 'user') {
        userIdx -= 1
      }
      if (userIdx < 0) return
      const userContent = thread.messages[userIdx].content?.trim()
      if (!userContent) return
      patchThread(threadId, t => ({ ...t, messages: t.messages.slice(0, idx) }))
      void handleAiMessage(userContent)
    },
    [agentThreads, aiSettings.enabled, handleAiMessage, patchThread]
  )

  const handleClearAiChat = useCallback(() => {
    const threadId = activeThreadIdRef.current
    if (!threadId) return
    void stopThreadAgent(threadId)
    clearThread(threadId)
  }, [clearThread, stopThreadAgent])

  const handleClaudePathChange = useCallback(
    (path: string) => {
      updateAiSettings(withActiveCliPath(aiSettings, path))
    },
    [aiSettings, updateAiSettings]
  )

  const handleStopAiMessage = useCallback(() => {
    const threadId = activeThreadIdRef.current
    if (!threadId) return
    const pending = claudeRequestsByThreadRef.current.get(threadId)
    if (!pending || pending.size === 0) return
    const assistantId =
      assistantByThreadRef.current.get(threadId) ?? activeAssistantIdRef.current
    for (const requestId of pending) {
      claudeSilentKeepaliveRef.current.get(requestId)?.dispose()
      requestMetaRef.current.delete(requestId)
      void cancelAiMessage(aiSettings.backend, requestId).catch(() => {})
    }
    claudeRequestsByThreadRef.current.delete(threadId)
    assistantByThreadRef.current.delete(threadId)
    activeAssistantIdRef.current = null
    patchThread(threadId, t => ({
      ...t,
      status: 'stopped',
      messages: t.messages.map(m =>
        assistantId && m.id === assistantId ? finalizeAssistantTurn(m) : m
      ),
    }))
  }, [aiSettings.backend, patchThread])

  const handlePromptContinue = useCallback(() => {
    const prompt = interactivePromptRef.current
    if (!prompt) return
    acknowledgeInteractivePrompt(prompt.sessionId, prompt.prompt)
    keepalivePendingClaudeRequests(activeThreadIdRef.current, true)
    setInteractivePrompt(null)
    workbenchRef.current?.focusTerminal()
  }, [])

  const handlePromptSendInput = useCallback((sessionId: string, input: string) => {
    void submitTerminalInput(sessionId, input).catch(() => {})
    workbenchRef.current?.focusTerminal()
  }, [])

  const handleAiSidebarToggle = useCallback(() => {
    setShowAiPane(v => !v)
  }, [])

  const openSettings = useCallback((tab: SettingsTab = 'ai') => {
    setSettingsTab(tab)
    setIsSettingsOpen(true)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey
      if (mod && event.key.toLowerCase() === 's' && !event.shiftKey && !event.altKey) {
        const conn = connectionsRef.current.find(c => c.id === activeConnectionIdRef.current)
        const fileId = conn?.activeFileId
        if (fileId) {
          event.preventDefault()
          event.stopPropagation()
          void handleFileSaveByIdRef.current(fileId)
          return
        }
      }

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
        case 'command-history':
          setCommandHistoryOpen(true)
          break
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
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
      tool === 'readRemoteFile' ||
      tool === 'openRemoteBrowser' ||
      tool === 'listPortForwards'
    ) {
      const toolRequestId =
        typeof payload.requestId === 'string' ? payload.requestId : undefined
      const meta = toolRequestId ? requestMetaRef.current.get(toolRequestId) : undefined
      const targetThreadId = meta?.threadId ?? activeThreadIdRef.current
      if (toolRequestId && meta) {
        meta.mcpShellUsed = true
      } else {
        mcpShellCommandThisTurnRef.current = true
      }
      keepalivePendingClaudeRequests(targetThreadId, true)
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
          handleSessionConnect(session, { activate: false })
        }
      }
    }
    if (tool === 'disconnectServer' && typeof payload.profileId === 'string') {
      const profileId = payload.profileId as string
      void (async () => {
        const session = foldersRef.current
          .flatMap(f => f.sessions)
          .find(s => s.id === profileId)
        const label = session?.name ?? profileId
        if (aiSettingsRef.current.requireCommandApproval) {
          const ok = await requestCommandApproval({
            command: `disconnectServer — ${label}`,
            assessment: assessDisconnectRisk(label),
            source: 'mcp',
            context: label,
          })
          if (!ok) return
        }
        handleDisconnectSession(profileId)
      })()
    }
    if (tool === 'createNewShell' && typeof payload.connectionId === 'string') {
      const connectionId = payload.connectionId as string
      const shellName = payload.shellName as string | undefined
      const referenceShellId = payload.referenceShellId as string | undefined
      const splitBelow = payload.splitBelow === true
      const conn = connectionsRef.current.find(c => c.id === connectionId)
      if (conn) {
        window.setTimeout(() => {
          handleNewShellForConnection(connectionId, shellName, {
            referenceShellId,
            splitBelow,
            activate: !splitBelow,
            activateConnection: false,
          })
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
        const displayCmd =
          (typeof payload.displayCommand === 'string' && payload.displayCommand) ||
          (payload.command as string)
        void executeShellToolInTab({
          requestId: payload.requestId as string,
          terminalSessionId,
          command: payload.command as string,
          waitMs: typeof payload.waitMs === 'number' ? payload.waitMs : undefined,
          sessionType:
            typeof payload.sessionType === 'string' ? payload.sessionType : undefined,
          requireApproval: async () => {
            const conn = connectionsRef.current.find(c =>
              c.shells.some(s => s.terminalSessionId === terminalSessionId)
            )
            const ctx = conn
              ? `${conn.session.name} (${formatSessionHost(conn.session)})`
              : terminalSessionId
            return requestCommandApprovalIfNeededRef.current(displayCmd, 'mcp', ctx)
          },
          beforeExecute: aiSettings.focusShellOnMcpExecute
            ? async () => {
                console.log(`[MCP] Focusing shell before execute: ${terminalSessionId}`)
                await focusShellByTerminalId(terminalSessionId)
              }
            : undefined,
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
    if (tool === 'openRemoteBrowser') {
      const profileId = typeof payload.profileId === 'string' ? payload.profileId : undefined
      let connectionId =
        typeof payload.connectionId === 'string' ? payload.connectionId : undefined
      const tabId = typeof payload.tabId === 'string' ? payload.tabId : undefined
      const localUrl = typeof payload.localUrl === 'string' ? payload.localUrl : undefined
      const title = typeof payload.title === 'string' ? payload.title : 'Browser'
      const tunnelId = typeof payload.tunnelId === 'string' ? payload.tunnelId : undefined

      if (!connectionId && profileId) {
        connectionId = connectionsRef.current.find(c => c.session.id === profileId)?.id
      }
      if (!connectionId || !tabId || !localUrl || !tunnelId) {
        console.error('[MCP] openRemoteBrowser 参数不完整', payload)
        return
      }

      appendBrowserTab(connectionId, {
        id: tabId,
        title: tabTitleFromUrl(localUrl),
        url: localUrl,
        webviewLabel: makeBrowserWebviewLabel(tabId),
        tunnelId,
      })
    }
  }

  useEffect(() => {
    if (!isTauriRuntime()) return

    let unlistenActivity: (() => void) | undefined

    void listenToolActivity(event => {
      setToolActivities(prev => [event, ...prev].slice(0, 50))
      if (event.kind === 'shell_command') {
        if (event.status === 'running' || event.status === 'completed' || event.status === 'error') {
          for (const tid of claudeRequestsByThreadRef.current.keys()) {
            keepalivePendingClaudeRequests(tid, true)
          }
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
      for (const [threadId, assistantId] of assistantByThreadRef.current.entries()) {
        const pending = claudeRequestsByThreadRef.current.get(threadId)
        if (!pending?.size) continue
        patchThread(threadId, t => ({
          ...t,
          messages: t.messages.map(m =>
            m.id === assistantId ? applyToolActivityToMessage(m, event) : m
          ),
        }))
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

  const handleReconnectTab = useCallback(
    async (connectionId: string) => {
      const conn = connections.find(c => c.id === connectionId)
      if (!conn?.terminalLive) return

      setActiveConnectionId(connectionId)

      for (const shell of conn.shells) {
        await disconnectTerminal(shell.terminalSessionId).catch(() => {})
        clearTerminalOutputBuffer(shell.terminalSessionId)
      }

      setConnections(prev =>
        prev.map(c => {
          if (c.id !== connectionId) return c
          const shells = c.shells.map(s => ({
            ...s,
            terminalStatus: 'connecting' as const,
            history: [
              ...s.history,
              {
                id: `reconnect-${Date.now()}`,
                type: 'system' as const,
                content: `正在重新连接 ${c.session.name}...`,
                timestamp: new Date(),
              },
            ],
          }))
          return {
            ...c,
            session: { ...c.session, status: connectionSessionStatus(shells) },
            shells,
          }
        })
      )
      if (!conn.isSyncGroup) {
        setFolders(prev => setSessionStatusInFolders(prev, conn.session.id, 'connecting'))
      }

      for (let i = 0; i < conn.shells.length; i++) {
        const shell = conn.shells[i]
        const memberSession =
          conn.isSyncGroup && conn.syncMembers?.[i]
            ? conn.syncMembers[i].session
            : conn.session
        runBackendConnect(memberSession, connectionId, shell.id, shell.terminalSessionId)
      }
    },
    [connections, runBackendConnect, setFolders]
  )

  const workbenchShells = useMemo(() => {
    if (!activeConnection) return []
    return activeConnection.shells.map(s => ({
      id: s.id,
      name: s.name,
      history: s.history,
      terminalSessionId: s.terminalSessionId,
      terminalStatus: s.terminalStatus,
    }))
  }, [activeConnection?.shells])

  const workbenchClearSignals = useMemo(() => {
    if (!activeConnection) return {}
    return Object.fromEntries(
      activeConnection.shells.map(s => [
        s.terminalSessionId,
        terminalClearSignals[s.terminalSessionId] ?? 0,
      ])
    )
  }, [activeConnection?.shells, terminalClearSignals])

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
        {!showSidebar ? (
          <CollapsiblePanelRail
            label="服务器"
            icon={Server}
            onExpand={() => setShowSidebar(true)}
          />
        ) : (
          <div className="w-64 shrink-0 overflow-hidden border-r border-sidebar-border">
            <Sidebar
              folders={sidebarFolders}
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
              onSaveLayoutSnapshot={handleSaveLayoutSnapshot}
              onLoadLayoutSnapshot={handleLoadLayoutSnapshot}
              onDeleteLayoutSnapshot={handleDeleteLayoutSnapshot}
              canSaveLayoutSnapshot={canSaveLayoutSnapshot}
              layoutSnapshotsVersion={layoutSnapshotsVersion}
              onCollapse={() => setShowSidebar(false)}
            />
          </div>
        )}

        {/* Center + Right Content */}
        {activeConnection ? (
          <div className="flex-1 flex min-w-0 overflow-hidden">
            {!showFileTree && !activeConnection.isSyncGroup && (
              <CollapsiblePanelRail
                label="文件"
                icon={FolderTree}
                onExpand={() => setShowFileTree(true)}
              />
            )}
            <ResizablePanel
              direction="horizontal"
              defaultSizes={[75, 25]}
              minSizes={[50, 15]}
              panelVisible={[true, showAiPane]}
              className="flex-1 min-w-0"
            >
              <div className="relative h-full min-w-0 overflow-hidden">
              <ResizablePanel
                direction="horizontal"
              defaultSizes={[28, 72]}
              minSizes={[24, 40]}
                panelVisible={[showFileTree && !activeConnection.isSyncGroup, true]}
                className="min-w-0 h-full"
              >
                {activeConnection.isSyncGroup ? (
                  <div className="h-full min-w-0 bg-sidebar border-r border-sidebar-border" aria-hidden />
                ) : (
                <FileTree
                  key={activeConnection.id}
                  onCollapse={() => setShowFileTree(false)}
                remoteLoadError={activeConnection.remoteFileError}
                files={activeConnection.remoteFiles ?? []}
                currentPath={activeConnection.remotePath}
                remoteMode={
                  activeConnection.session.type === 'ssh' ||
                  activeConnection.session.type === 'local' ||
                  activeConnection.session.type === 'wsl'
                }
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
                fileRootMode={activeConnection.session.type === 'ssh' ? fileRootMode : false}
                onFileRootModeChange={
                  activeConnection.session.type === 'ssh'
                    ? handleFileRootModeChange
                    : undefined
                }
                onUpload={
                  activeConnection.session.type === 'ssh' ? handleRemoteUpload : undefined
                }
                onMove={activeConnection.session.type === 'ssh' ? handleRemoteMove : undefined}
                onDownload={
                  activeConnection.session.type === 'ssh' ? handleRemoteDownload : undefined
                }
                onDelete={
                  activeConnection.session.type === 'ssh' ? handleRemoteDelete : undefined
                }
                onRename={
                  activeConnection.session.type === 'ssh' ? handleRemoteRename : undefined
                }
                onOpenInTerminal={
                  activeConnection.session.type === 'ssh' ? handleOpenInTerminal : undefined
                }
                onCreateRemoteFile={
                  activeConnection.session.type === 'ssh' ? handleCreateRemoteFile : undefined
                }
                onCreateRemoteFolder={
                  activeConnection.session.type === 'ssh' ? handleCreateRemoteFolder : undefined
                }
                onSearchRemote={
                  activeConnection.session.type === 'ssh' ? handleRemoteSearch : undefined
                }
                onChmod={
                  activeConnection.session.type === 'ssh' ? handleRemoteChmod : undefined
                }
                onFileOpen={handleFileOpen}
                onFileSelect={handleFileSelect}
                onNavigate={handleRemoteNavigate}
                onDirectoryExpand={handleRemoteDirectoryExpand}
                onRefresh={() => {
                  const t = activeConnection.session.type
                  if (t === 'ssh' || t === 'local' || t === 'wsl') {
                    void loadRemoteFiles(
                      activeConnection.session,
                      activeConnection.remotePath ?? '~',
                      {
                        refreshInPlace: true,
                        connectionId: activeConnection.id,
                      }
                    )
                  }
                }}
              />
                )}
              <WorkbenchLayout
                ref={workbenchRef}
                connectionId={activeConnection.id}
                session={activeConnection.session}
                  shells={workbenchShells}
                  activeShellId={activeConnection.activeShellId}
                openFiles={activeConnection.openFiles}
                activeFileId={activeConnection.activeFileId}
                terminalLive={activeConnection.terminalLive}
                clearSignals={workbenchClearSignals}
                browserTabs={activeConnection.browserTabs ?? []}
                activeBrowserTabId={activeConnection.activeBrowserTabId ?? undefined}
                monitorOpen={activeConnection.monitorOpen ?? false}
                monitorHistory={hostStatsHistory}
                isSyncGroup={activeConnection.isSyncGroup}
                  onShellChange={handleShellChange}
                  onNewShell={activeConnection.isSyncGroup ? () => {} : handleNewShell}
                  onCloseShell={activeConnection.isSyncGroup ? () => {} : handleCloseShell}
                  onCloseBrowser={handleCloseBrowserTab}
                  onBrowserUrlChange={handleBrowserUrlChange}
                  onNewBrowser={
                    !activeConnection.isSyncGroup &&
                    isTauriRuntime() &&
                    activeConnection.shells.some(s => s.terminalStatus === 'connected')
                      ? handleNewBrowser
                      : undefined
                  }
                  onOpenMonitor={
                    !activeConnection.isSyncGroup &&
                    activeConnection.session.type === 'ssh' &&
                    activeConnection.session.status === 'connected'
                      ? handleOpenMonitor
                      : undefined
                  }
                  onCloseMonitor={handleCloseMonitor}
                  onReconnect={
                    activeConnection.terminalLive &&
                    !activeConnection.shells.some(s => s.terminalStatus === 'connected')
                      ? () => handleReconnectTab(activeConnection.id)
                      : undefined
                  }
                  onCommand={handleCommand}
                onFileChange={handleFileChange}
                onFileSave={handleFileSaveById}
                onFileClose={handleFileClose}
                onActiveFileChange={handleActiveFileChange}
                layoutRestore={pendingLayoutRestore}
                onLayoutRestoreDone={() => {
                  setPendingLayoutRestore(null)
                  layoutRestorePendingRef.current = false
                }}
              />
              </ResizablePanel>
              <ThreadsDrawer
                open={threadsDrawerOpen}
                onOpenChange={setThreadsDrawerOpen}
                threads={agentThreads}
                activeThreadId={activeThreadId}
                onSelectThread={selectThread}
                onStopThread={threadId => void stopThreadAgent(threadId)}
              />
              </div>

            <AiPane
              messages={activeThread?.messages ?? []}
              isThinking={activeThread?.status === 'running'}
              isTaskActive={
                activeThread?.status === 'running' || Boolean(interactivePrompt)
              }
              aiEnabled={aiSettings.enabled}
              modelLabel={
                aiSettings.enabled
                  ? getBackendMeta(aiSettings.backend).label
                  : undefined
              }
              bridgeStatus={
                aiSettings.backend === 'claude-code' && claudeCode.bridge
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
              mcpStatus={aiSettings.backend === 'claude-code' ? claudeCode.mcpStatus : null}
              mcpRegisterError={aiSettings.backend === 'claude-code' ? claudeCode.mcpRegisterError : null}
              mcpRegistering={aiSettings.backend === 'claude-code' ? claudeCode.mcpRegistering : false}
              streamListenError={claudeCode.streamListenError}
              lastDiag={claudeCode.lastDiag}
              onRetryMcpRegister={() => void claudeCode.retryMcpRegister()}
              onSendMessage={handleAiMessage}
              onStopMessage={handleStopAiMessage}
              onExecuteCommand={handleAiExecuteCommand}
              onClearChat={handleClearAiChat}
              onRegenerateMessage={handleRegenerateMessage}
              claudePath={getActiveCliPath(aiSettings) || undefined}
              claudeCandidates={claudeCode.detected?.candidates ?? []}
              onClaudePathChange={handleClaudePathChange}
              interactivePrompt={interactivePrompt}
              onPromptDismiss={handlePromptContinue}
              onFocusTerminal={() => workbenchRef.current?.focusTerminal()}
              onPromptSendInput={handlePromptSendInput}
              onPromptCancel={sid => {
                cancelShellToolForSession(sid)
                setInteractivePrompt(null)
              }}
              profileId={activeConnection.session.id}
              threadsDrawerOpen={threadsDrawerOpen}
              onOpenThreadsDrawer={() => setThreadsDrawerOpen(open => !open)}
              onNewThread={createNewThread}
              commandApprovalPending={commandApprovalPending}
              commandApprovalResolved={commandApprovalResolved}
              onApproveCommand={handleApproveCommand}
              onDenyCommand={handleDenyCommand}
            />
          </ResizablePanel>
          </div>
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
        hostStatsHistory={hostStatsHistory}
        hostStatsError={hostStatsError}
        aiSidebarVisible={showAiPane}
        aiThinking={activeThread?.status === 'running'}
        onAiSidebarToggle={handleAiSidebarToggle}
        onOpenMonitor={handleOpenMonitor}
        connectedTerminalCount={syncServerTargets.length}
        onOpenMultiServerSync={() => setMultiServerSyncOpen(true)}
        isSyncGroup={activeConnection?.isSyncGroup}
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

      <UpdateAvailableDialog
        open={updatePromptOpen}
        update={updatePrompt}
        onOpenChange={setUpdatePromptOpen}
      />

      <SettingsModal
        open={isSettingsOpen}
        onOpenChange={setIsSettingsOpen}
        activeTab={settingsTab}
        aiSettings={aiSettings}
        onSaveAiSettings={updateAiSettings}
        folders={folders}
        auditShellLabels={Object.fromEntries(
          connections.flatMap(c =>
            c.shells.map(s => [s.terminalSessionId, s.name])
          )
        )}
        onRunAuditCommand={handleRunHistoryCommand}
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

      <CommandHistoryDialog
        open={commandHistoryOpen}
        onOpenChange={setCommandHistoryOpen}
        sessionIds={activeTerminalSessionIds}
        onRunCommand={handleRunHistoryCommand}
      />

      <MultiServerSyncDialog
        open={multiServerSyncOpen}
        onOpenChange={setMultiServerSyncOpen}
        servers={syncServerTargets}
        onStart={handleStartMultiServerSync}
      />
    </div>
  )
}
