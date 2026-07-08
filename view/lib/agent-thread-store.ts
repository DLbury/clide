import type { ChatMessage } from '@/lib/types'
import { listChatHistorySummaries, loadChatHistory } from '@/lib/chat-history-store'

export type AgentThreadStatus = 'idle' | 'running' | 'stopped' | 'error'

export interface AgentThread {
  id: string
  title: string
  messages: ChatMessage[]
  backendSessionId?: string
  status: AgentThreadStatus
  createdAt: number
  updatedAt: number
}

const STORAGE_KEY = 'aiterm-agent-threads-v1'
const MAX_MESSAGES = 500
const MIGRATION_FLAG = 'aiterm-agent-threads-migrated-v1'

function readRaw(): AgentThread[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as AgentThread[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeRaw(threads: AgentThread[]): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(threads))
  } catch {
    /* quota */
  }
}

function messagePreview(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = messages[i].content?.trim()
    if (text) return text.slice(0, 80)
  }
  return ''
}

function migrateFromProfileChats(): AgentThread[] {
  if (typeof window === 'undefined') return []
  if (localStorage.getItem(MIGRATION_FLAG)) return []
  const summaries = listChatHistorySummaries()
  if (summaries.length === 0) {
    localStorage.setItem(MIGRATION_FLAG, '1')
    return []
  }
  const threads: AgentThread[] = summaries.map(s => {
    const messages = loadChatHistory(s.profileId)
    const now = s.updatedAt || Date.now()
    return {
      id: `thread-${s.profileId}`,
      title: messagePreview(messages) || s.profileId.slice(0, 12),
      messages,
      status: 'idle' as const,
      createdAt: now,
      updatedAt: now,
    }
  })
  localStorage.setItem(MIGRATION_FLAG, '1')
  return threads
}

export function createAgentThread(title = '新对话'): AgentThread {
  const now = Date.now()
  return {
    id: `thread-${now}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    messages: [],
    status: 'idle',
    createdAt: now,
    updatedAt: now,
  }
}

export function loadAgentThreads(): AgentThread[] {
  let threads = readRaw()
  if (threads.length === 0) {
    const migrated = migrateFromProfileChats()
    if (migrated.length > 0) {
      threads = migrated
      writeRaw(threads)
    }
  }
  if (threads.length === 0) {
    const initial = createAgentThread()
    threads = [initial]
    writeRaw(threads)
  }
  return threads
}

/** 应用启动时加载对话；若上次对话非空则自动新建空白对话并选中 */
export function initializeAgentThreadsOnStartup(): {
  threads: AgentThread[]
  activeThreadId: string
} {
  const loaded = loadAgentThreads()
  const latest = loaded[0]
  if (latest && latest.messages.length > 0) {
    const fresh = createAgentThread()
    const threads = [fresh, ...loaded]
    writeRaw(threads)
    return { threads, activeThreadId: fresh.id }
  }
  return { threads: loaded, activeThreadId: latest?.id ?? '' }
}

export function saveAgentThreads(threads: AgentThread[]): void {
  writeRaw(
    threads.map(t => ({
      ...t,
      messages: t.messages.slice(-MAX_MESSAGES),
    }))
  )
}

export function deriveThreadTitle(messages: ChatMessage[], fallback: string): string {
  const firstUser = messages.find(m => m.role === 'user' && m.content?.trim())
  if (firstUser?.content?.trim()) {
    return firstUser.content.trim().slice(0, 48)
  }
  return fallback
}
