import { getVersion } from '@tauri-apps/api/app'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { isTauriRuntime } from '@/lib/tauri-env'

const AUTO_CHECK_KEY = 'clide.autoCheckUpdates'

export function loadAutoCheckUpdates(): boolean {
  if (typeof window === 'undefined') return true
  const stored = localStorage.getItem(AUTO_CHECK_KEY)
  return stored === null ? true : stored === '1'
}

export function saveAutoCheckUpdates(enabled: boolean): void {
  localStorage.setItem(AUTO_CHECK_KEY, enabled ? '1' : '0')
}

export async function getAppVersion(): Promise<string | null> {
  if (!isTauriRuntime()) return null
  try {
    return await getVersion()
  } catch {
    return null
  }
}

export interface UpdateCheckResult {
  available: boolean
  version?: string
  date?: string
  notes?: string
  update?: Update
}

export async function checkForAppUpdate(): Promise<UpdateCheckResult> {
  if (!isTauriRuntime()) return { available: false }

  const update = await check()
  if (!update) return { available: false }

  return {
    available: true,
    version: update.version,
    date: update.date ?? undefined,
    notes: update.body ?? undefined,
    update,
  }
}

export type DownloadProgressHandler = (downloaded: number, total?: number) => void

export async function installAppUpdate(
  update: Update,
  onProgress?: DownloadProgressHandler
): Promise<void> {
  let downloaded = 0
  await update.downloadAndInstall(event => {
    switch (event.event) {
      case 'Started':
        onProgress?.(0, event.data.contentLength ?? undefined)
        break
      case 'Progress':
        downloaded += event.data.chunkLength
        onProgress?.(downloaded)
        break
      case 'Finished':
        onProgress?.(downloaded, downloaded)
        break
    }
  })
  await relaunch()
}
