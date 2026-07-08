'use client'

import { useEffect, useMemo, useState } from 'react'
import { ScrollText } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Session, SessionFolder } from '@/lib/types'
import {
  clearCommandAuditForProfile,
  countCommandAuditByProfile,
  filterCommandAuditByProfile,
  getAuditProfileSessionId,
  listCommandAudit,
} from '@/lib/command-audit-store'
import { CommandAuditPanel } from '@/components/settings/command-audit-panel'

interface CommandAuditSettingsPanelProps {
  folders: SessionFolder[]
  shellLabels?: Record<string, string>
  onRunCommand?: (sessionId: string, command: string) => void
}

function formatSessionHost(session: Session): string {
  if (session.type === 'serial') {
    return `${session.host} @ ${session.baudRate || 115200}`
  }
  const user = session.user ? `${session.user}@` : ''
  const port = session.port && session.port !== 22 ? `:${session.port}` : ''
  return `${user}${session.host ?? session.name}${port}`
}

interface AuditServerItem {
  id: string
  name: string
  subtitle: string
  count: number
}

export function CommandAuditSettingsPanel({
  folders,
  shellLabels = {},
  onRunCommand,
}: CommandAuditSettingsPanelProps) {
  const [tick, setTick] = useState(0)
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null)

  const allEntries = useMemo(() => {
    void tick
    return listCommandAudit()
  }, [tick])

  const counts = useMemo(() => countCommandAuditByProfile(allEntries), [allEntries])

  const serverItems = useMemo((): AuditServerItem[] => {
    const sessionById = new Map<string, Session>()
    for (const folder of folders) {
      for (const session of folder.sessions) {
        sessionById.set(session.id, session)
      }
    }

    const ids = new Set<string>(Object.keys(counts))
    for (const session of sessionById.values()) {
      ids.add(session.id)
    }

    return [...ids]
      .map(id => {
        const session = sessionById.get(id)
        return {
          id,
          name: session?.name ?? '已删除的服务器',
          subtitle: session ? formatSessionHost(session) : id,
          count: counts[id] ?? 0,
        }
      })
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      })
  }, [folders, counts])

  useEffect(() => {
    if (serverItems.length === 0) {
      setSelectedProfileId(null)
      return
    }
    if (!selectedProfileId || !serverItems.some(item => item.id === selectedProfileId)) {
      const firstWithEntries = serverItems.find(item => item.count > 0)
      setSelectedProfileId(firstWithEntries?.id ?? serverItems[0].id)
    }
  }, [serverItems, selectedProfileId])

  const profileEntries = useMemo(() => {
    if (!selectedProfileId) return []
    return filterCommandAuditByProfile(allEntries, selectedProfileId)
  }, [allEntries, selectedProfileId])

  const orphanCount = useMemo(
    () => allEntries.filter(e => !getAuditProfileSessionId(e)).length,
    [allEntries]
  )

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-medium flex items-center gap-2">
          <ScrollText className="w-4 h-4" />
          命令审计
        </h3>
        <p className="text-xs text-muted-foreground mt-1">
          按服务器查看终端执行过的命令，数据仅保存在本地。
          {allEntries.length > 0 && (
            <span className="ml-1">共 {allEntries.length} 条记录。</span>
          )}
        </p>
      </div>

      {serverItems.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center rounded border border-dashed border-border">
          暂无已保存的服务器。连接终端后执行的命令会在此按服务器归档。
        </p>
      ) : (
        <div className="flex gap-3 flex-col sm:flex-row">
          <nav className="sm:w-52 shrink-0 space-y-1 sm:max-h-[360px] sm:overflow-y-auto rounded border border-border p-1.5 bg-muted/20">
            {serverItems.map(item => (
              <button
                key={item.id}
                type="button"
                onClick={() => setSelectedProfileId(item.id)}
                className={cn(
                  'w-full text-left rounded-md px-2.5 py-2 transition-colors',
                  selectedProfileId === item.id
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium truncate">{item.name}</span>
                  <span
                    className={cn(
                      'shrink-0 text-[10px] tabular-nums px-1.5 py-0.5 rounded-full',
                      item.count > 0
                        ? 'bg-primary/15 text-primary'
                        : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {item.count}
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                  {item.subtitle}
                </p>
              </button>
            ))}
            {orphanCount > 0 && (
              <p className="text-[10px] text-muted-foreground px-2 pt-1">
                另有 {orphanCount} 条无法归属服务器的记录
              </p>
            )}
          </nav>

          <div className="flex-1 min-w-0">
            {selectedProfileId ? (
              <CommandAuditPanel
                entries={profileEntries}
                shellLabels={shellLabels}
                onRunCommand={onRunCommand}
                onClear={() => {
                  clearCommandAuditForProfile(selectedProfileId)
                  setTick(t => t + 1)
                }}
                emptyMessage="该服务器暂无命令记录。"
              />
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}
