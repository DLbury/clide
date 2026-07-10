'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RefreshCw, Skull, Loader2, HardDrive, Network, Gpu, ChevronUp, ChevronDown, Server, Clock, Cpu } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatUsagePair, formatBytesPerSec, formatBytesCompact } from '@/lib/format-bytes'
import { useResizableColumns } from '@/hooks/use-resizable-columns'
import {
  getRemoteHostStats,
  listRemoteProcesses,
  listRemotePorts,
  killRemoteProcess,
  killRemotePort,
  type RemoteHostStats,
  type RemoteProcess,
  type RemotePort,
} from '@/lib/terminal-client'
import type { Session } from '@/lib/types'
import {
  type HostStatsSample,
  sparklinePoints,
  appendHostStatsSample,
  mergeHostStatsHistory,
} from '@/lib/host-stats-history'

export interface ServerMonitorPanelProps {
  session: Session | null
  initialHistory?: HostStatsSample[]
  /** Panel is mounted and visible in the workbench */
  active?: boolean
}

function formatUptime(secs?: number): string {
  if (secs == null) return '—'
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (d > 0) return `${d}天 ${h}时`
  if (h > 0) return `${h}时 ${m}分`
  return `${m}分`
}

function pct(used: number, total: number): number {
  return total > 0 ? (used / total) * 100 : 0
}

function UsageBar({
  label,
  percent,
  detail,
  barClass,
}: {
  label: string
  percent: number
  detail: string
  barClass: string
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs gap-2">
        <span className="text-muted-foreground shrink-0">{label}</span>
        <span className="font-mono truncate">{detail}</span>
      </div>
      <div className="h-2 rounded-full bg-muted/80 overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all duration-500', barClass)}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
    </div>
  )
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 px-2.5 py-2 min-w-0">
      <p className="text-[10px] text-muted-foreground truncate">{label}</p>
      <p className="text-sm font-mono truncate">{value}</p>
    </div>
  )
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
  const path = history.length >= 2 ? sparklinePoints(history, pick, 160, 40) : ''
  return (
    <div className="rounded-lg border border-border p-3 space-y-2 min-w-0">
      <div className="flex items-center justify-between text-sm gap-2">
        <span className="text-muted-foreground shrink-0">{label}</span>
        <span className="font-mono truncate">{value}</span>
      </div>
      {path ? (
        <svg width="100%" height={40} viewBox="0 0 160 40" className={colorClass} aria-hidden>
          <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      ) : (
        <div className="h-10 text-xs text-muted-foreground flex items-center">采样中…</div>
      )}
    </div>
  )
}

function isPortQuery(q: string): boolean {
  const t = q.trim()
  return /^\d{1,5}$/.test(t) || /^:\d{1,5}$/.test(t)
}

function portFromQuery(q: string): number | null {
  const t = q.trim().replace(/^:/, '')
  const n = Number.parseInt(t, 10)
  return Number.isFinite(n) && n > 0 && n <= 65535 ? n : null
}

type SortDir = 'asc' | 'desc'
type ProcSortKey = 'pid' | 'cpu' | 'mem' | 'command'
type PortSortKey = 'port' | 'protocol' | 'pid' | 'address' | 'command'

function toggleSortKey<T extends string>(
  current: { key: T; dir: SortDir },
  key: T,
  defaultDesc: T[]
): { key: T; dir: SortDir } {
  if (current.key === key) {
    return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
  }
  return { key, dir: defaultDesc.includes(key) ? 'desc' : 'asc' }
}

