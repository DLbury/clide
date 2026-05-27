import { createDefaultLocalShellSession } from '@/lib/default-local-shell'
import { makeTerminalSessionId } from '@/lib/terminal-session'
import { isTauriRuntime } from '@/lib/tauri-env'
import type { ChatMessage } from '@/lib/types'

export interface InitialShell {
  id: string
  name: string
  history: Array<{
    id: string
    type: 'system' | 'input' | 'error'
    content: string
    timestamp: Date
  }>
  terminalSessionId: string
  terminalStatus: 'connecting'
}

export interface InitialConnection {
  id: string
  session: ReturnType<typeof createDefaultLocalShellSession> & { status: 'connecting' }
  shells: InitialShell[]
  activeShellId: string
  openFiles: []
  activeFileId: null
  selectedFilePath: null
  aiMessages: ChatMessage[]
  aiThinking: boolean
  terminalLive: true
}

export function createInitialDesktopConnection(): {
  activeConnectionId: string
  connections: InitialConnection[]
} | null {
  if (!isTauriRuntime()) return null

  const localSession = createDefaultLocalShellSession()
  const shellId = 'shell-default'
  const terminalSessionId = makeTerminalSessionId(localSession.id, shellId)
  const connectionId = 'conn-default-local'
  const now = Date.now()

  return {
    activeConnectionId: connectionId,
    connections: [
      {
        id: connectionId,
        session: { ...localSession, status: 'connecting' },
        shells: [
          {
            id: shellId,
            name: 'Shell 1',
            history: [
              {
                id: `sys-${now}`,
                type: 'system',
                content: '正在启动本地终端…',
                timestamp: new Date(),
              },
            ],
            terminalSessionId,
            terminalStatus: 'connecting',
          },
        ],
        activeShellId: shellId,
        openFiles: [],
        activeFileId: null,
        selectedFilePath: null,
        aiMessages: [],
        aiThinking: false,
        terminalLive: true,
      },
    ],
  }
}
