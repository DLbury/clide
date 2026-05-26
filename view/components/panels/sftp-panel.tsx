'use client'

import { useState, useMemo } from 'react'
import { 
  ChevronRight, 
  ChevronDown, 
  Folder, 
  File, 
  Upload, 
  Download, 
  RefreshCw,
  Trash2,
  FilePlus,
  FolderPlus,
  Home,
  ArrowUp
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FileItem } from '@/lib/types'

interface SftpPanelProps {
  sessionId: string
  onFileOpen: (file: FileItem) => void
}

// Mock file data
const mockFiles: FileItem[] = [
  {
    id: '1',
    name: 'home',
    path: '/home',
    type: 'directory',
    permissions: 'drwxr-xr-x',
    owner: 'dev',
    children: [
      {
        id: '1-1',
        name: 'dev',
        path: '/home/dev',
        type: 'directory',
        permissions: 'drwxr-xr-x',
        owner: 'dev',
        children: [
          { id: '1-1-1', name: '.bashrc', path: '/home/dev/.bashrc', type: 'file', size: 3526, permissions: '-rw-r--r--', owner: 'dev', modified: new Date() },
          { id: '1-1-2', name: '.profile', path: '/home/dev/.profile', type: 'file', size: 807, permissions: '-rw-r--r--', owner: 'dev', modified: new Date() },
          { id: '1-1-3', name: 'projects', path: '/home/dev/projects', type: 'directory', permissions: 'drwxr-xr-x', owner: 'dev', children: [
            { id: '1-1-3-1', name: 'app', path: '/home/dev/projects/app', type: 'directory', permissions: 'drwxr-xr-x', owner: 'dev', children: [
              { id: '1-1-3-1-1', name: 'package.json', path: '/home/dev/projects/app/package.json', type: 'file', size: 1024, permissions: '-rw-r--r--', owner: 'dev', modified: new Date() },
              { id: '1-1-3-1-2', name: 'index.ts', path: '/home/dev/projects/app/index.ts', type: 'file', size: 2048, permissions: '-rw-r--r--', owner: 'dev', modified: new Date() },
            ]},
          ]},
          { id: '1-1-4', name: 'documents', path: '/home/dev/documents', type: 'directory', permissions: 'drwxr-xr-x', owner: 'dev', children: [] },
        ]
      }
    ]
  },
  {
    id: '2',
    name: 'etc',
    path: '/etc',
    type: 'directory',
    permissions: 'drwxr-xr-x',
    owner: 'root',
    children: [
      { id: '2-1', name: 'hosts', path: '/etc/hosts', type: 'file', size: 221, permissions: '-rw-r--r--', owner: 'root', modified: new Date() },
      { id: '2-2', name: 'passwd', path: '/etc/passwd', type: 'file', size: 2645, permissions: '-rw-r--r--', owner: 'root', modified: new Date() },
      { id: '2-3', name: 'nginx', path: '/etc/nginx', type: 'directory', permissions: 'drwxr-xr-x', owner: 'root', children: [
        { id: '2-3-1', name: 'nginx.conf', path: '/etc/nginx/nginx.conf', type: 'file', size: 2656, permissions: '-rw-r--r--', owner: 'root', modified: new Date() },
      ]},
    ]
  },
  {
    id: '3',
    name: 'var',
    path: '/var',
    type: 'directory',
    permissions: 'drwxr-xr-x',
    owner: 'root',
    children: [
      { id: '3-1', name: 'log', path: '/var/log', type: 'directory', permissions: 'drwxr-xr-x', owner: 'root', children: [
        { id: '3-1-1', name: 'syslog', path: '/var/log/syslog', type: 'file', size: 1048576, permissions: '-rw-r-----', owner: 'root', modified: new Date() },
        { id: '3-1-2', name: 'auth.log', path: '/var/log/auth.log', type: 'file', size: 524288, permissions: '-rw-r-----', owner: 'root', modified: new Date() },
      ]},
    ]
  },
]

