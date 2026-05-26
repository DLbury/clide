import type { Session } from '@/lib/types'
import { joinRemotePath } from '@/lib/terminal-cwd'
import { isTauriRuntime } from '@/lib/tauri-env'
import {
  deleteRemotePath,
  moveRemotePath,
  readRemoteFileBinary,
  writeRemoteFileBinary,
  type RemoteFileOptions,
} from '@/lib/terminal-client'
import { resolveSessionForConnect } from '@/lib/auth-config'

export type UploadProgressPhase = 'reading' | 'uploading'

export interface UploadProgress {
  fileName: string
  fileIndex: number
  fileCount: number
  phase: UploadProgressPhase
}

export type UploadProgressCallback = (progress: UploadProgress) => void

export function uploadOverallPercent(progress: UploadProgress): number {
  const perFile = 100 / progress.fileCount
  const phaseOffset = progress.phase === 'reading' ? perFile * 0.2 : perFile * 0.8
  return Math.min(100, Math.round(progress.fileIndex * perFile + phaseOffset))
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64.trim())
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function fileToBase64(
  file: File,
  onReading?: () => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('无法读取文件'))
        return
      }
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    onReading?.()
    reader.readAsDataURL(file)
  })
}

export async function downloadRemoteFile(
  session: Session,
  remotePath: string,
  options?: RemoteFileOptions
): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error('下载仅 Tauri 桌面版可用')
  }
  const resolved = resolveSessionForConnect(session)
  const base64 = await readRemoteFileBinary(resolved, remotePath, options)
  const bytes = base64ToBytes(base64)
  const name = remotePath.split('/').filter(Boolean).pop() ?? 'download'
  const blob = new Blob([bytes])
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export async function uploadFilesToRemote(
  session: Session,
  remoteDir: string,
  files: FileList | File[],
  options?: RemoteFileOptions,
  onProgress?: UploadProgressCallback
): Promise<{ uploaded: number; errors: string[] }> {
  if (!isTauriRuntime()) {
    throw new Error('上传仅 Tauri 桌面版可用')
  }
  const resolved = resolveSessionForConnect(session)
  const list = Array.from(files)
  const errors: string[] = []
  let uploaded = 0
  const dir = remoteDir.replace(/\/+$/, '') || '/'

  for (let i = 0; i < list.length; i++) {
    const file = list[i]
    onProgress?.({
      fileName: file.name,
      fileIndex: i,
      fileCount: list.length,
      phase: 'reading',
    })
    try {
      const base64 = await fileToBase64(file, () => {
        onProgress?.({
          fileName: file.name,
          fileIndex: i,
          fileCount: list.length,
          phase: 'reading',
        })
      })
      onProgress?.({
        fileName: file.name,
        fileIndex: i,
        fileCount: list.length,
        phase: 'uploading',
      })
      const remotePath = joinRemotePath(dir, file.name)
      await writeRemoteFileBinary(resolved, remotePath, base64, options)
      uploaded += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`${file.name}: ${message}`)
    }
  }

  return { uploaded, errors }
}

export async function moveRemoteFile(
  session: Session,
  sourcePath: string,
  destDir: string,
  options?: RemoteFileOptions
): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error('移动仅 Tauri 桌面版可用')
  }
  const resolved = resolveSessionForConnect(session)
  await moveRemotePath(resolved, sourcePath, destDir, options)
}

export async function deleteRemoteFile(
  session: Session,
  path: string,
  options?: RemoteFileOptions
): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error('删除仅 Tauri 桌面版可用')
  }
  const resolved = resolveSessionForConnect(session)
  await deleteRemotePath(resolved, path, options)
}
