import type { Webview } from '@tauri-apps/api/webview'

/** Tauri webview 标签仅允许 a-zA-Z0-9 与 - / : _ */
export function sanitizeWebviewLabel(label: string): string {
  const cleaned = label.replace(/[^a-zA-Z0-9\-/:_]/g, '-').replace(/-+/g, '-')
  return cleaned.slice(0, 64) || 'browser-tab'
}

export function makeBrowserWebviewLabel(tabId: string): string {
  const compact = tabId.replace(/-/g, '').slice(0, 12)
  return sanitizeWebviewLabel(`bv-${compact}-${Date.now().toString(36)}`)
}

function formatWebviewError(payload: unknown): string {
  if (payload instanceof Error) return payload.message
  if (typeof payload === 'string' && payload.trim()) return payload
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    if (typeof obj.message === 'string' && obj.message.trim()) return obj.message
    if (typeof obj.error === 'string' && obj.error.trim()) return obj.error
    try {
      const json = JSON.stringify(payload)
      if (json && json !== '{}') return json
    } catch {
      /* ignore */
    }
  }
  return '创建 WebView 失败'
}

/** 等待宿主区域有有效尺寸后再创建子 WebView。 */
export async function waitForHostBounds(
  el: HTMLElement,
  minSize = 8,
  timeoutMs = 3000
): Promise<DOMRect> {
  const start = Date.now()
  for (;;) {
    const rect = el.getBoundingClientRect()
    if (rect.width >= minSize && rect.height >= minSize) return rect
    if (Date.now() - start >= timeoutMs) {
      throw new Error('浏览器区域尺寸无效，请稍后再试')
    }
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  }
}

/** 等待 Tauri 子 WebView 在 Rust 侧创建完成（否则 setSize/hide 会报 webview not found）。 */
export function waitWebviewCreated(wv: Webview, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error('创建 WebView 超时'))
    }, timeoutMs)

    const finish = (fn: () => void) => {
      window.clearTimeout(timer)
      fn()
    }

    void wv.once('tauri://created', () => finish(resolve))
    void wv.once('tauri://error', payload => {
      finish(() => reject(new Error(formatWebviewError(payload))))
    })
  })
}

export async function closeWebviewByLabel(label: string): Promise<void> {
  const safeLabel = sanitizeWebviewLabel(label)
  const { Webview } = await import('@tauri-apps/api/webview')
  const existing = await Webview.getByLabel(safeLabel)
  if (!existing) return
  try {
    await existing.close()
  } catch {
    /* already closed */
  }
}
