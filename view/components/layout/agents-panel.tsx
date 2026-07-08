'use client'

import { Plus, MessageSquare, Loader2, Square, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AgentThread } from '@/lib/agent-thread-store'

interface AgentsPanelProps {
  threads: AgentThread[]
  activeThreadId: string | null
  onSelectThread: (threadId: string) => void
  onNewThread?: () => void
  onStopThread?: (threadId: string) => void
  onCollapse?: () => void
  showNewButton?: boolean
}

function statusDot(status: AgentThread['status']) {
  switch (status) {
    case 'running':
      return 'bg-primary animate-pulse'
    case 'stopped':
      return 'bg-muted-foreground/40'
    case 'error':
      return 'bg-destructive'
    default:
      return 'bg-muted-foreground/25'
  }
}

export function AgentsPanel({
  threads,
  activeThreadId,
  onSelectThread,
  onNewThread,
  onStopThread,
  onCollapse,
  showNewButton = true,
}: AgentsPanelProps) {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border shrink-0">
        <span className="text-sm font-medium">对话记录</span>
        <div className="flex items-center gap-0.5">
          {showNewButton && onNewThread && (
            <button
              type="button"
              onClick={onNewThread}
              className="icon-btn p-1 rounded-md hover:bg-accent"
              title="新对话"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          )}
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              className="icon-btn p-1 rounded-md hover:bg-accent"
              title="关闭"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="overflow-y-auto flex-1 min-h-0 py-1 terminal-scrollbar">
        {threads.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted-foreground">暂无对话</p>
        )}
        {threads.map(thread => {
          const active = thread.id === activeThreadId
          const isRunning = thread.status === 'running'
          return (
            <div
              key={thread.id}
              className={cn(
                'group flex items-center gap-2 px-3 py-2 cursor-pointer text-sm',
                active ? 'bg-accent/80' : 'hover:bg-accent/40'
              )}
              onClick={() => onSelectThread(thread.id)}
            >
              <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', statusDot(thread.status))} />
              {isRunning ? (
                <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-primary" />
              ) : (
                <MessageSquare className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="flex-1 truncate text-left">{thread.title || '新对话'}</span>
              {isRunning && onStopThread && (
                <button
                  type="button"
                  className="icon-btn p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-background/80"
                  title="停止"
                  onClick={e => {
                    e.stopPropagation()
                    onStopThread(thread.id)
                  }}
                >
                  <Square className="w-3 h-3" />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
