const FOLLOW_CWD_KEY = 'clide-file-follow-terminal-cwd'
const ROOT_MODE_KEY = 'clide-file-root-mode'

export function loadFollowTerminalCwd(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return localStorage.getItem(FOLLOW_CWD_KEY) === '1'
  } catch {
    return false
  }
}

export function saveFollowTerminalCwd(enabled: boolean): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(FOLLOW_CWD_KEY, enabled ? '1' : '0')
  } catch {
    /* ignore */
  }
}

export function loadFileRootMode(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return localStorage.getItem(ROOT_MODE_KEY) === '1'
  } catch {
    return false
  }
}

export function saveFileRootMode(enabled: boolean): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(ROOT_MODE_KEY, enabled ? '1' : '0')
  } catch {
    /* ignore */
  }
}
