import { isTauriRuntime } from '@/lib/tauri-env'
import type { AiBackend } from '@/lib/ai-settings'
import type { ClaudeStreamEvent } from '@/lib/claude-client'

export interface AiDetectResult {
  provider: string
  found: boolean
  path?: string
  version?: string
  candidates: string[]
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) {
    throw new Error('AI CLI 集成仅在 Tauri 桌面版可用')
  }
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke<T>(cmd, args)
}

export async function detectAiBackend(
  provider: AiBackend,
  cliPath?: string
): Promise<AiDetectResult> {
  return invoke<AiDetectResult>('ai_detect', {
    provider,
    cliPath: cliPath || null,
  })
}

export async function sendAiMessage(options: {
  provider: AiBackend
  prompt: string
  cliPath?: string
  sessionId?: string
  continueSession?: boolean
  requestId?: string
  threadId?: string
  /** @deprecated 使用 threadId */
  connectionKey?: string
}): Promise<string> {
  return invoke<string>('ai_send_message', {
    provider: options.provider,
    prompt: options.prompt,
    cliPath: options.cliPath || null,
    sessionId: options.sessionId || null,
    continueSession: options.continueSession ?? false,
    requestId: options.requestId || null,
    threadId: options.threadId || options.connectionKey || null,
    connectionKey: options.connectionKey || options.threadId || null,
  })
}

export async function cancelAiMessage(provider: AiBackend, requestId: string): Promise<void> {
  return invoke<void>('ai_cancel_message', { provider, requestId })
}

export async function cancelAllAiMessages(provider: AiBackend): Promise<void> {
  return invoke<void>('ai_cancel_all_messages', { provider })
}

export function uniqueAiCandidates(candidates: string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const candidate of candidates) {
    const trimmed = candidate.trim()
    if (!trimmed) continue
    const key = trimmed.replace(/\\/g, '/').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(trimmed)
  }
  return unique
}

export type { ClaudeStreamEvent as AiStreamEvent }
