'use client'

import { useState, useRef, useEffect, useCallback, KeyboardEvent, useMemo } from 'react'
import { Send, Sparkles, Play, Loader2, Trash2, PlugZap, Square, Terminal, CornerDownLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChatMessage } from '@/lib/types'
import { AiAssistantParts } from '@/components/layout/ai-assistant-parts'
import { ThinkingIndicator } from '@/components/layout/thinking-indicator'
import type { McpRegisterStatus } from '@/lib/claude-client'
import { classifyInteractivePrompt } from '@/lib/shell-tool-executor'
import { claudePathLabel, uniqueClaudeCandidates } from '@/lib/claude-client'
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
  mcpStatus?: McpRegisterStatus | null
  mcpRegisterError?: string | null
  mcpRegistering?: boolean
  streamListenError?: string | null
  lastDiag?: string | null
  onRetryMcpRegister?: () => void
  onSendMessage: (message: string) => void
  onStopMessage?: () => void
  onExecuteCommand: (command: string) => void
  onClearChat: () => void
  onRegenerateMessage?: (messageId: string) => void
  claudePath?: string
  claudeCandidates?: string[]
  onClaudePathChange?: (path: string) => void
  /** 终端等待密码/交互输入时显示的提示信息 */
  interactivePrompt?: { sessionId: string; command: string; prompt: string } | null
  /** Claude 请求或 Shell 工具等待用户输入时为 true，控制发送/停止按钮 */
  isTaskActive?: boolean
  onPromptDismiss?: () => void
  onPromptCancel?: (sessionId: string) => void
  onFocusTerminal?: () => void
  onPromptSendInput?: (sessionId: string, input: string) => void
}

function serializeAssistantMessage(msg: ChatMessage): string {
  const sections: string[] = []
  if (msg.content?.trim()) {
    sections.push(msg.content.trim())
  }
  if (msg.command?.trim()) {
    sections.push(`【命令】\n${msg.command.trim()}`)
  }
  if (sections.length === 0 && msg.tools?.length) {
    const running = msg.tools.some(t => t.status === 'running' || t.status === 'pending')
    sections.push(running ? '正在执行工具调用…' : '工具调用已完成，等待回复…')
  }
  if (sections.length === 0 && msg.reasoning?.trim()) {
    sections.push('思考中…')
  }
  return sections.join('\n\n').trim()
}

