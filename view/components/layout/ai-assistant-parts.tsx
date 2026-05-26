'use client'

import { AiMarkdown } from '@/components/layout/ai-markdown'
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '@/components/ai-elements/reasoning'
import {
  Queue,
  QueueItem,
  QueueItemContent,
  QueueItemDescription,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from '@/components/ai-elements/queue'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool'
import { toolStatusToUiState } from '@/lib/chat-stream-parts'
import type { ChatMessage } from '@/lib/types'

interface AiAssistantPartsProps {
  message: ChatMessage
  isStreaming?: boolean
}

export function AiAssistantParts({ message, isStreaming = false }: AiAssistantPartsProps) {
  const reasoning = message.reasoning?.trim() ?? ''
  const tools = message.tools ?? []
  const tasks = message.tasks ?? []
  const reasoningStreaming = isStreaming && !message.content.trim()

  return (
    <div className="space-y-3 min-w-0">
      {reasoning && (
        <Reasoning className="w-full mb-0" isStreaming={reasoningStreaming}>
          <ReasoningTrigger
            getThinkingMessage={(streaming, duration) => {
              if (streaming || duration === 0) {
                return <span className="text-muted-foreground">思考中…</span>
              }
              if (duration === undefined) {
                return <span>已完成思考</span>
              }
              return <span>思考 {duration} 秒</span>
            }}
          />
          <ReasoningContent>{reasoning}</ReasoningContent>
        </Reasoning>
      )}

      {tasks.length > 0 && (
        <Queue className="rounded-md border border-border/60 bg-background/40">
          <QueueSection defaultOpen={isStreaming}>
            <QueueSectionTrigger>
              <QueueSectionLabel count={tasks.length} label="任务进度" />
            </QueueSectionTrigger>
            <QueueSectionContent>
              <QueueList>
                {tasks.map(task => (
                  <QueueItem key={task.id}>
                    <div className="flex items-start gap-2">
                      <QueueItemIndicator completed={task.status === 'completed'} />
                      <div className="min-w-0 flex-1">
                        <QueueItemContent completed={task.status === 'completed'}>
                          {task.title}
                        </QueueItemContent>
                        {task.description && (
                          <QueueItemDescription completed={task.status === 'completed'}>
                            {task.description}
                          </QueueItemDescription>
                        )}
                      </div>
                    </div>
                  </QueueItem>
                ))}
              </QueueList>
            </QueueSectionContent>
          </QueueSection>
        </Queue>
      )}

      {tools.map(tool => (
        <Tool
          key={tool.id}
          defaultOpen={tool.status === 'running' || tool.status === 'error'}
        >
          <ToolHeader
            type="dynamic-tool"
            toolName={tool.name.replace(/^mcp__aiterm__/, '')}
            state={toolStatusToUiState(tool.status)}
            title={tool.name.replace(/^mcp__aiterm__/, '')}
          />
          <ToolContent>
            {tool.input !== undefined && <ToolInput input={tool.input} />}
            <ToolOutput output={tool.output} errorText={tool.error} />
          </ToolContent>
        </Tool>
      ))}

      {message.content.trim() && (
        <AiMarkdown content={message.content} isStreaming={isStreaming} />
      )}
    </div>
  )
}
