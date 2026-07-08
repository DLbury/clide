'use client'

import { KeyRound, Terminal } from 'lucide-react'
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from '@/components/ai-elements/confirmation'
import { classifyInteractivePrompt } from '@/lib/shell-tool-executor'

interface TerminalInputInlineProps {
  sessionId: string
  command: string
  prompt: string
  onConfirm: () => void
  onCancel: () => void
  onFocusTerminal?: () => void
  onSendInput?: (sessionId: string, input: string) => void
}

export function TerminalInputInline({
  sessionId,
  command,
  prompt,
  onConfirm,
  onCancel,
  onFocusTerminal,
  onSendInput,
}: TerminalInputInlineProps) {
  const kind = classifyInteractivePrompt(prompt)

  return (
    <div className="flex justify-start w-full">
      <div className="w-full max-w-full">
        <Confirmation
          approval={{ id: sessionId }}
          state="approval-requested"
          className="border-primary/30 bg-primary/5"
        >
          <KeyRound className="text-primary" />
          <ConfirmationTitle>
            {kind === 'password'
              ? '终端等待密码输入'
              : kind === 'confirm'
                ? '终端等待确认'
                : '终端等待交互输入'}
          </ConfirmationTitle>
          <ConfirmationRequest>
            <div className="space-y-2 text-sm">
              {kind === 'password' ? (
                <p>
                  请在左侧 Shell 中手动输入密码（不会显示字符，也不会经过 AI）。输入完成后点击下方
                  <strong className="text-foreground"> 确认继续</strong>。
                </p>
              ) : kind === 'confirm' ? (
                <p>终端正在等待 yes/no 等确认。您可在 Shell 中输入，或使用下方按钮。</p>
              ) : (
                <p>终端正在等待您的输入。请在 Shell 中操作，或使用下方按钮。</p>
              )}
              <div className="rounded-md border border-border/60 bg-background/50 p-2.5 space-y-1.5 text-xs">
                <p>
                  <span className="font-medium text-foreground">命令：</span>
                  <span className="font-mono break-all">{command}</span>
                </p>
                <p>
                  <span className="font-medium text-foreground">提示：</span>
                  <span className="font-mono break-all">{prompt}</span>
                </p>
              </div>
            </div>
          </ConfirmationRequest>
          <ConfirmationActions>
            <ConfirmationAction variant="outline" onClick={onCancel}>
              取消
            </ConfirmationAction>
            {onFocusTerminal && (
              <ConfirmationAction variant="outline" onClick={onFocusTerminal}>
                <Terminal className="size-3.5 mr-1" />
                聚焦终端
              </ConfirmationAction>
            )}
            {kind === 'confirm' && onSendInput && (
              <ConfirmationAction variant="secondary" onClick={() => onSendInput(sessionId, 'yes\n')}>
                发送 yes
              </ConfirmationAction>
            )}
            <ConfirmationAction onClick={onConfirm}>
              {kind === 'password' ? '密码已输入，继续' : '确认继续'}
            </ConfirmationAction>
          </ConfirmationActions>
        </Confirmation>
      </div>
    </div>
  )
}
