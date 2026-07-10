'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export function useResizableColumns(
  storageKey: string,
  defaults: Record<string, number>
) {
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    if (typeof window === 'undefined') return defaults
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) return { ...defaults, ...(JSON.parse(raw) as Record<string, number>) }
    } catch {
      /* ignore */
    }
    return defaults
  })

  const dragRef = useRef<{ col: string; startX: number; startW: number } | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(widths))
    } catch {
      /* ignore */
    }
  }, [storageKey, widths])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const delta = e.clientX - drag.startX
      const next = Math.max(40, drag.startW + delta)
      setWidths(prev => ({ ...prev, [drag.col]: next }))
    }
    const onUp = () => {
      dragRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const startResize = useCallback(
    (col: string, e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragRef.current = {
        col,
        startX: e.clientX,
        startW: widths[col] ?? defaults[col] ?? 80,
      }
    },
    [widths, defaults]
  )

  const colStyle = useCallback(
    (col: string) => ({ width: widths[col] ?? defaults[col] ?? 80 }),
    [widths, defaults]
  )

  return { widths, startResize, colStyle }
}