export function AiPane({
  messages,
  isThinking,
  aiEnabled,
  modelLabel,
  bridgeStatus,
  mcpStatus,
  mcpRegisterError,
  mcpRegistering = false,
  streamListenError,
  lastDiag,
  onRetryMcpRegister,
  onSendMessage,
  onStopMessage,
  onExecuteCommand,
  onClearChat,
  onRegenerateMessage,
  claudePath,
  claudeCandidates = [],
  onClaudePathChange,
  interactivePrompt,
  isTaskActive,
  onPromptDismiss,
  onPromptCancel,
  onFocusTerminal,
  onPromptSendInput,
}: AiPaneProps) {
  const [input, setInput] = useState('')
  const [historyIndex, setHistoryIndex] = useState(-1)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const userMessageHistory = useMemo(
    () =>
      messages
        .filter(m => m.role === 'user' && m.content.trim())
        .map(m => m.content.trim()),
    [messages]
  )

  const showManualMcp =
    Boolean(mcpRegisterError) || (mcpStatus != null && !mcpStatus.ready)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isThinking])

  const handleRegisterMcp = useCallback(() => {
    onRetryMcpRegister?.()
  }, [onRetryMcpRegister])

  const taskActive = isTaskActive ?? isThinking
  const promptKind = interactivePrompt
    ? classifyInteractivePrompt(interactivePrompt.prompt)
    : null

  const handleSend = useCallback(() => {
    if (!input.trim() || taskActive || !aiEnabled) return
    onSendMessage(input.trim())
    setInput('')
    setHistoryIndex(-1)
  }, [input, taskActive, aiEnabled, onSendMessage])

  const handlePrimaryAction = useCallback(() => {
    if (taskActive) {
      onStopMessage?.()
      return
    }
    handleSend()
  }, [taskActive, onStopMessage, handleSend])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
        return
      }
      if (e.key === 'ArrowUp' && !e.shiftKey && userMessageHistory.length > 0) {
        e.preventDefault()
        const atOldest =
          historyIndex >= userMessageHistory.length - 1
        const newIndex = atOldest
          ? historyIndex
          : historyIndex < userMessageHistory.length - 1
            ? historyIndex + 1
            : 0
        setHistoryIndex(newIndex)
        setInput(userMessageHistory[userMessageHistory.length - 1 - newIndex] ?? '')
        return
      }
      if (e.key === 'ArrowDown' && !e.shiftKey && historyIndex >= 0) {
        e.preventDefault()
        if (historyIndex > 0) {
          const newIndex = historyIndex - 1
          setHistoryIndex(newIndex)
          setInput(userMessageHistory[userMessageHistory.length - 1 - newIndex] ?? '')
        } else {
          setHistoryIndex(-1)
          setInput('')
        }
      }
    },
    [handleSend, userMessageHistory, historyIndex]
  )

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {})
  }

  const copySelectionOrMessage = (msg: ChatMessage) => {
    const selected = window.getSelection?.()?.toString()?.trim()
    if (selected) {
      copyText(selected)
      return
    }
    if (msg.role === 'assistant') {
      copyText(serializeAssistantMessage(msg) || msg.content || '')
    } else {
      copyText(msg.content || '')
    }
  }

  const copyAllMessages = () => {
    const text = messages
      .map(m => {
        if (m.role === 'assistant') {
          return `Assistant:\n${serializeAssistantMessage(m) || m.content || ''}`
        }
        return `User:\n${m.content || ''}`
      })
      .filter(Boolean)
      .join('\n\n----------------\n\n')
    if (text.trim()) copyText(text)
  }

  const exportChat = () => {
    if (messages.length === 0) return
    const markdown = messages
      .map(m => {
        const heading = m.role === 'assistant' ? '## Assistant' : '## User'
        const body =
          m.role === 'assistant'
            ? serializeAssistantMessage(m) || m.content || ''
            : m.content || ''
        return `${heading}\n\n${body}`
      })
      .join('\n\n---\n\n')
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `clide-chat-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const lastMessage = messages[messages.length - 1]
  const lastMessageId = lastMessage?.id
  const showThinkingPlaceholder =
    isThinking &&
    lastMessage?.role === 'assistant' &&
    !assistantHasVisibleContent(lastMessage)

  const installOptions = useMemo(
    () => uniqueClaudeCandidates(claudeCandidates),
    [claudeCandidates]
  )
  const showClaudeSwitch = installOptions.length > 1 && Boolean(onClaudePathChange)

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
          <ContextMenuItem onClick={copyAllMessages} disabled={messages.length === 0}>
            全部复制
          </ContextMenuItem>
          <ContextMenuItem onClick={exportChat} disabled={messages.length === 0}>
            导出对话
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {!aiEnabled && (
        <div className="px-4 py-2 text-xs bg-muted/50 text-muted-foreground border-b border-border">
          AI 已关闭，请在全局设置（Ctrl+,）中启用，或点击状态栏切换
        </div>
      )}

      {aiEnabled && showClaudeSwitch && (
        <div className="px-4 py-2 text-[11px] border-b border-border bg-muted/20">
          <label className="flex items-center gap-2 min-w-0">
            <span className="shrink-0 text-muted-foreground">Claude</span>
            <select
              value={claudePath ?? ''}
              onChange={e => onClaudePathChange?.(e.target.value)}
              className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-[11px] outline-none focus:ring-1 focus:ring-primary"
              title={claudePath || '自动选择'}
            >
              <option value="">自动选择</option>
              {installOptions.map(path => (
                <option key={path} value={path}>
                  {claudePathLabel(path)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {aiEnabled && bridgeStatus && (
        <div className="px-4 py-2 text-[11px] border-b border-border space-y-1.5">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'w-1.5 h-1.5 rounded-full shrink-0',
                bridgeStatus.running && bridgeStatus.connected
                  ? 'bg-green-500'
                  : mcpRegistering || (bridgeStatus.running && !bridgeStatus.connected)
                    ? 'bg-amber-500'
                    : 'bg-muted-foreground'
              )}
            />
            <span className="text-muted-foreground inline-flex items-center gap-1">
              Claude Code
              {bridgeStatus.running && bridgeStatus.connected ? (
                <>· 已连接</>
              ) : mcpRegistering || (bridgeStatus.running && !bridgeStatus.connected) ? (
                <>
                  · 连接中
                  <Loader2 className="w-3 h-3 animate-spin" />
                </>
              ) : (
                <>· 未连接</>
              )}
            </span>
          </div>
          {/* 仅在出问题时提示，正常不打扰用户 */}
          {(streamListenError || mcpRegisterError) && (
            <div className="pl-3.5 space-y-1">
              {streamListenError && (
                <p className="text-red-600 dark:text-red-400 break-words">{streamListenError}</p>
              )}
              {mcpRegisterError && (
                <p className="text-amber-600 dark:text-amber-400 break-words">{mcpRegisterError}</p>
              )}
              {showManualMcp && onRetryMcpRegister && (
                <button
                  type="button"
                  onClick={() => void handleRegisterMcp()}
                  disabled={mcpRegistering}
                  className={cn(
                    'inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] border border-border',
                    'hover:bg-muted/60 transition-colors disabled:opacity-50'
                  )}
                >
                  {mcpRegistering ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <PlugZap className="w-3 h-3" />
                  )}
                  重新连接
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {interactivePrompt && (
        <div className="mx-4 mt-3 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-3 text-xs space-y-2.5">
          <div className="font-medium text-amber-800 dark:text-amber-300">
            {promptKind === 'password'
              ? '请在左侧终端输入密码'
              : promptKind === 'confirm'
                ? '请在左侧终端确认，或使用下方快捷按钮'
                : '终端正在等待您的输入'}
          </div>
          <div className="font-mono text-[11px] text-muted-foreground break-all">
            提示: {interactivePrompt.prompt}
          </div>
          <div className="font-mono text-[11px] text-muted-foreground truncate">
            命令: {interactivePrompt.command}
          </div>
          <p className="text-muted-foreground leading-relaxed">
            密码不会经过 AI，请直接在左侧 Shell 中输入（输入时不会显示字符）。输入完成后点击右侧「继续」。
          </p>
          <div className="flex flex-wrap gap-2 pt-0.5">
            <button
              type="button"
              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border text-xs hover:bg-muted/60"
              onClick={() => onFocusTerminal?.()}
            >
              <Terminal className="w-3 h-3" />
              聚焦终端
            </button>
            {promptKind === 'confirm' && (
              <button
                type="button"
                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border text-xs hover:bg-muted/60"
                onClick={() =>
                  onPromptSendInput?.(interactivePrompt.sessionId, 'yes\n')
                }
              >
                发送 yes
              </button>
            )}
            <button
              type="button"
              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border text-xs hover:bg-muted/60"
              onClick={() =>
                onPromptSendInput?.(interactivePrompt.sessionId, '\n')
              }
            >
              <CornerDownLeft className="w-3 h-3" />
              发送 Enter
            </button>
          </div>
          <div className="flex flex-wrap gap-2 pt-1 border-t border-amber-500/20">
            <button
              type="button"
              className="px-2.5 py-1 rounded bg-primary text-primary-foreground text-xs hover:bg-primary/90"
              onClick={onPromptDismiss}
            >
              继续
            </button>
            <button
              type="button"
              className="px-2.5 py-1 rounded border border-amber-500/40 text-xs hover:bg-amber-500/10"
              onClick={onPromptDismiss}
            >
              密码已输入
            </button>
            <button
              type="button"
              className="px-2.5 py-1 rounded border border-destructive/40 text-destructive text-xs hover:bg-destructive/10"
              onClick={() => onPromptCancel?.(interactivePrompt.sessionId)}
            >
              取消 (Ctrl+C)
            </button>
          </div>
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
                      'text-sm select-text-region',
                      msg.role === 'user'
                        ? 'max-w-[85%] rounded-lg px-3 py-2 bg-primary text-primary-foreground'
                        : 'max-w-full w-full'
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
                <ContextMenuItem onClick={() => copySelectionOrMessage(msg)}>
                  复制
                </ContextMenuItem>
                <ContextMenuItem onClick={copyAllMessages} disabled={messages.length === 0}>
                  全部复制
                </ContextMenuItem>
                {msg.role === 'assistant' && onRegenerateMessage && (
                  <ContextMenuItem
                    disabled={isThinking}
                    onClick={() => onRegenerateMessage(msg.id)}
                  >
                    重新生成
                  </ContextMenuItem>
                )}
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
              <div className="text-sm">
                <ThinkingIndicator label="正在等待 Claude 响应" />
              </div>
            </div>
          )}

        <div ref={messagesEndRef} />
      </div>

      <div className="p-3 border-t border-border">
        <div className="relative">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={aiEnabled ? '输入问题或描述你想执行的操作...' : 'AI 已关闭'}
            disabled={!aiEnabled}
            rows={2}
            className={cn(
              'w-full resize-none bg-muted rounded-lg px-3 py-3 pr-12 text-sm leading-relaxed',
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
            type="button"
            onClick={handlePrimaryAction}
            disabled={taskActive ? !aiEnabled : !input.trim() || !aiEnabled}
            className={cn(
              'absolute bottom-2.5 right-2.5 h-9 w-9',
              'flex items-center justify-center rounded-md transition-colors',
              taskActive
                ? 'bg-amber-500 text-white hover:bg-amber-600'
                : input.trim() && aiEnabled
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'bg-muted text-muted-foreground'
            )}
            title={taskActive ? '停止回复' : '发送'}
          >
            {taskActive ? (
              <Square className="w-4 h-4" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
