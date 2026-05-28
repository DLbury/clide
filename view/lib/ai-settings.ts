'use client'

import { useCallback, useEffect, useState } from 'react'

export type AiBackend = 'claude-code'

export interface AiSettings {
  enabled: boolean
  /** 固定为 Claude Code 本机 CLI */
  backend: AiBackend
  claudePath: string
  claudeSessionId?: string
  provider: 'anthropic'
  apiKey: string
  baseUrl: string
  model: string
  temperature: number
  systemPrompt: string
  injectTerminalContext: boolean
  autoExecuteCommands: boolean
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: true,
  backend: 'claude-code',
  claudePath: '',
  provider: 'anthropic',
  apiKey: '',
  baseUrl: 'https://api.anthropic.com/v1',
  model: 'claude-sonnet-4-20250514',
  temperature: 0.7,
  systemPrompt:
    '你是 AI Terminal 助手。远程命令必须用 MCP aiterm 的 runShellCommand 执行并汇报 output。sudo 等需要交互输入密码的命令：用 runShellCommand 发起后，提示用户在左侧 Shell 终端里手动输入密码，不要向用户索要密码、不要把密码写进命令或聊天。',
  injectTerminalContext: true,
  // Safety: avoid executing suggested commands without explicit user action.
  autoExecuteCommands: false,
}

const STORAGE_KEY = 'aiterm-ai-settings'

function normalizeSettings(raw: Partial<AiSettings>): AiSettings {
  const merged = { ...DEFAULT_AI_SETTINGS, ...raw, backend: 'claude-code' }
  delete merged.claudeSessionId
  return merged
}

export function loadAiSettings(): AiSettings {
  if (typeof window === 'undefined') return DEFAULT_AI_SETTINGS
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_AI_SETTINGS
    return normalizeSettings(JSON.parse(raw))
  } catch {
    return DEFAULT_AI_SETTINGS
  }
}

export function saveAiSettings(settings: AiSettings): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeSettings(settings)))
}

export function useAiSettings() {
  const [settings, setSettings] = useState<AiSettings>(DEFAULT_AI_SETTINGS)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    setSettings(loadAiSettings())
    setLoaded(true)
  }, [])

  const updateSettings = useCallback((next: AiSettings) => {
    const normalized = normalizeSettings(next)
    setSettings(normalized)
    saveAiSettings(normalized)
  }, [])

  const toggleEnabled = useCallback(() => {
    setSettings(prev => {
      const next = normalizeSettings({ ...prev, enabled: !prev.enabled })
      saveAiSettings(next)
      return next
    })
  }, [])

  const clearClaudeSessionId = useCallback(() => {
    setSettings(prev => {
      if (!prev.claudeSessionId) return prev
      const next = { ...prev }
      delete next.claudeSessionId
      saveAiSettings(next)
      return next
    })
  }, [])

  return { settings, updateSettings, toggleEnabled, clearClaudeSessionId, loaded }
}
