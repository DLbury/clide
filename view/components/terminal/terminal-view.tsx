'use client'

import { useRef, useEffect, useState, KeyboardEvent } from 'react'
import { Copy, Check, ChevronRight, Send, Play, Bot, User, GripVertical } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TerminalLine, ChatMessage } from '@/lib/types'
import { Button } from '@/components/ui/button'

interface TerminalViewProps {
  lines: TerminalLine[]
  onCommand: (command: string) => void
  currentPath: string
  isAiThinking: boolean
  aiEnabled: boolean
}

export function TerminalView({ 
  lines, 
  onCommand, 
  currentPath, 
  isAiThinking,
  aiEnabled 
}: TerminalViewProps) {
  const [inputValue, setInputValue] = useState('')
  const [commandHistory, setCommandHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [chatInput, setChatInput] = useState('')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: '1',
      role: 'assistant',
      content: '你好！我是你的 AI 终端助手。你可以用自然语言告诉我你想做什么，我会帮你生成并执行相应的命令。\n\n例如：\n- "列出当前目录的所有文件"\n- "查看系统内存使用情况"\n- "在 components 目录下查找所有 tsx 文件"',
      timestamp: new Date()
    }
  ])
  const [isAiResponding, setIsAiResponding] = useState(false)
  const [panelWidth, setPanelWidth] = useState(50) // 百分比
  const [isDragging, setIsDragging] = useState(false)
  
  const terminalRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const chatRef = useRef<HTMLDivElement>(null)
  const chatInputRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // 过滤掉 AI 响应，只在左边 Shell 显示纯命令输出
  const shellLines = lines.filter(line => line.type !== 'ai-response')

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight
    }
  }, [shellLines])

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight
    }
  }, [chatMessages])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // 拖拽调整面板宽度
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const newWidth = ((e.clientX - rect.left) / rect.width) * 100
      setPanelWidth(Math.min(Math.max(newWidth, 30), 70))
    }

    const handleMouseUp = () => {
      setIsDragging(false)
    }

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && inputValue.trim()) {
      onCommand(inputValue.trim())
      setCommandHistory(prev => [...prev, inputValue.trim()])
      setHistoryIndex(-1)
      setInputValue('')
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (commandHistory.length > 0) {
        const newIndex = historyIndex < commandHistory.length - 1 ? historyIndex + 1 : historyIndex
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
    }
  }

  const copyToClipboard = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const getLineColor = (type: TerminalLine['type']) => {
    switch (type) {
      case 'input':
        return 'text-terminal-cyan'
      case 'output':
        return 'text-foreground'
      case 'error':
        return 'text-terminal-red'
      case 'system':
        return 'text-terminal-yellow'
      default:
        return 'text-foreground'
    }
  }

  // 处理 AI 对话
  const handleChatSubmit = () => {
    if (!chatInput.trim() || isAiResponding) return

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: chatInput.trim(),
      timestamp: new Date()
    }

    setChatMessages(prev => [...prev, userMessage])
    setChatInput('')
    setIsAiResponding(true)

    // 模拟 AI 响应
    setTimeout(() => {
      const input = userMessage.content.toLowerCase()
      let response: ChatMessage

      if (input.includes('列出') || input.includes('文件') || input.includes('目录') || input.includes('ls')) {
        response = {
          id: `ai-${Date.now()}`,
          role: 'assistant',
          content: '好的，我来帮你列出目录内容。我建议使用以下命令：',
          timestamp: new Date(),
          command: 'ls -la'
        }
      } else if (input.includes('内存') || input.includes('memory')) {
        response = {
          id: `ai-${Date.now()}`,
          role: 'assistant',
          content: '要查看系统内存使用情况，可以使用以下命令：',
          timestamp: new Date(),
          command: 'free -h'
        }
      } else if (input.includes('查找') || input.includes('find') || input.includes('搜索')) {
        response = {
          id: `ai-${Date.now()}`,
          role: 'assistant',
          content: '我来帮你搜索文件。使用 find 命令可以实现：',
          timestamp: new Date(),
          command: 'find . -name "*.tsx" -type f'
        }
      } else if (input.includes('git') || input.includes('提交') || input.includes('commit')) {
        response = {
          id: `ai-${Date.now()}`,
          role: 'assistant',
          content: '关于 Git 操作，我建议先查看当前状态：',
          timestamp: new Date(),
          command: 'git status'
        }
      } else if (input.includes('进程') || input.includes('process') || input.includes('运行')) {
        response = {
          id: `ai-${Date.now()}`,
          role: 'assistant',
          content: '要查看系统运行的进程，可以使用：',
          timestamp: new Date(),
          command: 'ps aux | head -20'
        }
      } else if (input.includes('磁盘') || input.includes('disk') || input.includes('空间')) {
        response = {
          id: `ai-${Date.now()}`,
          role: 'assistant',
          content: '要查看磁盘使用情况，建议使用：',
          timestamp: new Date(),
          command: 'df -h'
        }
      } else if (input.includes('网络') || input.includes('network') || input.includes('端口')) {
        response = {
          id: `ai-${Date.now()}`,
          role: 'assistant',
          content: '要查看网络连接和端口情况：',
          timestamp: new Date(),
          command: 'netstat -tuln'
        }
      } else if (input.includes('清空') || input.includes('clear')) {
        response = {
          id: `ai-${Date.now()}`,
          role: 'assistant',
          content: '我来帮你清空终端：',
          timestamp: new Date(),
          command: 'clear'
        }
      } else {
        response = {
          id: `ai-${Date.now()}`,
          role: 'assistant',
          content: `我理解你想要${userMessage.content}。\n\n请告诉我更多细节，比如：\n- 你想操作哪个目录或文件？\n- 需要什么样的输出格式？\n- 有什么特殊的过滤条件吗？\n\n或者你可以直接在左边的终端中输入命令，我会帮你分析执行结果。`,
          timestamp: new Date()
        }
      }

      setChatMessages(prev => [...prev, response])
      setIsAiResponding(false)
    }, 800)
  }

  // 执行 AI 建议的命令
  const executeCommand = (command: string) => {
    onCommand(command)
    
    // 添加执行反馈到聊天
    const feedbackMessage: ChatMessage = {
      id: `feedback-${Date.now()}`,
      role: 'assistant',
      content: `已执行命令: \`${command}\`\n请查看左侧终端的输出结果。`,
      timestamp: new Date()
    }
    setChatMessages(prev => [...prev, feedbackMessage])
  }

  const handleChatKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleChatSubmit()
    }
  }

  return (
    <div 
      ref={containerRef}
      className="flex-1 flex bg-background font-mono text-sm overflow-hidden"
    >
      {/* 左侧：Shell 终端 */}
      <div 
        className="flex flex-col border-r border-border"
        style={{ width: `${panelWidth}%` }}
      >
        {/* 终端头部 */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-muted/30">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-terminal-red" />
            <div className="w-3 h-3 rounded-full bg-terminal-yellow" />
            <div className="w-3 h-3 rounded-full bg-primary" />
          </div>
          <span className="text-xs text-muted-foreground ml-2">Shell Terminal</span>
        </div>

        {/* 终端输出 */}
        <div 
          ref={terminalRef}
          className="flex-1 overflow-y-auto p-4 terminal-scrollbar"
          onClick={() => inputRef.current?.focus()}
        >
          {shellLines.map((line) => (
            <div 
              key={line.id} 
              className="group flex items-start gap-2 py-0.5"
            >
              {line.type === 'input' && (
                <span className="text-primary shrink-0">$</span>
              )}
              <pre className={cn(
                "flex-1 whitespace-pre-wrap break-all",
                getLineColor(line.type)
              )}>
                {line.content}
              </pre>
              {line.type === 'output' && line.content && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    copyToClipboard(line.content, line.id)
                  }}
                  className="opacity-0 group-hover:opacity-100 p-1 hover:bg-muted rounded transition-opacity shrink-0"
                >
                  {copiedId === line.id ? (
                    <Check className="w-3.5 h-3.5 text-primary" />
                  ) : (
                    <Copy className="w-3.5 h-3.5 text-muted-foreground" />
                  )}
                </button>
              )}
            </div>
          ))}
        </div>

        {/* 命令输入 */}
        <div className="border-t border-border p-3 bg-muted/20">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs shrink-0">{currentPath}</span>
            <ChevronRight className="w-4 h-4 text-primary shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 bg-transparent outline-none text-foreground placeholder:text-muted-foreground"
              placeholder="输入命令..."
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        </div>
      </div>

      {/* 拖拽手柄 */}
      <div 
        className={cn(
          "w-1 bg-border hover:bg-primary/50 cursor-col-resize flex items-center justify-center transition-colors",
          isDragging && "bg-primary"
        )}
        onMouseDown={() => setIsDragging(true)}
      >
        <GripVertical className="w-3 h-3 text-muted-foreground" />
      </div>

      {/* 右侧：AI 对话 */}
      <div 
        className="flex flex-col"
        style={{ width: `${100 - panelWidth}%` }}
      >
        {/* AI 对话头部 */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-muted/30">
          <Bot className="w-4 h-4 text-primary" />
          <span className="text-xs text-muted-foreground">AI Assistant</span>
          <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-primary/20 text-primary">
            智能对话
          </span>
        </div>

        {/* 对话内容 */}
        <div 
          ref={chatRef}
          className="flex-1 overflow-y-auto p-4 terminal-scrollbar space-y-4"
        >
          {chatMessages.map((message) => (
            <div 
              key={message.id}
              className={cn(
                "flex gap-3",
                message.role === 'user' && "flex-row-reverse"
              )}
            >
              <div className={cn(
                "w-7 h-7 rounded-full flex items-center justify-center shrink-0",
                message.role === 'user' ? "bg-primary/20" : "bg-muted"
              )}>
                {message.role === 'user' ? (
                  <User className="w-4 h-4 text-primary" />
                ) : (
                  <Bot className="w-4 h-4 text-muted-foreground" />
                )}
              </div>
              <div className={cn(
                "flex flex-col gap-2 max-w-[85%]",
                message.role === 'user' && "items-end"
              )}>
                <div className={cn(
                  "rounded-lg px-3 py-2 text-sm",
                  message.role === 'user' 
                    ? "bg-primary text-primary-foreground" 
                    : "bg-muted"
                )}>
                  <pre className="whitespace-pre-wrap font-sans">{message.content}</pre>
                </div>
                {message.command && (
                  <div className="flex items-center gap-2 bg-background border border-border rounded-lg px-3 py-2">
                    <code className="text-xs text-primary font-mono flex-1">{message.command}</code>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs gap-1"
                      onClick={() => executeCommand(message.command!)}
                    >
                      <Play className="w-3 h-3" />
                      执行
                    </Button>
                  </div>
                )}
                <span className="text-[10px] text-muted-foreground">
                  {message.timestamp.toLocaleTimeString('zh-CN', { 
                    hour: '2-digit', 
                    minute: '2-digit' 
                  })}
                </span>
              </div>
            </div>
          ))}

          {/* AI 正在响应 */}
          {isAiResponding && (
            <div className="flex gap-3">
              <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center shrink-0">
                <Bot className="w-4 h-4 text-muted-foreground animate-pulse" />
              </div>
              <div className="bg-muted rounded-lg px-3 py-2">
                <div className="flex gap-1">
                  <span className="w-2 h-2 bg-primary/50 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-2 h-2 bg-primary/50 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-2 h-2 bg-primary/50 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 输入区域 */}
        <div className="border-t border-border p-3 bg-muted/20">
          <div className="flex gap-2 items-end">
            <textarea
              ref={chatInputRef}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={handleChatKeyDown}
              placeholder="用自然语言描述你想做什么..."
              className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm resize-none outline-none focus:border-primary/50 transition-colors min-h-[40px] max-h-[120px]"
              rows={1}
            />
            <Button
              size="sm"
              className="h-10 px-3"
              onClick={handleChatSubmit}
              disabled={!chatInput.trim() || isAiResponding}
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground mt-2">
            按 Enter 发送，Shift + Enter 换行
          </p>
        </div>
      </div>
    </div>
  )
}
