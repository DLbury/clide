'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Server,
  Terminal,
  Container,
  Monitor,
  Search,
  MoreHorizontal,
  Folder,
  FolderPlus,
  Wifi,
  Radio,
  ScreenShare,
  MonitorSmartphone,
  Pencil,
  Trash2,
  Plug,
  Unplug,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { AppLogo } from '@/components/app-logo'
import { APP_NAME, APP_TAGLINE } from '@/lib/app-brand'
import type { Session, SessionFolder } from '@/lib/types'
import { isSidebarVisibleSession } from '@/lib/default-local-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AppConfirmDialog, type AppConfirmDialogState } from '@/components/ui/app-confirm-dialog'

interface SidebarProps {
  folders: SessionFolder[]
  onSessionSelect: (session: Session) => void
  onSessionConnect: (session: Session) => void
  onNewSession: () => void
  onNewSessionInFolder: (folderId: string) => void
  onCreateFolder: (name: string) => void
  onRenameFolder: (folderId: string, name: string) => void
  onDeleteFolder: (folderId: string) => void
  onEditSession: (session: Session) => void
  onDeleteSession: (sessionId: string) => void
  onDisconnectSession: (sessionId: string) => void
  activeSessionId?: string
}

const getSessionIcon = (type: Session['type']) => {
  switch (type) {
    case 'ssh':
      return Server
    case 'telnet':
      return Wifi
    case 'serial':
      return Radio
    case 'docker':
      return Container
    case 'wsl':
      return Monitor
    case 'vnc':
      return ScreenShare
    case 'rdp':
      return MonitorSmartphone
    default:
      return Terminal
  }
}

const getStatusColor = (status: Session['status']) => {
  switch (status) {
    case 'connected':
      return 'bg-terminal-green'
    case 'connecting':
      return 'bg-terminal-yellow'
    default:
      return 'bg-muted-foreground/50'
  }
}

