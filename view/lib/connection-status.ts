import type { Session, SessionFolder } from '@/lib/types'

export type TerminalShellStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface ConnectionLike {
  session: Pick<Session, 'id'>
  shells: Array<{ terminalStatus?: TerminalShellStatus }>
  isSyncGroup?: boolean
}

/** Derive session-level status from all shells on a connection tab. */
export function connectionSessionStatus(
  shells: Array<{ terminalStatus?: TerminalShellStatus }>
): Session['status'] {
  if (shells.some(s => s.terminalStatus === 'connected')) return 'connected'
  if (shells.some(s => s.terminalStatus === 'connecting')) return 'connecting'
  return 'disconnected'
}

/** Merge live connection state into folder sessions for sidebar display. */
export function mergeFolderSessionStatuses(
  folders: SessionFolder[],
  connections: ConnectionLike[]
): SessionFolder[] {
  return folders.map(folder => ({
    ...folder,
    sessions: folder.sessions.map(session => {
      const conn = connections.find(c => c.session.id === session.id && !c.isSyncGroup)
      if (conn) {
        const status = connectionSessionStatus(conn.shells)
        return session.status === status ? session : { ...session, status }
      }
      if (session.status === 'connected' || session.status === 'connecting') {
        return { ...session, status: 'disconnected' as const }
      }
      return session
    }),
  }))
}

export function foldersNeedStatusSync(
  folders: SessionFolder[],
  connections: ConnectionLike[]
): boolean {
  const merged = mergeFolderSessionStatuses(folders, connections)
  return JSON.stringify(merged) !== JSON.stringify(folders)
}
