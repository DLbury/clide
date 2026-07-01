'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  detectClaude,
  getClaudeBridgeStatus,
  listenBridgeConnected,
  listenClaudeStream,
  listenClaudeDiag,
  registerClaudeMcp,
  waitClaudeMcpTools,
  restartClaudeBridge,
  startClaudeBridge,
  stopClaudeBridge,
  updateIdeContext,
  type BridgeStatus,
  type ClaudeDetectResult,
  type ClaudeStreamEvent,
  type IdeContext,
  type McpRegisterStatus,
} from '@/lib/claude-client'
import { isTauriRuntime } from '@/lib/tauri-env'

export interface UseClaudeCodeOptions {
  enabled: boolean
  claudePath?: string
  getIdeContext?: () => IdeContext
  /** 变化时立即推送 IDE 上下文（连接/Shell 切换） */
  contextSyncKey?: string
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} 超时（>${Math.round(timeoutMs / 1000)}s）`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
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
  const [mcpStatus, setMcpStatus] = useState<McpRegisterStatus | null>(null)
  const [mcpRegisterError, setMcpRegisterError] = useState<string | null>(null)
  const [mcpRegistering, setMcpRegistering] = useState(false)
  const [streamListenError, setStreamListenError] = useState<string | null>(null)
  const [lastDiag, setLastDiag] = useState<string | null>(null)
  const pendingRequests = useRef(new Map<string, (event: ClaudeStreamEvent) => void>())
  const getIdeContextRef = useRef(getIdeContext)
  getIdeContextRef.current = getIdeContext
  const bridgeStartedRef = useRef(false)
  const mcpAutoAttemptedRef = useRef(false)
  const unlistenStreamRef = useRef<(() => void) | null>(null)
  const unlistenBridgeRef = useRef<(() => void) | null>(null)
  const streamReadyRef = useRef(false)
  const claudePathRef = useRef(claudePath)
  claudePathRef.current = claudePath
  const mcpStatusRef = useRef(mcpStatus)
  mcpStatusRef.current = mcpStatus

  const runAutoMcpRegister = useCallback(async (force = false) => {
    if (!isTauriRuntime()) return null
    if (!force && mcpAutoAttemptedRef.current) return null
    setMcpRegistering(true)
    setMcpRegisterError(null)
    try {
      const status = await registerClaudeMcp(claudePathRef.current || undefined)
      setMcpStatus(status)
      if (!status.projectMcpConfigReady || !status.mcpScriptExists) {
        setMcpRegisterError(status.runtimeError ?? 'MCP 脚本或 .mcp.json 未就绪')
        return null
      }
      // 配置写入成功后预热运行时工具；此前因 strict runtime 判定导致自动注册误报失败
      try {
        const count = await withTimeout(waitClaudeMcpTools(10_000), 12_000, '预热 MCP 工具')
        const warmed: McpRegisterStatus = {
          ...status,
          runtimeToolsReady: true,
          runtimeToolCount: count,
          runtimeError: null,
          ready: true,
        }
        setMcpStatus(warmed)
        mcpAutoAttemptedRef.current = true
        setMcpRegisterError(null)
        return warmed
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setMcpRegisterError(`MCP 配置已写入，运行时预热失败: ${msg}`)
        mcpAutoAttemptedRef.current = true
        return status
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setMcpRegisterError(msg)
      return null
    } finally {
      setMcpRegistering(false)
    }
  }, [])

  const retryMcpRegister = useCallback(async () => {
    mcpAutoAttemptedRef.current = false
    return runAutoMcpRegister(true)
  }, [runAutoMcpRegister])

  /**
   * 发送 AI 消息前确保 .mcp.json 已写入（工具预检在 Rust claude_send_message 内完成）。
   * MCP 配置/工具在一个应用会话内不变，已就绪时直接复用，避免每条消息都重复
   * registerClaudeMcp + waitClaudeMcpTools（会额外拉起 claude/node 进程，约数秒开销）。
   */
  const ensureMcpReady = useCallback(async () => {
    if (!isTauriRuntime() || !enabled) return null
    if (mcpAutoAttemptedRef.current && mcpStatusRef.current?.ready) {
      return mcpStatusRef.current
    }
    return runAutoMcpRegister(true)
  }, [enabled, runAutoMcpRegister])

  const ensureStreamReady = useCallback(async () => {
    if (streamReadyRef.current) return
    const deadline = Date.now() + 5000
    while (!streamReadyRef.current && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (!streamReadyRef.current) {
      throw new Error('Claude stream 通道未就绪，请稍后重试')
    }
  }, [])

  const ensureBridgeReady = useCallback(async () => {
    if (!isTauriRuntime() || !enabled) return null

    const current = await withTimeout(
      getClaudeBridgeStatus().catch(() => null),
      8000,
      '检查 Claude Bridge 状态'
    )
    if (current?.running) {
      setBridge(current)
      // 只在未注册过时自动注册
      if (!mcpAutoAttemptedRef.current) {
        void runAutoMcpRegister()
      }
      return current
    }

    const status = await withTimeout(
      startClaudeBridge([], claudePathRef.current || undefined),
      15000,
      '启动 Claude Bridge'
    )
    bridgeStartedRef.current = true
    setBridge(status)
    void runAutoMcpRegister()
    return status
  }, [enabled, runAutoMcpRegister])

  useEffect(() => {
    if (!isTauriRuntime() || !enabled) {
      bridgeStartedRef.current = false
      mcpAutoAttemptedRef.current = false
      return
    }

    unlistenStreamRef.current = null
    unlistenBridgeRef.current = null
    mcpAutoAttemptedRef.current = false
    streamReadyRef.current = false

    // 启动阶段不主动拉起 Bridge；仅做轻量检测，避免首屏卡顿。
    const detectTimer = setTimeout(() => {
      detectClaude(claudePathRef.current || undefined)
        .then(setDetected)
        .catch(console.error)
    }, 2000)

    // AI 启用后预热桥接 + MCP，避免首条消息才注册导致 Claude 拿不到工具
    const warmTimer = setTimeout(() => {
      void (async () => {
        try {
          const status = await getClaudeBridgeStatus()
          if (status?.running) {
            setBridge(status)
            void runAutoMcpRegister()
            return
          }
          const started = await withTimeout(
            startClaudeBridge([], claudePathRef.current || undefined),
            15_000,
            '预热 Claude Bridge'
          )
          bridgeStartedRef.current = true
          setBridge(started)
          void runAutoMcpRegister()
        } catch {
          // 预热失败不阻断；首条消息会再试
        }
      })()
    }, 2500)

    listenClaudeStream(event => {
      const handler = pendingRequests.current.get(event.requestId)
      if (handler) {
        queueMicrotask(() => {
          handler(event)
          if (event.done) {
            pendingRequests.current.delete(event.requestId)
          }
        })
      } else if (event.done) {
        pendingRequests.current.delete(event.requestId)
      }
      if (event.sessionId) {
        setSessionId(prev => (prev === event.sessionId ? prev : event.sessionId))
      }
    })
      .then(fn => {
        streamReadyRef.current = true
        setStreamListenError(null)
        unlistenStreamRef.current = fn
      })
      .catch(err => {
        streamReadyRef.current = false
        const msg = err instanceof Error ? err.message : String(err)
        setStreamListenError(`Claude 事件通道监听失败: ${msg}`)
        console.error('listenClaudeStream failed', err)
      })

    listenClaudeDiag(event => {
      if (event?.message) setLastDiag(`[${event.kind}] ${event.message}`)
    }).catch(() => {})

    listenBridgeConnected(() => {
      getClaudeBridgeStatus().then(setBridge).catch(console.error)
      // 桥接连接时只更新状态，不重置注册标记
      // MCP 配置已在桥接启动时写入，无需重复注册
    }).then(fn => {
      unlistenBridgeRef.current = fn
    })

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
    }, 30_000)

    return () => {
      clearTimeout(detectTimer)
      clearTimeout(warmTimer)
      clearInterval(statusPoll)
      unlistenStreamRef.current?.()
      unlistenBridgeRef.current?.()
      unlistenStreamRef.current = null
      unlistenBridgeRef.current = null
      streamReadyRef.current = false
      pendingRequests.current.clear()
      mcpAutoAttemptedRef.current = false
      if (bridgeStartedRef.current) {
        stopClaudeBridge().catch(console.error)
        bridgeStartedRef.current = false
      }
    }
  }, [enabled, claudePath, runAutoMcpRegister])

  useEffect(() => {
    if (!isTauriRuntime() || !enabled) return
    const fn = getIdeContextRef.current
    if (fn) void updateIdeContext(fn()).catch(() => {})
  }, [enabled, contextSyncKey])

  const registerStreamHandler = useCallback(
    (requestId: string, handler: (event: ClaudeStreamEvent) => void) => {
      pendingRequests.current.set(requestId, handler)
    },
    []
  )

  const unregisterStreamHandler = useCallback((requestId: string) => {
    pendingRequests.current.delete(requestId)
  }, [])

  const restartBridge = useCallback(async () => {
    if (!isTauriRuntime()) return null
    mcpAutoAttemptedRef.current = false
    const status = await restartClaudeBridge([], claudePath || undefined)
    bridgeStartedRef.current = true
    setBridge(status)
    void runAutoMcpRegister(true)
    return status
  }, [claudePath, runAutoMcpRegister])

  return {
    isDesktop: isTauriRuntime(),
    detected,
    bridge,
    sessionId,
    setSessionId,
    claudePath,
    mcpStatus,
    mcpRegisterError,
    mcpRegistering,
    streamListenError,
    lastDiag,
    retryMcpRegister,
    ensureBridgeReady,
    ensureMcpReady,
    ensureStreamReady,
    registerStreamHandler,
    unregisterStreamHandler,
    restartBridge,
  }
}
