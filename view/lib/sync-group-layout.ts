/** 多机同步界面：Shell 分屏平铺（优先左右，再上下） */

export type SyncTileDirection = 'right' | 'below'

export interface SyncTilePlacement {
  shellId: string
  referenceShellId?: string
  direction?: SyncTileDirection
}

/**
 * 将 N 个 Shell 平铺为网格：先按行左右排列，行满后向下扩展。
 * 例：4 台 → 2×2；3 台 → 2 列且左下补一行。
 */
export function computeSyncGroupTilePlacements(shellIds: string[]): SyncTilePlacement[] {
  const n = shellIds.length
  if (n === 0) return []
  if (n === 1) return [{ shellId: shellIds[0] }]

  const cols = Math.min(n, Math.max(2, Math.ceil(Math.sqrt(n))))
  const placements: SyncTilePlacement[] = [{ shellId: shellIds[0] }]

  for (let i = 1; i < n; i++) {
    const row = Math.floor(i / cols)
    if (row === 0) {
      placements.push({
        shellId: shellIds[i],
        referenceShellId: shellIds[i - 1],
        direction: 'right',
      })
    } else {
      placements.push({
        shellId: shellIds[i],
        referenceShellId: shellIds[i - cols],
        direction: 'below',
      })
    }
  }

  return placements
}
