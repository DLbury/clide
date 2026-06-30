'use client'

import { useCallback, useEffect, useState } from 'react'
import { Download, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import {
  checkForAppUpdate,
  getAppVersion,
  installAppUpdate,
  loadAutoCheckUpdates,
  saveAutoCheckUpdates,
  type UpdateCheckResult,
} from '@/lib/app-updater'
import { isTauriRuntime } from '@/lib/tauri-env'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function UpdateSettingsPanel() {
  const [currentVersion, setCurrentVersion] = useState<string | null>(null)
  const [autoCheck, setAutoCheck] = useState(true)
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<UpdateCheckResult | null>(null)
  const [progress, setProgress] = useState<{ downloaded: number; total?: number } | null>(
    null
  )

  useEffect(() => {
    setAutoCheck(loadAutoCheckUpdates())
    void getAppVersion().then(setCurrentVersion)
  }, [])

  const handleAutoCheckChange = (enabled: boolean) => {
    setAutoCheck(enabled)
    saveAutoCheckUpdates(enabled)
  }

  const handleCheck = useCallback(async () => {
    if (!isTauriRuntime()) return
    setChecking(true)
    setError(null)
    setPending(null)
    try {
      const result = await checkForAppUpdate()
      if (result.available) {
        setPending(result)
      } else {
        setError('当前已是最新版本')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '检查更新失败')
    } finally {
      setChecking(false)
    }
  }, [])

  const handleInstall = useCallback(async () => {
    if (!pending?.update) return
    setInstalling(true)
    setError(null)
    setProgress({ downloaded: 0 })
    try {
      await installAppUpdate(pending.update, (downloaded, total) => {
        setProgress({ downloaded, total })
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '安装更新失败')
      setInstalling(false)
      setProgress(null)
    }
  }, [pending])

  if (!isTauriRuntime()) {
    return (
      <p className="text-sm text-muted-foreground">
        自动更新仅在桌面版可用。Web 版请从 GitHub Releases 手动下载。
      </p>
    )
  }

  const progressPercent =
    progress?.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : undefined

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-medium mb-1">应用更新</h3>
        <p className="text-xs text-muted-foreground">
          从 GitHub Releases 下载并安装已签名的更新包。
        </p>
      </div>

      <div className="rounded-lg border border-border p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">当前版本</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              v{currentVersion ?? '…'}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={checking || installing}
            onClick={() => void handleCheck()}
          >
            {checking ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            <span className="ml-2">检查更新</span>
          </Button>
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <Label htmlFor="auto-check-updates" className="text-sm">
              启动时自动检查
            </Label>
            <p className="text-xs text-muted-foreground">发现新版本时提示安装</p>
          </div>
          <Switch
            id="auto-check-updates"
            checked={autoCheck}
            onCheckedChange={handleAutoCheckChange}
            disabled={installing}
          />
        </div>
      </div>

      {pending?.available && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
          <div>
            <p className="text-sm font-medium">发现新版本 v{pending.version}</p>
            {pending.date && (
              <p className="text-xs text-muted-foreground mt-0.5">{pending.date}</p>
            )}
            {pending.notes && (
              <pre className="mt-2 max-h-32 overflow-auto rounded-md border border-border bg-background/60 p-2 text-xs text-muted-foreground whitespace-pre-wrap">
                {pending.notes}
              </pre>
            )}
          </div>
          <Button type="button" size="sm" disabled={installing} onClick={() => void handleInstall()}>
            {installing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            <span className="ml-2">{installing ? '正在下载并安装…' : '下载并安装'}</span>
          </Button>
        </div>
      )}

      {progress && installing && (
        <div className="space-y-2">
          <Progress value={progressPercent} className="h-2" />
          <p className="text-xs text-muted-foreground">
            已下载 {formatBytes(progress.downloaded)}
            {progress.total ? ` / ${formatBytes(progress.total)}` : ''}
          </p>
        </div>
      )}

      {error && (
        <p className="text-xs text-destructive whitespace-pre-wrap">{error}</p>
      )}
    </div>
  )
}