function ResizableSortableTh({
  label,
  active,
  dir,
  onClick,
  width,
  onResizeStart,
}: {
  label: string
  active: boolean
  dir: SortDir
  onClick: () => void
  width: number
  onResizeStart: (e: React.MouseEvent) => void
}) {
  return (
    <th
      className="relative p-2 cursor-pointer select-none text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
      style={{ width }}
      onClick={onClick}
    >
      <span className="inline-flex items-center gap-0.5 pr-2">
        {label}
        {active &&
          (dir === 'asc' ? (
            <ChevronUp className="w-3 h-3" />
          ) : (
            <ChevronDown className="w-3 h-3" />
          ))}
      </span>
      <span
        role="separator"
        aria-orientation="vertical"
        className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-primary/40"
        onMouseDown={onResizeStart}
        onClick={e => e.stopPropagation()}
      />
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

export function ServerMonitorPanel({
  session,
  initialHistory = [],
  active = true,
}: ServerMonitorPanelProps) {
  const [stats, setStats] = useState<RemoteHostStats | null>(null)
  const [history, setHistory] = useState<HostStatsSample[]>(initialHistory)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [statsBusy, setStatsBusy] = useState(false)
  const [processes, setProcesses] = useState<RemoteProcess[]>([])
  const [ports, setPorts] = useState<RemotePort[]>([])
  const [procBusy, setProcBusy] = useState(false)
  const [procError, setProcError] = useState<string | null>(null)
  const [procFilter, setProcFilter] = useState('')
  const [killBusyKey, setKillBusyKey] = useState<string | null>(null)
  const [procTab, setProcTab] = useState<'processes' | 'ports'>('processes')
  const [procSort, setProcSort] = useState<{ key: ProcSortKey; dir: SortDir }>({
    key: 'cpu',
    dir: 'desc',
  })
  const [portSort, setPortSort] = useState<{ key: PortSortKey; dir: SortDir }>({
    key: 'port',
    dir: 'asc',
  })
  const openedSessionRef = useRef<string | null>(null)

  const procCols = useResizableColumns('clide-monitor-proc-cols', {
    pid: 56,
    cpu: 52,
    mem: 72,
    user: 88,
    command: 240,
    action: 40,
  })
  const portCols = useResizableColumns('clide-monitor-port-cols', {
    port: 72,
    protocol: 52,
    pid: 56,
    address: 120,
    command: 220,
    action: 40,
  })

  const refreshStats = useCallback(async () => {
    if (!session || session.type !== 'ssh') return
    setStatsBusy(true)
    setStatsError(null)
    try {
      const next = await getRemoteHostStats(session)
      setStats(next)
      setHistory(prev => appendHostStatsSample(prev, next))
    } catch (e) {
      setStatsError(e instanceof Error ? e.message : String(e))
    } finally {
      setStatsBusy(false)
    }
  }, [session])

  const refreshProcesses = useCallback(async () => {
    if (!session || session.type !== 'ssh') return
    setProcBusy(true)
    setProcError(null)
    try {
      const [list, portList] = await Promise.all([
        listRemoteProcesses(session),
        listRemotePorts(session),
      ])
      setProcesses(list)
      setPorts(portList)
    } catch (e) {
      setProcError(e instanceof Error ? e.message : String(e))
    } finally {
      setProcBusy(false)
    }
  }, [session])

  useEffect(() => {
    if (!active || !session) {
      openedSessionRef.current = null
      return
    }
    const sessionKey = session.id
    if (openedSessionRef.current !== sessionKey) {
      openedSessionRef.current = sessionKey
      setHistory(initialHistory)
      setProcFilter('')
      setProcTab('processes')
      void refreshStats()
      void refreshProcesses()
    }
  }, [active, session?.id, refreshStats, refreshProcesses, session])

  // Merge background polling history from the status bar / page layer.
  useEffect(() => {
    if (!active) return
    setHistory(prev => mergeHostStatsHistory(prev, initialHistory))
  }, [active, initialHistory])

  useEffect(() => {
    if (!active || !session || session.type !== 'ssh') return
    const timer = window.setInterval(() => void refreshStats(), 30_000)
    return () => window.clearInterval(timer)
  }, [active, session, refreshStats])

  useEffect(() => {
    if (isPortQuery(procFilter)) {
      setProcTab('ports')
    }
  }, [procFilter])

  const processByPid = useMemo(() => {
    const map = new Map<number, RemoteProcess>()
    for (const p of processes) map.set(p.pid, p)
    return map
  }, [processes])

  const filteredProcs = useMemo(() => {
    const q = procFilter.trim().toLowerCase()
    let list = processes
    if (q && !isPortQuery(q)) {
      const portNum = portFromQuery(q)
      if (portNum != null) {
        const pids = new Set(
          ports.filter(p => p.port === portNum || String(p.port).includes(q)).map(p => p.pid)
        )
        if (pids.size > 0) {
          list = processes.filter(p => pids.has(p.pid))
        } else {
          list = processes.filter(
            p =>
              p.command.toLowerCase().includes(q) ||
              String(p.pid).includes(q) ||
              (p.user?.toLowerCase().includes(q) ?? false)
          )
        }
      } else {
        list = processes.filter(
          p =>
            p.command.toLowerCase().includes(q) ||
            String(p.pid).includes(q) ||
            (p.user?.toLowerCase().includes(q) ?? false)
        )
      }
    }
    const sorted = [...list]
    sorted.sort((a, b) => {
      switch (procSort.key) {
        case 'pid':
          return compareNumbers(a.pid, b.pid, procSort.dir)
        case 'cpu':
          return compareNumbers(a.cpuPercent, b.cpuPercent, procSort.dir)
        case 'mem':
          return compareNumbers(
            a.memBytes ?? a.memPercent,
            b.memBytes ?? b.memPercent,
            procSort.dir
          )
        case 'command':
          return compareStrings(
            `${a.user ?? ''}:${a.command}`,
            `${b.user ?? ''}:${b.command}`,
            procSort.dir
          )
        default:
          return 0
      }
    })
    return sorted
  }, [processes, ports, procFilter, procSort])

  const filteredPorts = useMemo(() => {
    const q = procFilter.trim().toLowerCase()
    let list = ports
    if (q) {
      const portNum = portFromQuery(q)
      list = ports.filter(p => {
        if (portNum != null && p.port === portNum) return true
        if (String(p.port).includes(q)) return true
        if (p.address.toLowerCase().includes(q)) return true
        if (p.protocol.includes(q)) return true
        if (String(p.pid).includes(q)) return true
        const proc = processByPid.get(p.pid)
        if (proc?.command.toLowerCase().includes(q)) return true
        if (proc?.user?.toLowerCase().includes(q)) return true
        if (p.command?.toLowerCase().includes(q)) return true
        return false
      })
    }
    const sorted = [...list]
    sorted.sort((a, b) => {
      const procA = processByPid.get(a.pid)
      const procB = processByPid.get(b.pid)
      const nameA = procA?.command ?? a.command ?? ''
      const nameB = procB?.command ?? b.command ?? ''
      switch (portSort.key) {
        case 'port':
          return compareNumbers(a.port, b.port, portSort.dir)
        case 'protocol':
          return compareStrings(a.protocol, b.protocol, portSort.dir)
        case 'pid':
          return compareNumbers(a.pid, b.pid, portSort.dir)
        case 'address':
          return compareStrings(a.address, b.address, portSort.dir)
        case 'command':
          return compareStrings(nameA, nameB, portSort.dir)
        default:
          return 0
      }
    })
    return sorted
  }, [ports, procFilter, processByPid, portSort])

  const killKeyForPid = (pid: number) => `pid:${pid}`
  const killKeyForPort = (p: RemotePort) => `port:${p.protocol}:${p.port}:${p.pid}`

  const handleKill = async (pid: number, force: boolean) => {
    if (!session) return
    const key = killKeyForPid(pid)
    setKillBusyKey(key)
    try {
      await killRemoteProcess(session, pid, force)
      await refreshProcesses()
    } catch (e) {
      setProcError(e instanceof Error ? e.message : String(e))
    } finally {
      setKillBusyKey(null)
    }
  }

  const handleKillPort = async (port: RemotePort) => {
    if (!session) return
    const key = killKeyForPort(port)
    setKillBusyKey(key)
    try {
      if (port.pid > 0) {
        await killRemoteProcess(session, port.pid, false)
      } else {
        await killRemotePort(session, port.port, port.protocol)
      }
      await refreshProcesses()
    } catch (e) {
      setProcError(e instanceof Error ? e.message : String(e))
    } finally {
      setKillBusyKey(null)
    }
  }

  const diskIo = stats ? (stats.diskReadBps ?? 0) + (stats.diskWriteBps ?? 0) : 0
  const netIo = stats ? (stats.netRxBps ?? 0) + (stats.netTxBps ?? 0) : 0
  const memAvailBytes =
    stats && stats.memTotalBytes > stats.memUsedBytes
      ? stats.memTotalBytes - stats.memUsedBytes
      : 0
  const diskFreeBytes =
    stats && stats.diskTotalBytes > stats.diskUsedBytes
      ? stats.diskTotalBytes - stats.diskUsedBytes
      : 0
  const loadDetail =
    stats?.loadAvg1 != null
      ? `${stats.loadAvg1.toFixed(2)} / ${stats.loadAvg5?.toFixed(2) ?? '—'} / ${stats.loadAvg15?.toFixed(2) ?? '—'}`
      : '—'
  const hasGpuStats =
    stats &&
    (stats.gpuPercent != null ||
      (stats.gpuMemTotalBytes != null && stats.gpuMemUsedBytes != null))
  const gpuLabel =
    stats?.gpuPercent != null &&
    stats.gpuMemTotalBytes != null &&
    stats.gpuMemUsedBytes != null
      ? `${stats.gpuPercent.toFixed(1)}% · ${formatUsagePair(stats.gpuMemUsedBytes, stats.gpuMemTotalBytes)}`
      : stats?.gpuPercent != null
        ? `${stats.gpuPercent.toFixed(1)}%`
        : stats?.gpuMemTotalBytes != null && stats.gpuMemUsedBytes != null
          ? formatUsagePair(stats.gpuMemUsedBytes, stats.gpuMemTotalBytes)
          : '—'

  if (!session || session.type !== 'ssh') {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        仅 SSH 连接支持服务器监控
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden p-3">
      <Tabs defaultValue="overview" className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <TabsList className="shrink-0">
          <TabsTrigger value="overview">资源概览</TabsTrigger>
          <TabsTrigger value="processes">进程 / 端口</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="flex-1 overflow-y-auto overflow-x-hidden space-y-3 mt-3">
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refreshStats()}
              disabled={statsBusy}
            >
              {statsBusy ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5 mr-1" />
              )}
              刷新
            </Button>
          </div>
          {statsError && (
            <p className="text-sm text-destructive rounded border border-destructive/30 bg-destructive/5 p-2">
              {statsError}
            </p>
          )}
          {stats && (
            <>
              <div className="rounded-lg border border-border p-3 space-y-2 bg-muted/10">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Server className="w-4 h-4 text-muted-foreground" />
                  <span className="truncate">{stats.hostname ?? session.host ?? session.name}</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <MetricTile
                    label="运行时间"
                    value={formatUptime(stats.uptimeSecs)}
                  />
                  <MetricTile
                    label="负载 (1/5/15m)"
                    value={loadDetail}
                  />
                  <MetricTile
                    label="CPU 核心"
                    value={stats.cpuCores != null ? String(stats.cpuCores) : '—'}
                  />
                  <MetricTile
                    label="进程数"
                    value={stats.processCount != null ? String(stats.processCount) : '—'}
                  />
                </div>
              </div>

              <div className="rounded-lg border border-border p-3 space-y-3">
                <p className="text-xs font-medium text-muted-foreground">资源使用率</p>
                <UsageBar
                  label="CPU"
                  percent={stats.cpuPercent}
                  detail={`${stats.cpuPercent.toFixed(1)}%${stats.cpuCores ? ` · ${stats.cpuCores} 核` : ''}`}
                  barClass="bg-primary/80"
                />
                <UsageBar
                  label="内存"
                  percent={pct(stats.memUsedBytes, stats.memTotalBytes)}
                  detail={formatUsagePair(stats.memUsedBytes, stats.memTotalBytes)}
                  barClass="bg-sky-500/80"
                />
                <UsageBar
                  label="磁盘 (/)"
                  percent={pct(stats.diskUsedBytes, stats.diskTotalBytes)}
                  detail={formatUsagePair(stats.diskUsedBytes, stats.diskTotalBytes)}
                  barClass="bg-amber-500/80"
                />
                {stats.swapTotalBytes != null && stats.swapTotalBytes > 0 && (
                  <UsageBar
                    label="Swap"
                    percent={pct(stats.swapUsedBytes ?? 0, stats.swapTotalBytes)}
                    detail={formatUsagePair(stats.swapUsedBytes ?? 0, stats.swapTotalBytes)}
                    barClass="bg-orange-500/70"
                  />
                )}
                {hasGpuStats && (
                  <UsageBar
                    label="GPU"
                    percent={
                      stats.gpuPercent ??
                      (stats.gpuMemTotalBytes && stats.gpuMemUsedBytes
                        ? pct(stats.gpuMemUsedBytes, stats.gpuMemTotalBytes)
                        : 0)
                    }
                    detail={gpuLabel}
                    barClass="bg-emerald-500/80"
                  />
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <StatSparkline
                  label="CPU"
                  value={`${stats.cpuPercent.toFixed(1)}%`}
                  history={history}
                  pick={s => s.cpuPercent}
                  colorClass="text-primary/80"
                />
                <StatSparkline
                  label="内存"
                  value={formatUsagePair(stats.memUsedBytes, stats.memTotalBytes)}
                  history={history}
                  pick={s => s.memUsedRatio * 100}
                  colorClass="text-sky-500/80"
                />
                <StatSparkline
                  label="磁盘读"
                  value={formatBytesPerSec(stats.diskReadBps ?? 0)}
                  history={history}
                  pick={s => s.diskReadBps ?? 0}
                  colorClass="text-amber-500/80"
                />
                <StatSparkline
                  label="磁盘写"
                  value={formatBytesPerSec(stats.diskWriteBps ?? 0)}
                  history={history}
                  pick={s => s.diskWriteBps ?? 0}
                  colorClass="text-amber-600/80"
                />
                <StatSparkline
                  label="网络入"
                  value={formatBytesPerSec(stats.netRxBps ?? 0)}
                  history={history}
                  pick={s => s.netRxBps ?? 0}
                  colorClass="text-violet-500/80"
                />
                <StatSparkline
                  label="网络出"
                  value={formatBytesPerSec(stats.netTxBps ?? 0)}
                  history={history}
                  pick={s => s.netTxBps ?? 0}
                  colorClass="text-violet-600/80"
                />
                {hasGpuStats && (
                  <StatSparkline
                    label="GPU"
                    value={gpuLabel}
                    history={history}
                    pick={s =>
                      s.gpuPercent ??
                      (s.gpuUsedRatio != null ? s.gpuUsedRatio * 100 : 0)
                    }
                    colorClass="text-emerald-500/80"
                  />
                )}
              </div>

              <div className="rounded-lg border border-border p-3 space-y-2">
                <p className="text-xs font-medium text-muted-foreground">内存 / 磁盘详情</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-xs font-mono">
                  <span className="text-muted-foreground">可用内存</span>
                  <span className="col-span-1 sm:col-span-2">{formatBytesCompact(memAvailBytes)}</span>
                  {stats.memBuffersBytes != null && (
                    <>
                      <span className="text-muted-foreground">Buffers</span>
                      <span className="col-span-1 sm:col-span-2">{formatBytesCompact(stats.memBuffersBytes)}</span>
                    </>
                  )}
                  {stats.memCachedBytes != null && (
                    <>
                      <span className="text-muted-foreground">Cached</span>
                      <span className="col-span-1 sm:col-span-2">{formatBytesCompact(stats.memCachedBytes)}</span>
                    </>
                  )}
                  <span className="text-muted-foreground">磁盘可用</span>
                  <span className="col-span-1 sm:col-span-2">{formatBytesCompact(diskFreeBytes)}</span>
                  <span className="text-muted-foreground">磁盘 IO 合计</span>
                  <span className="col-span-1 sm:col-span-2">{formatBytesPerSec(diskIo)}</span>
                  <span className="text-muted-foreground">网络 IO 合计</span>
                  <span className="col-span-1 sm:col-span-2">{formatBytesPerSec(netIo)}</span>
                </div>
              </div>

              <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
                <span className="flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5" />
                  更新间隔 30s
                </span>
                <span className="flex items-center gap-1">
                  <Cpu className="w-3.5 h-3.5" />
                  采样 {history.length} 次
                </span>
                <span className="flex items-center gap-1">
                  <HardDrive className="w-3.5 h-3.5" />
                  {formatUsagePair(stats.diskUsedBytes, stats.diskTotalBytes)}
                </span>
                {hasGpuStats && (
                  <span className="flex items-center gap-1">
                    <Gpu className="w-3.5 h-3.5" />
                    {gpuLabel}
                  </span>
                )}
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="processes" className="flex-1 min-h-0 flex flex-col gap-2 mt-3 overflow-hidden">
          <div className="flex gap-2 shrink-0">
            <Input
              value={procFilter}
              onChange={e => setProcFilter(e.target.value)}
              placeholder="过滤进程 / PID / 用户 / 端口（如 8080）"
              className="h-8 min-w-0 flex-1"
            />
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={() => void refreshProcesses()}
              disabled={procBusy}
            >
              {procBusy ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
            </Button>
          </div>

          <div className="flex gap-2 shrink-0">
            <Button
              size="sm"
              variant={procTab === 'processes' ? 'secondary' : 'ghost'}
              className="h-7 text-xs"
              onClick={() => setProcTab('processes')}
            >
              进程 ({filteredProcs.length})
            </Button>
            <Button
              size="sm"
              variant={procTab === 'ports' ? 'secondary' : 'ghost'}
              className="h-7 text-xs"
              onClick={() => setProcTab('ports')}
            >
              <Network className="w-3 h-3 mr-1" />
              端口 ({filteredPorts.length})
            </Button>
          </div>

          {procError && (
            <p className="text-sm text-destructive shrink-0">{procError}</p>
          )}

          <div className="flex-1 min-h-0 overflow-auto rounded border border-border">
            {procTab === 'ports' ? (
              <table className="w-max min-w-full text-xs table-fixed">
                <thead className="sticky top-0 bg-muted/80 backdrop-blur z-10">
                  <tr className="text-left text-muted-foreground">
                    <ResizableSortableTh
                      label="端口"
                      active={portSort.key === 'port'}
                      dir={portSort.dir}
                      width={portCols.widths.port ?? 72}
                      onResizeStart={e => portCols.startResize('port', e)}
                      onClick={() =>
                        setPortSort(prev =>
                          toggleSortKey(prev, 'port', ['port', 'pid'])
                        )
                      }
                    />
                    <ResizableSortableTh
                      label="协议"
                      active={portSort.key === 'protocol'}
                      dir={portSort.dir}
                      width={portCols.widths.protocol ?? 52}
                      onResizeStart={e => portCols.startResize('protocol', e)}
                      onClick={() =>
                        setPortSort(prev =>
                          toggleSortKey(prev, 'protocol', ['port', 'pid'])
                        )
                      }
                    />
                    <ResizableSortableTh
                      label="PID"
                      active={portSort.key === 'pid'}
                      dir={portSort.dir}
                      width={portCols.widths.pid ?? 56}
                      onResizeStart={e => portCols.startResize('pid', e)}
                      onClick={() =>
                        setPortSort(prev => toggleSortKey(prev, 'pid', ['port', 'pid']))
                      }
                    />
                    <ResizableSortableTh
                      label="地址"
                      active={portSort.key === 'address'}
                      dir={portSort.dir}
                      width={portCols.widths.address ?? 120}
                      onResizeStart={e => portCols.startResize('address', e)}
                      onClick={() =>
                        setPortSort(prev =>
                          toggleSortKey(prev, 'address', ['port', 'pid'])
                        )
                      }
                    />
                    <ResizableSortableTh
                      label="进程"
                      active={portSort.key === 'command'}
                      dir={portSort.dir}
                      width={portCols.widths.command ?? 220}
                      onResizeStart={e => portCols.startResize('command', e)}
                      onClick={() =>
                        setPortSort(prev =>
                          toggleSortKey(prev, 'command', ['port', 'pid'])
                        )
                      }
                    />
                    <th className="p-2" style={{ width: portCols.widths.action ?? 40 }} />
                  </tr>
                </thead>
                <tbody>
                  {filteredPorts.map(p => {
                    const proc = processByPid.get(p.pid)
                    const name = proc?.command ?? p.command ?? '—'
                    const busyKey = killKeyForPort(p)
                    return (
                      <tr
                        key={`${p.protocol}-${p.address}-${p.port}-${p.pid}`}
                        className="border-t border-border/50 hover:bg-muted/30"
                      >
                        <td className="p-2 font-mono truncate">{p.port}</td>
                        <td className="p-2 uppercase truncate">{p.protocol}</td>
                        <td className="p-2 font-mono truncate">{p.pid || '—'}</td>
                        <td className="p-2 font-mono truncate" title={p.address}>
                          {p.address}
                        </td>
                        <td className="p-2 truncate min-w-0" title={name}>
                          {proc?.user ? `${proc.user}: ` : ''}
                          {name}
                        </td>
                        <td className="p-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                            disabled={killBusyKey === busyKey}
                            onClick={() => void handleKillPort(p)}
                            title={
                              p.pid > 0
                                ? `终止占用端口 ${p.port} 的进程 (PID ${p.pid})`
                                : `释放端口 ${p.port}`
                            }
                          >
                            {killBusyKey === busyKey ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Skull className="w-3 h-3" />
                            )}
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                  {!procBusy && filteredPorts.length === 0 && (
                    <tr>
                      <td colSpan={6} className="p-4 text-center text-muted-foreground">
                        无端口数据
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            ) : (
              <table className="w-max min-w-full text-xs table-fixed">
                <thead className="sticky top-0 bg-muted/80 backdrop-blur z-10">
                  <tr className="text-left text-muted-foreground">
                    <ResizableSortableTh
                      label="PID"
                      active={procSort.key === 'pid'}
                      dir={procSort.dir}
                      width={procCols.widths.pid ?? 56}
                      onResizeStart={e => procCols.startResize('pid', e)}
                      onClick={() =>
                        setProcSort(prev => toggleSortKey(prev, 'pid', ['cpu', 'mem', 'pid']))
                      }
                    />
                    <ResizableSortableTh
                      label="CPU%"
                      active={procSort.key === 'cpu'}
                      dir={procSort.dir}
                      width={procCols.widths.cpu ?? 52}
                      onResizeStart={e => procCols.startResize('cpu', e)}
                      onClick={() =>
                        setProcSort(prev => toggleSortKey(prev, 'cpu', ['cpu', 'mem', 'pid']))
                      }
                    />
                    <ResizableSortableTh
                      label="内存"
                      active={procSort.key === 'mem'}
                      dir={procSort.dir}
                      width={procCols.widths.mem ?? 72}
                      onResizeStart={e => procCols.startResize('mem', e)}
                      onClick={() =>
                        setProcSort(prev => toggleSortKey(prev, 'mem', ['cpu', 'mem', 'pid']))
                      }
                    />
                    <ResizableSortableTh
                      label="用户"
                      active={false}
                      dir="asc"
                      width={procCols.widths.user ?? 88}
                      onResizeStart={e => procCols.startResize('user', e)}
                      onClick={() => {}}
                    />
                    <ResizableSortableTh
                      label="命令"
                      active={procSort.key === 'command'}
                      dir={procSort.dir}
                      width={procCols.widths.command ?? 240}
                      onResizeStart={e => procCols.startResize('command', e)}
                      onClick={() =>
                        setProcSort(prev =>
                          toggleSortKey(prev, 'command', ['cpu', 'mem', 'pid'])
                        )
                      }
                    />
                    <th className="p-2" style={{ width: procCols.widths.action ?? 40 }} />
                  </tr>
                </thead>
                <tbody>
                  {filteredProcs.map(p => (
                    <tr key={p.pid} className="border-t border-border/50 hover:bg-muted/30">
                      <td className="p-2 font-mono truncate">{p.pid}</td>
                      <td className="p-2 font-mono truncate">{p.cpuPercent.toFixed(1)}</td>
                      <td className="p-2 font-mono truncate">
                        {p.memBytes != null
                          ? formatBytesCompact(p.memBytes)
                          : `${p.memPercent.toFixed(1)}%`}
                      </td>
                      <td className="p-2 truncate" title={p.user}>
                        {p.user ?? '—'}
                      </td>
                      <td className="p-2 truncate min-w-0" title={p.command}>
                        {p.command}
                      </td>
                      <td className="p-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                          disabled={killBusyKey === killKeyForPid(p.pid)}
                          onClick={() => void handleKill(p.pid, false)}
                          title="终止进程 (SIGTERM)"
                        >
                          {killBusyKey === killKeyForPid(p.pid) ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Skull className="w-3 h-3" />
                          )}
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {!procBusy && filteredProcs.length === 0 && (
                    <tr>
                      <td colSpan={6} className="p-4 text-center text-muted-foreground">
                        无进程数据
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
