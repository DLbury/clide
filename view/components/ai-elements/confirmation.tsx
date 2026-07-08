'use client'

import { createContext, useContext, type ComponentProps, type ReactNode } from 'react'
import { CheckIcon, XIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type ConfirmationState =
  | 'approval-requested'
  | 'approval-responded'
  | 'output-denied'
  | 'output-available'

export type ConfirmationApproval = {
  id: string
  approved?: boolean
}

const ConfirmationContext = createContext<{
  approval: ConfirmationApproval
  state: ConfirmationState
} | null>(null)

function useConfirmationContext() {
  const ctx = useContext(ConfirmationContext)
  if (!ctx) {
    throw new Error('Confirmation subcomponents must be used within Confirmation')
  }
  return ctx
}

export type ConfirmationProps = ComponentProps<typeof Alert> & {
  approval?: ConfirmationApproval
  state: ConfirmationState
}

export function Confirmation({
  approval,
  state,
  className,
  children,
  ...props
}: ConfirmationProps) {
  if (!approval) return null

  return (
    <ConfirmationContext.Provider value={{ approval, state }}>
      <Alert className={cn('my-0', className)} {...props}>
        {children}
      </Alert>
    </ConfirmationContext.Provider>
  )
}

export function ConfirmationTitle({
  className,
  ...props
}: ComponentProps<typeof AlertTitle>) {
  return <AlertTitle className={className} {...props} />
}

export function ConfirmationRequest({ children }: { children: ReactNode }) {
  const { state } = useConfirmationContext()
  if (state !== 'approval-requested') return null
  return <AlertDescription>{children}</AlertDescription>
}

export function ConfirmationAccepted({ children }: { children: ReactNode }) {
  const { approval, state } = useConfirmationContext()
  if (approval.approved !== true) return null
  if (
    state !== 'approval-responded' &&
    state !== 'output-available' &&
    state !== 'output-denied'
  ) {
    return null
  }
  return (
    <AlertDescription className="flex items-center gap-2 text-foreground">
      {children}
    </AlertDescription>
  )
}

export function ConfirmationRejected({ children }: { children: ReactNode }) {
  const { approval, state } = useConfirmationContext()
  if (approval.approved !== false) return null
  if (
    state !== 'approval-responded' &&
    state !== 'output-denied' &&
    state !== 'output-available'
  ) {
    return null
  }
  return (
    <AlertDescription className="flex items-center gap-2 text-muted-foreground">
      {children}
    </AlertDescription>
  )
}

export function ConfirmationActions({
  className,
  ...props
}: ComponentProps<'div'>) {
  const { state } = useConfirmationContext()
  if (state !== 'approval-requested') return null
  return (
    <div
      className={cn('col-start-2 flex flex-wrap items-center gap-2 mt-3', className)}
      {...props}
    />
  )
}

export function ConfirmationAction(props: ComponentProps<typeof Button>) {
  return <Button size="sm" className="h-8 px-3 text-xs" {...props} />
}

export function ConfirmationStatusIcon({ approved }: { approved: boolean }) {
  return approved ? (
    <CheckIcon className="size-4 shrink-0 text-green-600" />
  ) : (
    <XIcon className="size-4 shrink-0 text-orange-600" />
  )
}
