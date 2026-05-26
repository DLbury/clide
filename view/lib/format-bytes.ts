export function formatBytesCompact(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const gb = bytes / (1024 ** 3)
  if (gb >= 10) return `${Math.round(gb)}GB`
  if (gb >= 1) return `${gb.toFixed(1)}GB`
  const mb = bytes / (1024 ** 2)
  if (mb >= 1) return `${Math.round(mb)}MB`
  return `${Math.round(bytes / 1024)}KB`
}

export function formatUsagePair(used: number, total: number): string {
  if (!total) return '—'
  return `${formatBytesCompact(used)}/${formatBytesCompact(total)}`
}

export function formatPercent(used: number, total: number): string {
  if (!total) return '—'
  return `${Math.round((used / total) * 100)}%`
}
