'use client'

import { X, Plus, Terminal, Sparkles, FolderOpen, FileCode, Sun, Moon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TerminalTab } from '@/lib/types'
import { useTheme } from '@teispace/next-themes'
import { useEffect, useState } from 'react'

interface TerminalTabsProps {
  tabs: TerminalTab[]
  activeTabId: string
  onTabClick: (tabId: string) => void
  onTabClose: (tabId: string) => void
  onNewTab: () => void
  aiEnabled: boolean
  onToggleAI: () => void
  activeViewMode: 'terminal' | 'sftp' | 'editor'
  onViewModeChange: (mode: 'terminal' | 'sftp' | 'editor') => void
  showSftpOption: boolean
}

const viewModes = [
  { mode: 'terminal' as const, label: '终端', icon: Terminal },
  { mode: 'sftp' as const, label: 'SFTP', icon: FolderOpen },
  { mode: 'editor' as const, label: '编辑器', icon: FileCode },
]

export function TerminalTabs({
  tabs,
  activeTabId,
  onTabClick,
  onTabClose,
  onNewTab,
  aiEnabled,
  onToggleAI,
  activeViewMode,
  onViewModeChange,
  showSftpOption
}: TerminalTabsProps) {
  const [mounted, setMounted] = useState(false)
  const { theme, setTheme } = useTheme()

  useEffect(() => {
    setMounted(true)
  }, [])

  const availableModes = showSftpOption 
    ? viewModes 
    : viewModes.filter(m => m.mode !== 'sftp')

  return (
    <div className="flex items-center h-10 bg-card border-b border-border">
      {/* View Mode Switcher */}
      <div className="flex items-center border-r border-border h-full">
        {availableModes.map(({ mode, label, icon: Icon }) => (
          <button
            key={mode}
            onClick={() => onViewModeChange(mode)}
            className={cn(
              "flex items-center gap-1.5 px-3 h-full text-xs transition-colors border-b-2",
              activeViewMode === mode
                ? "bg-background text-primary border-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50 border-transparent"
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            <span className="hidden md:inline">{label}</span>
          </button>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex-1 flex items-center overflow-x-auto terminal-scrollbar">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => onTabClick(tab.id)}
            className={cn(
              "group flex items-center gap-2 px-4 h-10 min-w-[140px] max-w-[200px] cursor-pointer border-r border-border transition-colors",
              tab.id === activeTabId
                ? "bg-background text-foreground"
                : "bg-card text-muted-foreground hover:text-foreground hover:bg-muted/50"
            )}
          >
            <Terminal className="w-3.5 h-3.5 shrink-0" />
            <span className="flex-1 text-sm truncate">{tab.title}</span>
            {tabs.length > 1 && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onTabClose(tab.id)
                }}
                className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-muted rounded transition-opacity"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}
        
        {/* New Tab Button */}
        <button
          onClick={onNewTab}
          className="flex items-center justify-center w-10 h-10 text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {/* AI Toggle */}
      <div className="flex items-center px-3 border-l border-border gap-2">
        <button
          onClick={onToggleAI}
          className={cn(
            "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-all",
            aiEnabled
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
          )}
        >
          <Sparkles className={cn(
            "w-4 h-4",
            aiEnabled && "animate-pulse"
          )} />
          <span className="hidden sm:inline">AI 助手</span>
        </button>

        {/* Theme Toggle */}
        {mounted && (
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            aria-label="切换主题"
          >
            {theme === 'dark' ? (
              <Sun className="w-4 h-4" />
            ) : (
              <Moon className="w-4 h-4" />
            )}
          </button>
        )}
      </div>
    </div>
  )
}
