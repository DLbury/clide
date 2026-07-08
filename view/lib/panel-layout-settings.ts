const SIDEBAR_KEY = 'clide-panel-sidebar-visible'
const FILE_TREE_KEY = 'clide-panel-file-tree-visible'
const AI_PANE_KEY = 'clide-panel-ai-pane-visible'

function loadBool(key: string, defaultValue: boolean): boolean {
  if (typeof window === 'undefined') return defaultValue
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return defaultValue
    return raw === '1'
  } catch {
    return defaultValue
  }
}

function saveBool(key: string, visible: boolean): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(key, visible ? '1' : '0')
  } catch {
    /* ignore */
  }
}

export function loadSidebarVisible(): boolean {
  return loadBool(SIDEBAR_KEY, true)
}

export function saveSidebarVisible(visible: boolean): void {
  saveBool(SIDEBAR_KEY, visible)
}

export function loadFileTreeVisible(): boolean {
  return loadBool(FILE_TREE_KEY, true)
}

export function saveFileTreeVisible(visible: boolean): void {
  saveBool(FILE_TREE_KEY, visible)
}

export function loadAiPaneVisible(): boolean {
  return loadBool(AI_PANE_KEY, true)
}

export function saveAiPaneVisible(visible: boolean): void {
  saveBool(AI_PANE_KEY, visible)
}
