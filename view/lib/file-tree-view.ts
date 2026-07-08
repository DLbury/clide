import type { FileItem } from '@/lib/types'

export const FILE_TREE_ROW_HEIGHT = 28
export const FILE_TREE_VIRTUAL_THRESHOLD = 80

export interface FlatFileRow {
  item: FileItem
  depth: number
}

/** 将当前可见节点扁平化为行（用于虚拟滚动） */
export function flattenVisibleFileTree(items: FileItem[], depth = 0): FlatFileRow[] {
  const rows: FlatFileRow[] = []
  for (const item of items) {
    rows.push({ item, depth })
    if (item.type === 'directory' && item.isExpanded && item.children?.length) {
      rows.push(...flattenVisibleFileTree(item.children, depth + 1))
    }
  }
  return rows
}

/** 浅层合并展开状态，避免 JSON 深拷贝 */
export function mergeExpandOverrides(
  items: FileItem[],
  overrides: ReadonlyMap<string, boolean>
): FileItem[] {
  if (overrides.size === 0) return items
  return items.map(item => {
    const isExpanded = overrides.has(item.id) ? overrides.get(item.id)! : item.isExpanded
    const children = item.children
      ? mergeExpandOverrides(item.children, overrides)
      : undefined
    if (isExpanded === item.isExpanded && children === item.children) {
      return item
    }
    return { ...item, isExpanded, children }
  })
}

export function computeVisibleRange(
  scrollTop: number,
  viewportHeight: number,
  totalRows: number,
  overscan = 8
): { start: number; end: number } {
  if (totalRows === 0) return { start: 0, end: 0 }
  const start = Math.max(0, Math.floor(scrollTop / FILE_TREE_ROW_HEIGHT) - overscan)
  const visibleCount = Math.ceil(viewportHeight / FILE_TREE_ROW_HEIGHT) + overscan * 2
  const end = Math.min(totalRows, start + visibleCount)
  return { start, end }
}
