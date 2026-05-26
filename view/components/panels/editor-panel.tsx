'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Save, X, Search, RotateCcw, Copy, Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OpenFile } from '@/lib/types'

interface EditorPanelProps {
  file: OpenFile
  onSave: (file: OpenFile) => void
  onClose: () => void
  onChange: (content: string) => void
}

// Language detection based on file extension
function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  const langMap: Record<string, string> = {
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'py': 'python',
    'rb': 'ruby',
    'go': 'go',
    'rs': 'rust',
    'java': 'java',
    'c': 'c',
    'cpp': 'cpp',
    'h': 'c',
    'hpp': 'cpp',
    'css': 'css',
    'scss': 'scss',
    'less': 'less',
    'html': 'html',
    'xml': 'xml',
    'json': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
    'md': 'markdown',
    'sh': 'shell',
    'bash': 'shell',
    'zsh': 'shell',
    'sql': 'sql',
    'conf': 'config',
    'ini': 'config',
    'toml': 'toml',
  }
  return langMap[ext || ''] || 'text'
}

export function EditorPanel({ file, onSave, onClose, onChange }: EditorPanelProps) {
  const [content, setContent] = useState(file.content)
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [copied, setCopied] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const lineNumbersRef = useRef<HTMLDivElement>(null)

  const language = detectLanguage(file.name)
  const lines = content.split('\n')
  const lineCount = lines.length

  // Sync scroll between line numbers and textarea
  const handleScroll = useCallback(() => {
    if (textareaRef.current && lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = textareaRef.current.scrollTop
    }
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 's') {
          e.preventDefault()
          handleSave()
        } else if (e.key === 'f') {
          e.preventDefault()
          setShowSearch(true)
        }
      }
      if (e.key === 'Escape') {
        setShowSearch(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [content])

  const handleSave = () => {
    onSave({ ...file, content, isModified: false })
  }

  const handleContentChange = (newContent: string) => {
    setContent(newContent)
    onChange(newContent)
  }

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleRevert = () => {
    setContent(file.content)
    onChange(file.content)
  }

  // Search highlighting
  const highlightedContent = searchQuery
    ? content.replace(
        new RegExp(`(${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'),
        '<<<HIGHLIGHT>>>$1<<<END>>>'
      )
    : content

  return (
    <div className="h-full flex flex-col bg-card">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-sm font-medium truncate">{file.name}</span>
          {file.isModified && (
            <span className="w-2 h-2 rounded-full bg-primary shrink-0" title="未保存" />
          )}
          <span className="text-xs text-muted-foreground px-1.5 py-0.5 bg-muted rounded">
            {language}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowSearch(!showSearch)}
            className={cn(
              "p-1.5 rounded hover:bg-muted",
              showSearch && "bg-muted"
            )}
            title="搜索 (Ctrl+F)"
          >
            <Search className="w-4 h-4" />
          </button>
          <button
            onClick={handleCopy}
            className="p-1.5 rounded hover:bg-muted"
            title="复制全部"
          >
            {copied ? (
              <Check className="w-4 h-4 text-primary" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </button>
          <button
            onClick={handleRevert}
            className="p-1.5 rounded hover:bg-muted"
            title="撤销更改"
            disabled={!file.isModified}
          >
            <RotateCcw className={cn("w-4 h-4", !file.isModified && "opacity-50")} />
          </button>
          <div className="w-px h-4 bg-border mx-1" />
          <button
            onClick={handleSave}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 rounded text-sm",
              file.isModified
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "bg-muted text-muted-foreground"
            )}
            title="保存 (Ctrl+S)"
          >
            <Save className="w-4 h-4" />
            <span>保存</span>
          </button>
        </div>
      </div>

      {/* Search Bar */}
      {showSearch && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索..."
            className="flex-1 bg-transparent text-sm outline-none"
            autoFocus
          />
          {searchQuery && (
            <span className="text-xs text-muted-foreground">
              {content.split(new RegExp(searchQuery, 'gi')).length - 1} 个匹配
            </span>
          )}
          <button
            onClick={() => {
              setSearchQuery('')
              setShowSearch(false)
            }}
            className="p-1 rounded hover:bg-muted"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Editor Area */}
      <div className="flex-1 flex overflow-hidden font-mono text-sm">
        {/* Line Numbers */}
        <div
          ref={lineNumbersRef}
          className="w-12 bg-muted/30 border-r border-border text-right overflow-hidden select-none"
        >
          {Array.from({ length: lineCount }, (_, i) => (
            <div
              key={i}
              className="px-2 leading-6 text-muted-foreground text-xs"
            >
              {i + 1}
            </div>
          ))}
        </div>

        {/* Text Area */}
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => handleContentChange(e.target.value)}
            onScroll={handleScroll}
            className={cn(
              "absolute inset-0 w-full h-full p-2 bg-transparent resize-none outline-none",
              "leading-6 terminal-scrollbar",
              "caret-primary"
            )}
            spellCheck={false}
          />
        </div>
      </div>

      {/* Status Bar */}
      <div className="flex items-center justify-between px-3 py-1 border-t border-border bg-muted/30 text-xs text-muted-foreground">
        <div className="flex items-center gap-3">
          <span>行 {lineCount}</span>
          <span>字符 {content.length}</span>
        </div>
        <div className="flex items-center gap-3">
          <span>UTF-8</span>
          <span>LF</span>
          <button className="flex items-center gap-1 hover:text-foreground">
            <span>{language}</span>
            <ChevronDown className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  )
}
