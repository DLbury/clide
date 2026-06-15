'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { cn } from '@/lib/utils'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { writeTerminal, resizeTerminal } from '@/lib/terminal-client'
import { registerTerminalInputHandler } from '@/lib/terminal-input-registry'
import {
  getTerminalOutputBuffer,
  subscribeTerminalOutput,
  onTerminalResync,
} from '@/lib/terminal-stream'
import { useAppTheme } from '@/hooks/use-app-theme'

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

    termRef.current = term
    fitRef.current = fitAddon
    setTermReady(true)

    resizeObserverRef.current = new ResizeObserver(() => scheduleFit())
    resizeObserverRef.current.observe(container)

    return () => {
      if (resizeRafRef.current != null) cancelAnimationFrame(resizeRafRef.current)
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
      dataDisposableRef.current?.dispose()
      dataDisposableRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
      setTermReady(false)
    }
  }, [isDark, fit, scheduleFit])

  /** 从滚动缓冲完整重绘 xterm（切换标签 / 漏帧时），必须先 clear 再 write，避免重复叠加 */
  const replayBufferToTerm = useCallback(() => {
    const term = termRef.current
    if (!term) return
    const buffered = getTerminalOutputBuffer(sessionId)
    term.clear()
    bufferSyncedRef.current = buffered.length
    if (!buffered) return
    // 分块写入避免主线程长时间阻塞（缓冲可达 512KB）
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
    const buffered = getTerminalOutputBuffer(sessionId)
    if (buffered.length < bufferSyncedRef.current) {
      replayBufferToTerm()
      return
    }
    if (buffered.length <= bufferSyncedRef.current) return
    term.write(buffered.slice(bufferSyncedRef.current))
    bufferSyncedRef.current = buffered.length
  }, [sessionId, replayBufferToTerm])

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
      replayBufferToTerm()
    })

    const unsubInput = registerTerminalInputHandler(sessionId, async data => {
      await writeTerminal(sessionId, data)
      // PTY 输出经 subscribeTerminalOutput 增量写入，无需 resync（否则会整屏重复渲染）
    })

    return () => {
      outputUnsubscribeRef.current?.()
      outputUnsubscribeRef.current = null
      unsubResync()
      unsubInput()
    }
  }, [sessionId, termReady, syncBufferToTerm, replayBufferToTerm])

  useEffect(() => {
    if (connected && inputEnabled) {
      termRef.current?.focus()
      scheduleFit()
    } else if (connected) {
      scheduleFit()
    }
  }, [connected, inputEnabled, scheduleFit])

  useEffect(() => {
    if (clearSignal > 0) {
      termRef.current?.clear()
      bufferSyncedRef.current = 0
    }
  }, [clearSignal])

  return (
    <div
      ref={containerRef}
      className={cn('select-text-region overflow-hidden', className ?? 'h-full w-full min-h-0')}
      onClick={() => termRef.current?.focus()}
    />
  )
}
