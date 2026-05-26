'use client'

import { useEffect, useState } from 'react'
import { Settings } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { AiSettingsPanel } from '@/components/settings/ai-settings-panel'
import {
  type AiSettings,
  DEFAULT_AI_SETTINGS,
} from '@/lib/ai-settings'
import { LAYOUT_SHORTCUTS, type SettingsTab } from '@/lib/layout-shortcuts'

interface SettingsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  activeTab?: SettingsTab
  aiSettings: AiSettings
  onSaveAiSettings: (settings: AiSettings) => void
}

const NAV_ITEMS: { id: SettingsTab; label: string }[] = [
  { id: 'ai', label: 'AI 助手' },
  { id: 'shortcuts', label: '快捷键' },
]

export function SettingsModal({
  open,
  onOpenChange,
  activeTab = 'ai',
  aiSettings,
  onSaveAiSettings,
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
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-hidden flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border">
          <DialogTitle className="flex items-center gap-2">
            <Settings className="w-4 h-4" />
            设置
          </DialogTitle>
          <DialogDescription>全局偏好与 AI 配置</DialogDescription>
        </DialogHeader>

        <div className="flex flex-1 min-h-0 overflow-hidden">
          <nav className="w-40 shrink-0 border-r border-border p-2 space-y-0.5">
            {NAV_ITEMS.map(item => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={cn(
                  'w-full text-left px-3 py-2 text-sm rounded-md transition-colors',
                  tab === item.id
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="flex-1 overflow-y-auto p-6">
            {tab === 'ai' && (
              <>
                <h3 className="text-sm font-medium mb-4">AI 助手</h3>
                <p className="text-xs text-muted-foreground mb-4">
                  API Key 仅保存在本地浏览器中，不会上传到服务器。
                </p>
                <AiSettingsPanel draft={aiDraft} onChange={setAiDraft} />
              </>
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

        {tab === 'ai' && (
          <DialogFooter className="px-6 py-4 border-t border-border gap-2 sm:gap-0">
            <Button type="button" variant="ghost" onClick={handleResetAi}>
              恢复 AI 默认
            </Button>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="button" onClick={handleSave}>
              保存
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
