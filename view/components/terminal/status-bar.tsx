'use client'

import type { ReactNode } from 'react'
import {
  Wifi,
  WifiOff,
  Cpu,
  MemoryStick,
  PanelRight,
  Activity,
  Server,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatUsagePair } from '@/lib/format-bytes'
import type { RemoteHostStats } from '@/lib/terminal-client'
import type { Session } from '@/lib/types'
import type { HostStatsSample } from '@/lib/host-stats-history'
import { HostStatsPanel } from '@/components/terminal/host-stats-panel'

interface StatusBarProps {
  session?: Session
  hostStats?: RemoteHostStats | null
  hostStatsHistory?: HostStatsSample[]
  hostStatsError?: string | null
  aiSidebarVisible: boolean
  aiThinking?: boolean
  onAiSidebarToggle?: () => void
  onOpenMonitor?: () => void
  connectedTerminalCount?: number
  onOpenMultiServerSync?: () => void
  isSyncGroup?: boolean
}

function formatSessionHost(session: Session): string {
  if (session.type === 'serial') {
    return `${session.host} @ ${session.baudRate || 115200}`
  }
  const user = session.user ? `${session.user}@` : ''
  const port = session.port && session.port !== 22 ? `:${session.port}` : ''
  return `${user}${session.host ?? session.name}${port}`
}

function sessionDetailTitle(session: Session): string {
  const lines = [formatSessionHost(session), `类型: ${session.type.toUpperCase()}`]
  if (session.type === 'ssh') {
    const hops =
      session.jumpHosts?.length
        ? session.jumpHosts
        : session.jumpHost?.host
          ? [session.jumpHost]
          : []
    if (hops.length > 0) {
      lines.push(
        `跳板: ${hops.map(h => `${h.user ? `${h.user}@` : ''}${h.host}`).join(' → ')}`
      )
    }
    const auth =
      session.authConfig?.type === 'default-keys' || session.authMethod === 'none'
        ? '默认密钥'
        : session.authMethod === 'password' ||
            session.authConfig?.type === 'password-plain'
          ? '密码认证'
          : session.authMethod === 'key'
            ? '密钥认证'
            : session.authMethod === 'ssh-agent'
              ? 'SSH Agent'
              : '默认密钥'
    lines.push(`认证: ${auth}`)
  }
  return lines.join('\n')
}

function IconAction({
  title,
  onClick,
  active,
  children,
}: {
  title: string
  onClick?: () => void
  active?: boolean
  children: ReactNode
}) {
  if (!onClick) return null
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'p-1 rounded transition-colors text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        active ? 'text-primary' : 'text-muted-foreground'
      )}
    >
      {children}
    </button>
  )
}

export function StatusBar({
  session,
  hostStats,
  hostStatsHistory = [],
  hostStatsError = null,
  aiSidebarVisible,
  aiThinking = false,
  onAiSidebarToggle,
  onOpenMonitor,
  connectedTerminalCount = 0,
  onOpenMultiServerSync,
  isSyncGroup = false,
}: StatusBarProps) {
  const isConnected = session?.status === 'connected'
  const showRemoteMonitor = isConnected && session?.type === 'ssh' && !isSyncGroup
  const metricsTitle = hostStats
    ? [
        `CPU ${hostStats.cpuPercent.toFixed(1)}%`,
        `内存 ${formatUsagePair(hostStats.memUsedBytes, hostStats.memTotalBytes)}`,
        hostStats.gpuPercent != null ? `GPU ${hostStats.gpuPercent.toFixed(0)}%` : null,
        hostStats.gpuMemTotalBytes != null && hostStats.gpuMemUsedBytes != null
          ? `显存 ${formatUsagePair(hostStats.gpuMemUsedBytes, hostStats.gpuMemTotalBytes)}`
          : null,
        `磁盘 ${formatUsagePair(hostStats.diskUsedBytes, hostStats.diskTotalBytes)}`,
      ]
        .filter(Boolean)
        .join(' · ')
    : hostStatsError ?? '点击查看服务器监控'

  return (
    <div className="h-6 bg-card border-t border-border flex items-center justify-between px-2 text-xs text-muted-foreground gap-2">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <div
          className="flex items-center gap-1.5 min-w-0"
          title={session ? sessionDetailTitle(session) : undefined}
        >
          {isConnected ? (
            <Wifi className="w-3 h-3 shrink-0 text-terminal-green" />
          ) : (
            <WifiOff className="w-3 h-3 shrink-0" />
          )}
          <span
            className={cn(
              'truncate',
              isConnected ? 'text-foreground/90' : 'text-muted-foreground'
            )}
          >
            {session
              ? isSyncGroup
                ? session.name
                : formatSessionHost(session)
              : '无会话'}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {showRemoteMonitor && onOpenMonitor && (
          <div className="flex items-center gap-0.5 max-w-[260px]">
            {hostStats && (
              <HostStatsPanel hostStats={hostStats} history={hostStatsHistory} />
            )}
            <button
              type="button"
              onClick={onOpenMonitor}
              className={cn(
                'flex items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-accent-foreground min-w-0',
                hostStatsError ? 'text-amber-600' : 'hover:text-foreground'
              )}
              title={metricsTitle}
            >
              <Activity className="w-3 h-3 shrink-0" />
              {hostStats ? (
                <span className="truncate font-mono text-[11px]">
                  <Cpu className="w-2.5 h-2.5 inline mr-0.5 -mt-px" />
                  {hostStats.cpuPercent.toFixed(0)}%
                  <span className="mx-1 text-border">·</span>
                  <MemoryStick className="w-2.5 h-2.5 inline mr-0.5 -mt-px" />
                  {formatUsagePair(hostStats.memUsedBytes, hostStats.memTotalBytes)}
                </span>
              ) : (
                <span className="text-[11px]">{hostStatsError ? '监控不可用' : '监控'}</span>
              )}
            </button>
          </div>
        )}

        {onOpenMultiServerSync && connectedTerminalCount >= 2 && !isSyncGroup && (
          <IconAction
            title={`多服务器同步输入 (${connectedTerminalCount} 台已连接)`}
            onClick={onOpenMultiServerSync}
          >
            <Server className="w-3.5 h-3.5" />
          </IconAction>
        )}

        <span className="w-px h-3.5 bg-border mx-0.5" />

        <IconAction
          title={aiSidebarVisible ? '隐藏 AI 侧边栏' : '显示 AI 侧边栏'}
          onClick={onAiSidebarToggle}
          active={aiSidebarVisible}
        >
          <PanelRight
            className={cn('w-3.5 h-3.5', aiThinking && aiSidebarVisible && 'animate-pulse')}
          />
        </IconAction>
      </div>
    </div>
  )
}
