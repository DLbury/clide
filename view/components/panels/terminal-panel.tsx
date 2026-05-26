'use client'

import { useState, useRef, useEffect, useCallback, KeyboardEvent } from 'react'
import { Copy, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TerminalLine } from '@/lib/types'

interface TerminalPanelProps {
  shellId: string
  sessionName: string
  history: TerminalLine[]
  onCommand: (shellId: string, command: string) => void
}

export function TerminalPanel({ shellId, sessionName, history, onCommand }: TerminalPanelProps) {
  const [currentInput, setCurrentInput] = useState('')
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const terminalRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLSpanElement>(null)

  // 获取命令历史
  const commandHistory = history.filter(line => line.type === 'input').map(line => line.content)

  // 自动滚动到底部
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight
    }
  }, [history])

  // 聚焦输入
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (currentInput.trim()) {
        onCommand(shellId, currentInput.trim())
        setCurrentInput('')
        setHistoryIndex(-1)
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (commandHistory.length > 0) {
        const newIndex = historyIndex < commandHistory.length - 1 ? historyIndex + 1 : historyIndex
        setHistoryIndex(newIndex)
        setCurrentInput(commandHistory[commandHistory.length - 1 - newIndex] || '')
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (historyIndex > 0) {
        const newIndex = historyIndex - 1
        setHistoryIndex(newIndex)
        setCurrentInput(commandHistory[commandHistory.length - 1 - newIndex] || '')
      } else if (historyIndex === 0) {
        setHistoryIndex(-1)
        setCurrentInput('')
      }
    } else if (e.key === 'c' && e.ctrlKey) {
      setCurrentInput('')
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault()
      // Clear will be handled by parent
      onCommand(shellId, 'clear')
    }
  }, [currentInput, historyIndex, commandHistory, shellId, onCommand])

  const handleInput = (e: React.FormEvent<HTMLSpanElement>) => {
    setCurrentInput(e.currentTarget.textContent || '')
    setHistoryIndex(-1)
  }

  const copyToClipboard = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const handleTerminalClick = () => {
    inputRef.current?.focus()
  }

  return (
    <div 
      className="h-full flex flex-col bg-card font-mono text-sm"
      onClick={handleTerminalClick}
    >
      {/* Terminal Output */}
      <div 
        ref={terminalRef}
        className="flex-1 overflow-auto p-3 terminal-scrollbar"
      >
        {history.map((line) => (
          <div key={line.id} className="group relative">
            {line.type === 'input' ? (
              <div className="flex items-start gap-2 text-primary">
                <span className="text-muted-foreground select-none shrink-0">
                  {sessionName}:~$
                </span>
                <span className="break-all">{line.content}</span>
              </div>
            ) : line.type === 'output' ? (
              <div className="relative">
                <pre className="whitespace-pre-wrap break-all text-foreground/90 pl-0">{line.content}</pre>
                {line.content && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      copyToClipboard(line.content, line.id)
                    }}
                    className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 p-1 rounded bg-muted/80 hover:bg-muted transition-opacity"
                  >
                    {copiedId === line.id ? (
                      <Check className="w-3 h-3 text-primary" />
                    ) : (
                      <Copy className="w-3 h-3 text-muted-foreground" />
                    )}
                  </button>
                )}
              </div>
            ) : line.type === 'error' ? (
              <pre className="whitespace-pre-wrap break-all text-destructive pl-0">{line.content}</pre>
            ) : line.type === 'system' ? (
              <div className="text-muted-foreground italic py-1">{line.content}</div>
            ) : null}
          </div>
        ))}

        {/* Current Input Line */}
        <div className="flex items-start gap-2 text-primary">
          <span className="text-muted-foreground select-none shrink-0">
            {sessionName}:~$
          </span>
          <span
            ref={inputRef}
            contentEditable
            suppressContentEditableWarning
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            className={cn(
              "outline-none min-w-[2px] break-all",
              "caret-primary",
              "empty:before:content-[''] empty:before:inline-block empty:before:w-2 empty:before:h-4 empty:before:bg-primary empty:before:animate-pulse"
            )}
            spellCheck={false}
          >
            {currentInput}
          </span>
          {!currentInput && (
            <span className="w-2 h-5 bg-primary animate-pulse" />
          )}
        </div>
      </div>
    </div>
  )
}
