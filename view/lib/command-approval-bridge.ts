import type { CommandApprovalSource, CommandRiskAssessment } from '@/lib/command-risk'

export type PendingCommandApproval = {
  id: string
  command: string
  assessment: CommandRiskAssessment
  source: CommandApprovalSource
  context?: string
}

type Listener = (pending: PendingCommandApproval | null) => void

let listener: Listener | null = null
let pending: {
  request: PendingCommandApproval
  resolve: (approved: boolean) => void
} | null = null

export function subscribeCommandApproval(fn: Listener): () => void {
  listener = fn
  fn(pending?.request ?? null)
  return () => {
    if (listener === fn) listener = null
  }
}

export function requestCommandApproval(
  request: Omit<PendingCommandApproval, 'id'>
): Promise<boolean> {
  if (pending) {
    return Promise.resolve(false)
  }
  return new Promise(resolve => {
    const full: PendingCommandApproval = { ...request, id: crypto.randomUUID() }
    pending = { request: full, resolve }
    listener?.(full)
  })
}

export function resolveCommandApproval(id: string, approved: boolean) {
  if (!pending || pending.request.id !== id) return
  const { resolve } = pending
  pending = null
  listener?.(null)
  resolve(approved)
}

export function getPendingCommandApproval(): PendingCommandApproval | null {
  return pending?.request ?? null
}
