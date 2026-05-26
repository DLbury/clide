'use client'

import { useState } from 'react'
import { 
  Folder, 
  File, 
  ChevronRight, 
  ChevronDown, 
  Upload, 
  Download, 
  Trash2, 
  RefreshCw,
  FolderPlus,
  FilePlus,
  Edit3,
  Copy,
  Scissors,
  Clipboard,
  Home,
  ArrowUp
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { FileItem } from '@/lib/types'

interface SftpBrowserProps {
  sessionName: string
  onOpenFile: (file: FileItem) => void
}

// Mock file system
const mockFileSystem: FileItem[] = [
  {
    id: '1',
    name: 'home',
    path: '/home',
    type: 'directory',
    permissions: 'drwxr-xr-x',
    owner: 'root',
    modified: new Date('2024-05-20'),
    children: [
      {
        id: '1-1',
        name: 'dev',
        path: '/home/dev',
        type: 'directory',
        permissions: 'drwxr-xr-x',
        owner: 'dev',
        modified: new Date('2024-05-23'),
        children: [
          { id: '1-1-1', name: '.bashrc', path: '/home/dev/.bashrc', type: 'file', size: 3526, permissions: '-rw-r--r--', owner: 'dev', modified: new Date('2024-05-10') },
          { id: '1-1-2', name: '.profile', path: '/home/dev/.profile', type: 'file', size: 807, permissions: '-rw-r--r--', owner: 'dev', modified: new Date('2024-05-10') },
          { id: '1-1-3', name: 'projects', path: '/home/dev/projects', type: 'directory', permissions: 'drwxr-xr-x', owner: 'dev', modified: new Date('2024-05-23'), children: [
            { id: '1-1-3-1', name: 'app.ts', path: '/home/dev/projects/app.ts', type: 'file', size: 2048, permissions: '-rw-r--r--', owner: 'dev', modified: new Date('2024-05-23') },
            { id: '1-1-3-2', name: 'config.json', path: '/home/dev/projects/config.json', type: 'file', size: 512, permissions: '-rw-r--r--', owner: 'dev', modified: new Date('2024-05-22') },
          ]},
        ]
      },
    ]
  },
  {
    id: '2',
    name: 'etc',
    path: '/etc',
    type: 'directory',
    permissions: 'drwxr-xr-x',
    owner: 'root',
    modified: new Date('2024-05-15'),
    children: [
      { id: '2-1', name: 'nginx', path: '/etc/nginx', type: 'directory', permissions: 'drwxr-xr-x', owner: 'root', modified: new Date('2024-05-15'), children: [
        { id: '2-1-1', name: 'nginx.conf', path: '/etc/nginx/nginx.conf', type: 'file', size: 4096, permissions: '-rw-r--r--', owner: 'root', modified: new Date('2024-05-15') },
        { id: '2-1-2', name: 'sites-available', path: '/etc/nginx/sites-available', type: 'directory', permissions: 'drwxr-xr-x', owner: 'root', modified: new Date('2024-05-15'), children: [] },
      ]},
      { id: '2-2', name: 'hosts', path: '/etc/hosts', type: 'file', size: 256, permissions: '-rw-r--r--', owner: 'root', modified: new Date('2024-05-10') },
      { id: '2-3', name: 'passwd', path: '/etc/passwd', type: 'file', size: 2048, permissions: '-rw-r--r--', owner: 'root', modified: new Date('2024-05-10') },
    ]
  },
  {
    id: '3',
    name: 'var',
    path: '/var',
    type: 'directory',
    permissions: 'drwxr-xr-x',
    owner: 'root',
    modified: new Date('2024-05-20'),
    children: [
      { id: '3-1', name: 'log', path: '/var/log', type: 'directory', permissions: 'drwxr-xr-x', owner: 'root', modified: new Date('2024-05-23'), children: [
        { id: '3-1-1', name: 'syslog', path: '/var/log/syslog', type: 'file', size: 102400, permissions: '-rw-r-----', owner: 'syslog', modified: new Date('2024-05-23') },
        { id: '3-1-2', name: 'auth.log', path: '/var/log/auth.log', type: 'file', size: 51200, permissions: '-rw-r-----', owner: 'syslog', modified: new Date('2024-05-23') },
      ]},
      { id: '3-2', name: 'www', path: '/var/www', type: 'directory', permissions: 'drwxr-xr-x', owner: 'www-data', modified: new Date('2024-05-20'), children: [
        { id: '3-2-1', name: 'html', path: '/var/www/html', type: 'directory', permissions: 'drwxr-xr-x', owner: 'www-data', modified: new Date('2024-05-20'), children: [
          { id: '3-2-1-1', name: 'index.html', path: '/var/www/html/index.html', type: 'file', size: 1024, permissions: '-rw-r--r--', owner: 'www-data', modified: new Date('2024-05-20') },
        ]},
      ]},
    ]
  },
]

function formatFileSize(bytes?: number): string {
  if (!bytes) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(date?: Date): string {
  if (!date) return '-'
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function SftpBrowser({ sessionName, onOpenFile }: SftpBrowserProps) {
  const [currentPath, setCurrentPath] = useState('/')
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['1', '1-1']))
  const [selectedItem, setSelectedItem] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'tree' | 'list'>('tree')

  const toggleFolder = (id: string) => {
    const newExpanded = new Set(expandedFolders)
    if (newExpanded.has(id)) {
      newExpanded.delete(id)
    } else {
      newExpanded.add(id)
    }
    setExpandedFolders(newExpanded)
  }

  const handleItemClick = (item: FileItem) => {
    setSelectedItem(item.id)
    if (item.type === 'directory') {
      toggleFolder(item.id)
      setCurrentPath(item.path)
    }
  }

  const handleItemDoubleClick = (item: FileItem) => {
    if (item.type === 'file') {
      onOpenFile(item)
    }
  }

  const renderFileTree = (items: FileItem[], depth: number = 0) => {
    return items.map(item => (
      <div key={item.id}>
        <div
          className={cn(
            "flex items-center gap-2 px-2 py-1 rounded cursor-pointer text-sm group transition-colors",
            selectedItem === item.id ? "bg-primary/10 text-primary" : "hover:bg-muted"
          )}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => handleItemClick(item)}
          onDoubleClick={() => handleItemDoubleClick(item)}
        >
          {item.type === 'directory' ? (
            <>
              {expandedFolders.has(item.id) ? (
                <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
              ) : (
                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
              )}
              <Folder className={cn(
                "w-4 h-4 shrink-0",
                selectedItem === item.id ? "text-primary" : "text-terminal-yellow"
              )} />
            </>
          ) : (
            <>
              <span className="w-4" />
              <File className={cn(
                "w-4 h-4 shrink-0",
                selectedItem === item.id ? "text-primary" : "text-muted-foreground"
              )} />
            </>
          )}
          <span className="flex-1 truncate">{item.name}</span>
          <span className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
            {formatFileSize(item.size)}
          </span>
        </div>
        
        {item.type === 'directory' && expandedFolders.has(item.id) && item.children && (
          renderFileTree(item.children, depth + 1)
        )}
      </div>
    ))
  }

  return (
    <div className="flex-1 flex flex-col bg-background font-mono text-sm overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border bg-muted/30">
        <Button variant="ghost" size="sm" className="h-7 px-2">
          <Home className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2">
          <ArrowUp className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2">
          <RefreshCw className="w-4 h-4" />
        </Button>
        <div className="w-px h-5 bg-border mx-1" />
        <Button variant="ghost" size="sm" className="h-7 px-2">
          <FolderPlus className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2">
          <FilePlus className="w-4 h-4" />
        </Button>
        <div className="w-px h-5 bg-border mx-1" />
        <Button variant="ghost" size="sm" className="h-7 px-2">
          <Upload className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2">
          <Download className="w-4 h-4" />
        </Button>
        <div className="w-px h-5 bg-border mx-1" />
        <Button variant="ghost" size="sm" className="h-7 px-2">
          <Edit3 className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2">
          <Copy className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2">
          <Scissors className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2">
          <Clipboard className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-terminal-red hover:text-terminal-red">
          <Trash2 className="w-4 h-4" />
        </Button>
        
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground">{sessionName}</span>
      </div>

      {/* Path Bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-muted/20">
        <span className="text-xs text-muted-foreground">路径:</span>
        <div className="flex-1 px-2 py-1 bg-background rounded border border-border text-xs">
          {currentPath}
        </div>
      </div>

      {/* Split View */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Tree View */}
        <div className="w-64 border-r border-border overflow-y-auto terminal-scrollbar p-2">
          <div className="text-xs text-muted-foreground px-2 py-1 mb-1">
            远程文件 - {sessionName}
          </div>
          {renderFileTree(mockFileSystem)}
        </div>

        {/* Right: File List */}
        <div className="flex-1 overflow-y-auto terminal-scrollbar">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted/50 border-b border-border">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">名称</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground w-24">大小</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground w-28">修改时间</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground w-24">权限</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground w-20">所有者</th>
              </tr>
            </thead>
            <tbody>
              {mockFileSystem.map(item => (
                <tr 
                  key={item.id}
                  className={cn(
                    "border-b border-border/50 cursor-pointer transition-colors",
                    selectedItem === item.id ? "bg-primary/10" : "hover:bg-muted/50"
                  )}
                  onClick={() => handleItemClick(item)}
                  onDoubleClick={() => handleItemDoubleClick(item)}
                >
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      {item.type === 'directory' ? (
                        <Folder className="w-4 h-4 text-terminal-yellow" />
                      ) : (
                        <File className="w-4 h-4 text-muted-foreground" />
                      )}
                      <span>{item.name}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{formatFileSize(item.size)}</td>
                  <td className="px-3 py-2 text-muted-foreground">{formatDate(item.modified)}</td>
                  <td className="px-3 py-2 text-muted-foreground font-mono">{item.permissions}</td>
                  <td className="px-3 py-2 text-muted-foreground">{item.owner}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Status Bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-border bg-muted/30 text-xs text-muted-foreground">
        <span>{mockFileSystem.length} 项</span>
        <span>SFTP 已连接</span>
      </div>
    </div>
  )
}
