'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '@/lib/types'
import {
  type AgentThread,
  type AgentThreadStatus,
  createAgentThread,
  deriveThreadTitle,
  initializeAgentThreadsOnStartup,
  saveAgentThreads,
} from '@/lib/agent-thread-store'

export function useAgentThreads() {
  const [startup] = useState(() => initializeAgentThreadsOnStartup())
  const [threads, setThreads] = useState<AgentThread[]>(() => startup.threads)
  const [activeThreadId, setActiveThreadId] = useState<string>(() => startup.activeThreadId)
  const threadsRef = useRef(threads)
  threadsRef.current = threads
  const activeThreadIdRef = useRef(activeThreadId)
  activeThreadIdRef.current = activeThreadId

  const activeThread =
    threads.find(t => t.id === activeThreadId) ?? threads[0] ?? null

  useEffect(() => {
    const timer = window.setTimeout(() => saveAgentThreads(threads), 400)
    return () => window.clearTimeout(timer)
  }, [threads])

  const patchThread = useCallback(
    (threadId: string, updater: (t: AgentThread) => AgentThread) => {
      setThreads(prev =>
        prev.map(t => (t.id === threadId ? updater({ ...t, updatedAt: Date.now() }) : t))
      )
    },
    []
  )

  const patchActiveThread = useCallback(
    (updater: (t: AgentThread) => AgentThread) => {
      const id = activeThreadIdRef.current
      if (!id) return
      patchThread(id, updater)
    },
    [patchThread]
  )

  const setThreadStatus = useCallback(
    (threadId: string, status: AgentThreadStatus) => {
      patchThread(threadId, t => ({ ...t, status }))
    },
    [patchThread]
  )

  const createNewThread = useCallback(() => {
    const thread = createAgentThread()
    setThreads(prev => {
      const next = [thread, ...prev]
      saveAgentThreads(next)
      return next
    })
    setActiveThreadId(thread.id)
    return thread.id
  }, [])

  const selectThread = useCallback((threadId: string) => {
    setActiveThreadId(threadId)
  }, [])

  const clearThread = useCallback(
    (threadId: string) => {
      patchThread(threadId, t => ({
        ...t,
        messages: [],
        backendSessionId: undefined,
        status: 'idle',
        title: '新对话',
      }))
    },
    [patchThread]
  )

  const deleteThread = useCallback((threadId: string) => {
    let next = threadsRef.current.filter(thread => thread.id !== threadId)
    if (next.length === 0) {
      next = [createAgentThread()]
    }

    threadsRef.current = next
    setThreads(next)
    saveAgentThreads(next)

    if (!next.some(thread => thread.id === activeThreadIdRef.current)) {
      activeThreadIdRef.current = next[0].id
      setActiveThreadId(next[0].id)
    }
  }, [])

  const updateThreadTitleFromMessages = useCallback(
    (threadId: string, messages: ChatMessage[]) => {
      patchThread(threadId, t => ({
        ...t,
        title: deriveThreadTitle(messages, t.title),
      }))
    },
    [patchThread]
  )

  return {
    threads,
    threadsRef,
    activeThreadId,
    activeThreadIdRef,
    activeThread,
    setActiveThreadId,
    patchThread,
    patchActiveThread,
    setThreadStatus,
    createNewThread,
    selectThread,
    clearThread,
    deleteThread,
    updateThreadTitleFromMessages,
  }
}
