'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Loader2, Server, Send } from 'lucide-react'
import { submitTerminalInput } from '@/lib/terminal-input-registry'
import type { Session } from '@/lib/types'

export interface SyncTerminalTarget {
  connectionId: string
  connectionName: string
  session: Session
  shellId: string
  shellTitle: string
  terminalSessionId: string
}

interface MultiServerSyncDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  targets: SyncTerminalTarget[]
}

export function MultiServerSyncDialog({
  open,
  onOpenChange,
  targets,
}: MultiServerSyncDialogProps) {
  const [command, setCommand] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [lastSent, setLastSent] = useState<string | null>(null)

  const targetKeys = useMemo(
    () => targets.map(t => `${t.connectionId}::${t.shellId}`),
    [targets]
  )

  useEffect(() => {
    if (!open) return
    setSelected(new Set(targetKeys))
    setLastSent(null)
  }, [open, targetKeys])

  const toggle = (key: string, checked: boolean) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (checked) next.add(key)
      else next.delete(key)
      return next
    })
  }

  const handleSend = useCallback(async () => {
    const trimmed = command.trim()
    if (!trimmed || selected.size === 0) return
    setBusy(true)
    try {
      const picked = targets.filter(t => selected.has(`${t.connectionId}::${t.shellId}`))
      await Promise.all(
        picked.map(t =>
          submitTerminalInput(t.terminalSessionId, `\x15${trimmed}\n`).catch(() => {})
        )
      )
      setLastSent(`已向 ${picked.length} 个终端发送命令`)
    } finally {
      setBusy(false)
    }
  }, [command, selected, targets])

  const labelFor = (t: SyncTerminalTarget) => {
    const host =
      t.session.type === 'ssh'
        ? `${t.session.user ? `${t.session.user}@` : ''}${t.session.host}`
        : t.session.name
    return `${t.connectionName} / ${t.shellTitle} (${host})`
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="w-4 h-4" />
            多服务器同步执行
          </DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          将同一条命令并行发送到多个已连接终端（Ctrl+Enter 发送）。
        </p>

        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden space-y-2 rounded border border-border p-2">
          {targets.length === 0 ? (
            <p className="text-sm text-muted-foreground p-2 text-center">
              需要至少 2 个已连接的 SSH / 本地 / WSL 终端
            </p>
          ) : (
            targets.map(t => {
              const key = `${t.connectionId}::${t.shellId}`
              return (
                <label
                  key={key}
                  className="flex items-start gap-2 rounded px-2 py-1.5 hover:bg-muted/40 cursor-pointer"
                >
                  <Checkbox
                    checked={selected.has(key)}
                    onCheckedChange={v => toggle(key, v === true)}
                    className="mt-0.5"
                  />
                  <span className="text-sm min-w-0 break-all">{labelFor(t)}</span>
                </label>
              )
            })
          )}
        </div>

        <Input
          value={command}
          onChange={e => setCommand(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void handleSend()
            }
          }}
          placeholder="输入要同步执行的命令…"
          className="font-mono"
        />

        {lastSent && (
          <p className="text-xs text-muted-foreground">{lastSent}</p>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button
            onClick={() => void handleSend()}
            disabled={busy || !command.trim() || selected.size === 0}
          >
            {busy ? (
              <Loader2 className="w-4 h-4 animate-spin mr-1" />
            ) : (
              <Send className="w-4 h-4 mr-1" />
            )}
            发送到 {selected.size} 个终端
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
