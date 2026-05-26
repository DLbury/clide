'use client'

import { useState, useRef, useEffect } from 'react'
import { Send, Sparkles, Terminal, Copy, Check, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChatMessage } from '@/lib/types'
import { AiMarkdown } from '@/components/layout/ai-markdown'

interface AiChatPanelProps {
  messages: ChatMessage[]
  isThinking: boolean
  onSendMessage: (message: string) => void
  onExecuteCommand: (command: string) => void
}

export function AiChatPanel({ messages, isThinking, onSendMessage, onExecuteCommand }: AiChatPanelProps) {
  const [input, setInput] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Auto scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = () => {
    if (input.trim() && !isThinking) {
      onSendMessage(input.trim())
      setInput('')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const copyToClipboard = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const lastMessageId = messages[messages.length - 1]?.id

  return (
    <div className="h-full flex flex-col bg-card">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <Sparkles className="w-4 h-4 text-primary" />
        <span className="font-medium text-sm">AI 助手</span>
        {isThinking && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground ml-auto">
            <Loader2 className="w-3 h-3 animate-spin" />
            思考中...
          </span>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-auto p-3 space-y-4 terminal-scrollbar select-text-region">
        {messages.length === 0 && (
          <div className="text-center py-8">
            <Sparkles className="w-8 h-8 text-primary/50 mx-auto mb-3" />
            <p className="text-muted-foreground text-sm">
              你好！我是 AI 助手。
            </p>
            <p className="text-muted-foreground text-xs mt-1">
              告诉我你想做什么，我会帮你生成命令。
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={cn(
              "flex",
              msg.role === 'user' ? "justify-end" : "justify-start"
            )}
          >
            <div
              className={cn(
                "max-w-[85%] rounded-lg px-3 py-2",
                msg.role === 'user'
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted"
              )}
            >
              {msg.role === 'user' ? (
                <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
              ) : (
                <AiMarkdown
                  content={msg.content}
                  isStreaming={isThinking && msg.id === lastMessageId}
                />
              )}
              
              {/* Command suggestion */}
              {msg.command && (
                <div className="mt-2 pt-2 border-t border-border/50">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                    <Terminal className="w-3 h-3" />
                    <span>建议命令</span>
                  </div>
                  <div className="flex items-center gap-2 bg-background/50 rounded px-2 py-1.5">
                    <code className="flex-1 text-xs font-mono">{msg.command}</code>
                    <button
                      onClick={() => copyToClipboard(msg.command!, msg.id)}
                      className="p-1 rounded hover:bg-muted shrink-0"
                      title="复制"
                    >
                      {copiedId === msg.id ? (
                        <Check className="w-3 h-3 text-primary" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                    </button>
                    <button
                      onClick={() => onExecuteCommand(msg.command!)}
                      className="px-2 py-0.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90"
                    >
                      执行
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}

        {isThinking && (
          <div className="flex justify-start">
            <div className="bg-muted rounded-lg px-3 py-2">
              <div className="flex items-center gap-2">
                <div className="flex gap-1">
                  <span className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-3 border-t border-border">
        <div className="flex items-end gap-2 bg-muted/50 rounded-lg p-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入你的问题..."
            className="flex-1 bg-transparent resize-none outline-none text-sm min-h-[40px] max-h-[120px]"
            rows={1}
            disabled={isThinking}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isThinking}
            className={cn(
              "p-2 rounded-lg transition-colors shrink-0",
              input.trim() && !isThinking
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "bg-muted text-muted-foreground cursor-not-allowed"
            )}
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-muted-foreground mt-2 text-center">
          按 Enter 发送，Shift+Enter 换行
        </p>
      </div>
    </div>
  )
}
