'use client'

import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

export interface AppAlertDialogState {
  open: boolean
  title: string
  description?: string
  details?: string
}

export function AppAlertDialog({
  state,
  onOpenChange,
}: {
  state: AppAlertDialogState
  onOpenChange: (open: boolean) => void
}) {
  if (!state.open) return null

  return (
    <AlertDialog open={state.open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{state.title}</AlertDialogTitle>
          {(state.description || state.details) && (
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                {state.description && <p className="text-sm">{state.description}</p>}
                {state.details && (
                  <pre className="max-h-56 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-xs text-muted-foreground whitespace-pre-wrap">
                    {state.details}
                  </pre>
                )}
              </div>
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>
            确定
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

