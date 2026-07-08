/** 按服务器（profile/session.id）保存多套工作台布局快照 */

import { resolveRemoteDisplayPath } from '@/lib/remote-file-tree'
import { remotePathForListApi } from '@/lib/terminal-cwd'
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

export function resolveShellSnapshotCwd(
  shell: { id: string; shellCwd?: string },
  activeShellId: string,
  remotePath?: string
): string | undefined {
  if (shell.shellCwd) return shell.shellCwd
  if (shell.id === activeShellId && remotePath) return remotePath
  return undefined
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
