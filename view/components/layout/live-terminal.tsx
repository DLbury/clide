'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { cn } from '@/lib/utils'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { writeTerminal, resizeTerminal, readTerminalBufferSince } from '@/lib/terminal-client'
import { registerTerminalInputHandler } from '@/lib/terminal-input-registry'
import {
  getTerminalOutputBuffer,
  subscribeTerminalOutput,
  onTerminalResync,
  injectTerminalOutput,
} from '@/lib/terminal-stream'
import { useAppTheme } from '@/hooks/use-app-theme'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

const TERMINAL_GREEN = '#23d18b'
const TERMINAL_GREEN_LIGHT = '#15803d'

interface LiveTerminalProps {
  sessionId: string
  connected: boolean
  inputEnabled?: boolean
  clearSignal?: number
  className?: string
}

export function LiveTerminal({
  sessionId,
  connected,
  inputEnabled = true,
  clearSignal = 0,
  className,
}: LiveTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionIdRef = useRef(sessionId)
  const connectedRef = useRef(connected)
  const inputEnabledRef = useRef(inputEnabled)
  const dataDisposableRef = useRef<{ dispose: () => void } | null>(null)
  const resizeDisposableRef = useRef<{ dispose: () => void } | null>(null)
  const bufferSyncedRef = useRef(0)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const resizeRafRef = useRef<number | null>(null)
  const outputUnsubscribeRef = useRef<(() => void) | null>(null)
  const [termReady, setTermReady] = useState(false)
  const { isDark } = useAppTheme()

  sessionIdRef.current = sessionId
  connectedRef.current = connected
  inputEnabledRef.current = inputEnabled

  useEffect(() => {
    bufferSyncedRef.current = 0
  }, [sessionId])

  const syncPtySize = useCallback(() => {
    const term = termRef.current
    if (!term || !connectedRef.current) return
    void resizeTerminal(sessionIdRef.current, term.cols, term.rows).catch(() => {})
  }, [])

  const fit = useCallback(() => {
    try {
      fitRef.current?.fit()
      syncPtySize()
    } catch {
      /* container may be hidden */
    }
  }, [syncPtySize])

  const scheduleFit = useCallback(() => {
    if (resizeRafRef.current != null) return
    resizeRafRef.current = requestAnimationFrame(() => {
      resizeRafRef.current = null
      fit()
    })
  }, [fit])

  const copySelection = useCallback(() => {
    const term = termRef.current
    if (!term) return
    const text = term.getSelection()
    if (text) {
      navigator.clipboard.writeText(text).catch(() => {})
    }
  }, [])

  const selectAll = useCallback(() => {
    termRef.current?.selectAll()
  }, [])

  const pasteFromClipboard = useCallback(() => {
    if (!connectedRef.current || !inputEnabledRef.current) return
    void navigator.clipboard
      .readText()
      .then(text => {
        if (!text) return
        void writeTerminal(sessionIdRef.current, text).catch(() => {})
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const green = isDark ? TERMINAL_GREEN : TERMINAL_GREEN_LIGHT

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      lineHeight: 1.2,
      fontFamily: 'Consolas, "Courier New", monospace',
      convertEol: false,
      scrollback: 8000,
      theme: isDark
        ? {
            background: '#1e1e1e',
            foreground: green,
            cursor: green,
            selectionBackground: '#264f78',
            green,
            brightGreen: green,
          }
        : {
            background: '#ffffff',
            foreground: green,
            cursor: green,
            selectionBackground: '#add6ff',
            green,
            brightGreen: green,
          },
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)
    fitAddon.fit()

    dataDisposableRef.current = term.onData(data => {
      if (!connectedRef.current || !inputEnabledRef.current) return
      void writeTerminal(sessionIdRef.current, data).catch(() => {})
    })

    resizeDisposableRef.current = term.onResize(({ cols, rows }) => {
      if (!connectedRef.current || cols < 1 || rows < 1) return
      void resizeTerminal(sessionIdRef.current, cols, rows).catch(() => {})
    })

    termRef.current = term
    fitRef.current = fitAddon
    setTermReady(true)

    syncPtySize()
    const syncTimers = [50, 200, 500].map(ms =>
      setTimeout(() => syncPtySize(), ms)
    )

    resizeObserverRef.current = new ResizeObserver(() => scheduleFit())
    resizeObserverRef.current.observe(container)

    return () => {
      syncTimers.forEach(clearTimeout)
      if (resizeRafRef.current != null) cancelAnimationFrame(resizeRafRef.current)
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
      dataDisposableRef.current?.dispose()
      dataDisposableRef.current = null
      resizeDisposableRef.current?.dispose()
      resizeDisposableRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
      setTermReady(false)
    }
  }, [isDark, fit, scheduleFit, syncPtySize])

  const catchUpTerminalBuffer = useCallback(() => {
    const term = termRef.current
    if (!term) return
    const buffered = getTerminalOutputBuffer(sessionId)

    if (buffered.length < bufferSyncedRef.current) {
      term.clear()
      bufferSyncedRef.current = 0
      if (buffered) term.write(buffered)
      bufferSyncedRef.current = buffered.length
      return
    }

    if (buffered.length <= bufferSyncedRef.current) return
    term.write(buffered.slice(bufferSyncedRef.current))
    bufferSyncedRef.current = buffered.length
  }, [sessionId])

  const replayBufferToTerm = useCallback(() => {
    const term = termRef.current
    if (!term) return
    const buffered = getTerminalOutputBuffer(sessionId)
    term.clear()
    bufferSyncedRef.current = buffered.length
    if (!buffered) return
    const CHUNK = 32 * 1024
    if (buffered.length <= CHUNK) {
      term.write(buffered)
      return
    }
    let offset = 0
    const writeNext = () => {
      if (offset >= buffered.length) return
      const end = Math.min(offset + CHUNK, buffered.length)
      termRef.current?.write(buffered.slice(offset, end))
      offset = end
      if (offset < buffered.length) {
        setTimeout(writeNext, 0)
      }
    }
    writeNext()
  }, [sessionId])

  const syncBufferToTerm = useCallback(() => {
    const term = termRef.current
    if (!term) return
    if (bufferSyncedRef.current === 0) {
      replayBufferToTerm()
      return
    }
    catchUpTerminalBuffer()
  }, [catchUpTerminalBuffer, replayBufferToTerm])

  useEffect(() => {
    if (!termReady) return

    syncBufferToTerm()

    outputUnsubscribeRef.current?.()

    outputUnsubscribeRef.current = subscribeTerminalOutput(sessionId, event => {
      termRef.current?.write(event.data)
      bufferSyncedRef.current = getTerminalOutputBuffer(sessionId).length
    })

    const unsubResync = onTerminalResync(sid => {
      if (sid !== sessionId) return
      catchUpTerminalBuffer()
    })

    const unsubInput = registerTerminalInputHandler(sessionId, async data => {
      await writeTerminal(sessionId, data)
    })

    return () => {
      outputUnsubscribeRef.current?.()
      outputUnsubscribeRef.current = null
      unsubResync()
      unsubInput()
    }
  }, [sessionId, termReady, syncBufferToTerm, catchUpTerminalBuffer, replayBufferToTerm])

  useEffect(() => {
    if (connected && inputEnabled) {
      termRef.current?.focus()
      syncPtySize()
      scheduleFit()
    } else if (connected) {
      syncPtySize()
      scheduleFit()
    }
  }, [connected, inputEnabled, scheduleFit, syncPtySize])

  useEffect(() => {
    if (!termReady || !connected) return
    let cancelled = false
    const timer = setTimeout(() => {
      void readTerminalBufferSince(sessionId, 0)
        .then(buf => {
          if (cancelled || !buf || !termRef.current) return
          const local = getTerminalOutputBuffer(sessionId)
          if (buf.length > local.length) {
            catchUpTerminalBuffer()
          } else if (local.length === 0 && buf.length > 0) {
            injectTerminalOutput(sessionId, buf)
            termRef.current.write(buf)
            bufferSyncedRef.current = buf.length
          }
        })
        .catch(() => {})
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [sessionId, termReady, connected, catchUpTerminalBuffer])

  useEffect(() => {
    if (clearSignal > 0) {
      termRef.current?.clear()
      bufferSyncedRef.current = 0
    }
  }, [clearSignal])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={containerRef}
          className={cn('select-text-region overflow-hidden', className ?? 'h-full w-full min-h-0')}
          onClick={() => termRef.current?.focus()}
        />
      </ContextMenuTrigger>
      <ContextMenuContent className="w-40">
        <ContextMenuItem onClick={copySelection}>复制</ContextMenuItem>
        <ContextMenuItem onClick={pasteFromClipboard} disabled={!connected || !inputEnabled}>
          粘贴
        </ContextMenuItem>
        <ContextMenuItem onClick={selectAll}>全选</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => {
            termRef.current?.clear()
            bufferSyncedRef.current = 0
          }}
        >
          清屏
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
