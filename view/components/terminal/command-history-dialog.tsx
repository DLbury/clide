'use client'

import { useMemo, useState } from 'react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { getCommandHistory } from '@/lib/command-history-store'

export interface CommandHistoryHit {
  sessionId: string
  command: string
}

function collectHistory(sessionIds: string[]): CommandHistoryHit[] {
  const hits: CommandHistoryHit[] = []
  for (const sessionId of sessionIds) {
    const commands = getCommandHistory(sessionId)
    for (const command of commands) {
      hits.push({ sessionId, command })
    }
  }
  return hits.reverse()
}

interface CommandHistoryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionIds: string[]
  onRunCommand: (command: string) => void
}

export function CommandHistoryDialog({
  open,
  onOpenChange,
  sessionIds,
  onRunCommand,
}: CommandHistoryDialogProps) {
  const [query, setQuery] = useState('')
  const allHits = useMemo(() => collectHistory(sessionIds), [sessionIds, open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return allHits.slice(0, 100)
    return allHits.filter(h => h.command.toLowerCase().includes(q)).slice(0, 100)
  }, [allHits, query])

  const handleSelect = (command: string) => {
    onRunCommand(command)
    onOpenChange(false)
    setQuery('')
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={v => {
        onOpenChange(v)
        if (!v) setQuery('')
      }}
      title="命令历史"
      description="搜索并重新执行历史命令"
      className="max-w-xl"
    >
      <CommandInput
        placeholder="搜索命令…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>无匹配命令</CommandEmpty>
        <CommandGroup heading="历史命令">
          {filtered.map((hit, i) => (
            <CommandItem
              key={`${hit.sessionId}-${i}-${hit.command.slice(0, 32)}`}
              value={hit.command}
              onSelect={() => handleSelect(hit.command)}
            >
              <span className="font-mono text-xs truncate">{hit.command}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
