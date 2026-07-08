/** 多服务器同步输入：同一组内任一终端的按键会广播到其余终端 */

const groups = new Map<string, string[]>()
const groupBySession = new Map<string, string>()

export function registerSyncGroup(groupId: string, sessionIds: string[]): void {
  const unique = [...new Set(sessionIds.filter(Boolean))]
  groups.set(groupId, unique)
  for (const sessionId of unique) {
    groupBySession.set(sessionId, groupId)
  }
}

export function unregisterSyncGroup(groupId: string): void {
  const sessionIds = groups.get(groupId) ?? []
  groups.delete(groupId)
  for (const sessionId of sessionIds) {
    if (groupBySession.get(sessionId) === groupId) {
      groupBySession.delete(sessionId)
    }
  }
}

export function unregisterSyncGroupBySession(sessionId: string): void {
  const groupId = groupBySession.get(sessionId)
  if (groupId) unregisterSyncGroup(groupId)
}

export function getSyncPeerSessionIds(sourceSessionId: string): string[] {
  const groupId = groupBySession.get(sourceSessionId)
  if (!groupId) return []
  return (groups.get(groupId) ?? []).filter(id => id !== sourceSessionId)
}

export function isSyncGroupSession(sessionId: string): boolean {
  return groupBySession.has(sessionId)
}
