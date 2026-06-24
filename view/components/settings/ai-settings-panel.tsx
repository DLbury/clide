'use client'

import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import type { AiSettings } from '@/lib/ai-settings'
import { detectClaude, getClaudeMcpStatus, registerClaudeMcp, type McpRegisterStatus } from '@/lib/claude-client'
import { isTauriRuntime } from '@/lib/tauri-env'

interface AiSettingsPanelProps {
  draft: AiSettings
  onChange: (next: AiSettings) => void
}

export function AiSettingsPanel({ draft, onChange }: AiSettingsPanelProps) {
  const isDesktop = isTauriRuntime()
  const [claudeDetect, setClaudeDetect] = useState<string>('')
  const [mcpStatus, setMcpStatus] = useState<McpRegisterStatus | null>(null)
  const [mcpBusy, setMcpBusy] = useState(false)
  const [mcpError, setMcpError] = useState<string | null>(null)

  const refreshMcpStatus = () => {
    if (!isDesktop) {
      setMcpStatus(null)
      return
    }
    void getClaudeMcpStatus(draft.claudePath || undefined)
      .then(setMcpStatus)
      .catch(() => setMcpStatus(null))
  }

  useEffect(() => {
    if (!isDesktop) return
    detectClaude(draft.claudePath || undefined)
      .then(result => {
        if (result.found) {
          setClaudeDetect(
            [result.path, result.version].filter(Boolean).join(' · ') || '已检测到'
          )
        } else {
          setClaudeDetect('未检测到 Claude Code CLI')
        }
      })
      .catch(() => setClaudeDetect('检测失败'))
    refreshMcpStatus()
  }, [isDesktop, draft.claudePath])

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
        <p className="font-medium text-foreground">Claude Code 集成</p>
        <p>
          通过本机已安装的 Claude Code CLI 工作，不写入全局 shell 配置、不注入环境变量到宿主机。
          IDE 桥接仅监听 127.0.0.1，向 Claude 提供终端/文件上下文。
        </p>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <Label>启用 AI 助手</Label>
          <p className="text-xs text-muted-foreground mt-0.5">关闭后 AI 面板仍可查看，但无法发送消息</p>
        </div>
        <Switch
          checked={draft.enabled}
          onCheckedChange={enabled => onChange({ ...draft, enabled, backend: 'claude-code' })}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="settings-claude-path">Claude Code 路径</Label>
        <Input
          id="settings-claude-path"
          placeholder="留空自动检测（PATH 或 ~/.claude/local/claude）"
          value={draft.claudePath}
          onChange={e => onChange({ ...draft, claudePath: e.target.value, backend: 'claude-code' })}
        />
        {claudeDetect && (
          <p className="text-xs text-muted-foreground">检测结果：{claudeDetect}</p>
        )}
      </div>

      {mcpStatus && (
        <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2 text-xs">
          <p className="font-medium text-foreground">MCP 集成（aiterm）</p>
          <p className="text-muted-foreground break-all">项目根：{mcpStatus.projectRoot}</p>
          <p className="text-muted-foreground">
            .mcp.json：{mcpStatus.projectMcpConfigReady ? '已配置' : '未配置'}
            {' · '}
            Claude 项目登记：{mcpStatus.claudeProjectRegistered ? '已登记' : '未登记'}
          </p>
          <p className="text-muted-foreground">
            IDE 桥接在 AI 启用时自动启动；MCP 配置写入应用数据目录 .mcp.json，桥接启动时自动同步。
          </p>
          {(!mcpStatus.projectMcpConfigReady || !mcpStatus.mcpScriptExists) && (
            <button
              type="button"
              disabled={mcpBusy}
              onClick={() => {
                setMcpBusy(true)
                setMcpError(null)
                void registerClaudeMcp(draft.claudePath || undefined)
                  .then(status => {
                    setMcpStatus(status)
                  })
                  .catch(err => {
                    setMcpError(err instanceof Error ? err.message : String(err))
                  })
                  .finally(() => setMcpBusy(false))
              }}
              className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted/60 disabled:opacity-50"
            >
              {mcpBusy ? '注册中…' : '手动注册 MCP'}
            </button>
          )}
          {mcpError && (
            <p className="text-amber-600 dark:text-amber-400 break-words">{mcpError}</p>
          )}
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="settings-ai-system-prompt">System Prompt</Label>
        <textarea
          id="settings-ai-system-prompt"
          rows={3}
          value={draft.systemPrompt}
          onChange={e => onChange({ ...draft, systemPrompt: e.target.value, backend: 'claude-code' })}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary resize-none"
        />
      </div>

      <div className="flex items-center justify-between">
        <div>
          <Label>注入终端上下文</Label>
          <p className="text-xs text-muted-foreground mt-0.5">将当前 Shell 输出作为 AI 参考（经 IDE 桥接传给 Claude）</p>
        </div>
        <Switch
          checked={draft.injectTerminalContext}
          onCheckedChange={injectTerminalContext =>
            onChange({ ...draft, injectTerminalContext, backend: 'claude-code' })
          }
        />
      </div>
    </div>
  )
}
