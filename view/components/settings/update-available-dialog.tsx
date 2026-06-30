'use client'

import { useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { installAppUpdate, type UpdateCheckResult } from '@/lib/app-updater'

interface UpdateAvailableDialogProps {
  open: boolean
  update: UpdateCheckResult | null
  onOpenChange: (open: boolean) => void
}

export function UpdateAvailableDialog({
  open,
  update,
  onOpenChange,
}: UpdateAvailableDialogProps) {
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ downloaded: number; total?: number } | null>(
    null
  )

  if (!open || !update?.available || !update.update) return null

  const progressPercent =
    progress?.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : undefined

  const handleInstall = async () => {
    if (!update.update) return
    setInstalling(true)
    setError(null)
    setProgress({ downloaded: 0 })
    try {
      await installAppUpdate(update.update, (downloaded, total) => {
        setProgress({ downloaded, total })
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '安装更新失败')
      setInstalling(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>发现新版本 v{update.version}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                是否下载并安装更新？安装完成后应用将自动重启。
              </p>
              {update.notes && (
                <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-xs text-muted-foreground whitespace-pre-wrap">
                  {update.notes}
                </pre>
              )}
              {progress && installing && (
                <Progress value={progressPercent} className="h-2" />
              )}
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={installing}
            onClick={() => onOpenChange(false)}
          >
            稍后
          </Button>
          <Button type="button" disabled={installing} onClick={() => void handleInstall()}>
            {installing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            <span className="ml-2">{installing ? '安装中…' : '立即更新'}</span>
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
