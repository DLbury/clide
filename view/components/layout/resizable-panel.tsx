'use client'

import { Children, Fragment, useLayoutEffect, useRef } from 'react'
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from 'react-resizable-panels'
import { cn } from '@/lib/utils'

interface ResizablePanelProps {
  children: React.ReactNode[]
  direction: 'horizontal' | 'vertical'
  defaultSizes?: number[]
  minSizes?: number[]
  panelVisible?: boolean[]
  className?: string
}

export function ResizablePanel({
  children,
  direction,
  defaultSizes,
  minSizes = [],
  panelVisible,
  className,
}: ResizablePanelProps) {
  const childArray = Children.toArray(children)
  const panelRefs = useRef<(ImperativePanelHandle | null)[]>([])

  useLayoutEffect(() => {
    if (!panelVisible) return
    for (let i = 0; i < panelVisible.length; i++) {
      const panel = panelRefs.current[i]
      if (!panel) continue
      if (panelVisible[i]) {
        if (panel.isCollapsed()) panel.expand(minSizes[i] ?? 8)
      } else if (!panel.isCollapsed()) {
        panel.collapse()
      }
    }
  }, [panelVisible, minSizes])

  const isHorizontal = direction === 'horizontal'

  return (
    <PanelGroup
      direction={direction}
      className={cn('h-full w-full min-h-0 min-w-0', className)}
    >
      {childArray.map((child, index) => {
        const visible = panelVisible?.[index] !== false
        const nextVisible =
          index < childArray.length - 1 && panelVisible?.[index + 1] !== false

        return (
          <Fragment key={index}>
            <Panel
              ref={el => {
                panelRefs.current[index] = el
              }}
              defaultSize={
                defaultSizes?.[index] ?? 100 / Math.max(childArray.length, 1)
              }
              minSize={visible ? (minSizes[index] ?? 8) : 0}
              collapsible={panelVisible != null}
              collapsedSize={0}
              className="min-h-0 min-w-0 overflow-hidden"
            >
              <div
                className={cn(
                  'h-full w-full min-h-0 min-w-0 overflow-hidden',
                  !visible && 'pointer-events-none opacity-0'
                )}
              >
                {child}
              </div>
            </Panel>

            {index < childArray.length - 1 && visible && nextVisible && (
              <PanelResizeHandle
                className={cn(
                  'relative shrink-0 bg-border transition-colors hover:bg-primary/50',
                  'data-[resize-handle-state=drag]:bg-primary',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  isHorizontal
                    ? 'w-px after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2'
                    : 'h-px after:absolute after:inset-x-0 after:top-1/2 after:h-2 after:-translate-y-1/2'
                )}
              />
            )}
          </Fragment>
        )
      })}
    </PanelGroup>
  )
}
