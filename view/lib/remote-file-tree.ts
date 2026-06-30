import type { FileItem } from '@/lib/types'
import type { RemoteFileEntry } from '@/lib/terminal-client'
import { getParentPath } from '@/lib/file-utils'

export function isWindowsRemotePath(path: string): boolean {
  return /^[A-Za-z]:\//.test(path) || /^[A-Za-z]:\\/.test(path)
}

export function resolveRemoteDisplayPath(path: string, user?: string): string {
  const normalized = path.replace(/\\/g, '/')
  if (isWindowsRemotePath(normalized)) return normalized
  if (!path || path === '~') {
    return user ? `/home/${user}` : '~'
  }
  if (path.startsWith('~/')) {
    return user ? `/home/${user}/${path.slice(2)}` : path
  }
  return normalized
}

export function remoteEntriesToFileTree(entries: RemoteFileEntry[]): FileItem[] {
  return entries.map(entry => ({
    id: entry.path,
    name: entry.name,
    path: entry.path,
    type: entry.type === 'directory' ? 'directory' : 'file',
    size: entry.size,
    permissions: entry.permissions,
    isExpanded: false,
    children: entry.type === 'directory' ? [] : undefined,
  }))
}

export function mergeRemoteChildren(
  items: FileItem[],
  parentPath: string,
  children: FileItem[]
): FileItem[] {
  const walk = (nodes: FileItem[]): FileItem[] =>
    nodes.map(item => {
      if (item.path === parentPath && item.type === 'directory') {
        return {
          ...item,
          isExpanded: true,
          children,
        }
      }
      if (item.children?.length) {
        return { ...item, children: walk(item.children) }
      }
      return item
    })
  return walk(items)
}

export function getRemoteParentPath(path: string, user?: string): string | null {
  const normalized = resolveRemoteDisplayPath(path, user)
  if (normalized === '/' || normalized === '~') return null
  if (isWindowsRemotePath(normalized)) {
    const parent = getParentPath(normalized)
    if (!parent || parent === normalized) return null
    return parent
  }
  const parent = getParentPath(normalized)
  if (!parent || parent === normalized) return '/'
  return parent
}

export { joinRemotePath } from '@/lib/terminal-cwd'

export function normalizeRemotePathInput(input: string, user?: string): string {
  const trimmed = input.trim().replace(/\\/g, '/')
  if (!trimmed) return '~'
  if (isWindowsRemotePath(trimmed)) return trimmed
  if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('/')) {
    return trimmed
  }
  return `/${trimmed}`
}
