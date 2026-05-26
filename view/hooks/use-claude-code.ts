'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  detectClaude,
  getClaudeBridgeStatus,
  listenBridgeConnected,
  listenClaudeStream,
  restartClaudeBridge,
  startClaudeBridge,
  stopClaudeBridge,
  updateIdeContext,
  type BridgeStatus,
  type ClaudeDetectResult,
  type ClaudeStreamEvent,
  type IdeContext,
} from '@/lib/claude-client'
import { isTauriRuntime } from '@/lib/tauri-env'

export interface UseClaudeCodeOptions {
  enabled: boolean
  claudePath?: string
  getIdeContext?: () => IdeContext
  /** 变化时立即推送 IDE 上下文（连接/Shell 切换） */
  contextSyncKey?: string
}

export function useClaudeCode({
  enabled,
  claudePath,
  getIdeContext,
  contextSyncKey,
}: UseClaudeCodeOptions) {
  const [detected, setDetected] = useState<ClaudeDetectResult | null>(null)
  const [bridge, setBridge] = useState<BridgeStatus | null>(null)
  const [sessionId, setSessionId] = useState<string | undefined>()
  const pendingRequests = useRef(new Map<string, (event: ClaudeStreamEvent) => void>())
  const getIdeContextRef = useRef(getIdeContext)
  getIdeContextRef.current = getIdeContext
  const bridgeStartedRef = useRef(false)
  const unlistenStreamRef = useRef<(() => void) | null>(null)
  const unlistenBridgeRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!isTauriRuntime() || !enabled) {
      bridgeStartedRef.current = false
      return
    }

    // 重置清理函数
    unlistenStreamRef.current = null
    unlistenBridgeRef.current = null

    detectClaude().then(setDetected).catch(console.error)

    listenClaudeStream(event => {
      const handler = pendingRequests.current.get(event.requestId)
      handler?.(event)
      if (event.done) {
        pendingRequests.current.delete(event.requestId)
      }
      if (event.sessionId) {
        setSessionId(event.sessionId)
      }
    }).then(fn => {
      unlistenStreamRef.current = fn
    })

    listenBridgeConnected(() => {
      getClaudeBridgeStatus().then(setBridge).catch(console.error)
    }).then(fn => {
      unlistenBridgeRef.current = fn
    })

    // 工作区由 Rust 侧 resolve_workspace_folders 解析，避免前端异步 root 导致桥接反复重启
    startClaudeBridge([], claudePath || undefined)
      .then(status => {
        bridgeStartedRef.current = true
        setBridge(status)
      })
      .catch(console.error)

    getClaudeBridgeStatus()
      .then(status => {
        if (status) setBridge(status)
      })
      .catch(() => {})

    const statusPoll = setInterval(() => {
      getClaudeBridgeStatus()
        .then(status => {
          if (status) setBridge(status)
        })
        .catch(() => {})
    }, 3000)

    return () => {
      clearInterval(statusPoll)
      unlistenStreamRef.current?.()
      unlistenBridgeRef.current?.()
      unlistenStreamRef.current = null
      unlistenBridgeRef.current = null
      // 清理所有挂起的请求，避免内存泄漏
      pendingRequests.current.clear()
      if (bridgeStartedRef.current) {
        stopClaudeBridge().catch(console.error)
        bridgeStartedRef.current = false
      }
    }
  }, [enabled, claudePath])

  useEffect(() => {
    if (!isTauriRuntime() || !enabled) return
    const sync = () => {
      const fn = getIdeContextRef.current
      if (fn) updateIdeContext(fn()).catch(console.error)
    }
    sync()
    const timer = setInterval(sync, 2000)
    return () => clearInterval(timer)
  }, [enabled, contextSyncKey])

  const registerStreamHandler = useCallback(
    (requestId: string, handler: (event: ClaudeStreamEvent) => void) => {
      pendingRequests.current.set(requestId, handler)
    },
    []
  )

  const restartBridge = useCallback(async () => {
    if (!isTauriRuntime()) return null
    const status = await restartClaudeBridge([], claudePath || undefined)
    bridgeStartedRef.current = true
    setBridge(status)
    return status
  }, [claudePath])

  return {
    isDesktop: isTauriRuntime(),
    detected,
    bridge,
    sessionId,
    setSessionId,
    claudePath,
    registerStreamHandler,
    restartBridge,
  }
}
