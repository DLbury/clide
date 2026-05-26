import type { Session } from '@/lib/types'

/** 启动时自动打开的默认本地 Shell，不在侧边栏展示 */
export const DEFAULT_LOCAL_SHELL_SESSION_ID = '__default_local_shell__'

const LEGACY_DEFAULT_LOCAL_NAME = '本地终端'
const LEGACY_DEFAULT_LOCAL_HOST = 'localhost'

export function isLegacyDefaultLocalShellSession(
  session: Pick<Session, 'id' | 'type' | 'name' | 'host'>
): boolean {
  return (
    session.id !== DEFAULT_LOCAL_SHELL_SESSION_ID &&
    session.type === 'local' &&
    session.name === LEGACY_DEFAULT_LOCAL_NAME &&
    session.host === LEGACY_DEFAULT_LOCAL_HOST
  )
}

export function isDefaultLocalShellSession(session: Pick<Session, 'id'>): boolean {
  return session.id === DEFAULT_LOCAL_SHELL_SESSION_ID
}

export function isSidebarVisibleSession(session: Session): boolean {
  return !isDefaultLocalShellSession(session)
}

export function createDefaultLocalShellSession(): Session {
  return {
    id: DEFAULT_LOCAL_SHELL_SESSION_ID,
    name: LEGACY_DEFAULT_LOCAL_NAME,
    type: 'local',
    host: LEGACY_DEFAULT_LOCAL_HOST,
    status: 'disconnected',
    lastActive: new Date(),
  }
}

export function stripLegacyDefaultLocalSessions(sessions: Session[]): Session[] {
  return sessions.filter(
    s => !isDefaultLocalShellSession(s) && !isLegacyDefaultLocalShellSession(s)
  )
}

export function findLegacyDefaultLocalShellSession(sessions: Session[]): Session | undefined {
  return sessions.find(isLegacyDefaultLocalShellSession)
}
