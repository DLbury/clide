import { isTauriRuntime } from '@/lib/tauri-env'

let cached: string | null = null

/** Claude Code / .mcp.json 所在仓库根目录 */
export async function getProjectRoot(): Promise<string> {
  if (cached) return cached
  if (!isTauriRuntime()) {
    cached = '.'
    return cached
  }
  const { invoke } = await import('@tauri-apps/api/core')
  cached = await invoke<string>('get_project_root')
  return cached
}
