'use client'

import {
  createContext,
  forwardRef,
  memo,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  DockviewReact,
  DockviewReadyEvent,
  IDockviewPanelProps,
  DockviewApi,
  IDockviewPanelHeaderProps,
  IDockviewHeaderActionsProps,
} from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'
import { Terminal, FileCode, Globe, X, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppTheme } from '@/hooks/use-app-theme'
import { EditorContent } from '@/components/layout/editor-content'
import { ShellPane } from '@/components/layout/shell-pane'
import { BrowserPanel } from '@/components/layout/browser-panel'
import {
  hideAllEmbeddedWebviews,
  showAllEmbeddedWebviews,
  syncAllEmbeddedWebviews,
} from '@/lib/webview-layout-bridge'
import { editorModelToOpenFile } from '@/lib/editor-service'
import type { TerminalLine, Session } from '@/lib/types'
import type { EditorModel } from '@/lib/editor-service'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

interface WorkbenchContextValue {
  onNewShell: (referencePanelId?: string) => void
  onNewBrowser?: () => void
  onReconnect?: () => void
  requestEditorClose: (fileId: string, panelApi: { close: () => void }) => void
  tryClosePanel: (panelId: string) => void
  closeOtherPanelsInGroup: (panelId: string) => void
  closeAllPanelsInGroup: (panelId: string) => void
  onShellChange: (id: string) => void
  onCloseShell: (id: string) => void
  onCommand: (shellId: string, command: string) => void
}

interface WorkbenchRuntimeContextValue {
  activeShellId: string
  shells: WorkbenchShell[]
  clearSignals: Record<string, number>
}

const WorkbenchContext = createContext<WorkbenchContextValue>({
  onNewShell: () => {},
  requestEditorClose: () => {},
  tryClosePanel: () => {},
  closeOtherPanelsInGroup: () => {},
  closeAllPanelsInGroup: () => {},
  onShellChange: () => {},
  onCloseShell: () => {},
  onCommand: () => {},
})

const WorkbenchRuntimeContext = createContext<WorkbenchRuntimeContextValue>({
  activeShellId: '',
  shells: [],
  clearSignals: {},
})

export interface WorkbenchShell {
  id: string
  name: string
  history: TerminalLine[]
  terminalSessionId: string
  terminalStatus?: 'connecting' | 'connected' | 'disconnected' | 'error'
}

interface TerminalPanelParams {
  type: 'terminal'
  shellId: string
  sessionId: string
  user?: string
  host?: string
  terminalLive?: boolean
  canCloseTab?: boolean
}

interface EditorPanelParams {
  type: 'editor'
  fileId: string
  file: ReturnType<typeof editorModelToOpenFile>
  onChange: (content: string) => void
  onSave: () => void
}

interface BrowserPanelParams {
  type: 'browser'
  tabId: string
  title: string
  url: string
  webviewLabel: string
  profileId?: string
  onUrlChange: (url: string, tunnelId?: string) => void
}

export interface WorkbenchBrowserTab {
  id: string
  title: string
  url: string
  webviewLabel: string
  tunnelId?: string
}

type PanelParams = TerminalPanelParams | EditorPanelParams | BrowserPanelParams

function TerminalPanel({ params }: IDockviewPanelProps<TerminalPanelParams>) {
  const { activeShellId, shells, clearSignals } = useContext(WorkbenchRuntimeContext)
  const { onShellChange, onNewShell, onCloseShell, onCommand, onReconnect } =
    useContext(WorkbenchContext)
  const shell = shells.find(s => s.id === params.shellId)
  if (!shell) {
    return <div className="p-4 text-muted-foreground text-sm">Shell 不存在</div>
  }

  return (
    <ShellPane
      shells={[{ id: shell.id, name: shell.name, history: shell.history }]}
      activeShellId={shell.id}
      onShellChange={onShellChange}
      onNewShell={onNewShell}
      onCloseShell={onCloseShell}
      onCommand={onCommand}
      user={params.user}
      host={params.host}
      terminalLive={params.terminalLive}
      sessionId={shell.terminalSessionId}
      terminalConnected={shell.terminalStatus === 'connected'}
      terminalStatus={shell.terminalStatus}
      clearSignal={clearSignals[shell.terminalSessionId] ?? 0}
      inputEnabled={activeShellId === params.shellId}
      hideTabBar
      onReconnect={
        shell.terminalStatus === 'disconnected' || shell.terminalStatus === 'error'
          ? onReconnect
          : undefined
      }
    />
  )
}

