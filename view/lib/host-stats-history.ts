import type { RemoteHostStats } from '@/lib/terminal-client'

export interface HostStatsSample {
  ts: number
  cpuPercent: number
  memUsedRatio: number
  diskReadBps?: number
  diskWriteBps?: number
  netRxBps?: number
  netTxBps?: number
  gpuUsedRatio?: number
  gpuPercent?: number
}

const MAX_SAMPLES = 60

export function appendHostStatsSample(
  history: HostStatsSample[],
  stats: RemoteHostStats
): HostStatsSample[] {
  const memUsedRatio =
    stats.memTotalBytes > 0 ? stats.memUsedBytes / stats.memTotalBytes : 0
  const gpuUsedRatio =
    stats.gpuMemTotalBytes != null &&
    stats.gpuMemUsedBytes != null &&
    stats.gpuMemTotalBytes > 0
      ? stats.gpuMemUsedBytes / stats.gpuMemTotalBytes
      : undefined
  const next: HostStatsSample = {
    ts: Date.now(),
    cpuPercent: stats.cpuPercent,
    memUsedRatio,
    diskReadBps: stats.diskReadBps,
    diskWriteBps: stats.diskWriteBps,
    netRxBps: stats.netRxBps,
    netTxBps: stats.netTxBps,
    gpuUsedRatio,
    gpuPercent: stats.gpuPercent,
  }
  const merged = [...history, next]
  return merged.length > MAX_SAMPLES ? merged.slice(-MAX_SAMPLES) : merged
}

export function sparklinePoints(
  samples: HostStatsSample[],
  pick: (s: HostStatsSample) => number,
  width: number,
  height: number
): string {
  if (samples.length < 2) return ''
  const values = samples.map(pick)
  const min = 0
  const max = Math.max(...values, 0.01)
  const step = width / (values.length - 1)
  return values
    .map((v, i) => {
      const x = i * step
      const y = height - (v - min) / (max - min) * height
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}
