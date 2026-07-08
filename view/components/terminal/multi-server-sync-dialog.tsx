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
import { Checkbox } from '@/components/ui/checkbox'
import { Loader2, Play, Server } from 'lucide-react'
import type { Session } from '@/lib/types'

export interface SyncServerTarget {
  connectionId: string
  name: string
  hostLabel: string
  session: Session
}

interface MultiServerSyncDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  servers: SyncServerTarget[]
  onStart: (connectionIds: string[]) => void | Promise<void>
}

export function MultiServerSyncDialog({
  open,
  onOpenChange,
  servers,
  onStart,
}: MultiServerSyncDialogProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const serverIds = useMemo(() => servers.map(s => s.connectionId), [servers])

  useEffect(() => {
    if (!open) return
    setSelected(new Set(serverIds))
  }, [open, serverIds])

  const toggle = (connectionId: string, checked: boolean) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (checked) next.add(connectionId)
      else next.delete(connectionId)
      return next
    })
  }

  const handleStart = useCallback(async () => {
    const picked = serverIds.filter(id => selected.has(id))
    if (picked.length < 2) return
    setBusy(true)
    try {
      await onStart(picked)
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }, [onStart, onOpenChange, selected, serverIds])

  return (
    <Dialog open={open} onOpenChange={open => !busy && onOpenChange(open)}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="w-4 h-4" />
            多服务器同步输入
          </DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          选择要同步操作的服务器，点击「开始」后将打开新的同步界面：每个服务器一个
          Shell，在任意终端输入时其余终端会同步输入。
        </p>

        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden space-y-2 rounded border border-border p-2">
          {servers.length === 0 ? (
            <p className="text-sm text-muted-foreground p-2 text-center">
              需要至少 2 个已连接的服务器（SSH / 本地 / WSL）
            </p>
          ) : (
            servers.map(server => (
              <label
                key={server.connectionId}
                className="flex items-start gap-2 rounded px-2 py-1.5 hover:bg-muted/40 cursor-pointer"
              >
                <Checkbox
                  checked={selected.has(server.connectionId)}
                  onCheckedChange={v => toggle(server.connectionId, v === true)}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{server.name}</span>
                  <span className="block text-xs text-muted-foreground break-all">
                    {server.hostLabel}
                  </span>
                </span>
              </label>
            ))
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button
            onClick={() => void handleStart()}
            disabled={busy || selected.size < 2}
          >
            {busy ? (
              <Loader2 className="w-4 h-4 animate-spin mr-1" />
            ) : (
              <Play className="w-4 h-4 mr-1" />
            )}
            开始（{selected.size} 台）
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
