/** MIME type for dragging remote file paths within the file tree. */
export const REMOTE_DRAG_TYPE = 'application/x-aiterm-remote-path'

export function isRemotePathDrag(e: Pick<DragEvent, 'dataTransfer'>): boolean {
  const dt = e.dataTransfer
  if (!dt) return false
  return Array.from(dt.types).includes(REMOTE_DRAG_TYPE)
}

/** OS / browser file drop (upload), not an in-tree remote move. */
export function isOsFileDrag(e: Pick<DragEvent, 'dataTransfer'>): boolean {
  const dt = e.dataTransfer
  if (!dt) return false
  if (isRemotePathDrag(e)) return false
  const types = Array.from(dt.types)
  if (types.includes('Files')) return true
  return types.length === 0 && dt.files.length > 0
}

export function getRemoteDragPath(e: Pick<DragEvent, 'dataTransfer'>): string | null {
  const dt = e.dataTransfer
  if (!dt) return null
  const path = dt.getData(REMOTE_DRAG_TYPE)
  return path.trim() || null
}