function formatSize(bytes?: number): string {
  if (!bytes) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(date?: Date): string {
  if (!date) return '-'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

interface FileTreeItemProps {
  item: FileItem
  depth: number
  expandedIds: Set<string>
  selectedId: string | null
  onToggle: (id: string) => void
  onSelect: (item: FileItem) => void
  onDoubleClick: (item: FileItem) => void
}

function FileTreeItem({ item, depth, expandedIds, selectedId, onToggle, onSelect, onDoubleClick }: FileTreeItemProps) {
  const isExpanded = expandedIds.has(item.id)
  const isSelected = selectedId === item.id
  const isDirectory = item.type === 'directory'

  return (
    <>
      <div
        className={cn(
          "flex items-center gap-1 py-1 px-2 cursor-pointer hover:bg-muted/50 rounded text-sm",
          isSelected && "bg-primary/10 text-primary"
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => {
          onSelect(item)
          if (isDirectory) onToggle(item.id)
        }}
        onDoubleClick={() => onDoubleClick(item)}
      >
        {isDirectory ? (
          <>
            {isExpanded ? (
              <ChevronDown className="w-4 h-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="w-4 h-4 shrink-0 text-muted-foreground" />
            )}
            <Folder className="w-4 h-4 shrink-0 text-primary" />
          </>
        ) : (
          <>
            <span className="w-4" />
            <File className="w-4 h-4 shrink-0 text-muted-foreground" />
          </>
        )}
        <span className="truncate">{item.name}</span>
      </div>
      {isDirectory && isExpanded && item.children?.map(child => (
        <FileTreeItem
          key={child.id}
          item={child}
          depth={depth + 1}
          expandedIds={expandedIds}
          selectedId={selectedId}
          onToggle={onToggle}
          onSelect={onSelect}
          onDoubleClick={onDoubleClick}
        />
      ))}
    </>
  )
}

export function SftpPanel({ sessionId, onFileOpen }: SftpPanelProps) {
  const [currentPath, setCurrentPath] = useState('/home/dev')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set(['1', '1-1']))
  const [selectedItem, setSelectedItem] = useState<FileItem | null>(null)
  const [viewMode, setViewMode] = useState<'tree' | 'list'>('list')

  // Find current directory files for list view
  const currentFiles = useMemo(() => {
    const findDir = (items: FileItem[], path: string): FileItem[] => {
      for (const item of items) {
        if (item.path === path && item.type === 'directory') {
          return item.children || []
        }
        if (item.children) {
          const found = findDir(item.children, path)
          if (found.length > 0) return found
        }
      }
      return []
    }
    return findDir(mockFiles, currentPath)
  }, [currentPath])

  const handleToggle = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const handleSelect = (item: FileItem) => {
    setSelectedItem(item)
  }

  const handleDoubleClick = (item: FileItem) => {
    if (item.type === 'directory') {
      setCurrentPath(item.path)
    } else {
      onFileOpen(item)
    }
  }

  const goUp = () => {
    const parts = currentPath.split('/').filter(Boolean)
    if (parts.length > 1) {
      parts.pop()
      setCurrentPath('/' + parts.join('/'))
    } else {
      setCurrentPath('/')
    }
  }

  const goHome = () => {
    setCurrentPath('/home/dev')
  }

  return (
    <div className="h-full flex flex-col bg-card">
      {/* Toolbar */}
      <div className="flex items-center gap-1 p-2 border-b border-border">
        <button
          onClick={goHome}
          className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
          title="主目录"
        >
          <Home className="w-4 h-4" />
        </button>
        <button
          onClick={goUp}
          className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
          title="上级目录"
        >
          <ArrowUp className="w-4 h-4" />
        </button>
        <button className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground" title="刷新">
          <RefreshCw className="w-4 h-4" />
        </button>
        <div className="w-px h-4 bg-border mx-1" />
        <button className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground" title="上传">
          <Upload className="w-4 h-4" />
        </button>
        <button className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground" title="下载">
          <Download className="w-4 h-4" />
        </button>
        <div className="w-px h-4 bg-border mx-1" />
        <button className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground" title="新建文件">
          <FilePlus className="w-4 h-4" />
        </button>
        <button className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground" title="新建文件夹">
          <FolderPlus className="w-4 h-4" />
        </button>
        <button className="p-1.5 rounded hover:bg-muted text-destructive hover:text-destructive" title="删除">
          <Trash2 className="w-4 h-4" />
        </button>
        <div className="flex-1" />
        <div className="flex rounded border border-border overflow-hidden">
          <button
            onClick={() => setViewMode('tree')}
            className={cn(
              "px-2 py-1 text-xs",
              viewMode === 'tree' ? "bg-primary text-primary-foreground" : "hover:bg-muted"
            )}
          >
            树形
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={cn(
              "px-2 py-1 text-xs",
              viewMode === 'list' ? "bg-primary text-primary-foreground" : "hover:bg-muted"
            )}
          >
            列表
          </button>
        </div>
      </div>

      {/* Path Bar */}
      <div className="px-3 py-2 text-sm text-muted-foreground border-b border-border bg-muted/30">
        <span className="font-mono">{currentPath}</span>
      </div>

      {/* File Browser */}
      <div className="flex-1 overflow-auto terminal-scrollbar">
        {viewMode === 'tree' ? (
          <div className="py-2">
            {mockFiles.map(item => (
              <FileTreeItem
                key={item.id}
                item={item}
                depth={0}
                expandedIds={expandedIds}
                selectedId={selectedItem?.id || null}
                onToggle={handleToggle}
                onSelect={handleSelect}
                onDoubleClick={handleDoubleClick}
              />
            ))}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="text-left text-muted-foreground border-b border-border">
                <th className="px-3 py-2 font-medium">名称</th>
                <th className="px-3 py-2 font-medium w-24">大小</th>
                <th className="px-3 py-2 font-medium w-28">修改时间</th>
                <th className="px-3 py-2 font-medium w-28">权限</th>
              </tr>
            </thead>
            <tbody>
              {currentFiles.map(item => (
                <tr
                  key={item.id}
                  className={cn(
                    "hover:bg-muted/50 cursor-pointer",
                    selectedItem?.id === item.id && "bg-primary/10"
                  )}
                  onClick={() => handleSelect(item)}
                  onDoubleClick={() => handleDoubleClick(item)}
                >
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      {item.type === 'directory' ? (
                        <Folder className="w-4 h-4 text-primary shrink-0" />
                      ) : (
                        <File className="w-4 h-4 text-muted-foreground shrink-0" />
                      )}
                      <span className="truncate">{item.name}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {item.type === 'directory' ? '-' : formatSize(item.size)}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatDate(item.modified)}
                  </td>
                  <td className="px-3 py-2 font-mono text-muted-foreground text-xs">
                    {item.permissions}
                  </td>
                </tr>
              ))}
              {currentFiles.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
                    空目录
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
