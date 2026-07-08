'use client'

import { ShieldAlert, AlertTriangle } from 'lucide-react'
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationAccepted,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationStatusIcon,
  ConfirmationTitle,
} from '@/components/ai-elements/confirmation'
import { cn } from '@/lib/utils'
import type { PendingCommandApproval } from '@/lib/command-approval-bridge'
import { sourceLabel } from '@/lib/command-risk'

interface CommandApprovalInlineProps {
  pending: PendingCommandApproval | null
  resolved?: { request: PendingCommandApproval; approved: boolean } | null
  onApprove: (id: string) => void
  onDeny: (id: string) => void
}

export function CommandApprovalInline({
  pending,
  resolved,
  onApprove,
  onDeny,
}: CommandApprovalInlineProps) {
  const active = pending ?? resolved?.request
  if (!active) return null

  const isCritical = active.assessment.level === 'critical'
  const isPending = Boolean(pending)
  const state = isPending
    ? 'approval-requested'
    : resolved?.approved
      ? 'output-available'
      : 'output-denied'

  return (
    <div className="flex justify-start w-full">
      <div className="w-full max-w-full">
        <Confirmation
          approval={{ id: active.id, approved: resolved?.approved }}
          state={state}
          variant={isCritical && isPending ? 'destructive' : 'default'}
          className={cn(
            isPending && !isCritical && 'border-amber-500/40 bg-amber-500/5',
            isPending && isCritical && 'border-destructive/40'
          )}
        >
          {isCritical ? (
            <ShieldAlert className="text-destructive" />
          ) : (
            <AlertTriangle className="text-amber-500" />
          )}
          <ConfirmationTitle>
            {isPending ? '需要您确认是否执行' : resolved?.approved ? '已批准执行' : '已拒绝执行'}
          </ConfirmationTitle>
          <ConfirmationRequest>
            <div className="space-y-2 text-sm">
              <p>AI 请求执行可能无法撤销的操作，请核对后决定。</p>
              <div className="rounded-md border border-border/60 bg-background/50 p-2.5 space-y-2">
                <div>
                  <p className="text-xs font-medium text-foreground mb-1">命令</p>
                  <pre className="text-xs font-mono whitespace-pre-wrap break-all">
                    {active.command}
                  </pre>
                </div>
                <div>
                  <p className="text-xs font-medium text-foreground mb-1">可能的影响</p>
                  <p className="text-xs">{active.assessment.summary}</p>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {sourceLabel(active.source)}
                  {active.context ? ` · ${active.context}` : ''}
                </p>
              </div>
            </div>
          </ConfirmationRequest>
          <ConfirmationAccepted>
            <ConfirmationStatusIcon approved />
            <span>您已批准执行上述命令</span>
          </ConfirmationAccepted>
          <ConfirmationRejected>
            <ConfirmationStatusIcon approved={false} />
            <span>您已拒绝执行，AI 将收到取消反馈</span>
          </ConfirmationRejected>
          <ConfirmationActions>
            <ConfirmationAction variant="outline" onClick={() => onDeny(active.id)}>
              拒绝
            </ConfirmationAction>
            <ConfirmationAction
              variant={isCritical ? 'destructive' : 'default'}
              onClick={() => onApprove(active.id)}
            >
              确认执行
            </ConfirmationAction>
          </ConfirmationActions>
        </Confirmation>
      </div>
    </div>
  )
}
