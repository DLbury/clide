/** 按服务器（profile/session.id）保存多套工作台布局快照 */

import { resolveRemoteDisplayPath } from '@/lib/remote-file-tree'
import {
  extractCwdFromTerminalChunk,
  extractCwdFromProbeOutput,
  extractWindowsShellDetectFromProbeOutput,
  formatShellPwdProbeCommand,
  formatWindowsShellDetectCommand,
  getWindowsShellFlavor,
  pwdProbeCommandsForWindowsShell,
  setWindowsShellFlavor,
  detectWindowsShellFlavorFromOutput,
  remotePathForListApi,
  usesWindowsShellCommands,
  type RemoteShellPlatform,
  type WindowsShellFlavor,
} from '@/lib/terminal-cwd'
import { normalizeShellCommandForPty } from '@/lib/terminal-client'
import { getTerminalOutputBuffer } from '@/lib/terminal-stream'
import type { Session } from '@/lib/types'

export interface LayoutSnapshotShell {
  id: string
  name: string
  /** Shell 当前工作目录（绝对路径） */
  cwd?: string
}

export interface LayoutSnapshotFile {
  id: string
  path: string
}

export interface LayoutSnapshotBrowser {
  id: string
  title: string
  url: string
  webviewLabel: string
}

export interface ServerLayoutSnapshot {
  id: string
  name: string
  profileId: string
  savedAt: string
  remotePath?: string
  activeShellId?: string
  activeFileId?: string | null
  activeBrowserTabId?: string | null
  monitorOpen?: boolean
  shells: LayoutSnapshotShell[]
  openFiles: LayoutSnapshotFile[]
  browserTabs: LayoutSnapshotBrowser[]
  /** Dockview api.toJSON() */
  dockview: unknown
}

const STORAGE_KEY = 'clide-layout-snapshots-v1'

type Store = Record<string, ServerLayoutSnapshot[]>

function readStore(): Store {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as Store
  } catch {
    return {}
  }
}

function writeStore(store: Store): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
}

export function listLayoutSnapshots(profileId: string): ServerLayoutSnapshot[] {
  return readStore()[profileId] ?? []
}

export function saveLayoutSnapshot(snapshot: ServerLayoutSnapshot): void {
  const store = readStore()
  const list = store[snapshot.profileId] ?? []
  const next = [snapshot, ...list.filter(s => s.id !== snapshot.id)].slice(0, 20)
  store[snapshot.profileId] = next
  writeStore(store)
}

export function deleteLayoutSnapshot(profileId: string, snapshotId: string): void {
  const store = readStore()
  const list = store[profileId] ?? []
  store[profileId] = list.filter(s => s.id !== snapshotId)
  writeStore(store)
}

export function renameLayoutSnapshot(
  profileId: string,
  snapshotId: string,
  name: string
): void {
  const store = readStore()
  const list = store[profileId] ?? []
  store[profileId] = list.map(s => (s.id === snapshotId ? { ...s, name } : s))
  writeStore(store)
}

/** 解析单个 Shell 保存时应记录的 cwd（绝对路径，不用文件树 remotePath 代替） */
export function resolveShellCwdForSnapshot(
  shell: {
    shellCwd?: string
    terminalSessionId?: string
    terminalStatus?: string
  },
  options?: { terminalLive?: boolean }
): string | undefined {
  if (shell.shellCwd) return shell.shellCwd.replace(/\\/g, '/')
  if (
    options?.terminalLive &&
    shell.terminalStatus === 'connected' &&
    shell.terminalSessionId
  ) {
    const buf = getTerminalOutputBuffer(shell.terminalSessionId)
    const fromTerminal = extractCwdFromTerminalChunk(buf.slice(-8192))
    if (fromTerminal) return fromTerminal.replace(/\\/g, '/')
  }
  return undefined
}

async function resolveWindowsShellFlavorForProbe(
  shell: {
    id: string
    terminalSessionId: string
  },
  write: (terminalSessionId: string, data: string) => Promise<void>
): Promise<WindowsShellFlavor> {
  const cached = getWindowsShellFlavor(shell.terminalSessionId)
  if (cached) return cached

  const buf = getTerminalOutputBuffer(shell.terminalSessionId)
  const fromPrompt = detectWindowsShellFlavorFromOutput(buf)
  if (fromPrompt) {
    setWindowsShellFlavor(shell.terminalSessionId, fromPrompt)
    return fromPrompt
  }

  const marker = `__CLIDE_SHELL_${shell.id.replace(/[^a-zA-Z0-9_-]/g, '')}_${Date.now()}__`
  const beforeLen = getTerminalOutputBuffer(shell.terminalSessionId).length
  try {
    await write(
      shell.terminalSessionId,
      normalizeShellCommandForPty(formatWindowsShellDetectCommand(marker))
    )
  } catch {
    return 'powershell'
  }

  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const delta = getTerminalOutputBuffer(shell.terminalSessionId).slice(
      Math.max(0, beforeLen - 64)
    )
    const detected = extractWindowsShellDetectFromProbeOutput(delta, marker)
    if (detected) {
      setWindowsShellFlavor(shell.terminalSessionId, detected)
      return detected
    }
    await new Promise(r => setTimeout(r, 80))
  }

  // PowerShell 探测无 PSVersionTable 响应 → 视为 cmd
  setWindowsShellFlavor(shell.terminalSessionId, 'cmd')
  return 'cmd'
}

