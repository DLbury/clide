'use client'

import { useCallback, useEffect, useState } from 'react'

export type AiBackend = 'claude-code' | 'codex' | 'opencode' | 'cursor'

export interface AiSettings {
  enabled: boolean
  backend: AiBackend
  /** @deprecated 使用 cliPaths['claude-code']；保留以兼容旧配置 */
  claudePath: string
  cliPaths: Partial<Record<AiBackend, string>>
  claudeSessionId?: string
  provider: 'anthropic'
  apiKey: string
  baseUrl: string
  model: string
  temperature: number
  systemPrompt: string
  injectTerminalContext: boolean
  autoExecuteCommands: boolean
  /** MCP runShellCommand 执行前是否自动切换到目标 Shell 标签 */
  focusShellOnMcpExecute: boolean
  /** 敏感/不可撤销命令执行前询问用户确认 */
  requireCommandApproval: boolean
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: true,
  backend: 'claude-code',
  claudePath: '',
  cliPaths: {},
  provider: 'anthropic',
  apiKey: '',
  baseUrl: 'https://api.anthropic.com/v1',
  model: 'claude-sonnet-4-20250514',
  temperature: 0.7,
  systemPrompt:
    '你是 Clide（AI Terminal）助手。平台通过 MCP 服务器 aiterm 提供真实远程 PTY：runShellCommand 在 Shell 中执行命令，getTerminalContext 读取终端输出快照，createNewShell 可新开 Shell（splitBelow 可在面板下方拆分）。同一 Shell 同时只能跑一条前台命令。sudo/SSH 密码由用户在 Shell 面板手动输入，不要索要或写入密码。',
  injectTerminalContext: true,
  autoExecuteCommands: false,
  focusShellOnMcpExecute: false,
  requireCommandApproval: true,
}

const STORAGE_KEY = 'aiterm-ai-settings'
const VALID_BACKENDS: AiBackend[] = ['claude-code', 'codex', 'opencode', 'cursor']

function isAiBackend(value: unknown): value is AiBackend {
  return typeof value === 'string' && VALID_BACKENDS.includes(value as AiBackend)
}

export function getActiveCliPath(settings: AiSettings): string {
  const fromMap = settings.cliPaths?.[settings.backend]?.trim()
  if (fromMap) return fromMap
  if (settings.backend === 'claude-code' && settings.claudePath.trim()) {
    return settings.claudePath.trim()
  }
  return ''
}

export function withActiveCliPath(settings: AiSettings, path: string): AiSettings {
  const cliPaths = { ...settings.cliPaths, [settings.backend]: path }
  return {
    ...settings,
    cliPaths,
    ...(settings.backend === 'claude-code' ? { claudePath: path } : {}),
  }
}

function normalizeSettings(raw: Partial<AiSettings>): AiSettings {
  const merged = { ...DEFAULT_AI_SETTINGS, ...raw }
  const backend = isAiBackend(merged.backend) ? merged.backend : 'claude-code'
  const cliPaths: Partial<Record<AiBackend, string>> = { ...merged.cliPaths }
  if (merged.claudePath?.trim() && !cliPaths['claude-code']) {
    cliPaths['claude-code'] = merged.claudePath.trim()
  }
  const claudePath = cliPaths['claude-code'] ?? merged.claudePath ?? ''
  delete merged.claudeSessionId
  return { ...merged, backend, cliPaths, claudePath }
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
