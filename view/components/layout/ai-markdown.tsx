'use client'

import { Streamdown } from 'streamdown'
import { code } from '@streamdown/code'
import { cn } from '@/lib/utils'

interface AiMarkdownProps {
  content: string
  /** 当前消息是否仍在流式输出中 */
  isStreaming?: boolean
  className?: string
}

export function AiMarkdown({ content, isStreaming = false, className }: AiMarkdownProps) {
  if (!content && !isStreaming) return null

  if (!content && isStreaming) {
    return (
      <div className={cn('ai-markdown min-w-0 text-sm leading-relaxed', className)}>
        <span className="inline-block w-0.5 h-4 bg-primary/80 animate-pulse align-middle" aria-hidden />
      </div>
    )
  }

  return (
    <div className={cn('ai-markdown min-w-0 text-sm leading-relaxed', className)}>
      <Streamdown animated isAnimating={isStreaming} plugins={{ code }}>
        {content}
      </Streamdown>
    </div>
  )
}
