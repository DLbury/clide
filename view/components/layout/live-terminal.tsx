'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { cn } from '@/lib/utils'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { writeTerminal, resizeTerminal, readTerminalBufferSince, exportTerminalBuffer } from '@/lib/terminal-client'
import {
  clearTerminalRecording,
  downloadTerminalCast,
  getTerminalRecordingEventCount,
  hasTerminalRecordingData,
  isTerminalRecording,
  startTerminalRecording,
  stopTerminalRecording,
  subscribeTerminalRecording,
  updateTerminalRecordingSize,
} from '@/lib/terminal-recording-store'
import {
  appendCommandHistory,
  CommandLineTracker,
  getCommandHistory,
} from '@/lib/command-history-store'
import { appendCommandAudit } from '@/lib/command-audit-store'
import { registerTerminalInputHandler } from '@/lib/terminal-input-registry'
import { getSyncPeerSessionIds, shouldBroadcastTerminalInput } from '@/lib/terminal-sync-group'
import {
  isAnyXtermFocused,
  registerTerminalFocusHandler,
} from '@/lib/terminal-focus-registry'
import {
  getTerminalOutputBuffer,
  replaceTerminalOutputBuffer,
  subscribeTerminalOutput,
  onTerminalResync,
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
  onInputFocus?: () => void
  clearSignal?: number
  className?: string
}

