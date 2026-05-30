'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { FileItem } from '@/lib/types'

const CONFIRM_PHRASE = '确认删除'

interface DeleteRemoteFileDialogProps {
  file: FileItem | null
  open: boolean
  busy?: boolean
  error?: string | null
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function DeleteRemoteFileDialog({
  file,
  open,
  busy = false,
  error = null,
  onOpenChange,
  onConfirm,
}: DeleteRemoteFileDialogProps) {
  const [confirmText, setConfirmText] = useState('')

  useEffect(() => {
    if (open) {
      setConfirmText('')
    }
  }, [open, file?.path])

  const canConfirm = confirmText === CONFIRM_PHRASE && !busy
  const kindLabel = file?.type === 'directory' ? '文件夹' : '文件'

  if (!open) return null

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>删除{kindLabel}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-left">
              <p>
                即将永久删除{kindLabel}{' '}
                <span className="font-medium text-foreground">「{file?.name}」</span>
                ，此操作无法撤销。
              </p>
              {file?.path && (
                <p className="font-mono text-xs break-all rounded-md border border-border bg-muted/40 px-2 py-1.5 text-muted-foreground">
                  {file.path}
                </p>
              )}
              <div className="space-y-2">
                <label htmlFor="delete-confirm-input" className="text-sm text-foreground">
                  请输入{' '}
                  <span className="font-mono font-medium text-destructive">{CONFIRM_PHRASE}</span>{' '}
                  以继续
                </label>
                <Input
                  id="delete-confirm-input"
                  value={confirmText}
                  onChange={e => setConfirmText(e.target.value)}
                  placeholder={CONFIRM_PHRASE}
                  disabled={busy}
                  autoComplete="off"
                  autoFocus
                  spellCheck={false}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && canConfirm) {
                      e.preventDefault()
                      onConfirm()
                    }
                  }}
                />
              </div>
              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            disabled={!canConfirm}
            onClick={onConfirm}
          >
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                删除中…
              </>
            ) : (
              '删除'
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
