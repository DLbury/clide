import type { ChatMessage } from '@/lib/types'

const STORAGE_KEY = 'aiterm-chat-history-v1'
const MAX_MESSAGES_PER_PROFILE = 500

type ChatHistoryStore = Record<string, ChatMessage[]>

export interface ChatHistorySummary {
  profileId: string
  messageCount: number
  updatedAt: number
  preview: string
}

function readStore(): ChatHistoryStore {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as ChatHistoryStore
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeStore(store: ChatHistoryStore): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    /* quota exceeded */
  }
}

/** 按 SSH profile / session.id 索引，重连后可恢复 */
export function chatHistoryKey(profileId: string): string {
  return profileId
}

function messagePreview(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const text = (m.role === 'user' ? m.content : m.content)?.trim()
    if (text) return text.slice(0, 120)
  }
  return ''
}

function lastUserTimestamp(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const ts = messages[i].timestamp
    if (ts) return typeof ts === 'number' ? ts : new Date(ts).getTime()
  }
  return Date.now()
}

export function loadChatHistory(profileId: string): ChatMessage[] {
  const messages = readStore()[chatHistoryKey(profileId)]
  return Array.isArray(messages) ? messages : []
}

export function saveChatHistory(profileId: string, messages: ChatMessage[]): void {
  if (messages.length === 0) return
  const store = readStore()
  store[chatHistoryKey(profileId)] = messages.slice(-MAX_MESSAGES_PER_PROFILE)
  writeStore(store)
}

export function clearChatHistory(profileId: string): void {
  const store = readStore()
  delete store[chatHistoryKey(profileId)]
  writeStore(store)
}

export function listChatHistorySummaries(): ChatHistorySummary[] {
  const store = readStore()
  return Object.entries(store)
    .filter(([, msgs]) => Array.isArray(msgs) && msgs.length > 0)
    .map(([profileId, messages]) => ({
      profileId,
      messageCount: messages.length,
      updatedAt: lastUserTimestamp(messages),
      preview: messagePreview(messages),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getChatHistorySummary(profileId: string): ChatHistorySummary | null {
  const messages = loadChatHistory(profileId)
  if (messages.length === 0) return null
  return {
    profileId,
    messageCount: messages.length,
    updatedAt: lastUserTimestamp(messages),
    preview: messagePreview(messages),
  }
}
