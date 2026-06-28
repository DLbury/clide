/** 协调嵌入式 Tauri 子 WebView 与 Dockview 布局/拖拽，避免原生层挡住标签拖拽。 */

type WebviewPanelHandlers = {
  syncBounds: () => void
  setHidden: (hidden: boolean) => void
}

const panels = new Map<string, WebviewPanelHandlers>()

export function registerEmbeddedWebview(label: string, handlers: WebviewPanelHandlers): void {
  panels.set(label, handlers)
}

export function unregisterEmbeddedWebview(label: string): void {
  panels.delete(label)
}

export function syncAllEmbeddedWebviews(): void {
  panels.forEach(h => h.syncBounds())
}

export function hideAllEmbeddedWebviews(): void {
  panels.forEach(h => h.setHidden(true))
}

export function showAllEmbeddedWebviews(): void {
  panels.forEach(h => {
    h.setHidden(false)
    h.syncBounds()
  })
}
