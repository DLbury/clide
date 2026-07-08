export type SettingsTab = 'ai' | 'shortcuts' | 'update' | 'audit'

export interface LayoutShortcut {
  id: string
  label: string
  keys: string[]
  category: '窗口排列' | '焦点切换' | '全局'
}

export const LAYOUT_SHORTCUTS: LayoutShortcut[] = [
  { id: 'toggle-sidebar', label: '切换服务器侧边栏', keys: ['Ctrl', 'B'], category: '窗口排列' },
  { id: 'toggle-explorer', label: '切换文件', keys: ['Ctrl', 'Shift', 'E'], category: '窗口排列' },
  { id: 'toggle-ai', label: '切换 AI 助手面板', keys: ['Ctrl', 'Shift', 'A'], category: '窗口排列' },
  { id: 'split-editor-right', label: '向右拆分编辑器', keys: ['Ctrl', '\\'], category: '窗口排列' },
  { id: 'split-editor-below', label: '向下拆分编辑器', keys: ['Ctrl', 'Shift', '\\'], category: '窗口排列' },
  { id: 'focus-terminal', label: '聚焦终端', keys: ['Ctrl', '`'], category: '焦点切换' },
  { id: 'focus-editor', label: '聚焦编辑器', keys: ['Ctrl', '1'], category: '焦点切换' },
  { id: 'save-file', label: '保存当前文件', keys: ['Ctrl', 'S'], category: '全局' },
  { id: 'open-settings', label: '打开设置', keys: ['Ctrl', ','], category: '全局' },
  { id: 'command-history', label: '命令历史搜索', keys: ['Ctrl', 'Shift', 'H'], category: '焦点切换' },
]

export type LayoutShortcutAction =
  | 'toggle-sidebar'
  | 'toggle-explorer'
  | 'toggle-ai'
  | 'split-editor-right'
  | 'split-editor-below'
  | 'focus-terminal'
  | 'focus-editor'
  | 'open-settings'
  | 'command-history'

export function matchShortcutAction(event: KeyboardEvent): LayoutShortcutAction | null {
  const mod = event.ctrlKey || event.metaKey
  if (!mod) return null

  const key = event.key.toLowerCase()

  if (key === 'b' && !event.shiftKey && !event.altKey) return 'toggle-sidebar'
  if (key === 'e' && event.shiftKey) return 'toggle-explorer'
  if (key === 'a' && event.shiftKey) return 'toggle-ai'
  if (key === '\\' && !event.shiftKey) return 'split-editor-right'
  if (key === '\\' && event.shiftKey) return 'split-editor-below'
  if (key === '`') return 'focus-terminal'
  if (key === '1' && !event.shiftKey) return 'focus-editor'
  if (key === 'h' && event.shiftKey) return 'command-history'
  if (key === ',') return 'open-settings'

  return null
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable
}
