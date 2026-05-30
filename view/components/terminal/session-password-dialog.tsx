'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { Session } from '@/lib/types'

export interface SessionPasswordDialogProps {
  session: Session | null
  open: boolean
  allowDefaultKeys?: boolean
  authFailureReason?: string
  onOpenChange: (open: boolean) => void
  onSubmit: (password: string) => void
  onUseDefaultKeys?: () => void
}

export function SessionPasswordDialog({
  session,
  open,
  allowDefaultKeys = false,
  authFailureReason,
  onOpenChange,
  onSubmit,
  onUseDefaultKeys,
}: SessionPasswordDialogProps) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      setPassword('')
      setError('')
    }
  }, [open, session?.id])

  const handleSubmit = () => {
    if (!password) {
      setError('请输入密码')
      return
    }
    onSubmit(password)
  }

  if (!open || !session) return null

  const hostLine = `${session.user ?? 'root'}@${session.host}${session.port ? `:${session.port}` : ''}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="sm:max-w-md"
        style={{ zIndex: 200 }}
      >
        <DialogHeader>
          <DialogTitle>{authFailureReason ? 'SSH 认证失败' : '输入 SSH 密码'}</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-1 pt-1 text-left text-muted-foreground text-sm">
              {authFailureReason && (
                <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive">
                  {authFailureReason}
                </p>
              )}
              <p>
                会话「<span className="font-medium text-foreground">{session.name}</span>」
                {authFailureReason
                  ? '认证未通过，请重新输入密码或尝试其他认证方式。'
                  : allowDefaultKeys
                    ? '当前认证为「默认密钥/暂无」，若服务器需要密码请在此输入。'
                    : '需要密码才能连接。'}
              </p>
              <p className="font-mono text-xs">{hostLine}</p>
              <p className="text-xs">
                密码保存在本机独立 vault（localStorage），不会写入会话 JSON 或发给 AI 模型。
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>

        <p className="text-xs text-muted-foreground -mt-2">
          保存会话时可在编辑里将认证方式改为「密码」，下次连接会默认弹出此窗口；选「默认密钥」则优先尝试 ~/.ssh。
        </p>

        <div className="space-y-2">
          <Input
            type="password"
            value={password}
            onChange={e => {
              setPassword(e.target.value)
              setError('')
            }}
            placeholder="SSH 登录密码"
            autoComplete="off"
            autoFocus
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleSubmit()
              }
            }}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
          {allowDefaultKeys && onUseDefaultKeys && (
            <Button
              type="button"
              variant="outline"
              className="sm:mr-auto"
              onClick={onUseDefaultKeys}
            >
              使用默认密钥 (~/.ssh)
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" onClick={handleSubmit}>
            连接
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
