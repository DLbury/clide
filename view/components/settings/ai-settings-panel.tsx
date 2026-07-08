'use client'

import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import type { AiSettings } from '@/lib/ai-settings'
import { getActiveCliPath, withActiveCliPath } from '@/lib/ai-settings'
import { AI_BACKENDS, getBackendMeta } from '@/lib/ai-backends'
import { detectAiBackend, uniqueAiCandidates } from '@/lib/ai-client'
import {
  getClaudeMcpStatus,
  registerClaudeMcp,
  claudePathLabel,
  type McpRegisterStatus,
} from '@/lib/claude-client'
import { isTauriRuntime } from '@/lib/tauri-env'
import { cn } from '@/lib/utils'

interface AiSettingsPanelProps {
  draft: AiSettings
  onChange: (next: AiSettings) => void
}

export function AiSettingsPanel({ draft, onChange }: AiSettingsPanelProps) {
  const isDesktop = isTauriRuntime()
  const backendMeta = getBackendMeta(draft.backend)
  const activeCliPath = getActiveCliPath(draft)
  const [detectLabel, setDetectLabel] = useState<string>('')
  const [candidates, setCandidates] = useState<string[]>([])
  const [mcpStatus, setMcpStatus] = useState<McpRegisterStatus | null>(null)
  const [mcpBusy, setMcpBusy] = useState(false)
  const [mcpError, setMcpError] = useState<string | null>(null)

  const refreshMcpStatus = () => {
    if (!isDesktop || draft.backend !== 'claude-code') {
      setMcpStatus(null)
      return
    }
    void getClaudeMcpStatus(activeCliPath || undefined)
      .then(setMcpStatus)
      .catch(() => setMcpStatus(null))
  }

  useEffect(() => {
    if (!isDesktop) return
    detectAiBackend(draft.backend, activeCliPath || undefined)
      .then(result => {
        setCandidates(uniqueAiCandidates(result.candidates ?? []))
        if (result.found) {
          setDetectLabel(
            [result.path, result.version].filter(Boolean).join(' · ') || '已检测到'
          )
        } else {
          setDetectLabel(`未检测到 ${backendMeta.label} CLI`)
        }
      })
      .catch(() => setDetectLabel('检测失败'))
    refreshMcpStatus()
  }, [isDesktop, draft.backend, activeCliPath, backendMeta.label])

  const setCliPath = (path: string) => {
    onChange(withActiveCliPath(draft, path))
  }

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
        <p className="font-medium text-foreground">AI 后端</p>
        <p>
          选择本机已安装的 AI Coding CLI。Claude Code 支持完整 IDE 桥接与 aiterm MCP；
          Codex / OpenCode / Cursor 通过各自 CLI 非交互模式接入（远程 Shell MCP 需在后端配置 MCP）。
        </p>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <Label>启用 AI 助手</Label>
          <p className="text-xs text-muted-foreground mt-0.5">关闭后 AI 面板仍可查看，但无法发送消息</p>
        </div>
        <Switch
          checked={draft.enabled}
          onCheckedChange={enabled => onChange({ ...draft, enabled })}
        />
      </div>

      <div className="space-y-2">
        <Label>AI 后端</Label>
        <div className="grid grid-cols-2 gap-2">
          {AI_BACKENDS.map(meta => (
            <button
              key={meta.id}
              type="button"
              onClick={() => onChange({ ...draft, backend: meta.id })}
              className={cn(
                'rounded-md border px-3 py-2 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground',
                draft.backend === meta.id
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border'
              )}
            >
              <span className="font-medium block">{meta.label}</span>
              <span className="text-muted-foreground line-clamp-2 mt-0.5">{meta.description}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="settings-cli-path">{backendMeta.label} 路径</Label>
        <Input
          id="settings-cli-path"
          placeholder={backendMeta.pathPlaceholder}
          value={activeCliPath}
          onChange={e => setCliPath(e.target.value)}
        />
        {detectLabel && (
          <p className="text-xs text-muted-foreground">检测结果：{detectLabel}</p>
        )}
        <p className="text-xs text-muted-foreground">环境变量：{backendMeta.envHint}</p>
      </div>

      {candidates.length > 0 && (
        <div className="space-y-2">
          <Label>已检测到的 {backendMeta.label} 安装</Label>
          <div className="max-h-40 overflow-y-auto rounded-md border border-border divide-y divide-border">
            <button
              type="button"
              onClick={() => setCliPath('')}
              className={cn(
                'w-full text-left px-3 py-2 text-xs hover:bg-accent hover:text-accent-foreground transition-colors',
                !activeCliPath && 'bg-primary/10 text-primary'
              )}
            >
              自动选择（PATH / 默认路径）
            </button>
            {candidates.map(path => (
              <button
                key={path}
                type="button"
                onClick={() => setCliPath(path)}
                className={cn(
                  'w-full text-left px-3 py-2 text-xs hover:bg-accent hover:text-accent-foreground transition-colors break-all',
                  activeCliPath.replace(/\\/g, '/').toLowerCase() ===
                    path.replace(/\\/g, '/').toLowerCase() && 'bg-primary/10 text-primary'
                )}
              >
                <span className="font-medium">{claudePathLabel(path)}</span>
                <span className="block text-muted-foreground mt-0.5">{path}</span>
              </button>
            ))}
          </div>
          {candidates.length > 1 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const currentIdx = candidates.findIndex(
                  p =>
                    p.replace(/\\/g, '/').toLowerCase() ===
                    activeCliPath.replace(/\\/g, '/').toLowerCase()
                )
                const next =
                  currentIdx >= 0
                    ? candidates[(currentIdx + 1) % candidates.length]
                    : candidates[0]
                setCliPath(next)
              }}
            >
              切换到下一个安装
            </Button>
          )}
        </div>
      )}

      {draft.backend === 'claude-code' && mcpStatus && (
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
                void registerClaudeMcp(activeCliPath || undefined)
                  .then(status => {
                    setMcpStatus(status)
                  })
                  .catch(err => {
                    setMcpError(err instanceof Error ? err.message : String(err))
                  })
                  .finally(() => setMcpBusy(false))
              }}
              className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
            >
              {mcpBusy ? '注册中…' : '手动注册 MCP'}
            </button>
          )}
          {mcpError && (
            <p className="text-amber-600 dark:text-amber-400 break-words">{mcpError}</p>
          )}
        </div>
      )}

      {draft.backend !== 'claude-code' && (
        <div className="rounded-lg border border-dashed border-border bg-muted/10 p-3 text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">MCP / 远程 Shell</p>
          <p>
            {draft.backend === 'codex' &&
              '在 ~/.codex/config.toml 或 `codex mcp add` 注册 aiterm（clide --aiterm-mcp-stdio）。'}
            {draft.backend === 'opencode' &&
              '在项目 opencode.json 的 mcp 段添加 aiterm stdio 服务。'}
            {draft.backend === 'cursor' &&
              '在 ~/.cursor/mcp.json 配置 aiterm；headless 模式需 `agent --approve-mcps`。'}
          </p>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="settings-ai-system-prompt">System Prompt</Label>
        <textarea
          id="settings-ai-system-prompt"
          rows={3}
          value={draft.systemPrompt}
          onChange={e => onChange({ ...draft, systemPrompt: e.target.value })}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary resize-none"
        />
      </div>

      <div className="flex items-center justify-between">
        <div>
          <Label>注入终端上下文</Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            将当前 Shell 输出附加到提示词
            {draft.backend === 'claude-code' ? '（并经 IDE 桥接传给 Claude）' : ''}
          </p>
        </div>
        <Switch
          checked={draft.injectTerminalContext}
          onCheckedChange={injectTerminalContext => onChange({ ...draft, injectTerminalContext })}
        />
      </div>

      <div className="flex items-center justify-between">
        <div>
          <Label>敏感命令执行前确认</Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            开启后，删除文件、强制终止进程等不可撤销操作会先展示命令与影响说明，由你决定是否执行
          </p>
        </div>
        <Switch
          checked={draft.requireCommandApproval}
          onCheckedChange={requireCommandApproval =>
            onChange({ ...draft, requireCommandApproval })
          }
        />
      </div>

      <div className="flex items-center justify-between">
        <div>
          <Label>MCP 执行时切换终端</Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            开启后 runShellCommand 会自动聚焦到目标 Shell；多服务器并行时建议关闭
          </p>
        </div>
        <Switch
          checked={draft.focusShellOnMcpExecute}
          onCheckedChange={focusShellOnMcpExecute =>
            onChange({ ...draft, focusShellOnMcpExecute })
          }
        />
      </div>
    </div>
  )
}
