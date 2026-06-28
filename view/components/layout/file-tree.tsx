'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FileText,
  FileCode,
  FileJson,
  File,
  RefreshCw,
  ChevronsUpDown,
  FolderPlus,
  ArrowUp,
  CornerDownLeft,
  Link2,
  Upload,
  Download,
  Loader2,
  Shield,
  Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FileItem } from '@/lib/types'
import { getParentPath } from '@/lib/file-utils'
import {
  getRemoteParentPath,
  normalizeRemotePathInput,
  resolveRemoteDisplayPath,
} from '@/lib/remote-file-tree'
import {
  EMPTY_FILE_TREE,
  toggleDirectoryExpanded,
  setAllExpanded,
  setDirectoryExpanded,
  createDirectory,
  createFile,
  cloneFileTree,
  findFileItem,
  findFileItemById,
  renameFileItem,
} from '@/lib/file-system'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Progress } from '@/components/ui/progress'
import {
  REMOTE_DRAG_TYPE,
  getRemoteDragPath,
  isOsFileDrag,
  isRemotePathDrag,
} from '@/lib/file-drag'
import {
  uploadOverallPercent,
  type UploadProgress,
} from '@/lib/remote-file-transfer'

interface FileTreeProps {
  files?: FileItem[]
  currentPath?: string
  remoteMode?: boolean
  remoteUser?: string
  selectedPath?: string | null
  onFileOpen: (file: FileItem) => void
  onFileSelect?: (file: FileItem) => void
  onNavigate?: (path: string) => void
  onDirectoryExpand?: (item: FileItem) => void
  onRefresh?: () => void
  followTerminalCwd?: boolean
  onFollowTerminalCwdChange?: (enabled: boolean) => void
  terminalCwd?: string | null
  onUpload?: (files: FileList) => void
  onMove?: (sourcePath: string, destDir: string) => void
  onDownload?: (file: FileItem) => void
  onDelete?: (file: FileItem) => void
  onRename?: (item: FileItem, newName: string) => void | Promise<void>
  onOpenInTerminal?: (path: string, isDirectory: boolean) => void
  onCreateRemoteFile?: (dirPath: string, fileName: string) => void | Promise<void>
  transferBusy?: boolean
  uploadProgress?: UploadProgress | null
  fileRootMode?: boolean
  onFileRootModeChange?: (enabled: boolean) => void
}

interface PendingFolder {
  parentId: string
  parentPath: string
  name: string
}

interface PendingRename {
  itemId: string
  name: string
}

function RemotePathBar({
  currentPath,
  remoteUser,
  onNavigate,
}: {
  currentPath: string
  remoteUser?: string
  onNavigate: (path: string) => void
}) {
  const displayPath = resolveRemoteDisplayPath(currentPath, remoteUser)
  const [draft, setDraft] = useState(displayPath)

  useEffect(() => {
    setDraft(resolveRemoteDisplayPath(currentPath, remoteUser))
  }, [currentPath, remoteUser])

  const go = () => {
    onNavigate(normalizeRemotePathInput(draft, remoteUser))
  }

  const goUp = () => {
    const parent = getRemoteParentPath(currentPath, remoteUser)
    if (parent) onNavigate(parent)
  }

  const segments = displayPath.split('/').filter(Boolean)

  return (
    <div className="border-b border-border px-2 py-1.5 space-y-1.5 shrink-0">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={goUp}
          disabled={!getRemoteParentPath(currentPath, remoteUser)}
          className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:pointer-events-none"
          title="上级目录"
        >
          <ArrowUp className="w-3.5 h-3.5 text-muted-foreground" />
        </button>
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              go()
            }
          }}
          className="flex-1 min-w-0 h-7 px-2 text-xs font-mono rounded border border-border bg-background outline-none focus:ring-1 focus:ring-primary"
          spellCheck={false}
          aria-label="远程路径"
        />
        <button
          type="button"
          onClick={go}
          className="p-1 rounded hover:bg-muted"
          title="转到"
        >
          <CornerDownLeft className="w-3.5 h-3.5 text-muted-foreground" />
        </button>
      </div>
      <div className="flex items-center flex-wrap gap-0.5 text-[11px] font-mono text-muted-foreground px-0.5">
        <button
          type="button"
          className="hover:text-foreground hover:underline"
          onClick={() => onNavigate('~')}
        >
          ~
        </button>
        {segments.map((seg, index) => {
          const path = `/${segments.slice(0, index + 1).join('/')}`
          return (
            <span key={path} className="flex items-center gap-0.5">
              <span>/</span>
              <button
                type="button"
                className="hover:text-foreground hover:underline truncate max-w-[80px]"
                onClick={() => onNavigate(path)}
                title={seg}
              >
                {seg}
              </button>
            </span>
          )
        })}
      </div>
    </div>
  )
}

