'use client'

import { X, Sun, Moon, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTheme } from '@teispace/next-themes'
import { useEffect, useState } from 'react'
import type { Session } from '@/lib/types'
import { WindowControls } from '@/components/window-controls'
import { AppLogo } from '@/components/app-logo'
import { APP_NAME } from '@/lib/app-brand'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

interface ServerTabsProps {
  connections: Array<{
    id: string
    session: Session
  }>
  activeConnectionId: string | null
  onTabClick: (connectionId: string) => void
  onTabClose: (connectionId: string) => void
  onCloseOtherTabs?: (connectionId: string) => void
  onCloseAllTabs?: () => void
  onReconnectTab?: (connectionId: string) => void
  onOpenSettings?: () => void
}

export function ServerTabs({
  connections,
  activeConnectionId,
  onTabClick,
  onTabClose,
  onCloseOtherTabs,
  onCloseAllTabs,
  onReconnectTab,
  onOpenSettings,
}: ServerTabsProps) {
  const [mounted, setMounted] = useState(false)
  const { theme, setTheme } = useTheme()

  useEffect(() => {
    setMounted(true)
  }, [])

  return (
    <div className="shrink-0 flex flex-col bg-card border-b border-border select-none">
      {/* 顶层：仅用于窗口拖拽，不放置可交互标签 */}
      <div className="h-8 flex items-center border-b border-border/60">
        <div
          data-tauri-drag-region
          className="flex items-center gap-2 px-3 h-full shrink-0"
        >
          <AppLogo size={18} className="rounded-md" />
          <span className="text-xs font-semibold tracking-wide text-muted-foreground">
            {APP_NAME}
          </span>
        </div>
        <div
          data-tauri-drag-region
          className="flex-1 h-full min-w-0"
          aria-hidden
        />
        <div
          data-tauri-drag-region={false}
          className="relative z-10 flex items-center shrink-0 h-full"
        >
          {onOpenSettings && (
            <button
              type="button"
              data-tauri-drag-region={false}
              onClick={onOpenSettings}
              className="h-8 px-2.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="设置 (Ctrl+,)"
            >
              <Settings className="w-4 h-4" />
            </button>
          )}
          {mounted && (
            <button
              type="button"
              data-tauri-drag-region={false}
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              className="h-8 px-2.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="切换主题"
            >
              {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          )}
          <WindowControls />
        </div>
      </div>

      {/* 服务器连接标签（下层，不参与拖拽） */}
      <div className="h-10 flex items-center min-w-0">
        <div className="flex-1 flex items-center overflow-x-auto terminal-scrollbar min-w-0 h-full">
          {connections.map(conn => (
            <ContextMenu key={conn.id}>
              <ContextMenuTrigger asChild>
                <div
                  className={cn(
                    'flex items-center gap-2 px-4 h-full border-r border-border cursor-pointer group transition-colors shrink-0',
                    activeConnectionId === conn.id
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                  )}
                  onClick={() => onTabClick(conn.id)}
                >
                  <div
                    className={cn(
                      'w-2 h-2 rounded-full shrink-0',
                      conn.session.status === 'connected' && 'bg-green-500',
                      conn.session.status === 'connecting' && 'bg-yellow-500',
                      conn.session.status === 'disconnected' && 'bg-muted-foreground/50'
                    )}
                  />
                  <span className="text-sm truncate max-w-[120px]">{conn.session.name}</span>
                  <button
                    type="button"
                    onClick={e => {
                      e.stopPropagation()
                      onTabClose(conn.id)
                    }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted transition-opacity shrink-0"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-44">
                <ContextMenuItem onClick={() => onTabClick(conn.id)}>切换到该标签</ContextMenuItem>
                {conn.session.status !== 'connected' && onReconnectTab && (
                  <ContextMenuItem onClick={() => onReconnectTab(conn.id)}>
                    重新连接
                  </ContextMenuItem>
                )}
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => onTabClose(conn.id)}>关闭</ContextMenuItem>
                {onCloseOtherTabs && connections.length > 1 && (
                  <ContextMenuItem onClick={() => onCloseOtherTabs(conn.id)}>
                    关闭其他
                  </ContextMenuItem>
                )}
                {onCloseAllTabs && connections.length > 0 && (
                  <ContextMenuItem onClick={onCloseAllTabs}>关闭全部</ContextMenuItem>
                )}
              </ContextMenuContent>
            </ContextMenu>
          ))}

          {connections.length === 0 && (
            <div className="px-4 text-sm text-muted-foreground">点击左侧服务器连接</div>
          )}
        </div>
      </div>
    </div>
  )
}
