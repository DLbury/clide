'use client'

import { HardDrive, ArrowDown, ArrowUp, Activity } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatUsagePair, formatBytesPerSec } from '@/lib/format-bytes'
import type { RemoteHostStats } from '@/lib/terminal-client'
import { type HostStatsSample, sparklinePoints } from '@/lib/host-stats-history'

interface HostStatsPanelProps {
  hostStats: RemoteHostStats
  history: HostStatsSample[]
}

function StatSparkline({
  label,
  value,
  history,
  pick,
  colorClass,
}: {
  label: string
  value: string
  history: HostStatsSample[]
  pick: (s: HostStatsSample) => number
  colorClass: string
}) {
  const path =
    history.length >= 2 ? sparklinePoints(history, pick, 120, 32) : ''
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono">{value}</span>
      </div>
      {path ? (
        <svg width={120} height={32} className={colorClass} aria-hidden>
          <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      ) : (
        <div className="h-8 rounded bg-muted/40 text-[10px] text-muted-foreground flex items-center justify-center">
          采样中…
        </div>
      )}
    </div>
  )
}

export function HostStatsPanel({ hostStats, history }: HostStatsPanelProps) {
  const memRatio =
    hostStats.memTotalBytes > 0
      ? hostStats.memUsedBytes / hostStats.memTotalBytes
      : 0
  const diskIo = (hostStats.diskReadBps ?? 0) + (hostStats.diskWriteBps ?? 0)
  const netIo = (hostStats.netRxBps ?? 0) + (hostStats.netTxBps ?? 0)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:text-foreground hover:bg-muted/60"
          title="资源监控详情"
        >
          <Activity className="w-3 h-3" />
          <span>监控</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3 space-y-3">
        <p className="text-xs font-medium">远程主机资源（最近 {history.length} 次采样）</p>

        <StatSparkline
          label="CPU"
          value={`${hostStats.cpuPercent.toFixed(1)}%`}
          history={history}
          pick={s => s.cpuPercent}
          colorClass="text-primary/80"
        />

        <StatSparkline
          label="内存"
          value={formatUsagePair(hostStats.memUsedBytes, hostStats.memTotalBytes)}
          history={history}
          pick={s => s.memUsedRatio * 100}
          colorClass="text-sky-500/80"
        />

        <StatSparkline
          label="磁盘 IO"
          value={formatBytesPerSec(diskIo)}
          history={history}
          pick={s => (s.diskReadBps ?? 0) + (s.diskWriteBps ?? 0)}
          colorClass="text-amber-500/80"
        />

        <StatSparkline
          label="网络 IO"
          value={formatBytesPerSec(netIo)}
          history={history}
          pick={s => (s.netRxBps ?? 0) + (s.netTxBps ?? 0)}
          colorClass="text-violet-500/80"
        />

        <div className="grid grid-cols-2 gap-2 pt-1 border-t border-border text-[11px] font-mono">
          <div className="flex items-center gap-1 text-muted-foreground">
            <HardDrive className="w-3 h-3" />
            {formatUsagePair(hostStats.diskUsedBytes, hostStats.diskTotalBytes)}
          </div>
          {hostStats.diskReadBps != null && (
            <div className="flex items-center gap-0.5">
              <ArrowDown className="w-2.5 h-2.5 text-muted-foreground" />
              {formatBytesPerSec(hostStats.diskReadBps)}
            </div>
          )}
          {hostStats.diskWriteBps != null && (
            <div className="flex items-center gap-0.5">
              <ArrowUp className="w-2.5 h-2.5 text-muted-foreground" />
              {formatBytesPerSec(hostStats.diskWriteBps)}
            </div>
          )}
          {hostStats.netRxBps != null && (
            <div className="flex items-center gap-0.5">
              <ArrowDown className="w-2.5 h-2.5 text-muted-foreground" />
              {formatBytesPerSec(hostStats.netRxBps)}
            </div>
          )}
          {hostStats.netTxBps != null && (
            <div className="flex items-center gap-0.5">
              <ArrowUp className="w-2.5 h-2.5 text-muted-foreground" />
              {formatBytesPerSec(hostStats.netTxBps)}
            </div>
          )}
        </div>

        {hostStats.gpuMemTotalBytes != null && hostStats.gpuMemUsedBytes != null && (
          <div className="flex items-center justify-between text-xs border-t border-border pt-2">
            <span className="text-muted-foreground">显存</span>
            <span className="font-mono">
              {formatUsagePair(hostStats.gpuMemUsedBytes, hostStats.gpuMemTotalBytes)}
            </span>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