/**
 * 主动向每个已连接的 Shell 探测 cwd，返回 shellId → cwd。
 * 通过写入带标记的 pwd，并从该 PTY 输出缓冲解析，保证各 Shell 路径独立。
 */
export async function probeShellCwds(
  shells: Array<{
    id: string
    terminalSessionId: string
    terminalStatus?: string
    shellCwd?: string
  }>,
  sessionType: Session['type'],
  write: (terminalSessionId: string, data: string) => Promise<void>,
  remotePlatform?: RemoteShellPlatform
): Promise<Map<string, string>> {
  const results = new Map<string, string>()
  const connected = shells.filter(s => s.terminalStatus === 'connected')
  if (connected.length === 0) return results

  const windowsShell = usesWindowsShellCommands(sessionType, remotePlatform)

  const waitForProbe = async (
    terminalSessionId: string,
    marker: string,
    beforeLen: number,
    timeoutMs = windowsShell ? 3500 : 2500
  ): Promise<string | null> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const buf = getTerminalOutputBuffer(terminalSessionId)
      const delta = buf.slice(Math.max(0, beforeLen - 64))
      const probed = extractCwdFromProbeOutput(delta, marker)
      if (probed) return probed
      const fromTail = extractCwdFromProbeOutput(buf.slice(-4096), marker)
      if (fromTail) return fromTail
      await new Promise(r => setTimeout(r, 80))
    }
    return null
  }

  const runProbe = async (
    shell: (typeof connected)[number],
    command: string,
    marker: string
  ): Promise<string | null> => {
    const beforeLen = getTerminalOutputBuffer(shell.terminalSessionId).length
    try {
      await write(
        shell.terminalSessionId,
        normalizeShellCommandForPty(command)
      )
    } catch {
      return null
    }
    return waitForProbe(shell.terminalSessionId, marker, beforeLen)
  }

  await Promise.all(
    connected.map(async shell => {
      const marker = `__CLIDE_CWD_${shell.id.replace(/[^a-zA-Z0-9_-]/g, '')}_${Date.now()}__`

      let commands: string[] = []
      if (windowsShell) {
        const flavor = await resolveWindowsShellFlavorForProbe(shell, write)
        commands = pwdProbeCommandsForWindowsShell(marker, flavor)
      } else {
        commands.push(formatShellPwdProbeCommand(marker, sessionType, remotePlatform))
      }

      for (const command of commands) {
        const probed = await runProbe(shell, command, marker)
        if (probed) {
          results.set(shell.id, probed)
          return
        }
      }

      const fallback =
        shell.shellCwd?.replace(/\\/g, '/') ||
        extractCwdFromTerminalChunk(
          getTerminalOutputBuffer(shell.terminalSessionId).slice(-8192)
        ) ||
        undefined
      if (fallback) results.set(shell.id, fallback)
    })
  )

  return results
}

/** @deprecated 使用 resolveShellCwdForSnapshot */
export function resolveShellSnapshotCwd(
  shell: { id: string; shellCwd?: string; terminalSessionId?: string; terminalStatus?: string },
  _activeShellId: string,
  _remotePath?: string,
  terminalLive?: boolean
): string | undefined {
  return resolveShellCwdForSnapshot(shell, { terminalLive })
}

export function resolveSnapshotFileTreePath(
  session: Pick<Session, 'type' | 'user'>,
  cwd?: string,
  fallback?: string
): string | undefined {
  if (!cwd) return fallback
  const normalized = cwd.replace(/\\/g, '/')
  if (session.type === 'ssh') {
    return resolveRemoteDisplayPath(
      remotePathForListApi(normalized, session.user),
      session.user
    )
  }
  return normalized
}

export function snapshotPathForFileTreeLoad(
  session: Pick<Session, 'type' | 'user'>,
  displayPath?: string
): string {
  if (!displayPath) return '~'
  if (session.type === 'ssh') {
    return remotePathForListApi(displayPath, session.user)
  }
  return displayPath
}

export function dockviewHasMonitorPanel(dockview: unknown): boolean {
  try {
    const json = JSON.stringify(dockview)
    return json.includes('monitor-main') || json.includes('"component":"monitor"')
  } catch {
    return false
  }
}
