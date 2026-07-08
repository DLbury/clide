'use client'

import { useEffect, useState } from 'react'
import { ExternalLink, Github, Settings, Star } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { AiSettingsPanel } from '@/components/settings/ai-settings-panel'
import { UpdateSettingsPanel } from '@/components/settings/update-settings-panel'
import { CommandAuditSettingsPanel } from '@/components/settings/command-audit-settings-panel'
import {
  type AiSettings,
  DEFAULT_AI_SETTINGS,
} from '@/lib/ai-settings'
import { LAYOUT_SHORTCUTS, type SettingsTab } from '@/lib/layout-shortcuts'
import type { SessionFolder } from '@/lib/types'

interface SettingsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  activeTab?: SettingsTab
  aiSettings: AiSettings
  onSaveAiSettings: (settings: AiSettings) => void
  folders?: SessionFolder[]
  auditShellLabels?: Record<string, string>
  onRunAuditCommand?: (sessionId: string, command: string) => void
}

const NAV_ITEMS: { id: SettingsTab; label: string }[] = [
  { id: 'ai', label: 'AI 助手' },
  { id: 'audit', label: '命令审计' },
  { id: 'update', label: '应用更新' },
  { id: 'shortcuts', label: '快捷键' },
]

/** 各设置页共用同一弹窗尺寸，避免切换标签时跳动 */
const SETTINGS_DIALOG_CLASS =
  'sm:max-w-5xl w-[min(96vw,64rem)] h-[min(90vh,680px)] max-h-[90vh] overflow-hidden flex flex-col p-0 gap-0'
const SETTINGS_BODY_CLASS = 'flex flex-1 min-h-0 overflow-hidden'
const SETTINGS_CONTENT_CLASS = 'flex-1 min-w-0 min-h-0 overflow-y-auto p-6'
const SETTINGS_FOOTER_CLASS =
  'shrink-0 px-6 py-4 border-t border-border min-h-[53px] flex items-center justify-between gap-2'

export function SettingsModal({
  open,
  onOpenChange,
  activeTab = 'ai',
  aiSettings,
  onSaveAiSettings,
  folders = [],
  auditShellLabels = {},
  onRunAuditCommand,
}: SettingsModalProps) {
  const [tab, setTab] = useState<SettingsTab>(activeTab)
  const [aiDraft, setAiDraft] = useState<AiSettings>(aiSettings)

  useEffect(() => {
    if (open) {
      setTab(activeTab)
      setAiDraft(aiSettings)
    }
  }, [open, activeTab, aiSettings])

  const handleSave = () => {
    onSaveAiSettings(aiDraft)
    onOpenChange(false)
  }

  const handleResetAi = () => {
    setAiDraft(DEFAULT_AI_SETTINGS)
  }

  if (!open) return null

  const groupedShortcuts = LAYOUT_SHORTCUTS.reduce<Record<string, typeof LAYOUT_SHORTCUTS>>(
    (acc, item) => {
      if (!acc[item.category]) acc[item.category] = []
      acc[item.category].push(item)
      return acc
    },
    {}
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={SETTINGS_DIALOG_CLASS}>
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Settings className="w-4 h-4" />
            设置
          </DialogTitle>
          <DialogDescription>全局偏好与 AI 配置</DialogDescription>
        </DialogHeader>

        <div className={SETTINGS_BODY_CLASS}>
          <nav className="w-40 shrink-0 border-r border-border p-2 space-y-0.5 overflow-y-auto">
            {NAV_ITEMS.map(item => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={cn(
                  'w-full text-left px-3 py-2 text-sm rounded-md transition-colors',
                  tab === item.id
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                )}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className={SETTINGS_CONTENT_CLASS}>
            {tab === 'ai' && (
              <>
                <h3 className="text-sm font-medium mb-4">AI 助手</h3>
                <p className="text-xs text-muted-foreground mb-4">
                  API Key 仅保存在本地浏览器中，不会上传到服务器。
                </p>
                <AiSettingsPanel draft={aiDraft} onChange={setAiDraft} />
              </>
            )}

            {tab === 'update' && <UpdateSettingsPanel />}

            {tab === 'audit' && (
              <CommandAuditSettingsPanel
                folders={folders}
                shellLabels={auditShellLabels}
                onRunCommand={onRunAuditCommand}
              />
            )}

            {tab === 'shortcuts' && (
              <>
                <h3 className="text-sm font-medium mb-2">窗口排列快捷键</h3>
                <p className="text-xs text-muted-foreground mb-4">
                  macOS 上将 Ctrl 换为 ⌘ 使用。
                </p>
                <div className="space-y-5">
                  {Object.entries(groupedShortcuts).map(([category, items]) => (
                    <div key={category}>
                      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                        {category}
                      </h4>
                      <div className="space-y-1">
                        {items.map(item => (
                          <div
                            key={item.id}
                            className="flex items-center justify-between py-1.5 text-sm"
                          >
                            <span>{item.label}</span>
                            <div className="flex items-center gap-1">
                              {item.keys.map(k => (
                                <kbd
                                  key={k}
                                  className="px-1.5 py-0.5 text-xs rounded border border-border bg-muted font-mono"
                                >
                                  {k}
                                </kbd>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div className={SETTINGS_FOOTER_CLASS}>
          {tab === 'ai' ? (
            <>
              <Button type="button" variant="ghost" onClick={handleResetAi}>
                恢复 AI 默认
              </Button>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  取消
                </Button>
                <Button type="button" onClick={handleSave}>
                  保存
                </Button>
              </div>
            </>
          ) : null}
        </div>

        {/* 站内推广：仓库入口（始终可见，非打扰式） */}
        <div className="flex items-center justify-between gap-3 px-6 py-2.5 border-t border-border bg-muted/30 text-xs text-muted-foreground shrink-0">
          <span>Clide · MIT · 开源运维终端</span>
          <div className="flex items-center gap-3">
            <a
              href="https://github.com/DLbury/clide"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-muted"
            >
              <Star className="w-3.5 h-3.5" />
              Star on GitHub
            </a>
            <a
              href="https://github.com/DLbury/clide/issues"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
            >
              <Github className="w-3.5 h-3.5" />
              Issues
            </a>
            <a
              href="https://github.com/DLbury/clide/releases"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Releases
            </a>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
