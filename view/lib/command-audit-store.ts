const AUDIT_KEY = 'aiterm-command-audit-v1'
const MAX_AUDIT = 5000

export interface CommandAuditEntry {
  id: string
  sessionId: string
  command: string
  timestamp: number
}

function readAudit(): CommandAuditEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(AUDIT_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as CommandAuditEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeAudit(entries: CommandAuditEntry[]): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(AUDIT_KEY, JSON.stringify(entries.slice(-MAX_AUDIT)))
  } catch {
    /* ignore */
  }
}

export function appendCommandAudit(sessionId: string, command: string): void {
  const trimmed = command.trim()
  if (!trimmed || trimmed.length > 4096) return
  const entry: CommandAuditEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    sessionId,
    command: trimmed,
    timestamp: Date.now(),
  }
  writeAudit([...readAudit(), entry])
}

export function listCommandAudit(): CommandAuditEntry[] {
  return readAudit().slice().reverse()
}

export function clearCommandAudit(): void {
  writeAudit([])
}

export function filterCommandAudit(
  entries: CommandAuditEntry[],
  query: string,
  sessionId?: string
): CommandAuditEntry[] {
  const q = query.trim().toLowerCase()
  return entries.filter(e => {
    if (sessionId && e.sessionId !== sessionId) return false
    if (!q) return true
    return e.command.toLowerCase().includes(q) || e.sessionId.toLowerCase().includes(q)
  })
}

export function getAuditProfileSessionId(entry: CommandAuditEntry): string | null {
  const idx = entry.sessionId.indexOf('::')
  if (idx <= 0) return null
  return entry.sessionId.slice(0, idx)
}

export function filterCommandAuditByProfile(
  entries: CommandAuditEntry[],
  profileSessionId: string
): CommandAuditEntry[] {
  return entries.filter(e => getAuditProfileSessionId(e) === profileSessionId)
}

export function countCommandAuditByProfile(
  entries: CommandAuditEntry[]
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const entry of entries) {
    const profileId = getAuditProfileSessionId(entry)
    if (!profileId) continue
    counts[profileId] = (counts[profileId] ?? 0) + 1
  }
  return counts
}

export function clearCommandAuditForProfile(profileSessionId: string): void {
  writeAudit(
    readAudit().filter(e => getAuditProfileSessionId(e) !== profileSessionId)
  )
}
