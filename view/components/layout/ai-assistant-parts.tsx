'use client'

import { memo } from 'react'
import { AiMarkdown } from '@/components/layout/ai-markdown'
import { ThinkingIndicator } from '@/components/layout/thinking-indicator'
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
import { toolStatusToUiState, messageHasRunningTools, assistantTextContent } from '@/lib/chat-stream-parts'
import type { ChatMessage, ChatMessagePart } from '@/lib/types'

interface AiAssistantPartsProps {
  message: ChatMessage
  isStreaming?: boolean
}

function timelineParts(parts: ChatMessagePart[] | undefined): ChatMessagePart[] {
  return (parts ?? []).filter(
    p => p.kind === 'reasoning' || p.kind === 'tool' || p.kind === 'text'
  )
}

export const AiAssistantParts = memo(function AiAssistantParts({
  message,
  isStreaming = false,
}: AiAssistantPartsProps) {
  const reasoning = message.reasoning?.trim() ?? ''
  const tools = message.tools ?? []
  const tasks = message.tasks ?? []
  const hasRunningTools = messageHasRunningTools(message)
  const replyText = assistantTextContent(message)
  const showReplyStream = Boolean(replyText.trim()) || (isStreaming && !hasRunningTools)

  const reasoningStreaming = isStreaming && !replyText.trim() && !hasRunningTools && !reasoning

  const parts = timelineParts(message.parts)
  const toolIdsInParts = new Set(
    parts.filter(p => p.kind === 'tool').map(p => p.toolId)
  )
  const orphanTools = tools.filter(t => !toolIdsInParts.has(t.id))
  // 时间线已内联渲染正文时，底部不再重复渲染整段 message.content
  const hasInlineText = parts.some(p => p.kind === 'text')

  const renderTimeline = () =>
    parts.map((p, idx) => {
      if (p.kind === 'text') {
        if (!p.content.trim()) return null
        const isLastPart = idx === parts.length - 1
        return (
          <AiMarkdown
            key={`text-${idx}`}
            content={p.content}
            isStreaming={isStreaming && isLastPart && !hasRunningTools}
          />
        )
      }

      if (p.kind === 'reasoning') {
        const trimmed = p.content.trim()
        if (!trimmed) return null
        return (
          <Reasoning key={`reasoning-${idx}`} className="w-full mb-0" isStreaming={reasoningStreaming}>
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
            <ReasoningContent>{trimmed}</ReasoningContent>
          </Reasoning>
        )
      }

      if (p.kind === 'tool') {
        const tool = tools.find(t => t.id === p.toolId)
        if (!tool) return null
        return (
          <Tool key={`tool-${p.toolId}`} defaultOpen={false}>
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
        )
      }

      return null
    })

  return (
    <div className="space-y-3 min-w-0">
      {parts.length > 0 ? (
        <>
          {renderTimeline()}
          {orphanTools.map(tool => (
            <Tool key={`orphan-tool-${tool.id}`} defaultOpen={false}>
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
        </>
      ) : (
        <>
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

          {tools.map(tool => (
            <Tool key={tool.id} defaultOpen={false}>
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
        </>
      )}

      {/* 时间线未内联正文时（无 parts 或仅工具/思考），底部回退渲染 message.content */}
      {showReplyStream && !hasInlineText && (
        <AiMarkdown content={replyText} isStreaming={isStreaming && !hasRunningTools} />
      )}

      {/* Claude 静默间隙（工具执行 / 等待生成回复）的实时活动指示，秒数递增即未卡死 */}
      {isStreaming && !replyText.trim() && (
        <ThinkingIndicator
          label={hasRunningTools ? '正在执行命令' : '处理中'}
          className="text-xs"
        />
      )}

      {tasks.length > 0 && !message.parts?.length && (
        <Queue className="rounded-md border border-border/60 bg-background/40">
          <QueueSection defaultOpen={false}>
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
    </div>
  )
}, (prev, next) => {
  if (prev.isStreaming !== next.isStreaming) return false
  if (prev.message.id !== next.message.id) return false
  return (
    prev.message.content === next.message.content &&
    prev.message.reasoning === next.message.reasoning &&
    prev.message.tools === next.message.tools &&
    prev.message.tasks === next.message.tasks &&
    prev.message.parts === next.message.parts
  )
})
