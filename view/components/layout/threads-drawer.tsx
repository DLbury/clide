'use client'

import { cn } from '@/lib/utils'
import { AgentsPanel } from '@/components/layout/agents-panel'
import type { AgentThread } from '@/lib/agent-thread-store'

interface ThreadsDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  threads: AgentThread[]
  activeThreadId: string | null
  onSelectThread: (threadId: string) => void
  onStopThread?: (threadId: string) => void
}

export function ThreadsDrawer({
  open,
  onOpenChange,
  threads,
  activeThreadId,
  onSelectThread,
  onStopThread,
}: ThreadsDrawerProps) {
  if (!open) return null

  return (
    <>
      <button
        type="button"
        aria-label="关闭对话列表"
        className="absolute inset-0 z-40 bg-black/35"
        onClick={() => onOpenChange(false)}
      />
      <div
        className={cn(
          'absolute inset-y-0 right-0 z-50 flex flex-col w-72 max-w-[min(85%,20rem)]',
          'bg-background border-l border-border shadow-2xl',
          'animate-in slide-in-from-right duration-300'
        )}
      >
        <AgentsPanel
          threads={threads}
          activeThreadId={activeThreadId}
          onSelectThread={threadId => {
            onSelectThread(threadId)
            onOpenChange(false)
          }}
          onStopThread={onStopThread}
          onCollapse={() => onOpenChange(false)}
          showNewButton={false}
        />
      </div>
    </>
  )
}
