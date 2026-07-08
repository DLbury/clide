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

/** 字节/秒，用于磁盘与网络 IO 速率 */
export function formatBytesPerSec(bps: number): string {
  if (!Number.isFinite(bps) || bps < 0) return '—'
  if (bps >= 1024 ** 3) return `${(bps / 1024 ** 3).toFixed(1)}G/s`
  if (bps >= 1024 ** 2) return `${(bps / 1024 ** 2).toFixed(1)}M/s`
  if (bps >= 1024) return `${Math.round(bps / 1024)}K/s`
  return `${Math.round(bps)}B/s`
}