function EditorPanel({ params }: IDockviewPanelProps<EditorPanelParams>) {
  return (
    <EditorContent
      file={params.file}
      onChange={params.onChange}
      onSave={params.onSave}
    />
  )
}

function BrowserPanelWrapper({ params, api }: IDockviewPanelProps<BrowserPanelParams>) {
  const [panelVisible, setPanelVisible] = useState(api.isVisible)

  useEffect(() => {
    const apply = () => setPanelVisible(api.isVisible)
    apply()
    const disposable = api.onDidVisibilityChange(apply)
    return () => disposable.dispose()
  }, [api])

  return (
    <BrowserPanel
      webviewLabel={params.webviewLabel}
      url={params.url}
      profileId={params.profileId}
      visible={panelVisible}
      onUrlChange={params.onUrlChange}
    />
  )
}

const WorkbenchTab = memo(function WorkbenchTab({
  params,
  api,
}: IDockviewPanelHeaderProps<PanelParams>) {
  const { requestEditorClose, tryClosePanel, closeOtherPanelsInGroup, closeAllPanelsInGroup } =
    useContext(WorkbenchContext)
  const data = params
  const panelId = api.id

  const icon = (() => {
    switch (data.type) {
      case 'terminal':
        return <Terminal className="w-3.5 h-3.5" />
      case 'editor':
        return <FileCode className="w-3.5 h-3.5" />
      case 'browser':
        return <Globe className="w-3.5 h-3.5" />
    }
  })()

  const title =
    data.type === 'terminal'
      ? api.title
      : data.type === 'browser'
        ? (data as BrowserPanelParams).title
        : (data as EditorPanelParams).file.name

  const isModified = data.type === 'editor' && (data as EditorPanelParams).file.isModified
  const canClose =
    data.type === 'editor' ||
    data.type === 'browser' ||
    (data.type === 'terminal' && (data as TerminalPanelParams).canCloseTab)

  const handleClose = (e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (data.type === 'editor') {
      const fileId = (data as EditorPanelParams).fileId
      const modified = (data as EditorPanelParams).file.isModified
      if (modified) {
        requestEditorClose(fileId, api)
        return
      }
    }
    api.close()
  }

  const groupPanelCount = api.group?.panels.length ?? 1
  const showGroupActions = groupPanelCount > 1

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="flex items-center gap-1.5 px-2 py-1 h-full min-w-0 max-w-[180px] select-none">
          <span className="text-muted-foreground shrink-0">{icon}</span>
          <span className="truncate text-xs flex-1 min-w-0">{title}</span>
          {isModified && <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />}
          {canClose && (
            <button
              type="button"
              onPointerDown={e => e.stopPropagation()}
              onClick={handleClose}
              className="ml-auto p-0.5 rounded hover:bg-muted/80 opacity-60 hover:opacity-100 transition-opacity shrink-0"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        {canClose && (
          <>
            <ContextMenuItem onClick={() => tryClosePanel(panelId)}>关闭</ContextMenuItem>
            {showGroupActions && (
              <>
                <ContextMenuItem onClick={() => closeOtherPanelsInGroup(panelId)}>
                  关闭其他
                </ContextMenuItem>
                <ContextMenuItem onClick={() => closeAllPanelsInGroup(panelId)}>
                  关闭全部
                </ContextMenuItem>
              </>
            )}
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem
          onClick={() => {
            const text =
              data.type === 'browser'
                ? (data as BrowserPanelParams).url
                : data.type === 'editor'
                  ? (data as EditorPanelParams).file.path
                  : title
            navigator.clipboard.writeText(text ?? '').catch(() => {})
          }}
        >
          复制路径
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})

function RightHeaderActions({ panels, activePanel }: IDockviewHeaderActionsProps) {
  const { onNewShell, onNewBrowser } = useContext(WorkbenchContext)
  const hasTerminal = panels.some(p => p.id.startsWith('terminal-'))

  if (!hasTerminal) return null

  const referencePanelId =
    (activePanel?.id.startsWith('terminal-') ? activePanel.id : undefined) ??
    panels.find(p => p.id.startsWith('terminal-'))?.id

  return (
    <div className="flex h-full items-stretch">
      {onNewBrowser && (
        <button
          onClick={() => onNewBrowser()}
          className={cn(
            'flex items-center justify-center h-full px-2',
            'hover:bg-muted/50 transition-colors border-l border-border',
            'text-muted-foreground hover:text-foreground'
          )}
          title="新增浏览器"
        >
          <Globe className="w-4 h-4" />
        </button>
      )}
      <button
        onClick={() => onNewShell(referencePanelId)}
        className={cn(
          'flex items-center justify-center h-full px-2',
          'hover:bg-muted/50 transition-colors border-l border-border',
          'text-muted-foreground hover:text-foreground'
        )}
        title="新建 Shell"
      >
        <Plus className="w-4 h-4" />
      </button>
    </div>
  )
}

const components = {
  terminal: TerminalPanel,
  editor: EditorPanel,
  browser: BrowserPanelWrapper,
}

const tabComponents = {
  tab: WorkbenchTab,
}

export interface WorkbenchLayoutProps {
  connectionId: string
  session: Session
  shells: WorkbenchShell[]
  activeShellId: string
  openFiles: EditorModel[]
  activeFileId: string | null
  terminalLive?: boolean
  clearSignals?: Record<string, number>
  browserTabs?: WorkbenchBrowserTab[]
  activeBrowserTabId?: string
  onShellChange: (shellId: string) => void
  onNewShell: () => void
  onCloseShell: (shellId: string) => void
  onCloseBrowser?: (tabId: string) => void
  onBrowserUrlChange?: (tabId: string, url: string, tunnelId?: string) => void
  onNewBrowser?: () => void
  onReconnect?: () => void
  onCommand: (shellId: string, command: string) => void
  onFileChange: (fileId: string, content: string) => void
  onFileSave: (fileId: string) => void
  onFileClose: (fileId: string) => void
  onActiveFileChange: (fileId: string) => void
}

export interface WorkbenchLayoutHandle {
  focusTerminal: () => void
  activateShellById: (shellId: string) => void
  focusEditor: () => void
  splitEditor: (direction: 'right' | 'below') => void
}

export const WorkbenchLayout = forwardRef<WorkbenchLayoutHandle, WorkbenchLayoutProps>(
  function WorkbenchLayout({
  connectionId,
  session,
  shells,
  activeShellId,
  openFiles,
  activeFileId,
  terminalLive,
  clearSignals = {},
  browserTabs = [],
  activeBrowserTabId,
  onShellChange,
  onNewShell,
  onCloseShell,
  onCloseBrowser,
  onBrowserUrlChange,
  onNewBrowser,
  onReconnect,
  onCommand,
  onFileChange,
  onFileSave,
  onFileClose,
  onActiveFileChange,
}, ref) {
  const { dockviewTheme } = useAppTheme()
  const [pendingClose, setPendingClose] = useState<{
    fileId: string
    closePanel: () => void
  } | null>(null)
  const apiRef = useRef<DockviewApi | null>(null)
  const syncingRef = useRef(false)
  const editorSnapshotRef = useRef<Map<string, string>>(new Map())
  const terminalParamsCacheRef = useRef<Map<string, string>>(new Map())
  const newShellPlacementRef = useRef<string | undefined>(undefined)

  const onShellChangeRef = useRef(onShellChange)
  const onNewShellRef = useRef(onNewShell)
  const onCloseShellRef = useRef(onCloseShell)
  const onCommandRef = useRef(onCommand)
  const onFileChangeRef = useRef(onFileChange)
  const onFileSaveRef = useRef(onFileSave)
  const onFileCloseRef = useRef(onFileClose)
  const onActiveFileChangeRef = useRef(onActiveFileChange)

  onShellChangeRef.current = onShellChange
  onNewShellRef.current = onNewShell
  onCloseShellRef.current = onCloseShell
  onCommandRef.current = onCommand
  onFileChangeRef.current = onFileChange
  onFileSaveRef.current = onFileSave
  onFileCloseRef.current = onFileClose
  onActiveFileChangeRef.current = onActiveFileChange
  const onCloseBrowserRef = useRef(onCloseBrowser)
  onCloseBrowserRef.current = onCloseBrowser
  const onBrowserUrlChangeRef = useRef(onBrowserUrlChange)
  onBrowserUrlChangeRef.current = onBrowserUrlChange
  const onNewBrowserRef = useRef(onNewBrowser)
  onNewBrowserRef.current = onNewBrowser
  const onReconnectRef = useRef(onReconnect)
  onReconnectRef.current = onReconnect

  const buildBrowserParams = useCallback(
    (tab: WorkbenchBrowserTab): BrowserPanelParams => ({
      type: 'browser',
      tabId: tab.id,
      title: tab.title,
      url: tab.url,
      webviewLabel: tab.webviewLabel,
      profileId: session.type === 'ssh' ? session.id : undefined,
      onUrlChange: (url, tunnelId) =>
        onBrowserUrlChangeRef.current?.(tab.id, url, tunnelId),
    }),
    [session.type, session.id]
  )

  const buildEditorParams = useCallback(
    (file: EditorModel): EditorPanelParams => {
      const openFile = editorModelToOpenFile(file)
      return {
        type: 'editor',
        fileId: file.id,
        file: openFile,
        onChange: (content: string) => onFileChangeRef.current(file.id, content),
        onSave: () => onFileSaveRef.current(file.id),
      }
    },
    []
  )

  const editorMetaKey = useCallback((file: EditorModel) => {
    return `${file.name}|${file.isModified}`
  }, [])

  const buildTerminalParams = useCallback(
    (shellId: string): TerminalPanelParams => ({
      type: 'terminal',
      shellId,
      sessionId:
        shells.find(s => s.id === shellId)?.terminalSessionId ?? `${session.id}::${shellId}`,
      user: session.user,
      host: session.host,
      terminalLive,
      canCloseTab: shells.length > 1,
    }),
    [shells, session.id, session.user, session.host, terminalLive]
  )

  const terminalParamsKey = useCallback(
    (shellId: string) => {
      const shell = shells.find(s => s.id === shellId)
      return `${shellId}:${shell?.terminalSessionId ?? ''}:${terminalLive ? '1' : '0'}:${shell?.terminalStatus ?? ''}:${shells.length > 1 ? '1' : '0'}`
    },
    [shells, terminalLive]
  )

  const shellsLayoutKey = shells
    .map(s => `${s.id}:${s.name}:${s.terminalSessionId}:${s.terminalStatus ?? ''}`)
    .join('|')

  const findTerminalRef = useCallback(
    (api: DockviewApi, excludePanelId?: string) =>
      api.panels.find(p => p.id.startsWith('terminal-') && p.id !== excludePanelId)?.id,
    []
  )

  const resolveTerminalReferencePanel = useCallback(
    (api: DockviewApi, excludePanelId?: string) => {
      const placement = newShellPlacementRef.current
      newShellPlacementRef.current = undefined
      if (placement && placement !== excludePanelId && api.getPanel(placement)) {
        return placement
      }
      return findTerminalRef(api, excludePanelId)
    },
    [findTerminalRef]
  )

  const ensureInitialTerminal = useCallback(
    (api: DockviewApi) => {
      if (shells.length === 0) return

      const missing = shells.filter(s => !api.getPanel(`terminal-${s.id}`))
      if (missing.length === 0) return

      missing.forEach((shell, index) => {
        const panelId = `terminal-${shell.id}`
        const refPanel = index === 0 ? undefined : resolveTerminalReferencePanel(api, panelId)
        api.addPanel({
          id: panelId,
          component: 'terminal',
          tabComponent: 'tab',
          title: shell.name,
          params: buildTerminalParams(shell.id),
          ...(refPanel
            ? { position: { referencePanel: refPanel, direction: 'within' as const } }
            : {}),
        })
      })
    },
    [shells, buildTerminalParams, resolveTerminalReferencePanel]
  )

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api
      apiRef.current = api

      const syncWebviews = () => syncAllEmbeddedWebviews()

      const onActivePanelChange = () => {
        // 分屏时浏览器与 Shell 同时可见，仅同步位置，不按 active 面板 hide
        requestAnimationFrame(() => {
          requestAnimationFrame(() => syncAllEmbeddedWebviews())
        })
      }

      let dragReleaseHandler: (() => void) | null = null
      const releaseAfterDrag = () => {
        if (dragReleaseHandler) {
          window.removeEventListener('pointerup', dragReleaseHandler)
          window.removeEventListener('pointercancel', dragReleaseHandler)
          dragReleaseHandler = null
        }
        showAllEmbeddedWebviews()
      }

      const hideForDrag = () => {
        hideAllEmbeddedWebviews()
        if (dragReleaseHandler) return
        dragReleaseHandler = releaseAfterDrag
        window.addEventListener('pointerup', dragReleaseHandler)
        window.addEventListener('pointercancel', dragReleaseHandler)
      }

      api.onDidLayoutChange(syncWebviews)
      api.onDidActivePanelChange(onActivePanelChange)
      api.onWillDragPanel(hideForDrag)
      api.onWillDragGroup(hideForDrag)
      api.onDidDrop(releaseAfterDrag)

      ensureInitialTerminal(api)
    },
    [ensureInitialTerminal]
  )

  // Reset dockview refs when connection changes
  // 注意：由于 DockviewReact 有 key={connectionId}，组件会在 connectionId 变化时重新挂载
  // 这里的清理函数确保在卸载或 connectionId 变化前完成所有清理
  useEffect(() => {
    return () => {
      // 先标记 API 为即将失效，阻止新的操作
      const api = apiRef.current
      if (api) {
        // 清理所有面板关闭事件监听器
        api.panels.forEach(panel => {
          try {
            // 任何需要在组件卸载前执行的清理
            if (panel.id.startsWith('terminal-')) {
              const shellId = panel.id.replace('terminal-', '')
              terminalParamsCacheRef.current.delete(panel.id)
            } else if (panel.id.startsWith('editor-')) {
              const fileId = panel.id.replace('editor-', '')
              editorSnapshotRef.current.delete(fileId)
            } else if (panel.id.startsWith('browser-')) {
              // browser webview closed in BrowserPanel unmount
            }
          } catch {
            // 忽略清理过程中的错误
          }
        })
      }
      // 最后清空 API 引用
      apiRef.current = null
    }
  }, [connectionId])

  // Sync shell panels（避免切换激活 Shell 时 updateParameters 打断标签拖拽）
  useEffect(() => {
    const api = apiRef.current
    if (!api) return

    const existingTerminalIds = new Set(
      api.panels.filter(p => p.id.startsWith('terminal-')).map(p => p.id.replace('terminal-', ''))
    )
    const shellIds = new Set(shells.map(s => s.id))

    shells.forEach(shell => {
      const panelId = `terminal-${shell.id}`
      const panel = api.getPanel(panelId)
      const params = buildTerminalParams(shell.id)
      const paramsKey = terminalParamsKey(shell.id)

      if (panel) {
        if (panel.api.title !== shell.name) {
          panel.api.setTitle(shell.name)
        }
        if (terminalParamsCacheRef.current.get(panelId) !== paramsKey) {
          panel.api.updateParameters(params)
          terminalParamsCacheRef.current.set(panelId, paramsKey)
        }
      } else {
        const refPanel = resolveTerminalReferencePanel(api, panelId)
        // 允许添加第一个面板（当没有参考面板且面板列表为空时）
        api.addPanel({
          id: panelId,
          component: 'terminal',
          tabComponent: 'tab',
          title: shell.name,
          params,
          ...(refPanel
            ? { position: { referencePanel: refPanel, direction: 'within' as const } }
            : {}),
        })
        terminalParamsCacheRef.current.set(panelId, paramsKey)
      }
    })

    existingTerminalIds.forEach(id => {
      if (!shellIds.has(id)) {
        syncingRef.current = true
        api.getPanel(`terminal-${id}`)?.api.close()
        terminalParamsCacheRef.current.delete(`terminal-${id}`)
        syncingRef.current = false
      }
    })
  }, [shellsLayoutKey, connectionId, buildTerminalParams, terminalParamsKey, resolveTerminalReferencePanel])

  const browserTabsKey = browserTabs.map(t => `${t.id}:${t.title}:${t.url}:${t.webviewLabel}`).join('|')

  // Sync browser panels
  useEffect(() => {
    const api = apiRef.current
    if (!api) return

    const existingBrowserIds = new Set(
      api.panels.filter(p => p.id.startsWith('browser-')).map(p => p.id.replace('browser-', ''))
    )
    const tabIds = new Set(browserTabs.map(t => t.id))

    browserTabs.forEach(tab => {
      const panelId = `browser-${tab.id}`
      const panel = api.getPanel(panelId)
      const params = buildBrowserParams(tab)

      if (panel) {
        if (panel.api.title !== tab.title) {
          panel.api.setTitle(tab.title)
        }
        panel.api.updateParameters(params)
      } else {
        const terminalRef = findTerminalRef(api)
        const existingBrowser = api.panels.find(p => p.id.startsWith('browser-'))
        const refPanel = existingBrowser?.id ?? terminalRef
        if (!refPanel) return

        api.addPanel({
          id: panelId,
          component: 'browser',
          tabComponent: 'tab',
          title: tab.title,
          params,
          position: { referencePanel: refPanel, direction: 'within' as const },
        })
      }
    })

    existingBrowserIds.forEach(id => {
      if (!tabIds.has(id)) {
        syncingRef.current = true
        api.getPanel(`browser-${id}`)?.api.close()
        syncingRef.current = false
      }
    })
  }, [browserTabsKey, connectionId, findTerminalRef, buildBrowserParams])

  // Activate browser tab when activeBrowserTabId changes
  useEffect(() => {
    const api = apiRef.current
    if (!api || !activeBrowserTabId) return
    const panel = api.getPanel(`browser-${activeBrowserTabId}`)
    if (!panel || panel.api.isActive) return
    panel.api.setActive()
  }, [activeBrowserTabId])

  const handleNewShellInGroup = useCallback(
    (referencePanelId?: string) => {
      newShellPlacementRef.current = referencePanelId
      onNewShellRef.current()
    },
    []
  )

  // Activate shell tab when activeShellId changes (e.g. new shell from + button)
  useEffect(() => {
    const api = apiRef.current
    if (!api || !activeShellId) return
    const panel = api.getPanel(`terminal-${activeShellId}`)
    if (!panel || panel.api.isActive) return
    panel.api.setActive()
  }, [activeShellId])

  // Handle panel removal (shell / editor close via tab X)
  useEffect(() => {
    const api = apiRef.current
    if (!api) return

    const disposable = api.onDidRemovePanel(panel => {
      if (syncingRef.current) return
      if (panel.id.startsWith('terminal-')) {
        const shellId = panel.id.replace('terminal-', '')
        if (shells.some(s => s.id === shellId)) {
          onCloseShellRef.current(shellId)
        }
      }
      if (panel.id.startsWith('editor-split-')) {
        return
      }
      if (panel.id.startsWith('editor-')) {
        const fileId = panel.id.replace('editor-', '')
        editorSnapshotRef.current.delete(fileId)
        if (openFiles.some(f => f.id === fileId)) {
          onFileCloseRef.current(fileId)
        }
      }
      if (panel.id.startsWith('browser-')) {
        const tabId = panel.id.replace('browser-', '')
        if (browserTabs.some(t => t.id === tabId)) {
          onCloseBrowserRef.current?.(tabId)
        }
      }
    })

    return () => disposable.dispose()
  }, [shells, openFiles, browserTabs])

  const openFileIdsKey = openFiles.map(f => f.id).join('\0')

  // Add / remove editor panels
  useEffect(() => {
    const api = apiRef.current
    if (!api) return

    const openIds = new Set(openFiles.map(f => f.id))

    openFiles.forEach(file => {
      const panelId = `editor-${file.id}`
      if (api.getPanel(panelId)) return

      const existingEditor = api.panels.find(p => p.id.startsWith('editor-'))
      const terminalRef = findTerminalRef(api)
      if (!terminalRef && !existingEditor) return

      const position = existingEditor
        ? { referencePanel: existingEditor.id, direction: 'within' as const }
        : terminalRef
          ? { referencePanel: terminalRef, direction: 'above' as const }
          : undefined

      if (!position) return

      api.addPanel({
        id: panelId,
        component: 'editor',
        tabComponent: 'tab',
        title: file.name,
        params: buildEditorParams(file),
        position,
      })
      editorSnapshotRef.current.set(file.id, editorMetaKey(file))
    })

    api.panels
      .filter(p => p.id.startsWith('editor-'))
      .forEach(panel => {
        const fileId = panel.id.replace('editor-', '')
        if (!openIds.has(fileId)) {
          syncingRef.current = true
          editorSnapshotRef.current.delete(fileId)
          panel.api.close()
          syncingRef.current = false
        }
      })
  }, [openFileIdsKey, connectionId, openFiles, buildEditorParams, editorMetaKey, findTerminalRef])

  // Sync tab title / modified indicator without pushing content on every keystroke
  useEffect(() => {
    const api = apiRef.current
    if (!api) return

    openFiles.forEach(file => {
      const panel = api.getPanel(`editor-${file.id}`)
      if (!panel) return

      const metaKey = editorMetaKey(file)
      const cached = editorSnapshotRef.current.get(file.id)
      if (cached === metaKey || cached === `${metaKey}|active`) return

      const prevActive = cached?.endsWith('|active')
      editorSnapshotRef.current.set(file.id, prevActive ? `${metaKey}|active` : metaKey)
      if (file.name !== panel.api.title) {
        panel.api.setTitle(file.name)
      }
      panel.api.updateParameters(buildEditorParams(file))
    })
  }, [openFiles, buildEditorParams, editorMetaKey])

  // Activate editor tab and load full content when switching files
  useEffect(() => {
    const api = apiRef.current
    if (!api || !activeFileId) return

    const file = openFiles.find(f => f.id === activeFileId)
    const panel = api.getPanel(`editor-${activeFileId}`)
    if (!file || !panel) return

    const metaKey = editorMetaKey(file)
    editorSnapshotRef.current.set(file.id, `${metaKey}|active`)
    panel.api.updateParameters(buildEditorParams(file))
    panel.api.setActive()
  }, [activeFileId, openFileIdsKey, openFiles, buildEditorParams, editorMetaKey])

  // Track active panel changes from user interaction
  useEffect(() => {
    const api = apiRef.current
    if (!api) return

    const disposable = api.onDidActivePanelChange(panel => {
      if (panel?.id.startsWith('editor-')) {
        const params = panel.params as EditorPanelParams | undefined
        if (params?.type === 'editor' && params.fileId) {
          onActiveFileChangeRef.current(params.fileId)
        } else if (!panel.id.startsWith('editor-split-')) {
          onActiveFileChangeRef.current(panel.id.replace('editor-', ''))
        }
      }
      if (panel?.id.startsWith('terminal-')) {
        onShellChangeRef.current(panel.id.replace('terminal-', ''))
      }
    })

    return () => disposable.dispose()
  }, [])

  const requestEditorClose = useCallback(
    (fileId: string, panelApi: { close: () => void }) => {
      setPendingClose({ fileId, closePanel: () => panelApi.close() })
    },
    []
  )

  const tryClosePanel = useCallback(
    (panelId: string) => {
      const dockApi = apiRef.current
      const panel = dockApi?.getPanel(panelId)
      if (!panel) return
      const params = panel.params as PanelParams | undefined
      if (params?.type === 'editor' && params.file.isModified) {
        requestEditorClose(params.fileId, panel.api)
        return
      }
      panel.api.close()
    },
    [requestEditorClose]
  )

  const closeOtherPanelsInGroup = useCallback(
    (panelId: string) => {
      const dockApi = apiRef.current
      const panel = dockApi?.getPanel(panelId)
      const group = panel?.api.group
      if (!group) return
      group.panels
        .filter(p => p.id !== panelId)
        .forEach(p => tryClosePanel(p.id))
    },
    [tryClosePanel]
  )

  const closeAllPanelsInGroup = useCallback(
    (panelId: string) => {
      const dockApi = apiRef.current
      const panel = dockApi?.getPanel(panelId)
      const group = panel?.api.group
      if (!group) return
      ;[...group.panels].forEach(p => tryClosePanel(p.id))
    },
    [tryClosePanel]
  )

  const handleSaveAndClose = useCallback(() => {
    if (!pendingClose) return
    onFileSave(pendingClose.fileId)
    pendingClose.closePanel()
    setPendingClose(null)
  }, [pendingClose, onFileSave])

  const handleDiscardAndClose = useCallback(() => {
    if (!pendingClose) return
    pendingClose.closePanel()
    setPendingClose(null)
  }, [pendingClose])

  const pendingFile = pendingClose
    ? openFiles.find(f => f.id === pendingClose.fileId)
    : null

  useImperativeHandle(
    ref,
    () => ({
      focusTerminal: () => {
        const api = apiRef.current
        if (!api) return
        const panel =
          api.getPanel(`terminal-${activeShellId}`) ??
          api.panels.find(p => p.id.startsWith('terminal-'))
        panel?.api.setActive()
      },
      activateShellById: (shellId: string) => {
        const api = apiRef.current
        if (!api) return
        api.getPanel(`terminal-${shellId}`)?.api.setActive()
      },
      focusEditor: () => {
        const api = apiRef.current
        if (!api || !activeFileId) return
        api.getPanel(`editor-${activeFileId}`)?.api.setActive()
      },
      splitEditor: (direction: 'right' | 'below') => {
        const api = apiRef.current
        if (!api || !activeFileId) return
        const file = openFiles.find(f => f.id === activeFileId)
        const refPanel = api.getPanel(`editor-${activeFileId}`)
        if (!file || !refPanel) return
        api.addPanel({
          id: `editor-split-${Date.now()}`,
          component: 'editor',
          tabComponent: 'tab',
          title: `${file.name} (拆分)`,
          params: buildEditorParams(file),
          position: {
            referencePanel: refPanel.id,
            direction: direction === 'right' ? 'right' : 'below',
          },
        })
      },
    }),
    [activeShellId, activeFileId, openFiles, buildEditorParams]
  )

  const workbenchContextValue = useMemo(
    () => ({
      onNewShell: handleNewShellInGroup,
      onNewBrowser: onNewBrowserRef.current ? () => onNewBrowserRef.current?.() : undefined,
      onReconnect: onReconnectRef.current ? () => onReconnectRef.current?.() : undefined,
      requestEditorClose,
      tryClosePanel,
      closeOtherPanelsInGroup,
      closeAllPanelsInGroup,
      onShellChange: (id: string) => onShellChangeRef.current(id),
      onCloseShell: (id: string) => onCloseShellRef.current(id),
      onCommand: (sid: string, cmd: string) => onCommandRef.current(sid, cmd),
    }),
    [
      handleNewShellInGroup,
      requestEditorClose,
      tryClosePanel,
      closeOtherPanelsInGroup,
      closeAllPanelsInGroup,
      onNewBrowser,
      onReconnect,
    ]
  )

  const runtimeContextValue = useMemo(
    () => ({
      activeShellId,
      shells,
      clearSignals,
    }),
    [activeShellId, shells, clearSignals]
  )

  return (
    <>
    <WorkbenchContext.Provider value={workbenchContextValue}>
      <WorkbenchRuntimeContext.Provider value={runtimeContextValue}>
      <DockviewReact
        key={connectionId}
        className={cn('h-full min-h-0', dockviewTheme)}
        components={components}
        tabComponents={tabComponents}
        rightHeaderActionsComponent={RightHeaderActions}
        onReady={onReady}
        dndStrategy="pointer"
        disableDnd={false}
        watermarkComponent={() => (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
            拖拽标签页到边缘以分屏 · Shell 与文件可自由组合
          </div>
        )}
      />
      </WorkbenchRuntimeContext.Provider>
    </WorkbenchContext.Provider>

    {pendingClose && (
    <AlertDialog open onOpenChange={open => !open && setPendingClose(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>保存更改？</AlertDialogTitle>
          <AlertDialogDescription>
            文件「{pendingFile?.name ?? '未命名'}」有未保存的更改，是否在关闭前保存？
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={handleDiscardAndClose}>不保存</AlertDialogCancel>
          <AlertDialogAction onClick={handleSaveAndClose}>保存</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    )}
    </>
  )
})