function InlineNameInput({
  value,
  onChange,
  onConfirm,
  onCancel,
  className,
}: {
  value: string
  onChange: (v: string) => void
  onConfirm: () => void
  onCancel: () => void
  className?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const confirmingRef = useRef(false)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const handleConfirm = () => {
    if (confirmingRef.current) return
    confirmingRef.current = true
    onConfirm()
  }

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={e => onChange(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') {
          e.preventDefault()
          handleConfirm()
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
      onBlur={handleConfirm}
      onMouseDown={e => e.stopPropagation()}
      className={cn(
        'flex-1 min-w-0 h-7 px-2 text-sm rounded border border-primary/50',
        'bg-sidebar-accent outline-none focus:ring-1 focus:ring-primary',
        className
      )}
    />
  )
}

function SessionMenuItems({
  session,
  onSessionConnect,
  onEditSession,
  onDeleteSession,
  onDisconnectSession,
  openConfirm,
}: {
  session: Session
  onSessionConnect: (session: Session) => void
  onEditSession: (session: Session) => void
  onDeleteSession: (sessionId: string) => void
  onDisconnectSession: (sessionId: string) => void
  openConfirm: (
    next: Omit<AppConfirmDialogState, 'open'> & { open?: boolean },
    action: () => void
  ) => void
}) {
  const isConnected = session.status === 'connected'

  return (
    <>
      {!isConnected ? (
        <ContextMenuItem onClick={() => onSessionConnect(session)}>
          <Plug className="w-3.5 h-3.5 mr-2" />
          连接
        </ContextMenuItem>
      ) : (
        <ContextMenuItem onClick={() => onDisconnectSession(session.id)}>
          <Unplug className="w-3.5 h-3.5 mr-2" />
          断开连接
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={() => onEditSession(session)}>
        <Pencil className="w-3.5 h-3.5 mr-2" />
        编辑
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        variant="destructive"
        onClick={() => {
          openConfirm(
            {
              title: '删除会话',
              description: `确定删除会话「${session.name}」？此操作不可撤销。`,
              confirmText: '删除',
              destructive: true,
            },
            () => onDeleteSession(session.id)
          )
        }}
      >
        <Trash2 className="w-3.5 h-3.5 mr-2" />
        删除
      </ContextMenuItem>
    </>
  )
}

export function Sidebar({
  folders,
  onSessionSelect,
  onSessionConnect,
  onNewSession,
  onNewSessionInFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onEditSession,
  onDeleteSession,
  onDisconnectSession,
  activeSessionId,
}: SidebarProps) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(folders.map(f => f.id))
  )
  const [searchQuery, setSearchQuery] = useState('')
  const [pendingFolderName, setPendingFolderName] = useState<string | null>(null)
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
  const [renameFolderName, setRenameFolderName] = useState('')
  const prevFolderIdsRef = useRef(new Set(folders.map(f => f.id)))
  const [confirmState, setConfirmState] = useState<AppConfirmDialogState>({
    open: false,
    title: '',
  })
  const confirmActionRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const prev = prevFolderIdsRef.current
    const newIds = folders.filter(f => !prev.has(f.id)).map(f => f.id)
    if (newIds.length) {
      setExpandedFolders(exp => {
        const next = new Set(exp)
        newIds.forEach(id => next.add(id))
        return next
      })
    }
    prevFolderIdsRef.current = new Set(folders.map(f => f.id))
  }, [folders])

  const toggleFolder = (folderId: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }

  const filteredFolders = folders
    .map(folder => ({
      ...folder,
      sessions: folder.sessions.filter(
        session =>
          isSidebarVisibleSession(session) &&
          (session.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            session.host.toLowerCase().includes(searchQuery.toLowerCase()))
      ),
    }))
    .filter(
      folder =>
        searchQuery === '' ||
        folder.sessions.length > 0 ||
        folder.name.toLowerCase().includes(searchQuery.toLowerCase())
    )

  const collapseAllFolders = useCallback(() => {
    setExpandedFolders(new Set())
  }, [])

  const startNewFolder = useCallback(() => {
    setPendingFolderName('新建文件夹')
  }, [])

  const confirmNewFolder = useCallback(() => {
    if (pendingFolderName === null) return
    const name = pendingFolderName.trim()
    if (name) onCreateFolder(name)
    setPendingFolderName(null)
  }, [pendingFolderName, onCreateFolder])

  const startRenameFolder = useCallback((folder: SessionFolder) => {
    setRenamingFolderId(folder.id)
    setRenameFolderName(folder.name)
  }, [])

  const confirmRenameFolder = useCallback(() => {
    if (!renamingFolderId) return
    const name = renameFolderName.trim()
    if (name) onRenameFolder(renamingFolderId, name)
    setRenamingFolderId(null)
  }, [renamingFolderId, renameFolderName, onRenameFolder])

  const openConfirm = useCallback((next: Omit<AppConfirmDialogState, 'open'> & { open?: boolean }, action: () => void) => {
    confirmActionRef.current = action
    setConfirmState({
      open: true,
      title: next.title,
      description: next.description,
      confirmText: next.confirmText,
      destructive: next.destructive,
    })
  }, [])

  return (
    <div className="w-64 h-full bg-sidebar border-r border-sidebar-border flex flex-col">
      <AppConfirmDialog
        state={confirmState}
        onOpenChange={open => setConfirmState(prev => ({ ...prev, open }))}
        onConfirm={() => confirmActionRef.current?.()}
      />
      <div className="p-4 border-b border-sidebar-border">
        <div className="flex items-center gap-2 mb-4">
          <AppLogo size={32} className="rounded-lg" />
          <div>
            <h1 className="text-sm font-semibold text-sidebar-foreground">{APP_NAME}</h1>
            <p className="text-xs text-muted-foreground">{APP_TAGLINE}</p>
          </div>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="搜索会话..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="pl-8 h-8 text-sm bg-sidebar-accent border-sidebar-border"
          />
        </div>
      </div>

      <div className="flex items-center justify-between px-4 py-2 border-b border-sidebar-border">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          服务器
        </span>
        <button
          onClick={startNewFolder}
          className="p-1 hover:bg-sidebar-accent rounded transition-colors"
          title="新建文件夹"
        >
          <FolderPlus className="w-3.5 h-3.5 text-muted-foreground" />
        </button>
      </div>

      <ContextMenu>
        <ContextMenuTrigger asChild>
      <div className="flex-1 overflow-y-auto terminal-scrollbar p-2">
        {filteredFolders.map(folder => (
          <ContextMenu key={folder.id}>
            <ContextMenuTrigger asChild>
              <div className="mb-2">
                {renamingFolderId === folder.id ? (
                  <div className="flex items-center gap-2 px-2 py-1.5">
                    <span className="w-4" />
                    <Folder className="w-4 h-4 flex-shrink-0" />
                    <InlineNameInput
                      value={renameFolderName}
                      onChange={setRenameFolderName}
                      onConfirm={confirmRenameFolder}
                      onCancel={() => setRenamingFolderId(null)}
                    />
                  </div>
                ) : (
                  <button
                    onClick={() => toggleFolder(folder.id)}
                    className="flex items-center gap-2 w-full px-2 py-1.5 text-sm text-muted-foreground hover:text-sidebar-foreground rounded-md hover:bg-sidebar-accent transition-colors"
                  >
                    {expandedFolders.has(folder.id) ? (
                      <ChevronDown className="w-4 h-4" />
                    ) : (
                      <ChevronRight className="w-4 h-4" />
                    )}
                    <Folder className="w-4 h-4" />
                    <span className="flex-1 text-left truncate">{folder.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {folder.sessions.filter(isSidebarVisibleSession).length}
                    </span>
                  </button>
                )}

                {expandedFolders.has(folder.id) && (
                  <div className="ml-4 mt-1 space-y-0.5">
                    {folder.sessions.map(session => {
                      const Icon = getSessionIcon(session.type)
                      const isActive = session.id === activeSessionId

                      const isConnected = session.status === 'connected'

                      return (
                        <ContextMenu key={session.id}>
                          <ContextMenuTrigger asChild>
                            <div
                              onClick={() => isConnected && onSessionSelect(session)}
                              className={cn(
                                'flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-md transition-colors group',
                                isConnected ? 'cursor-pointer' : 'cursor-default',
                                isActive
                                  ? 'bg-primary/10 text-primary'
                                  : 'text-sidebar-foreground hover:bg-sidebar-accent'
                              )}
                            >
                              <div className="relative shrink-0">
                                <Icon className="w-4 h-4" />
                                <div
                                  className={cn(
                                    'absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-sidebar',
                                    getStatusColor(session.status)
                                  )}
                                />
                              </div>
                              <div className="flex-1 text-left min-w-0">
                                <div className="truncate">{session.name}</div>
                                <div className="text-xs text-muted-foreground truncate">
                                  {session.user ? `${session.user}@` : ''}
                                  {session.host}
                                </div>
                              </div>
                              {isConnected ? (
                                <button
                                  type="button"
                                  title="断开连接"
                                  onClick={e => {
                                    e.stopPropagation()
                                    onDisconnectSession(session.id)
                                  }}
                                  className="shrink-0 px-1.5 py-0.5 text-[10px] rounded border border-border text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
                                >
                                  断开
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  title="连接"
                                  onClick={e => {
                                    e.stopPropagation()
                                    onSessionConnect(session)
                                  }}
                                  className="shrink-0 px-1.5 py-0.5 text-[10px] rounded border border-primary/40 text-primary bg-primary/5 hover:bg-primary/15 transition-colors"
                                >
                                  连接
                                </button>
                              )}
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <button
                                    type="button"
                                    onClick={e => e.stopPropagation()}
                                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-sidebar-accent rounded transition-opacity shrink-0"
                                  >
                                    <MoreHorizontal className="w-3 h-3" />
                                  </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-44">
                                  {!isConnected ? (
                                    <DropdownMenuItem onClick={() => onSessionConnect(session)}>
                                      连接
                                    </DropdownMenuItem>
                                  ) : (
                                    <DropdownMenuItem onClick={() => onDisconnectSession(session.id)}>
                                      断开连接
                                    </DropdownMenuItem>
                                  )}
                                  <DropdownMenuItem onClick={() => onEditSession(session)}>
                                    编辑
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    className="text-destructive"
                                    onClick={() => {
                                      openConfirm(
                                        {
                                          title: '删除会话',
                                          description: `确定删除会话「${session.name}」？此操作不可撤销。`,
                                          confirmText: '删除',
                                          destructive: true,
                                        },
                                        () => onDeleteSession(session.id)
                                      )
                                    }}
                                  >
                                    删除
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </ContextMenuTrigger>
                          <ContextMenuContent className="w-44">
                            <SessionMenuItems
                              session={session}
                              onSessionConnect={onSessionConnect}
                              onEditSession={onEditSession}
                              onDeleteSession={onDeleteSession}
                              onDisconnectSession={onDisconnectSession}
                              openConfirm={openConfirm}
                            />
                          </ContextMenuContent>
                        </ContextMenu>
                      )
                    })}
                  </div>
                )}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-48">
              <ContextMenuItem onClick={() => onNewSessionInFolder(folder.id)}>
                <Plus className="w-3.5 h-3.5 mr-2" />
                新建会话
              </ContextMenuItem>
              <ContextMenuItem onClick={startNewFolder}>
                <FolderPlus className="w-3.5 h-3.5 mr-2" />
                新建文件夹
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => startRenameFolder(folder)}>
                <Pencil className="w-3.5 h-3.5 mr-2" />
                重命名
              </ContextMenuItem>
              <ContextMenuItem onClick={() => toggleFolder(folder.id)}>
                {expandedFolders.has(folder.id) ? '折叠' : '展开'}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                variant="destructive"
                onClick={() => {
                  const msg =
                    folder.sessions.length > 0
                      ? `文件夹「${folder.name}」内有 ${folder.sessions.length} 个会话，确定删除？`
                      : `确定删除文件夹「${folder.name}」？`
                  openConfirm(
                    {
                      title: '删除文件夹',
                      description: msg,
                      confirmText: '删除',
                      destructive: true,
                    },
                    () => onDeleteFolder(folder.id)
                  )
                }}
              >
                <Trash2 className="w-3.5 h-3.5 mr-2" />
                删除
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}

        {folders.length === 0 && searchQuery === '' && pendingFolderName === null && (
          <div className="px-3 py-8 text-center">
            <Server className="w-10 h-10 mx-auto mb-3 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">暂无会话</p>
            <p className="text-xs text-muted-foreground/70 mt-1 leading-relaxed">
              点击下方「新建会话」录入真实的主机、端口与认证信息，数据会保存在本机。
            </p>
          </div>
        )}

        {pendingFolderName !== null && (
          <div className="flex items-center gap-2 px-2 py-1.5 mb-1">
            <span className="w-4" />
            <Folder className="w-4 h-4 text-primary/80 flex-shrink-0" />
            <InlineNameInput
              value={pendingFolderName}
              onChange={setPendingFolderName}
              onConfirm={confirmNewFolder}
              onCancel={() => setPendingFolderName(null)}
            />
          </div>
        )}
      </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          <ContextMenuItem onClick={onNewSession}>
            <Plus className="w-3.5 h-3.5 mr-2" />
            新建会话
          </ContextMenuItem>
          <ContextMenuItem onClick={startNewFolder}>
            <FolderPlus className="w-3.5 h-3.5 mr-2" />
            新建文件夹
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={collapseAllFolders}>全部折叠</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <div className="p-3 border-t border-sidebar-border">
        <Button
          onClick={onNewSession}
          className="w-full h-9 text-sm bg-primary/10 text-primary hover:bg-primary/30 hover:text-primary border border-primary/25"
          variant="outline"
        >
          <Plus className="w-4 h-4 mr-2" />
          新建会话
        </Button>
      </div>
    </div>
  )
}