function resolveParentDirectory(
  items: FileItem[],
  selectedPath: string | null | undefined
): FileItem | null {
  if (selectedPath) {
    const selected = findFileItem(items, selectedPath)
    if (selected?.type === 'directory') return selected
    const parent = findFileItem(items, getParentPath(selectedPath))
    if (parent?.type === 'directory') return parent
  }
  return (
    findFileItem(items, '/home') ??
    items.find(item => item.type === 'directory') ??
    null
  )
}

function getFileIcon(name: string, isDirectory: boolean, isExpanded: boolean) {
  if (isDirectory) {
    return isExpanded ? FolderOpen : Folder
  }

  const ext = name.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
      return FileCode
    case 'json':
      return FileJson
    case 'md':
    case 'txt':
      return FileText
    default:
      return File
  }
}

function NewFolderInput({
  depth,
  name,
  onChange,
  onConfirm,
  onCancel,
  icon: IconComponent = Folder,
}: {
  depth: number
  name: string
  onChange: (name: string) => void
  onConfirm: () => void
  onCancel: () => void
  icon?: typeof Folder
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
    <div
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      className="flex items-center gap-1 py-0.5 px-2"
      onMouseDown={e => e.stopPropagation()}
    >
      <span className="w-3.5" />
      <IconComponent className="w-4 h-4 flex-shrink-0 text-primary/80" />
      <input
        ref={inputRef}
        value={name}
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
        className={cn(
          'flex-1 min-w-0 h-6 px-1.5 text-sm rounded border border-primary/50',
          'bg-background outline-none focus:ring-1 focus:ring-primary'
        )}
      />
    </div>
  )
}

