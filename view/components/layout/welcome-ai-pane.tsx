'use client'

import { useState, useRef, useEffect, useCallback, KeyboardEvent } from 'react'
import {
  Send,
  Sparkles,
  Loader2,
  Server,
  Terminal,
  Wifi,
  ChevronRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { AppLogo } from '@/components/app-logo'
import { APP_NAME } from '@/lib/app-brand'
import type { ChatMessage, Session } from '@/lib/types'
import { AiMarkdown } from '@/components/layout/ai-markdown'
import type { ConnectionIntent } from '@/lib/ai-connection-parser'

interface WelcomeAiPaneProps {
  messages: ChatMessage[]
  isThinking: boolean
  onSendMessage: (message: string) => void
  onConnectIntent: (intent: ConnectionIntent) => void
  onConnectSession: (sessionId: string) => void
  onNewSession: () => void
  availableSessions: Session[]
}

const QUICK_PROMPTS = ['列出所有服务器', '打开本地终端', '帮助']

const TYPE_ICONS: Record<string, typeof Server> = {
  ssh: Server,
  telnet: Wifi,
  local: Terminal,
  docker: Terminal,
  wsl: Terminal,
  serial: Terminal,
  vnc: Terminal,
  rdp: Terminal,
}

export function WelcomeAiPane({
  messages,
  isThinking,
  onSendMessage,
  onConnectIntent,
  onConnectSession,
  onNewSession,
  availableSessions,
}: WelcomeAiPaneProps) {
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isThinking])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSend = useCallback(() => {
    if (!input.trim() || isThinking) return
    onSendMessage(input.trim())
    setInput('')
  }, [input, isThinking, onSendMessage])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  const disconnectedSessions = availableSessions.filter(s => s.status !== 'connected')

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col max-w-3xl mx-auto w-full">
          <div className="flex-1 overflow-auto px-6 py-8 terminal-scrollbar select-text-region">
            {messages.length === 0 ? (
              <EmptyWelcome
                disconnectedSessions={disconnectedSessions}
                onSendMessage={onSendMessage}
                onConnectSession={onConnectSession}
              />
            ) : (
              <div className="space-y-6">
                {messages.map(msg => (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    isStreaming={
                      isThinking && msg.id === messages[messages.length - 1]?.id
                    }
                    onConnectIntent={onConnectIntent}
                    onConnectSession={onConnectSession}
                  />
                ))}
                {isThinking && (
                  <div className="flex justify-start">
                    <div className="bg-muted rounded-xl px-4 py-3 flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin text-primary" />
                      <span className="text-sm text-muted-foreground">思考中...</span>
                    </div>
                  </div>
                )}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="px-6 pb-6 pt-2">
            <div className="relative border border-border rounded-xl bg-card shadow-sm focus-within:ring-1 focus-within:ring-primary/50">
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="描述你想连接的服务器，例如：SSH 连接到 192.168.1.100，用户 root..."
                rows={1}
                disabled={isThinking}
                className={cn(
                  'w-full resize-none bg-transparent px-4 py-3 pr-12 text-sm outline-none',
                  'max-h-32 overflow-auto terminal-scrollbar'
                )}
                onInput={e => {
                  const target = e.target as HTMLTextAreaElement
                  target.style.height = 'auto'
                  target.style.height = Math.min(target.scrollHeight, 128) + 'px'
                }}
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || isThinking}
                className={cn(
                  'absolute right-2 bottom-2 p-2 rounded-lg transition-colors',
                  input.trim() && !isThinking
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'bg-muted text-muted-foreground cursor-not-allowed'
                )}
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
            <div className="flex items-center justify-between mt-2 px-1">
              <p className="text-xs text-muted-foreground">Enter 发送 · Shift+Enter 换行</p>
              <button onClick={onNewSession} className="text-xs text-primary hover:underline">
                手动新建会话
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function EmptyWelcome({
  disconnectedSessions,
  onSendMessage,
  onConnectSession,
}: {
  disconnectedSessions: Session[]
  onSendMessage: (msg: string) => void
  onConnectSession: (id: string) => void
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center">
      <AppLogo size={64} className="rounded-2xl mb-6 shadow-sm" />
      <h1 className="text-2xl font-semibold mb-2">{APP_NAME}</h1>
      <p className="text-muted-foreground text-sm max-w-md mb-8">
        通过 AI 对话连接服务器、管理终端。描述你想连接的目标，我会帮你完成配置。
      </p>

      <div className="grid grid-cols-2 gap-2 w-full max-w-lg mb-8">
        {QUICK_PROMPTS.map(prompt => (
          <button
            key={prompt}
            onClick={() => onSendMessage(prompt)}
            className={cn(
              'text-left text-sm px-4 py-3 rounded-lg border border-border',
              'hover:bg-muted/50 hover:border-primary/30 transition-colors'
            )}
          >
            {prompt}
          </button>
        ))}
      </div>

      {disconnectedSessions.length > 0 && (
        <div className="w-full max-w-lg">
          <p className="text-xs text-muted-foreground mb-3 uppercase tracking-wider">
            快速连接
          </p>
          <div className="space-y-1">
            {disconnectedSessions.slice(0, 5).map(session => {
              const Icon = TYPE_ICONS[session.type] ?? Server
              return (
                <button
                  key={session.id}
                  onClick={() => onConnectSession(session.id)}
                  className={cn(
                    'w-full flex items-center gap-3 px-4 py-2.5 rounded-lg',
                    'hover:bg-muted/50 transition-colors text-left group'
                  )}
                >
                  <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{session.name}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {session.type.toUpperCase()} → {session.host}
                      {session.port ? `:${session.port}` : ''}
                    </p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function MessageBubble({
  message,
  isStreaming,
  onConnectIntent,
  onConnectSession,
}: {
  message: ChatMessage
  isStreaming?: boolean
  onConnectIntent: (intent: ConnectionIntent) => void
  onConnectSession: (sessionId: string) => void
}) {
  const isUser = message.role === 'user'

  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[90%] rounded-xl px-4 py-3 text-sm',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted'
        )}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap leading-relaxed">{message.content}</p>
        ) : (
          <AiMarkdown content={message.content} isStreaming={isStreaming} />
        )}

        {message.connectionIntent && message.role === 'assistant' && (
          <div className="mt-3 pt-3 border-t border-border/50">
            <ConnectionCard
              intent={message.connectionIntent}
              onConnect={() => onConnectIntent(message.connectionIntent!)}
            />
          </div>
        )}

        {message.sessionId && message.role === 'assistant' && (
          <div className="mt-3">
            <button
              onClick={() => onConnectSession(message.sessionId!)}
              className="flex items-center gap-2 px-3 py-1.5 text-xs bg-primary/20 hover:bg-primary/30 rounded-lg transition-colors"
            >
              <Server className="w-3.5 h-3.5" />
              立即连接
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function ConnectionCard({
  intent,
  onConnect,
}: {
  intent: ConnectionIntent
  onConnect: () => void
}) {
  const Icon = TYPE_ICONS[intent.type] ?? Server

  return (
    <div className="bg-background/50 rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4 text-primary" />
        <span className="font-medium text-xs">{intent.type.toUpperCase()} 连接</span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        {intent.host && (
          <>
            <span className="text-muted-foreground">主机</span>
            <span className="font-mono">{intent.host}{intent.port ? `:${intent.port}` : ''}</span>
          </>
        )}
        {intent.user && (
          <>
            <span className="text-muted-foreground">用户</span>
            <span className="font-mono">{intent.user}</span>
          </>
        )}
      </div>
      {intent.missingFields.length === 0 && (
        <button
          onClick={onConnect}
          className="w-full mt-1 flex items-center justify-center gap-2 px-3 py-2 text-xs bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
        >
          <Server className="w-3.5 h-3.5" />
          确认连接
        </button>
      )}
    </div>
  )
}
