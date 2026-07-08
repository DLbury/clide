'use client'

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Copy, ChevronUp, ChevronDown, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  filterCommandAudit,
  type CommandAuditEntry,
} from '@/lib/command-audit-store'

type SortDir = 'asc' | 'desc'
type AuditSortKey = 'timestamp' | 'session' | 'command'

function toggleSortKey(
  current: { key: AuditSortKey; dir: SortDir },
  key: AuditSortKey,
  defaultDesc: AuditSortKey[]
): { key: AuditSortKey; dir: SortDir } {
  if (current.key === key) {
    return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
  }
  return { key, dir: defaultDesc.includes(key) ? 'desc' : 'asc' }
}

function SortableTh({
  label,
  active,
  dir,
  onClick,
  className,
}: {
  label: string
  active: boolean
  dir: SortDir
  onClick: () => void
  className?: string
}) {
  return (
    <th
      className={cn(
        'p-2 cursor-pointer select-none text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors',
        className
      )}
      onClick={onClick}
    >
      <span className="inline-flex items-center gap-0.5">
        {label}
        {active &&
          (dir === 'asc' ? (
            <ChevronUp className="w-3 h-3" />
          ) : (
            <ChevronDown className="w-3 h-3" />
          ))}
      </span>
    </th>
  )
}

function compareStrings(a: string, b: string, dir: SortDir): number {
  const cmp = a.localeCompare(b, undefined, { sensitivity: 'base' })
  return dir === 'asc' ? cmp : -cmp
}

function compareNumbers(a: number, b: number, dir: SortDir): number {
  return dir === 'asc' ? a - b : b - a
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export interface CommandAuditPanelProps {
  entries: CommandAuditEntry[]
  shellLabels?: Record<string, string>
  onRunCommand?: (sessionId: string, command: string) => void
  onClear?: () => void
  emptyMessage?: string
}

export function CommandAuditPanel({
  entries,
  shellLabels = {},
  onRunCommand,
  onClear,
  emptyMessage = '暂无审计记录。在终端执行的命令会自动记录。',
}: CommandAuditPanelProps) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ key: AuditSortKey; dir: SortDir }>({
    key: 'timestamp',
    dir: 'desc',
  })

  const labelFor = (sessionId: string) =>
    shellLabels[sessionId] ?? sessionId.split('::').pop() ?? sessionId

  const filtered = useMemo(
    () => filterCommandAudit(entries, query),
    [entries, query]
  )

  const sorted = useMemo(() => {
    const list = [...filtered]
    list.sort((a, b) => {
      switch (sort.key) {
        case 'timestamp':
          return compareNumbers(a.timestamp, b.timestamp, sort.dir)
        case 'session':
          return compareStrings(labelFor(a.sessionId), labelFor(b.sessionId), sort.dir)
        case 'command':
          return compareStrings(a.command, b.command, sort.dir)
        default:
          return 0
      }
    })
    return list
  }, [filtered, sort, shellLabels])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="搜索命令…"
          className="flex-1 min-w-[200px] h-9"
        />
        {onClear && entries.length > 0 && (
          <Button variant="outline" size="sm" className="h-9" onClick={onClear}>
            <Trash2 className="w-3.5 h-3.5 mr-1" />
            清空本服务器
          </Button>
        )}
      </div>

      <div className="min-h-[320px] max-h-[360px] overflow-auto rounded border border-border">
        <table className="w-full min-w-[560px] text-sm table-fixed">
          <colgroup>
            <col className="w-[132px]" />
            <col className="w-[120px]" />
            <col />
            <col className="w-[88px]" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-muted/90 backdrop-blur text-xs text-muted-foreground">
            <tr className="text-left">
              <SortableTh
                label="时间"
                active={sort.key === 'timestamp'}
                dir={sort.dir}
                onClick={() =>
                  setSort(prev => toggleSortKey(prev, 'timestamp', ['timestamp']))
                }
              />
              <SortableTh
                label="终端"
                active={sort.key === 'session'}
                dir={sort.dir}
                onClick={() =>
                  setSort(prev => toggleSortKey(prev, 'session', ['timestamp']))
                }
              />
              <SortableTh
                label="命令"
                active={sort.key === 'command'}
                dir={sort.dir}
                onClick={() =>
                  setSort(prev => toggleSortKey(prev, 'command', ['timestamp']))
                }
              />
              <th className="p-2 w-[88px]" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((entry: CommandAuditEntry) => (
              <tr key={entry.id} className="border-t border-border/40 hover:bg-muted/20">
                <td className="p-2 font-mono text-xs text-muted-foreground whitespace-nowrap align-top">
                  {formatTime(entry.timestamp)}
                </td>
                <td
                  className="p-2 text-xs align-top truncate"
                  title={labelFor(entry.sessionId)}
                >
                  {labelFor(entry.sessionId)}
                </td>
                <td className="p-2 font-mono text-xs align-top whitespace-pre-wrap break-words">
                  {entry.command}
                </td>
                <td className="p-2 align-top">
                  <div className="flex gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title="复制"
                      onClick={() => void navigator.clipboard.writeText(entry.command)}
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </Button>
                    {onRunCommand && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs px-2"
                        onClick={() => onRunCommand(entry.sessionId, entry.command)}
                      >
                        运行
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={4} className="p-8 text-center text-muted-foreground">
                  {emptyMessage}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
