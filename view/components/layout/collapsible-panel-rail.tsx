'use client'

import type { LucideIcon } from 'lucide-react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CollapsiblePanelRailProps {
  label: string
  icon: LucideIcon
  onExpand: () => void
  className?: string
}

export function CollapsiblePanelRail({
  label,
  icon: Icon,
  onExpand,
  className,
}: CollapsiblePanelRailProps) {
  return (
    <button
      type="button"
      onClick={onExpand}
      title={`展开${label}`}
      className={cn(
        'w-7 shrink-0 flex flex-col items-center justify-center gap-1.5',
        'border-r border-border bg-card text-muted-foreground',
        'hover:bg-muted/50 hover:text-foreground transition-colors',
        className
      )}
    >
      <ChevronRight className="w-3.5 h-3.5" />
      <Icon className="w-3.5 h-3.5" />
      <span
        className="text-[9px] leading-none tracking-wide select-none"
        style={{ writingMode: 'vertical-rl' }}
      >
        {label}
      </span>
    </button>
  )
}
