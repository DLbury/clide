'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ThinkingIndicatorProps {
  /** 阶段文案，如「思考中」「正在执行命令」「生成回复中」 */
  label?: string
  className?: string
}

/**
 * 带秒数的活动指示器。秒数持续递增即可证明前端在等待而非冻结，
 * 用于 Claude 静默间隙（冷启动、工具完成后再生成）让用户分辨「在跑」还是「卡住」。
 */
export function ThinkingIndicator({ label = '思考中', className }: ThinkingIndicatorProps) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const start = Date.now()
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000))
    }, 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <span className={cn('flex items-center gap-2 text-muted-foreground', className)}>
      <Loader2 className="w-4 h-4 animate-spin text-primary" />
      <span>
        {label}
        {elapsed > 0 ? ` · ${elapsed}s` : ''}
      </span>
    </span>
  )
}
