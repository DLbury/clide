/**
 * SSH 密码本机持久化（localStorage，按 profileId 索引）。
 * 不写入 aiterm-sessions-v1，不会进入 AI / MCP 上下文。
 */
const STORAGE_KEY = 'aiterm-profile-passwords-v1'

function readMap(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, string>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeMap(map: Record<string, string>) {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
}

export function getStoredPassword(profileId: string): string | undefined {
  const pw = readMap()[profileId]
  return pw && pw.length > 0 ? pw : undefined
}

export function setStoredPassword(profileId: string, password: string): void {
  const trimmed = password.trim()
  if (!trimmed) return
  const map = readMap()
  map[profileId] = trimmed
  writeMap(map)
}

export function removeStoredPassword(profileId: string): void {
  const map = readMap()
  if (!(profileId in map)) return
  delete map[profileId]
  writeMap(map)
}
