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

/**
 * xterm 会通过 onData 回传 DSR/设备属性查询响应；这些数据只应回写给发起查询的 PTY，
 * 不能作为用户输入同步给其它服务器。
 */
export function shouldBroadcastTerminalInput(data: string): boolean {
  if (/^\x1b\[\d+;\d+R$/.test(data)) return false
  if (/^\x1b\[\??\d*(?:;\d+)*[cn]$/.test(data)) return false
  if (/^\x1b\][0-9]+;[\s\S]*(?:\x07|\x1b\\)$/.test(data)) return false
  return true
}

export function isSyncGroupSession(sessionId: string): boolean {
  return groupBySession.has(sessionId)
}
