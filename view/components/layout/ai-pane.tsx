'use client'

import { useState, useRef, useEffect, useCallback, KeyboardEvent } from 'react'
import { Send, Sparkles, Play, Loader2, Trash2, PlugZap } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChatMessage } from '@/lib/types'
import { AiAssistantParts } from '@/components/layout/ai-assistant-parts'
import {
  getClaudeMcpStatus,
  registerClaudeMcp,
  type McpRegisterStatus,
} from '@/lib/claude-client'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

function assistantHasVisibleContent(msg: ChatMessage): boolean {
  return !!(
    msg.content?.trim() ||
    msg.reasoning?.trim() ||
    (msg.tools?.length ?? 0) > 0 ||
    (msg.tasks?.length ?? 0) > 0 ||
    msg.command
  )
}

interface AiPaneProps {
  messages: ChatMessage[]
  isThinking: boolean
  aiEnabled: boolean
  modelLabel?: string
  bridgeStatus?: {
    running: boolean
    connected: boolean
    hasClient?: boolean
    port?: number
    lockFile?: string
    workspaceFolders?: string[]
  }
  onSendMessage: (message: string) => void
  onExecuteCommand: (command: string) => void
  onClearChat: () => void
  claudePath?: string
}

export function AiPane({
  messages,
  isThinking,
  aiEnabled,
  modelLabel,
  bridgeStatus,
  onSendMessage,
  onExecuteCommand,
  onClearChat,
  claudePath,
}: AiPaneProps) {
  const [input, setInput] = useState('')
  const [mcpStatus, setMcpStatus] = useState<McpRegisterStatus | null>(null)
  const [mcpBusy, setMcpBusy] = useState(false)
  const [mcpError, setMcpError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isThinking])

  const refreshMcpStatus = useCallback(() => {
    if (!aiEnabled || !bridgeStatus?.running) {
      setMcpStatus(null)
      setMcpError(null)
      return
    }
    void getClaudeMcpStatus(claudePath)
      .then(status => {
        setMcpStatus(status)
        setMcpError(null)
      })
      .catch(() => setMcpStatus(null))
  }, [aiEnabled, bridgeStatus?.running, claudePath])

  useEffect(() => {
    refreshMcpStatus()
  }, [refreshMcpStatus])

  const handleRegisterMcp = useCallback(async () => {
    setMcpBusy(true)
    setMcpError(null)
    try {
      const status = await registerClaudeMcp(claudePath)
      setMcpStatus(status)
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err))
    } finally {
      setMcpBusy(false)
    }
  }, [claudePath])

  const handleSend = useCallback(() => {
    if (!input.trim() || isThinking || !aiEnabled) return
    onSendMessage(input.trim())
    setInput('')
  }, [input, isThinking, aiEnabled, onSendMessage])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {})
  }

  const lastMessage = messages[messages.length - 1]
  const lastMessageId = lastMessage?.id
  const showThinkingPlaceholder =
    isThinking &&
    lastMessage?.role === 'assistant' &&
    !assistantHasVisibleContent(lastMessage)

  return (
    <div className="h-full flex flex-col bg-card border-l border-border">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div className="flex items-center gap-2 min-w-0">
              <Sparkles className={cn('w-4 h-4 shrink-0', aiEnabled ? 'text-primary' : 'text-muted-foreground')} />
              <div className="min-w-0">
                <span className="font-medium text-sm">AI 助手</span>
                {modelLabel && (
                  <p className="text-xs text-muted-foreground truncate">{modelLabel}</p>
                )}
              </div>
            </div>
            <button
              onClick={onClearChat}
              disabled={messages.length === 0}
              className="p-1.5 rounded hover:bg-muted transition-colors disabled:opacity-40"
              title="清空对话"
            >
              <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          <ContextMenuItem onClick={onClearChat} disabled={messages.length === 0}>
            清空对话
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {!aiEnabled && (
        <div className="px-4 py-2 text-xs bg-muted/50 text-muted-foreground border-b border-border">
          AI 已关闭，请在全局设置（Ctrl+,）中启用，或点击状态栏切换
        </div>
      )}

      {aiEnabled && bridgeStatus && (
        <div className="px-4 py-2 text-[11px] border-b border-border space-y-1.5">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'w-1.5 h-1.5 rounded-full shrink-0',
                bridgeStatus.running ? 'bg-green-500' : 'bg-muted-foreground'
              )}
            />
            <span className="text-muted-foreground">
              Claude Code IDE 桥接
              {bridgeStatus.running
                ? bridgeStatus.connected
                  ? ` · 已就绪 (:${bridgeStatus.port})`
                  : ' · 未启动'
                : ' · 未启动'}
              {bridgeStatus.running &&
                bridgeStatus.connected &&
                bridgeStatus.hasClient === false && (
                  <span className="text-amber-600 dark:text-amber-400">
                    {' '}
                    · 等待 Claude 连接
                  </span>
                )}
            </span>
          </div>
          {bridgeStatus.running && bridgeStatus.connected && (
            <div className="text-muted-foreground/90 leading-relaxed pl-3.5 space-y-1.5">
              {bridgeStatus.workspaceFolders && bridgeStatus.workspaceFolders.length > 0 && (
                <p className="truncate" title={bridgeStatus.workspaceFolders.join(', ')}>
                  工作区：{bridgeStatus.workspaceFolders[0]}
                </p>
              )}
              {mcpStatus && (
                <>
                  <p className="truncate" title={mcpStatus.projectRoot}>
                    MCP 根目录：{mcpStatus.projectRoot}
                  </p>
                  <p>
                    项目 .mcp.json：
                    {mcpStatus.projectMcpConfigReady ? '已配置' : '未配置'}
                    {' · '}
                    Claude 登记：
                    {mcpStatus.claudeProjectRegistered ? '已登记' : '未登记'}
                  </p>
                  {(!mcpStatus.ready || !mcpStatus.claudeProjectRegistered) && (
                    <button
                      type="button"
                      onClick={() => void handleRegisterMcp()}
                      disabled={mcpBusy}
                      className={cn(
                        'inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] border border-border',
                        'hover:bg-muted/60 transition-colors disabled:opacity-50'
                      )}
                    >
                      {mcpBusy ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <PlugZap className="w-3 h-3" />
                      )}
                      手动注册 MCP
                    </button>
                  )}
                  {mcpError && (
                    <p className="text-amber-600 dark:text-amber-400 break-words">{mcpError}</p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-auto p-4 space-y-4 terminal-scrollbar select-text-region">
        {messages.length === 0 && (
          <div className="text-center text-muted-foreground text-sm py-6">
            <Sparkles className="w-8 h-8 mx-auto mb-3 text-primary/50" />
            <p>你好！我是 AI 助手</p>
            <p className="mt-1">可以帮你生成命令或解答问题</p>
          </div>
        )}

        {messages.map(msg => {
          const isStreamingMsg = isThinking && msg.id === lastMessageId
          const isEmptyStreamingAssistant =
            msg.role === 'assistant' && isStreamingMsg && !assistantHasVisibleContent(msg)

          if (isEmptyStreamingAssistant) return null

          return (
            <ContextMenu key={msg.id}>
              <ContextMenuTrigger asChild>
                <div className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                  <div
                    className={cn(
                      'rounded-lg px-3 py-2 text-sm',
                      msg.role === 'user'
                        ? 'max-w-[85%] bg-primary text-primary-foreground'
                        : 'max-w-full w-full bg-muted/80'
                    )}
                  >
                    {msg.role === 'user' ? (
                      <p className="whitespace-pre-wrap">{msg.content}</p>
                    ) : (
                      <AiAssistantParts
                        message={msg}
                        isStreaming={isStreamingMsg}
                      />
                    )}
                    {msg.command && msg.role === 'assistant' && (
                      <div className="mt-2 pt-2 border-t border-border/50">
                        <div className="flex items-center gap-2">
                          <code className="flex-1 text-xs bg-background/50 px-2 py-1 rounded font-mono">
                            {msg.command}
                          </code>
                          <button
                            onClick={() => onExecuteCommand(msg.command!)}
                            className="flex items-center gap-1 px-2 py-1 text-xs bg-primary/20 hover:bg-primary/30 rounded transition-colors"
                          >
                            <Play className="w-3 h-3" />
                            执行
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-40">
                <ContextMenuItem onClick={() => copyText(msg.content)}>复制</ContextMenuItem>
                {msg.command && (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={() => copyText(msg.command!)}>复制命令</ContextMenuItem>
                    <ContextMenuItem onClick={() => onExecuteCommand(msg.command!)}>执行命令</ContextMenuItem>
                  </>
                )}
              </ContextMenuContent>
            </ContextMenu>
          )
        })}

        {showThinkingPlaceholder && (
            <div className="flex justify-start">
              <div className="bg-muted rounded-lg px-3 py-2 text-sm flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                <span className="text-muted-foreground">思考中...</span>
              </div>
            </div>
          )}

        <div ref={messagesEndRef} />
      </div>

      <div className="p-3 border-t border-border">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={aiEnabled ? '输入问题或描述你想执行的操作...' : 'AI 已关闭'}
            disabled={!aiEnabled}
            rows={2}
            className={cn(
              'flex-1 resize-none bg-muted rounded-lg px-3 py-3 text-sm leading-relaxed',
              'outline-none focus:ring-2 focus:ring-primary/40',
              'min-h-[52px] max-h-36 overflow-auto disabled:opacity-50'
            )}
            onInput={e => {
              const target = e.target as HTMLTextAreaElement
              target.style.height = 'auto'
              target.style.height = Math.min(target.scrollHeight, 144) + 'px'
            }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isThinking || !aiEnabled}
            className={cn(
              'h-10 w-10 shrink-0 flex items-center justify-center rounded-lg transition-colors',
              input.trim() && !isThinking && aiEnabled
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'bg-muted text-muted-foreground'
            )}
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
