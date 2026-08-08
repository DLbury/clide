import { isTauriRuntime } from '@/lib/tauri-env'

/**
 * WebKitGTK 无法可靠读取外部应用写入的系统剪贴板；
 * Linux 上优先走 Tauri 原生剪贴板插件，其它平台 web API 失败时再回退。
 */
const preferNativeClipboard =
  typeof navigator !== 'undefined' &&
  /Linux/i.test(navigator.userAgent) &&
  !/Android/i.test(navigator.userAgent)

async function readViaPlugin(): Promise<string | null> {
  if (!isTauriRuntime()) return null
  try {
    const { readText } = await import('@tauri-apps/plugin-clipboard-manager')
    return (await readText()) ?? ''
  } catch {
    return null
  }
}

async function writeViaPlugin(text: string): Promise<boolean> {
  if (!isTauriRuntime()) return false
  try {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
    await writeText(text)
    return true
  } catch {
    return false
  }
}

export async function readTerminalClipboard(): Promise<string> {
  if (preferNativeClipboard) {
    const native = await readViaPlugin()
    if (native != null) return native
  }
  try {
    return (await navigator.clipboard.readText()) ?? ''
  } catch {
    const native = await readViaPlugin()
    return native ?? ''
  }
}

export async function writeTerminalClipboard(text: string): Promise<void> {
  if (!text) return
  if (preferNativeClipboard) {
    if (await writeViaPlugin(text)) return
  }
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    await writeViaPlugin(text)
  }
}
