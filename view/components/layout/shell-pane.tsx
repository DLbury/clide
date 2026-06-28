'use client'

import { useState, useRef, useEffect, useCallback, KeyboardEvent } from 'react'
import { Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TerminalLine } from '@/lib/types'
import { LiveTerminal } from '@/components/layout/live-terminal'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

interface ShellPaneProps {
  shells: { id: string; name: string; history: TerminalLine[] }[]
  activeShellId: string
  onShellChange: (shellId: string) => void
  onNewShell: () => void
  onCloseShell: (shellId: string) => void
  onCommand: (shellId: string, command: string) => void
  user?: string
  host?: string
  terminalLive?: boolean
  sessionId?: string
  /** 该 Shell 的 PTY 是否已连接（与侧边栏会话状态独立） */
  terminalConnected?: boolean
  terminalStatus?: 'connecting' | 'connected' | 'disconnected' | 'error'
  clearSignal?: number
  inputEnabled?: boolean
  hideTabBar?: boolean
  onReconnect?: () => void
}

interface TerminalPromptProps {
  user: string
  host: string
}

function TerminalPrompt({ user, host }: TerminalPromptProps) {
  return (
    <span className="shrink-0 select-none">
      <span className="text-terminal-green">{user}@{host}</span>
      <span className="text-terminal-green/70">:</span>
      <span className="text-terminal-green">~</span>
      <span className="text-terminal-green/70">$&nbsp;</span>
    </span>
  )
}

export function ShellPane({
  shells,
  activeShellId,
  onShellChange,
  onNewShell,
  onCloseShell,
  onCommand,
  user = 'local',
  host = 'session',
  terminalLive = false,
  sessionId,
  terminalConnected = false,
  terminalStatus,
  clearSignal = 0,
  inputEnabled = true,
  hideTabBar = false,
  onReconnect,
}: ShellPaneProps) {
  const [inputValue, setInputValue] = useState('')
  const [commandHistory, setCommandHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const outputRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const activeShell = shells.find(s => s.id === activeShellId)
  const useXterm = terminalLive && !!sessionId

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [activeShell?.history])

  useEffect(() => {
    if (!terminalLive) {
      inputRef.current?.focus()
    }
  }, [activeShellId, terminalLive])

  const handleSubmit = useCallback(() => {
    if (!inputValue.trim() || !activeShellId) return
    onCommand(activeShellId, inputValue.trim())
    setCommandHistory(prev => [...prev, inputValue.trim()])
    setHistoryIndex(-1)
    setInputValue('')
  }, [inputValue, activeShellId, onCommand])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        handleSubmit()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (commandHistory.length > 0) {
          const newIndex =
            historyIndex < commandHistory.length - 1 ? historyIndex + 1 : historyIndex
          setHistoryIndex(newIndex)
          setInputValue(commandHistory[commandHistory.length - 1 - newIndex] || '')
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (historyIndex > 0) {
          const newIndex = historyIndex - 1
          setHistoryIndex(newIndex)
          setInputValue(commandHistory[commandHistory.length - 1 - newIndex] || '')
        } else if (historyIndex === 0) {
          setHistoryIndex(-1)
          setInputValue('')
        }
      } else if (e.key === 'Tab') {
        e.preventDefault()
      } else if (e.key === 'c' && e.ctrlKey) {
        e.preventDefault()
        onCommand(activeShellId, '\x03')
        setInputValue('')
      } else if (e.key === 'l' && e.ctrlKey) {
        e.preventDefault()
        onCommand(activeShellId, 'clear')
      }
    },
    [handleSubmit, commandHistory, historyIndex, activeShellId, onCommand]
  )

  const handleContainerClick = () => {
    inputRef.current?.focus()
  }

  const terminalText = activeShell?.history.map(line => line.content).join('\n') ?? ''

  const copyOutput = () => {
    navigator.clipboard.writeText(terminalText).catch(() => {})
  }

  const selectAllOutput = () => {
    const selection = window.getSelection()
    if (!outputRef.current || !selection) return
    const range = document.createRange()
    range.selectNodeContents(outputRef.current)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  return (
    <div className="h-full flex flex-col bg-card min-h-0">
      {!hideTabBar && (
        <div className="flex items-center border-b border-border bg-muted/30 min-h-[34px] shrink-0">
          <div className="flex items-center overflow-x-auto terminal-scrollbar">
            {shells.map(shell => (
              <div
                key={shell.id}
                onClick={() => onShellChange(shell.id)}
                className={cn(
                  'flex items-center gap-2 px-3 py-1.5 text-sm border-r border-border cursor-pointer group shrink-0',
                  'hover:bg-muted/50 transition-colors',
                  activeShellId === shell.id && 'bg-card'
                )}
              >
                <span className="truncate">{shell.name}</span>
                {shells.length > 1 && (
                  <button
                    type="button"
                    onClick={e => {
                      e.stopPropagation()
                      onCloseShell(shell.id)
                    }}
                    className="p-0.5 rounded hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={onNewShell}
              className="flex items-center justify-center px-2 py-1.5 hover:bg-muted/50 transition-colors shrink-0 border-r border-border"
              title="新建 Shell"
            >
              <Plus className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
        </div>
      )}

      {useXterm ? (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <LiveTerminal
            sessionId={sessionId!}
            connected={terminalConnected}
            inputEnabled={inputEnabled}
            clearSignal={clearSignal}
            className="flex-1 min-h-0 overflow-hidden"
          />
          {!terminalConnected && (
            <div className="shrink-0 border-t border-border px-3 py-2 text-xs flex items-center justify-between gap-2 bg-amber-500/10 text-amber-800 dark:text-amber-300">
              <span>
                {terminalStatus === 'connecting'
                  ? '正在连接终端…'
                  : '终端连接已断开'}
              </span>
              {terminalStatus !== 'connecting' && onReconnect && (
                <button
                  type="button"
                  onClick={onReconnect}
                  className="shrink-0 rounded px-2 py-1 text-[11px] font-medium bg-amber-600 text-white hover:bg-amber-700 transition-colors"
                >
                  重新连接
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              ref={outputRef}
              onClick={handleContainerClick}
              className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-3 font-mono text-sm terminal-scrollbar cursor-text flex flex-col select-text-region"
            >
              {activeShell?.history.map(line => (
                <div key={line.id} className="leading-5">
                  {line.type === 'input' ? (
                    <div className="flex">
                      <TerminalPrompt user={user} host={host} />
                      <span>{line.content}</span>
                    </div>
                  ) : line.type === 'system' ? (
                    <div className="text-terminal-green/80 italic">{line.content}</div>
                  ) : line.type === 'error' ? (
                    <div className="text-destructive">{line.content}</div>
                  ) : (
                    <div className="whitespace-pre-wrap text-terminal-green/90">{line.content}</div>
                  )}
                </div>
              ))}
              <div className="flex items-center leading-5">
                <TerminalPrompt user={user} host={host} />
                <input
                  ref={inputRef}
                  type="text"
                  value={inputValue}
                  onChange={e => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="flex-1 bg-transparent outline-none caret-terminal-green text-terminal-green"
                  autoFocus
                  spellCheck={false}
                />
              </div>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-40">
            <ContextMenuItem onClick={copyOutput}>复制</ContextMenuItem>
            <ContextMenuItem onClick={selectAllOutput}>全选</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => activeShellId && onCommand(activeShellId, 'clear')}>
              清屏
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}
    </div>
  )
}
