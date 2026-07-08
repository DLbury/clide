'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  computeVisibleRange,
  FILE_TREE_ROW_HEIGHT,
  type FlatFileRow,
} from '@/lib/file-tree-view'

interface VirtualFileTreeBodyProps {
  rows: FlatFileRow[]
  renderRow: (row: FlatFileRow, index: number) => ReactNode
  footer?: ReactNode
  className?: string
}

export function VirtualFileTreeBody({
  rows,
  renderRow,
  footer,
  className,
}: VirtualFileTreeBodyProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [viewportHeight, setViewportHeight] = useState(400)
  const [scrollTop, setScrollTop] = useState(0)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewportHeight(el.clientHeight))
    ro.observe(el)
    setViewportHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  const onScroll = useCallback(() => {
    const el = containerRef.current
    if (el) setScrollTop(el.scrollTop)
  }, [])

  const { start, end } = computeVisibleRange(scrollTop, viewportHeight, rows.length)
  const totalHeight = rows.length * FILE_TREE_ROW_HEIGHT
  const paddingTop = start * FILE_TREE_ROW_HEIGHT

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      className={className}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div style={{ transform: `translateY(${paddingTop}px)` }}>
          {rows.slice(start, end).map((row, i) => (
            <div key={row.item.id} style={{ height: FILE_TREE_ROW_HEIGHT }}>
              {renderRow(row, start + i)}
            </div>
          ))}
        </div>
      </div>
      {footer}
    </div>
  )
}