function FileTreeItem({
  item,
  depth,
  selectedPath,
  pendingFolder,
  pendingRename,
  remoteMode,
  onFileOpen,
  onFileSelect,
  onToggle,
  onNavigate,
  onStartNewFolder,
  onStartNewFile,
  onCopyPath,
  onPendingFolderChange,
  onConfirmNewFolder,
  onCancelNewFolder,
  onDownload,
  onDelete,
  onMove,
  onRename,
  onOpenInTerminal,
  onStartRename,
  onRenameChange,
  onConfirmRename,
  onCancelRename,
  transferBusy,
  onRemoteDragEnd,
}: {
  item: FileItem
  depth: number
  selectedPath?: string | null
  pendingFolder: PendingFolder | null
  pendingRename: PendingRename | null
  remoteMode?: boolean
  onFileOpen: (file: FileItem) => void
  onFileSelect?: (file: FileItem) => void
  onToggle: (id: string) => void
  onNavigate?: (path: string) => void
  onStartNewFolder: (parent: FileItem) => void
  onStartNewFile: (parent: FileItem) => void
  onCopyPath: (path: string) => void
  onPendingFolderChange: (name: string) => void
  onConfirmNewFolder: () => void
  onCancelNewFolder: () => void
  onDownload?: (file: FileItem) => void
  onDelete?: (file: FileItem) => void
  onMove?: (sourcePath: string, destDir: string) => void
  onRename?: (item: FileItem, newName: string) => void | Promise<void>
  onOpenInTerminal?: (path: string, isDirectory: boolean) => void
  onStartRename: (item: FileItem) => void
  onRenameChange: (name: string) => void
  onConfirmRename: () => void
  onCancelRename: () => void
  transferBusy?: boolean
  onRemoteDragEnd?: () => void
}) {
  const Icon = getFileIcon(item.name, item.type === 'directory', item.isExpanded || false)
  const isDirectory = item.type === 'directory'
  const isSelected = selectedPath === item.path
  const showNewFolderInput = pendingFolder?.parentId === item.id
  const showRenameInput = pendingRename?.itemId === item.id
  const childCount = item.children?.length ?? 0
  const [isDropTarget, setIsDropTarget] = useState(false)
  const canDragRemote = remoteMode && !!onMove && !transferBusy

  const handleClick = () => {
    if (isDirectory) {
      onFileSelect?.(item)
      onToggle(item.id)
    } else {
      onFileSelect?.(item)
      onFileOpen(item)
    }
  }

  const handleDoubleClick = () => {
    if (isDirectory && remoteMode && onNavigate) {
      onNavigate(item.path)
    } else if (isDirectory) {
      onToggle(item.id)
    }
  }

  const handleDragStart = (e: React.DragEvent) => {
    if (!canDragRemote) return
    e.dataTransfer.setData(REMOTE_DRAG_TYPE, item.path)
    e.dataTransfer.effectAllowed = 'move'
    e.stopPropagation()
    window.getSelection()?.removeAllRanges()
    document.body.classList.add('file-tree-dragging')
  }

  const handleFolderDragOver = (e: React.DragEvent) => {
    if (!canDragRemote || !isDirectory || !isRemotePathDrag(e)) return
    const source = getRemoteDragPath(e)
    if (!source || source === item.path || source.startsWith(`${item.path}/`)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setIsDropTarget(true)
  }

  const handleFolderDragLeave = (e: React.DragEvent) => {
    e.stopPropagation()
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDropTarget(false)
    }
  }

  const handleFolderDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDropTarget(false)
    if (!canDragRemote || !isDirectory || !onMove) return
    const source = getRemoteDragPath(e)
    if (!source || source === item.path || source.startsWith(`${item.path}/`)) return
    onMove(source, item.path)
  }

  const handleDragEnd = () => {
    setIsDropTarget(false)
    document.body.classList.remove('file-tree-dragging')
    window.getSelection()?.removeAllRanges()
    onRemoteDragEnd?.()
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>
          {showRenameInput && pendingRename ? (
            <NewFolderInput
              depth={depth}
              name={pendingRename.name}
              icon={Icon}
              onChange={onRenameChange}
              onConfirm={onConfirmRename}
              onCancel={onCancelRename}
            />
          ) : (
          <div
            draggable={canDragRemote}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragOver={isDirectory ? handleFolderDragOver : undefined}
            onDragLeave={isDirectory ? handleFolderDragLeave : undefined}
            onDrop={isDirectory ? handleFolderDrop : undefined}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
            className={cn(
              'flex items-center gap-1 py-0.5 px-2 cursor-pointer text-sm select-none',
              'hover:bg-muted/50 transition-colors',
              isSelected && 'bg-primary/10 text-primary',
              isDropTarget && 'bg-primary/20 ring-1 ring-primary/40 ring-inset'
            )}
          >
            {isDirectory ? (
              item.isExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
              )
            ) : (
              <span className="w-3.5" />
            )}
            <Icon
              className={cn(
                'w-4 h-4 flex-shrink-0',
                isDirectory ? 'text-primary/80' : 'text-muted-foreground'
              )}
            />
            <span className="truncate">{item.name}</span>
          </div>
          )}

          {!showRenameInput && isDirectory && item.isExpanded && (
            <div>
              {childCount === 0 && remoteMode ? (
                <div
                  style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
                  className="py-1 text-xs text-muted-foreground italic"
                >
                  加载中…
                </div>
              ) : (
                item.children?.map(child => (
                  <FileTreeItem
                    key={child.id}
                    item={child}
                    depth={depth + 1}
                    selectedPath={selectedPath}
                    pendingFolder={pendingFolder}
                    pendingRename={pendingRename}
                    remoteMode={remoteMode}
                    onFileOpen={onFileOpen}
                    onFileSelect={onFileSelect}
                    onToggle={onToggle}
                    onNavigate={onNavigate}
                    onStartNewFolder={onStartNewFolder}
                    onStartNewFile={onStartNewFile}
                    onCopyPath={onCopyPath}
                    onPendingFolderChange={onPendingFolderChange}
                    onConfirmNewFolder={onConfirmNewFolder}
                    onCancelNewFolder={onCancelNewFolder}
                    onDownload={onDownload}
                    onDelete={onDelete}
                    onMove={onMove}
                    onRename={onRename}
                    onOpenInTerminal={onOpenInTerminal}
                    onStartRename={onStartRename}
                    onRenameChange={onRenameChange}
                    onConfirmRename={onConfirmRename}
                    onCancelRename={onCancelRename}
                    transferBusy={transferBusy}
                    onRemoteDragEnd={onRemoteDragEnd}
                  />
                ))
              )}
              {showNewFolderInput && pendingFolder && (
                <NewFolderInput
                  depth={depth + 1}
                  name={pendingFolder.name}
                  onChange={onPendingFolderChange}
                  onConfirm={onConfirmNewFolder}
                  onCancel={onCancelNewFolder}
                />
              )}
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        {!isDirectory && (
          <>
            <ContextMenuItem onClick={() => onFileOpen(item)}>打开</ContextMenuItem>
            <ContextMenuItem onClick={() => onCopyPath(item.path)}>复制路径</ContextMenuItem>
            {(!remoteMode || onRename) && (
              <ContextMenuItem disabled={transferBusy} onClick={() => onStartRename(item)}>
                重命名
              </ContextMenuItem>
            )}
            {remoteMode && onOpenInTerminal && (
              <ContextMenuItem onClick={() => onOpenInTerminal(item.path, false)}>
                在终端打开此处
              </ContextMenuItem>
            )}
            {remoteMode && onDownload && (
              <ContextMenuItem onClick={() => onDownload(item)}>下载</ContextMenuItem>
            )}
            {remoteMode && onDelete && (
              <ContextMenuItem
                disabled={transferBusy}
                className="text-destructive focus:text-destructive"
                onClick={() => onDelete(item)}
              >
                <Trash2 className="w-3.5 h-3.5 mr-2" />
                删除
              </ContextMenuItem>
            )}
          </>
        )}
        {isDirectory && (
          <>
            {remoteMode && onNavigate && (
              <ContextMenuItem onClick={() => onNavigate(item.path)}>进入文件夹</ContextMenuItem>
            )}
            {!remoteMode && (
              <>
                <ContextMenuItem onClick={() => onStartNewFile(item)}>新建文件</ContextMenuItem>
                <ContextMenuItem onClick={() => onStartNewFolder(item)}>新建文件夹</ContextMenuItem>
              </>
            )}
            {(!remoteMode || onRename) && (
              <ContextMenuItem disabled={transferBusy} onClick={() => onStartRename(item)}>
                重命名
              </ContextMenuItem>
            )}
            {remoteMode && onOpenInTerminal && (
              <ContextMenuItem onClick={() => onOpenInTerminal(item.path, true)}>
                在终端打开此处
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onCopyPath(item.path)}>复制路径</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onToggle(item.id)}>
              {item.isExpanded ? '折叠' : '展开'}
            </ContextMenuItem>
            {remoteMode && onDelete && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem
                  disabled={transferBusy}
                  className="text-destructive focus:text-destructive"
                  onClick={() => onDelete(item)}
                >
                  <Trash2 className="w-3.5 h-3.5 mr-2" />
                  删除
                </ContextMenuItem>
              </>
            )}
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function FileTree({
  files: externalFiles,
  currentPath,
  remoteMode = false,
  remoteUser,
  selectedPath,
  onFileOpen,
  onFileSelect,
  onNavigate,
  onDirectoryExpand,
  onRefresh,
  followTerminalCwd = false,
  onFollowTerminalCwdChange,
  terminalCwd,
  onUpload,
  onMove,
  onDownload,
  onDelete,
  onRename,
  onOpenInTerminal,
  onCreateRemoteFile,
  transferBusy = false,
  uploadProgress = null,
  fileRootMode = false,
  onFileRootModeChange,
}: FileTreeProps) {
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const [dropMode, setDropMode] = useState<'upload' | 'move' | null>(null)
  const resetDropMode = useCallback(() => {
    setDropMode(null)
  }, [])

  useEffect(() => {
    const onDragEnd = () => {
      document.body.classList.remove('file-tree-dragging')
      window.getSelection()?.removeAllRanges()
      resetDropMode()
    }
    document.addEventListener('dragend', onDragEnd)
    return () => document.removeEventListener('dragend', onDragEnd)
  }, [resetDropMode])

  const [files, setFiles] = useState<FileItem[]>(() =>
    externalFiles ? cloneFileTree(externalFiles) : cloneFileTree(EMPTY_FILE_TREE)
  )
  const [pendingFolder, setPendingFolder] = useState<PendingFolder | null>(null)
  const [pendingRename, setPendingRename] = useState<PendingRename | null>(null)
  const renameTargetRef = useRef<FileItem | null>(null)
  const filesFingerprint = externalFiles?.map(f => `${f.path}:${f.isExpanded}:${f.children?.length ?? 0}`).join('|')

  useEffect(() => {
    if (remoteMode || externalFiles !== undefined) {
      setFiles(cloneFileTree(externalFiles ?? []))
      setPendingFolder(null)
      setPendingRename(null)
    }
  }, [externalFiles, filesFingerprint, remoteMode])

  const handleToggle = useCallback(
    (id: string) => {
      setFiles(prev => {
        const item = findFileItemById(prev, id)
        if (
          remoteMode &&
          item?.type === 'directory' &&
          !item.isExpanded &&
          (!item.children || item.children.length === 0)
        ) {
          onDirectoryExpand?.(item)
        }
        return toggleDirectoryExpanded(prev, id)
      })
    },
    [remoteMode, onDirectoryExpand]
  )

  const handleRefresh = useCallback(() => {
    setPendingFolder(null)
    setPendingRename(null)
    setFiles(cloneFileTree(externalFiles ?? EMPTY_FILE_TREE))
    onRefresh?.()
  }, [externalFiles, onRefresh])

  const startRename = useCallback((item: FileItem) => {
    renameTargetRef.current = item
    setPendingRename({ itemId: item.id, name: item.name })
  }, [])

  const confirmRename = useCallback(() => {
    const target = renameTargetRef.current
    if (!target || !pendingRename) return
    const newName = pendingRename.name.trim()
    if (!newName || newName === target.name) {
      setPendingRename(null)
      renameTargetRef.current = null
      return
    }
    if (remoteMode && onRename) {
      void Promise.resolve(onRename(target, newName)).finally(() => {
        setPendingRename(null)
        renameTargetRef.current = null
      })
      return
    }
    if (!remoteMode) {
      setFiles(prev => renameFileItem(prev, target.path, newName))
    }
    setPendingRename(null)
    renameTargetRef.current = null
  }, [pendingRename, remoteMode, onRename])

  const cancelRename = useCallback(() => {
    setPendingRename(null)
    renameTargetRef.current = null
  }, [])

  const handleCreateRemoteFile = useCallback(() => {
    if (!remoteMode || !onCreateRemoteFile) return
    const dir = currentPath || '/'
    void onCreateRemoteFile(dir, '新建文件.txt')
  }, [remoteMode, onCreateRemoteFile, currentPath])

  const copyCurrentPath = useCallback(() => {
    if (!currentPath) return
    navigator.clipboard.writeText(currentPath).catch(() => {})
  }, [currentPath])

  const handleCollapseAll = useCallback(() => {
    setFiles(prev => setAllExpanded(prev, false))
  }, [])

  const startNewFolder = useCallback((parent: FileItem) => {
    setFiles(prev => setDirectoryExpanded(prev, parent.id, true))
    setPendingFolder({
      parentId: parent.id,
      parentPath: parent.path,
      name: '新建文件夹',
    })
  }, [])

  const handleNewFolderClick = useCallback(() => {
    const parent = resolveParentDirectory(files, selectedPath)
    if (parent) startNewFolder(parent)
  }, [files, selectedPath, startNewFolder])

  const confirmNewFolder = useCallback(() => {
    if (!pendingFolder) return
    const name = pendingFolder.name.trim()
    if (name) {
      setFiles(prev => createDirectory(prev, pendingFolder.parentPath, name))
    }
    setPendingFolder(null)
  }, [pendingFolder])

  const cancelNewFolder = useCallback(() => {
    setPendingFolder(null)
  }, [])

  const startNewFile = useCallback(
    (parent: FileItem) => {
      setFiles(prev => {
        const next = setDirectoryExpanded(prev, parent.id, true)
        const updated = createFile(next, parent.path, '新建文件.txt', '')
        const created = findFileItem(updated, parent.path)?.children?.slice(-1)[0]
        if (created?.type === 'file') {
          setTimeout(() => onFileOpen(created), 0)
        }
        return updated
      })
    },
    [onFileOpen]
  )

  const copyPath = useCallback((path: string) => {
    navigator.clipboard.writeText(path).catch(() => {})
  }, [])

  const uploadFiles = useCallback(
    (fileList: FileList) => {
      if (!onUpload || transferBusy || fileList.length === 0) return
      onUpload(fileList)
    },
    [onUpload, transferBusy]
  )

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (!remoteMode) return
      if (isRemotePathDrag(e) && onMove && !transferBusy) {
        e.preventDefault()
        setDropMode('move')
        return
      }
      if (isOsFileDrag(e) && onUpload && !transferBusy) {
        e.preventDefault()
        setDropMode('upload')
      }
    },
    [remoteMode, onMove, onUpload, transferBusy]
  )

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropMode(null)
    }
  }, [])

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!remoteMode) return
      if (isRemotePathDrag(e) && onMove && !transferBusy) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        return
      }
      if (isOsFileDrag(e) && onUpload && !transferBusy) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }
    },
    [remoteMode, onMove, onUpload, transferBusy]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      resetDropMode()
      if (!remoteMode || transferBusy) return

      if (isRemotePathDrag(e) && onMove) {
        const source = getRemoteDragPath(e)
        const dest = currentPath
        if (source && dest && source !== dest && !source.startsWith(`${dest}/`)) {
          onMove(source, dest)
        }
        return
      }

      if (onUpload && isOsFileDrag(e) && e.dataTransfer.files.length > 0) {
        uploadFiles(e.dataTransfer.files)
      }
    },
    [remoteMode, onMove, onUpload, transferBusy, currentPath, uploadFiles, resetDropMode]
  )

  const handleDropCapture = useCallback(
    (e: React.DragEvent) => {
      if (!remoteMode) return
      resetDropMode()
      if (isRemotePathDrag(e) || isOsFileDrag(e)) {
        e.preventDefault()
      }
    },
    [remoteMode, resetDropMode]
  )

  return (
    <div
      className="h-full flex flex-col bg-card min-w-0 w-full select-none"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDropCapture={handleDropCapture}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          文件
        </span>
        <div className="flex items-center gap-0.5">
          {remoteMode && onFileRootModeChange && (
            <button
              type="button"
              onClick={() => onFileRootModeChange(!fileRootMode)}
              className={cn(
                'p-1 rounded transition-colors',
                fileRootMode
                  ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400'
                  : 'hover:bg-muted text-muted-foreground'
              )}
              title={
                fileRootMode
                  ? '已开启：文件管理使用 root (sudo)'
                  : '以 root 权限浏览/读写文件 (sudo)'
              }
            >
              <Shield className="w-3.5 h-3.5" />
            </button>
          )}
          {remoteMode && onFollowTerminalCwdChange && (
            <button
              type="button"
              onClick={() => onFollowTerminalCwdChange(!followTerminalCwd)}
              className={cn(
                'p-1 rounded transition-colors',
                followTerminalCwd
                  ? 'bg-primary/15 text-primary'
                  : 'hover:bg-muted text-muted-foreground'
              )}
              title={
                followTerminalCwd
                  ? '已开启：跟随 Shell 当前目录'
                  : '跟随 Shell 当前目录'
              }
            >
              <Link2 className="w-3.5 h-3.5" />
            </button>
          )}
          {remoteMode && onUpload && (
            <>
              <input
                ref={uploadInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={e => {
                  if (e.target.files?.length) uploadFiles(e.target.files)
                  e.target.value = ''
                }}
              />
              <button
                type="button"
                onClick={() => uploadInputRef.current?.click()}
                disabled={transferBusy}
                className="p-1 hover:bg-muted rounded transition-colors disabled:opacity-40"
                title="上传 / 拖拽文件到列表"
              >
                {transferBusy ? (
                  <Loader2 className="w-3.5 h-3.5 text-muted-foreground animate-spin" />
                ) : (
                  <Upload className="w-3.5 h-3.5 text-muted-foreground" />
                )}
              </button>
            </>
          )}
          {!remoteMode && (
            <button
              onClick={handleNewFolderClick}
              className="p-1 hover:bg-muted rounded transition-colors"
              title="新建文件夹"
            >
              <FolderPlus className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          )}
          <button
            onClick={handleCollapseAll}
            className="p-1 hover:bg-muted rounded transition-colors"
            title="全部折叠"
          >
            <ChevronsUpDown className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
          <button
            onClick={handleRefresh}
            className="p-1 hover:bg-muted rounded transition-colors"
            title="刷新"
          >
            <RefreshCw className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
        </div>
      </div>

      {remoteMode && currentPath && onNavigate && (
        <>
          <RemotePathBar
            currentPath={currentPath}
            remoteUser={remoteUser}
            onNavigate={onNavigate}
          />
          {(followTerminalCwd && terminalCwd) || fileRootMode ? (
            <div className="px-3 py-1 text-[10px] text-muted-foreground border-b border-border space-y-0.5 font-mono truncate">
              {fileRootMode && (
                <p className="text-amber-600 dark:text-amber-400">root 模式 (sudo)</p>
              )}
              {followTerminalCwd && terminalCwd && <p>Shell: {terminalCwd}</p>}
            </div>
          ) : null}
        </>
      )}

      {uploadProgress && (
        <div className="px-3 py-2 border-b border-border space-y-1.5 shrink-0">
          <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
            <span className="truncate">
              {uploadProgress.phase === 'reading' ? '读取' : '上传'}:{' '}
              {uploadProgress.fileName}
            </span>
            <span className="shrink-0 tabular-nums">
              {uploadProgress.fileIndex + 1}/{uploadProgress.fileCount}
            </span>
          </div>
          <Progress value={uploadOverallPercent(uploadProgress)} className="h-1.5" />
        </div>
      )}

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              'flex-1 overflow-auto terminal-scrollbar py-1 min-h-0 relative',
              dropMode === 'upload' &&
                'outline outline-2 outline-dashed outline-primary/60 outline-offset-[-2px] bg-primary/5',
              dropMode === 'move' &&
                'outline outline-2 outline-dashed outline-amber-500/60 outline-offset-[-2px] bg-amber-500/5'
            )}
          >
            {dropMode === 'upload' && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-primary/10">
                <p className="text-xs font-medium text-primary px-3 py-1.5 rounded-md bg-background/90 border border-primary/30">
                  松开以上传到当前目录
                </p>
              </div>
            )}
            {dropMode === 'move' && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-amber-500/10">
                <p className="text-xs font-medium text-amber-700 dark:text-amber-300 px-3 py-1.5 rounded-md bg-background/90 border border-amber-500/30">
                  松开以移动到当前目录
                </p>
              </div>
            )}
            {files.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-muted-foreground space-y-1.5">
                <p>暂无远程文件</p>
                <p className="text-muted-foreground/70">
                  {remoteMode && onUpload
                    ? '连接 SSH 后显示目录；拖入本地文件上传，拖入远程项可移动'
                    : '连接 SSH 后显示远程目录'}
                </p>
              </div>
            ) : (
              files.map(item => (
                <FileTreeItem
                  key={item.id}
                  item={item}
                  depth={0}
                  selectedPath={selectedPath}
                  pendingFolder={pendingFolder}
                  pendingRename={pendingRename}
                  remoteMode={remoteMode}
                  onFileOpen={onFileOpen}
                  onFileSelect={onFileSelect}
                  onToggle={handleToggle}
                  onNavigate={onNavigate}
                  onStartNewFolder={startNewFolder}
                  onStartNewFile={startNewFile}
                  onCopyPath={copyPath}
                  onPendingFolderChange={name =>
                    setPendingFolder(prev => (prev ? { ...prev, name } : null))
                  }
                  onConfirmNewFolder={confirmNewFolder}
                  onCancelNewFolder={cancelNewFolder}
                  onDownload={onDownload}
                  onDelete={onDelete}
                  onMove={onMove}
                  onRename={onRename}
                  onOpenInTerminal={onOpenInTerminal}
                  onStartRename={startRename}
                  onRenameChange={name =>
                    setPendingRename(prev => (prev ? { ...prev, name } : null))
                  }
                  onConfirmRename={confirmRename}
                  onCancelRename={cancelRename}
                  transferBusy={transferBusy}
                  onRemoteDragEnd={resetDropMode}
                />
              ))
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          {remoteMode && onUpload && (
            <ContextMenuItem
              disabled={transferBusy}
              onClick={() => uploadInputRef.current?.click()}
            >
              上传到当前目录
            </ContextMenuItem>
          )}
          {remoteMode && onCreateRemoteFile && (
            <ContextMenuItem disabled={transferBusy} onClick={handleCreateRemoteFile}>
              新建文件
            </ContextMenuItem>
          )}
          {!remoteMode && (
            <ContextMenuItem onClick={handleNewFolderClick}>新建文件夹</ContextMenuItem>
          )}
          {remoteMode && currentPath && (
            <ContextMenuItem onClick={copyCurrentPath}>复制当前路径</ContextMenuItem>
          )}
          <ContextMenuItem onClick={handleCollapseAll}>全部折叠</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={handleRefresh}>刷新</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}
