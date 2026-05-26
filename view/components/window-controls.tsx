'use client'

import { useCallback, useEffect, useState } from 'react'
import { Minus, Square, Copy, Maximize2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isTauriRuntime } from '@/lib/tauri-env'

export function WindowControls({ className }: { className?: string }) {
  const [mounted, setMounted] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  const syncMaximized = useCallback(async () => {
    if (!isTauriRuntime()) return
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    setIsMaximized(await getCurrentWindow().isMaximized())
  }, [])

  useEffect(() => {
    void syncMaximized()
    if (!isTauriRuntime()) return

    let unlisten: (() => void) | undefined
    void (async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const win = getCurrentWindow()
      unlisten = await win.onResized(() => {
        void win.isMaximized().then(setIsMaximized)
      })
    })()

    return () => {
      unlisten?.()
    }
  }, [syncMaximized])

  // 避免 SSR/客户端 isTauriRuntime 不一致导致 hydration 报错
  if (!mounted || !isTauriRuntime()) {
    return null
  }

  const run = async (action: () => Promise<void>) => {
    try {
      await action()
    } catch (err) {
      console.error('[window-controls]', err)
    }
  }

  return (
    <div
      data-tauri-drag-region={false}
      className={cn('relative z-10 flex items-center shrink-0', className)}
    >
      <button
        type="button"
        data-tauri-drag-region={false}
        onClick={() =>
          run(async () => {
            const { getCurrentWindow } = await import('@tauri-apps/api/window')
            await getCurrentWindow().minimize()
          })
        }
        className="h-8 w-10 inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        title="最小化"
      >
        <Minus className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        data-tauri-drag-region={false}
        onClick={() =>
          run(async () => {
            const { getCurrentWindow } = await import('@tauri-apps/api/window')
            const win = getCurrentWindow()
            if (await win.isMaximized()) {
              await win.unmaximize()
            } else {
              await win.maximize()
            }
            setIsMaximized(await win.isMaximized())
          })
        }
        className="h-8 w-10 inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        title={isMaximized ? '还原' : '最大化'}
      >
        {isMaximized ? (
          <Copy className="w-3 h-3" />
        ) : (
          <Square className="w-3.5 h-3.5" />
        )}
      </button>
      <button
        type="button"
        data-tauri-drag-region={false}
        onClick={() =>
          run(async () => {
            const { getCurrentWindow } = await import('@tauri-apps/api/window')
            const win = getCurrentWindow()
            await win.setFullscreen(!(await win.isFullscreen()))
          })
        }
        className="h-8 w-10 inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        title="全屏"
      >
        <Maximize2 className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        data-tauri-drag-region={false}
        onClick={() =>
          run(async () => {
            const { getCurrentWindow } = await import('@tauri-apps/api/window')
            await getCurrentWindow().close()
          })
        }
        className="h-8 w-10 inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-destructive hover:text-destructive-foreground transition-colors"
        title="关闭"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
