/** 按服务器（profile/session.id）保存多套工作台布局快照 */

export interface LayoutSnapshotShell {
  id: string
  name: string
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