export function LiveTerminal({
  sessionId,
  connected,
  inputEnabled = true,
  onInputFocus,
  clearSignal = 0,
  className,
}: LiveTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionIdRef = useRef(sessionId)
  const connectedRef = useRef(connected)
  const inputEnabledRef = useRef(inputEnabled)
  const onInputFocusRef = useRef(onInputFocus)
  const dataDisposableRef = useRef<{ dispose: () => void } | null>(null)
  const resizeDisposableRef = useRef<{ dispose: () => void } | null>(null)
  const bufferSyncedRef = useRef(0)
  const lastColsRef = useRef(0)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const resizeRafRef = useRef<number | null>(null)
  const resizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const outputUnsubscribeRef = useRef<(() => void) | null>(null)
  const wasConnectedRef = useRef(false)
  const commandTrackerRef = useRef(new CommandLineTracker())
  const historyIndexRef = useRef(-1)
  const historyDraftRef = useRef('')
  const [termReady, setTermReady] = useState(false)
  const [, setRecordingTick] = useState(0)
  const { isDark } = useAppTheme()

  useEffect(() => {
    return subscribeTerminalRecording(() => setRecordingTick(t => t + 1))
  }, [])

  const recording = isTerminalRecording(sessionId)
  const hasRecording = hasTerminalRecordingData(sessionId)
  const recordingEvents = getTerminalRecordingEventCount(sessionId)

  sessionIdRef.current = sessionId
  connectedRef.current = connected
  inputEnabledRef.current = inputEnabled
  onInputFocusRef.current = onInputFocus

  const writeWithSync = useCallback((data: string) => {
    void writeTerminal(sessionIdRef.current, data).catch(() => {})
    if (!shouldBroadcastTerminalInput(data)) return
    for (const peerId of getSyncPeerSessionIds(sessionIdRef.current)) {
      void writeTerminal(peerId, data).catch(() => {})
    }
  }, [])

  useEffect(() => {
    bufferSyncedRef.current = 0
    lastColsRef.current = 0
    commandTrackerRef.current.reset()
    historyIndexRef.current = -1
    historyDraftRef.current = ''
  }, [sessionId])

  const syncPtySize = useCallback(() => {
    const term = termRef.current
    if (!term || !connectedRef.current) return
    if (isTerminalRecording(sessionIdRef.current)) {
      updateTerminalRecordingSize(sessionIdRef.current, term.cols, term.rows)
    }
    void resizeTerminal(sessionIdRef.current, term.cols, term.rows).catch(() => {})
  }, [])

  const fit = useCallback(() => {
    const container = containerRef.current
    const term = termRef.current
    if (!container || !term) return
    if (container.offsetWidth < 16 || container.offsetHeight < 16) return
    try {
      fitRef.current?.fit()
      term.refresh(0, term.rows - 1)
    } catch {
      /* container may be hidden */
    }
  }, [])

  const scheduleFit = useCallback(() => {
    if (resizeDebounceRef.current) clearTimeout(resizeDebounceRef.current)
    resizeDebounceRef.current = setTimeout(() => {
      resizeDebounceRef.current = null
      fit()
    }, 120)
  }, [fit])

  const replayFullBufferToTerm = useCallback((full: string) => {
    const term = termRef.current
    if (!term) return
    term.clear()
    bufferSyncedRef.current = full.length
    if (!full) return
    const CHUNK = 32 * 1024
    if (full.length <= CHUNK) {
      term.write(full)
      return
    }
    let offset = 0
    const writeNext = () => {
      if (offset >= full.length) return
      const end = Math.min(offset + CHUNK, full.length)
      termRef.current?.write(full.slice(offset, end))
      offset = end
      if (offset < full.length) {
        setTimeout(writeNext, 0)
      }
    }
    writeNext()
  }, [])

  const resolveReplayBuffer = useCallback(async (): Promise<string> => {
    const local = getTerminalOutputBuffer(sessionIdRef.current)
    try {
      const remote = await readTerminalBufferSince(sessionIdRef.current, 0)
      if (remote && remote.length > local.length) {
        replaceTerminalOutputBuffer(sessionIdRef.current, remote)
        return remote
      }
    } catch {
      /* use local buffer */
    }
    return local
  }, [])

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
        writeWithSync(text)
      })
      .catch(() => {})
  }, [writeWithSync])

  const exportLog = useCallback(async () => {
    try {
      const text = await exportTerminalBuffer(sessionIdRef.current)
      if (!text.trim()) return
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const filename = `terminal-${sessionIdRef.current.replace(/::/g, '-')}-${stamp}.log`
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('export terminal log failed', err)
    }
  }, [])

  const toggleRecording = useCallback(() => {
    const term = termRef.current
    const sid = sessionIdRef.current
    if (isTerminalRecording(sid)) {
      stopTerminalRecording(sid)
      return
    }
    startTerminalRecording(sid, term?.cols ?? 80, term?.rows ?? 24)
  }, [])

  const exportCast = useCallback(() => {
    downloadTerminalCast(sessionIdRef.current)
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
      rightClickSelectsWord: true,
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

    term.attachCustomKeyEventHandler(event => {
      if (event.type === 'keydown' && event.ctrlKey && event.key.toLowerCase() === 'c') {
        const text = term.getSelection()
        if (text) {
          event.preventDefault()
          navigator.clipboard.writeText(text).catch(() => {})
          return false
        }
        if (!event.shiftKey) return true
      }
      if (!connectedRef.current || !inputEnabledRef.current) return true
      if (event.type !== 'keydown') return true
      if (!event.ctrlKey || !event.shiftKey) return true

      const history = getCommandHistory(sessionIdRef.current)
      if (history.length === 0) return true

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        if (historyIndexRef.current === -1) {
          historyDraftRef.current = commandTrackerRef.current.currentLine()
        }
        const nextIndex =
          historyIndexRef.current < 0
            ? history.length - 1
            : Math.max(0, historyIndexRef.current - 1)
        historyIndexRef.current = nextIndex
        const cmd = history[nextIndex]
        void writeWithSync(`\x15${cmd}`)
        commandTrackerRef.current.reset()
        for (const ch of cmd) commandTrackerRef.current.feed(ch)
        return false
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        if (historyIndexRef.current < 0) return false
        const nextIndex = historyIndexRef.current + 1
        if (nextIndex >= history.length) {
          historyIndexRef.current = -1
          void writeWithSync(`\x15${historyDraftRef.current}`)
          commandTrackerRef.current.reset()
          for (const ch of historyDraftRef.current) commandTrackerRef.current.feed(ch)
        } else {
          historyIndexRef.current = nextIndex
          const cmd = history[nextIndex]
          void writeWithSync(`\x15${cmd}`)
          commandTrackerRef.current.reset()
          for (const ch of cmd) commandTrackerRef.current.feed(ch)
        }
        return false
      }

      return true
    })

    dataDisposableRef.current = term.onData(data => {
      if (!connectedRef.current) return
      const submitted = commandTrackerRef.current.feed(data)
      if (submitted) {
        appendCommandHistory(sessionIdRef.current, submitted)
        appendCommandAudit(sessionIdRef.current, submitted)
        historyIndexRef.current = -1
        historyDraftRef.current = ''
      }
      writeWithSync(data)
    })

    resizeDisposableRef.current = term.onResize(({ cols, rows }) => {
      if (!connectedRef.current || cols < 1 || rows < 1) return
      const colsChanged = lastColsRef.current > 0 && lastColsRef.current !== cols
      lastColsRef.current = cols
      if (isTerminalRecording(sessionIdRef.current)) {
        updateTerminalRecordingSize(sessionIdRef.current, cols, rows)
      }
      void resizeTerminal(sessionIdRef.current, cols, rows).catch(() => {})
      term.refresh(0, rows - 1)
      if (colsChanged) {
        // 列宽变化时重绘 xterm，不追加到输出缓冲（避免内容重复）
        void resolveReplayBuffer().then(full => {
          const t = termRef.current
          if (!t) return
          replayFullBufferToTerm(full)
          t.refresh(0, t.rows - 1)
        })
      }
    })

    termRef.current = term
    fitRef.current = fitAddon
    lastColsRef.current = term.cols
    setTermReady(true)

    const screenEl = term.element
    const enableSelection = () => {
      const svc = (term as unknown as { _core?: { _selectionService?: { enable: () => void } } })
        ._core?._selectionService
      svc?.enable()
    }
    const onScreenMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      enableSelection()
      term.focus()
      onInputFocusRef.current?.()
    }
    screenEl?.addEventListener('mousedown', onScreenMouseDown, true)

    syncPtySize()
    const syncTimers = [50, 200, 500].map(ms =>
      setTimeout(() => syncPtySize(), ms)
    )

    resizeObserverRef.current = new ResizeObserver(() => scheduleFit())
    resizeObserverRef.current.observe(container)

    return () => {
      syncTimers.forEach(clearTimeout)
      if (resizeDebounceRef.current) clearTimeout(resizeDebounceRef.current)
      if (resizeRafRef.current != null) cancelAnimationFrame(resizeRafRef.current)
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
      dataDisposableRef.current?.dispose()
      dataDisposableRef.current = null
      resizeDisposableRef.current?.dispose()
      resizeDisposableRef.current = null
      screenEl?.removeEventListener('mousedown', onScreenMouseDown, true)
      term.dispose()
      termRef.current = null
      fitRef.current = null
      setTermReady(false)
    }
  }, [isDark, fit, scheduleFit, syncPtySize, resolveReplayBuffer, replayFullBufferToTerm])

  useEffect(() => {
    const onWindowResize = () => scheduleFit()
    window.addEventListener('resize', onWindowResize)
    return () => window.removeEventListener('resize', onWindowResize)
  }, [scheduleFit])

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
    replayFullBufferToTerm(getTerminalOutputBuffer(sessionId))
  }, [sessionId, replayFullBufferToTerm])

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

    const unsubFocus = registerTerminalFocusHandler(sessionId, () => {
      termRef.current?.focus()
    })

    return () => {
      outputUnsubscribeRef.current?.()
      outputUnsubscribeRef.current = null
      unsubResync()
      unsubInput()
      unsubFocus()
    }
  }, [sessionId, termReady, syncBufferToTerm, catchUpTerminalBuffer, replayBufferToTerm])

  useEffect(() => {
    if (!connected) {
      wasConnectedRef.current = false
      return
    }

    const justConnected = !wasConnectedRef.current
    wasConnectedRef.current = true

    syncPtySize()
    scheduleFit()

    if (justConnected) {
      void resolveReplayBuffer().then(full => {
        replayFullBufferToTerm(full)
      })
    }

    // 仅在首次连上且当前没有其它 xterm 持焦时自动聚焦，避免分屏时后连上的 Shell 抢走输入焦点
    if (justConnected && inputEnabled && !isAnyXtermFocused()) {
      termRef.current?.focus()
    }
  }, [connected, inputEnabled, scheduleFit, syncPtySize, resolveReplayBuffer, replayFullBufferToTerm])

  useEffect(() => {
    if (!termReady || !connected) return
    let cancelled = false
    const timer = setTimeout(() => {
      void resolveReplayBuffer()
        .then(full => {
          if (cancelled || !termRef.current) return
          const local = getTerminalOutputBuffer(sessionId)
          if (full.length > local.length) {
            catchUpTerminalBuffer()
          } else if (local.length === 0 && full.length > 0) {
            replaceTerminalOutputBuffer(sessionId, full)
            replayFullBufferToTerm(full)
          }
        })
        .catch(() => {})
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [sessionId, termReady, connected, catchUpTerminalBuffer, resolveReplayBuffer, replayFullBufferToTerm])

  useEffect(() => {
    if (clearSignal > 0) {
      termRef.current?.clear()
      bufferSyncedRef.current = 0
    }
  }, [clearSignal])

  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>
        <div
          ref={containerRef}
          className={cn('terminal-host overflow-hidden', className ?? 'h-full w-full min-h-0')}
        />
      </ContextMenuTrigger>
      <ContextMenuContent className="w-40">
        <ContextMenuItem onClick={copySelection}>复制</ContextMenuItem>
        <ContextMenuItem onClick={pasteFromClipboard} disabled={!connected || !inputEnabled}>
          粘贴
        </ContextMenuItem>
        <ContextMenuItem onClick={selectAll}>全选</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={toggleRecording} disabled={!connected}>
          {recording ? '停止录制' : '开始录制'}
          {recording && <span className="ml-auto text-red-500">●</span>}
        </ContextMenuItem>
        <ContextMenuItem onClick={exportCast} disabled={!hasRecording}>
          导出 Asciicast{hasRecording ? ` (${recordingEvents})` : ''}
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => clearTerminalRecording(sessionId)}
          disabled={!hasRecording}
        >
          清除录像
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void exportLog()}>导出终端日志</ContextMenuItem>
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
