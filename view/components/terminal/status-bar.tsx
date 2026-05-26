'use client'

import { Wifi, WifiOff, Clock, Cpu, HardDrive, MemoryStick, Gpu, PanelRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatUsagePair } from '@/lib/format-bytes'
import type { RemoteHostStats } from '@/lib/terminal-client'
import type { Session } from '@/lib/types'

interface StatusBarProps {
  session?: Session
  hostStats?: RemoteHostStats | null
  aiSidebarVisible: boolean
  aiThinking?: boolean
  onAiSidebarToggle?: () => void
}

export function StatusBar({
  session,
  hostStats,
  aiSidebarVisible,
  aiThinking = false,
  onAiSidebarToggle,
}: StatusBarProps) {
  const isConnected = session?.status === 'connected'
  const showRemoteStats = isConnected && session?.type === 'ssh' && hostStats

  return (
    <div className="h-6 bg-card border-t border-border flex items-center justify-between px-3 text-xs text-muted-foreground">
      {/* Left Section */}
      <div className="flex items-center gap-4 min-w-0">
        {/* Connection Status */}
        <div className="flex items-center gap-1.5">
          {isConnected ? (
            <Wifi className="w-3 h-3 text-terminal-green" />
          ) : (
            <WifiOff className="w-3 h-3 text-muted-foreground" />
          )}
          <span className={cn(
            isConnected ? "text-terminal-green" : "text-muted-foreground"
          )}>
            {session ? (
              isConnected ? '已连接' : '未连接'
            ) : '无会话'}
          </span>
        </div>

        {/* Session Info */}
        {session && (
          <>
            <span className="text-border">|</span>
            <span>{session.type.toUpperCase()}</span>
            {session.host && (
              <>
                <span className="text-border">|</span>
                <span>
                  {session.type === 'serial' 
                    ? `${session.host} @ ${session.baudRate || 115200} baud`
                    : `${session.user ? `${session.user}@` : ''}${session.host}${session.port ? `:${session.port}` : ''}`
                  }
                </span>
              </>
            )}
            {session.type === 'ssh' && (
              <>
                <span className="text-border">|</span>
                <span className="text-muted-foreground">
                  {session.authConfig?.type === 'default-keys' || session.authMethod === 'none'
                    ? '默认密钥'
                    : session.authMethod === 'key' ||
                        session.authConfig?.type === 'key-path' ||
                        session.authConfig?.type === 'key-env'
                      ? '密钥认证'
                      : session.authMethod === 'ssh-agent' ||
                          session.authConfig?.type === 'ssh-agent'
                        ? 'SSH Agent'
                        : session.authMethod === 'password' ||
                            session.authConfig?.type === 'password-plain' ||
                            session.authConfig?.type === 'password-env' ||
                            session.authConfig?.type === 'password-keychain'
                          ? '密码认证'
                          : '默认密钥'}
                </span>
              </>
            )}
          </>
        )}
      </div>

      {/* Right Section */}
      <div className="flex items-center gap-4 shrink-0">
        {showRemoteStats ? (
          <>
            <div className="flex items-center gap-1.5" title="CPU 使用率">
              <Cpu className="w-3 h-3" />
              <span>{hostStats.cpuPercent.toFixed(0)}%</span>
            </div>

            <div
              className="flex items-center gap-1.5"
              title={`内存 ${formatUsagePair(hostStats.memUsedBytes, hostStats.memTotalBytes)}`}
            >
              <MemoryStick className="w-3 h-3" />
              <span>{formatUsagePair(hostStats.memUsedBytes, hostStats.memTotalBytes)}</span>
            </div>

            {hostStats.gpuMemTotalBytes != null && hostStats.gpuMemUsedBytes != null && (
              <div
                className="flex items-center gap-1.5"
                title={`显存 ${formatUsagePair(hostStats.gpuMemUsedBytes, hostStats.gpuMemTotalBytes)}`}
              >
                <Gpu className="w-3 h-3" />
                <span>
                  {formatUsagePair(hostStats.gpuMemUsedBytes, hostStats.gpuMemTotalBytes)}
                </span>
              </div>
            )}

            <div
              className="flex items-center gap-1.5"
              title={`磁盘 ${formatUsagePair(hostStats.diskUsedBytes, hostStats.diskTotalBytes)}`}
            >
              <HardDrive className="w-3 h-3" />
              <span>{formatUsagePair(hostStats.diskUsedBytes, hostStats.diskTotalBytes)}</span>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-1.5">
              <Cpu className="w-3 h-3" />
              <span>—</span>
            </div>

            <div className="flex items-center gap-1.5">
              <HardDrive className="w-3 h-3" />
              <span>—</span>
            </div>
          </>
        )}

        <span className="text-border">|</span>

        <div className="flex items-center gap-1.5">
          <Clock className="w-3 h-3" />
          <span>{new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
        </div>

        <span className="text-border">|</span>

        <button
          type="button"
          onClick={onAiSidebarToggle}
          className={cn(
            'flex items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors hover:text-foreground hover:bg-muted/60',
            aiSidebarVisible ? 'text-primary' : 'text-muted-foreground'
          )}
          title={aiSidebarVisible ? '隐藏 AI 侧边栏' : '显示 AI 侧边栏'}
          aria-pressed={aiSidebarVisible}
        >
          <PanelRight
            className={cn('w-3 h-3', aiThinking && aiSidebarVisible && 'animate-pulse')}
          />
          <span>AI 侧边栏</span>
        </button>
      </div>
    </div>
  )
}
