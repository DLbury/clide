'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, Loader2 } from 'lucide-react'
import { isTauriRuntime } from '@/lib/tauri-env'
import { normalizeBrowserUrl } from '@/lib/browser-address'
import {
  closeWebviewByLabel,
  sanitizeWebviewLabel,
  waitForHostBounds,
} from '@/lib/tauri-child-webview'
import { startSocksProxy } from '@/lib/tunnel-client'
import {
  registerEmbeddedWebview,
  unregisterEmbeddedWebview,
} from '@/lib/webview-layout-bridge'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

interface BrowserPanelProps {
  webviewLabel: string
  url?: string
  profileId?: string
  visible?: boolean
  className?: string
  onUrlChange?: (url: string, tunnelId?: string) => void
}

type AuthPopupState = {
  url: string
  label: string
}

/**
 * 工作台浏览器：顶部地址栏 + Tauri 子 WebView。
 */
export function BrowserPanel({
  webviewLabel,
  url: loadedUrl = '',
  profileId,
  visible = true,
  className,
  onUrlChange,
}: BrowserPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const authHostRef = useRef<HTMLDivElement>(null)
  const webviewRef = useRef<import('@tauri-apps/api/webview').Webview | null>(null)
  const authWebviewRef = useRef<import('@tauri-apps/api/webview').Webview | null>(null)
  const mountGenRef = useRef(0)
  const authMountGenRef = useRef(0)
  const lastMountedUrlRef = useRef('')
  const [address, setAddress] = useState(loadedUrl)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [webviewReady, setWebviewReady] = useState(false)
  const [authPopup, setAuthPopup] = useState<AuthPopupState | null>(null)
  const [authWebviewReady, setAuthWebviewReady] = useState(false)
  const addressRef = useRef<HTMLInputElement>(null)
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  useEffect(() => {
    setAddress(loadedUrl)
  }, [loadedUrl, webviewLabel])

  useEffect(() => {
    if (isTauriRuntime() && visible) {
      addressRef.current?.focus()
    }
  }, [webviewLabel, visible])

  const syncBounds = useCallback(async () => {
    const el = hostRef.current
    const wv = webviewRef.current
    if (!el || !wv || !visible || !webviewReady || authPopup) return
    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return
    try {
      const { LogicalPosition, LogicalSize } = await import('@tauri-apps/api/dpi')
      await wv.setPosition(new LogicalPosition(Math.round(rect.left), Math.round(rect.top)))
      await wv.setSize(
        new LogicalSize(Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)))
      )
    } catch {
      /* webview closed */
    }
  }, [visible, webviewReady, authPopup])

  const syncAuthBounds = useCallback(async () => {
    const el = authHostRef.current
    const wv = authWebviewRef.current
    if (!el || !wv || !authWebviewReady) return
    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return
    try {
      const { LogicalPosition, LogicalSize } = await import('@tauri-apps/api/dpi')
      await wv.setPosition(new LogicalPosition(Math.round(rect.left), Math.round(rect.top)))
      await wv.setSize(
        new LogicalSize(Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)))
      )
    } catch {
      /* webview closed */
    }
  }, [authWebviewReady])

  const safeLabel = sanitizeWebviewLabel(webviewLabel)
  const proxyUrlRef = useRef<string | null>(null)

  const ensureProxyUrl = useCallback(async (): Promise<string | undefined> => {
    if (!profileId) return undefined
    if (proxyUrlRef.current) return proxyUrlRef.current
    setStatus('启动服务器代理…')
    const info = await Promise.race([
      startSocksProxy(profileId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('启动服务器代理超时（SSH 认证失败或无响应）')), 25000)
      ),
    ])
    proxyUrlRef.current = `socks5://${info.localHost}:${info.localPort}`
    return proxyUrlRef.current
  }, [profileId])

  const mountWebview = useCallback(
    async (targetUrl: string) => {
      if (!isTauriRuntime() || !hostRef.current) return

      const gen = ++mountGenRef.current
      setWebviewReady(false)
      webviewRef.current = null

      const proxyUrl = await ensureProxyUrl()
      if (gen !== mountGenRef.current) return

      await closeWebviewByLabel(safeLabel)
      if (gen !== mountGenRef.current) return

      const { invoke } = await import('@tauri-apps/api/core')
      const { Webview } = await import('@tauri-apps/api/webview')
      const { getCurrentWindow } = await import('@tauri-apps/api/window')

      const host = hostRef.current
      const rect = await waitForHostBounds(host)
      const parent = getCurrentWindow()
      setStatus(proxyUrl ? '创建浏览器窗口（经服务器）…' : '创建浏览器窗口…')

      // 通过 Rust 创建：带代理时需要独立数据目录（独立 WebView2 环境），
      // 否则会与主窗口共用环境导致黑屏。
      await invoke('browser_webview_open', {
        windowLabel: parent.label,
        label: safeLabel,
        url: targetUrl,
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
        proxyUrl: proxyUrl ?? null,
        dataDirKey: null,
      })

      if (gen !== mountGenRef.current) {
        await closeWebviewByLabel(safeLabel)
        return
      }

      const wv = await Webview.getByLabel(safeLabel)
      if (!wv) {
        throw new Error('WebView 创建后未找到')
      }

      setStatus('加载页面…')
      // 不用 setAutoResize：它只跟随窗口缩放，不跟随 Dockview 分屏移动，会挡住标签拖拽。
      webviewRef.current = wv
      setWebviewReady(true)
      setStatus(null)

      if (!visible) {
        await wv.hide()
      } else {
        const { LogicalPosition, LogicalSize } = await import('@tauri-apps/api/dpi')
        const latest = host.getBoundingClientRect()
        await wv.setPosition(new LogicalPosition(Math.round(latest.left), Math.round(latest.top)))
        await wv.setSize(
          new LogicalSize(Math.max(1, Math.round(latest.width)), Math.max(1, Math.round(latest.height)))
        )
      }
    },
    [safeLabel, visible, ensureProxyUrl]
  )

  const closeAuthPopup = useCallback(async () => {
    authMountGenRef.current += 1
    const label = authPopup?.label
    authWebviewRef.current = null
    setAuthWebviewReady(false)
    setAuthPopup(null)
    if (label) {
      await closeWebviewByLabel(label)
    }
    const wv = webviewRef.current
    if (wv && visibleRef.current) {
      try {
        await wv.show()
        await syncBounds()
      } catch {
        /* ignore */
      }
    }
  }, [authPopup?.label, syncBounds])

  const mountAuthWebview = useCallback(
    async (popup: AuthPopupState) => {
      if (!isTauriRuntime() || !authHostRef.current) return

      const gen = ++authMountGenRef.current
      setAuthWebviewReady(false)
      authWebviewRef.current = null

      const mainWv = webviewRef.current
      if (mainWv) {
        try {
          await mainWv.hide()
        } catch {
          /* ignore */
        }
      }

      const proxyUrl = await ensureProxyUrl()
      if (gen !== authMountGenRef.current) return

      await closeWebviewByLabel(popup.label)
      if (gen !== authMountGenRef.current) return

      const { invoke } = await import('@tauri-apps/api/core')
      const { Webview } = await import('@tauri-apps/api/webview')
      const { getCurrentWindow } = await import('@tauri-apps/api/window')

      const host = authHostRef.current
      const rect = await waitForHostBounds(host)
      const parent = getCurrentWindow()

      await invoke('browser_webview_open', {
        windowLabel: parent.label,
        label: popup.label,
        url: popup.url,
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
        proxyUrl: proxyUrl ?? null,
        dataDirKey: safeLabel,
      })

      if (gen !== authMountGenRef.current) {
        await closeWebviewByLabel(popup.label)
        return
      }

      const wv = await Webview.getByLabel(popup.label)
      if (!wv) {
        throw new Error('认证 WebView 创建后未找到')
      }

      authWebviewRef.current = wv
      setAuthWebviewReady(true)
      const { LogicalPosition, LogicalSize } = await import('@tauri-apps/api/dpi')
      const latest = host.getBoundingClientRect()
      await wv.setPosition(new LogicalPosition(Math.round(latest.left), Math.round(latest.top)))
      await wv.setSize(
        new LogicalSize(Math.max(1, Math.round(latest.width)), Math.max(1, Math.round(latest.height)))
      )
    },
    [ensureProxyUrl, safeLabel]
  )

  // 拦截 window.open：Rust 发事件，前端用模态对话框承载认证页
  useEffect(() => {
    if (!isTauriRuntime()) return
    let unlisten: (() => void) | undefined
    void import('@tauri-apps/api/event').then(({ listen }) => {
      void listen<{ parentLabel: string; url: string }>('browser-new-window', event => {
        const { parentLabel, url } = event.payload
        if (parentLabel !== safeLabel && !parentLabel.startsWith(`${safeLabel}-auth`)) return
        const authLabel = sanitizeWebviewLabel(`${safeLabel}-auth-${Date.now().toString(36)}`)
        setAuthPopup(prev => {
          if (prev?.label) void closeWebviewByLabel(prev.label)
          return { url, label: authLabel }
        })
      }).then(fn => {
        unlisten = fn
      })
    })
    return () => {
      unlisten?.()
    }
  }, [safeLabel])

  useEffect(() => {
    if (!authPopup) return
    void mountAuthWebview(authPopup).catch(err => {
      setError(err instanceof Error ? err.message : String(err))
      void closeAuthPopup()
    })
  }, [authPopup, mountAuthWebview, closeAuthPopup])

  useEffect(() => {
    if (!authWebviewReady) return
    void syncAuthBounds()
    const onScroll = () => void syncAuthBounds()
    const ro = new ResizeObserver(() => void syncAuthBounds())
    if (authHostRef.current) ro.observe(authHostRef.current)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      ro.disconnect()
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [authWebviewReady, syncAuthBounds])

  // 切离浏览器标签时隐藏认证 WebView，避免挡住终端
  useEffect(() => {
    if (!authWebviewReady) return
    const authWv = authWebviewRef.current
    if (!authWv) return
    void (async () => {
      try {
        if (visible && authPopup) {
          await authWv.show()
          await syncAuthBounds()
        } else {
          await authWv.hide()
        }
      } catch {
        /* ignore */
      }
    })()
  }, [visible, authWebviewReady, authPopup, syncAuthBounds])

  useEffect(() => {
    return () => {
      authMountGenRef.current += 1
      authWebviewRef.current = null
      if (authPopup?.label) {
        void closeWebviewByLabel(authPopup.label)
      }
    }
  }, [authPopup?.label])

  const navigate = useCallback(
    async (raw: string) => {
      if (!isTauriRuntime()) return
      setError(null)
      setLoading(true)
      try {
        const finalUrl = normalizeBrowserUrl(raw)
        lastMountedUrlRef.current = finalUrl
        await mountWebview(finalUrl)
        setAddress(finalUrl)
        onUrlChange?.(finalUrl)
      } catch (err) {
        lastMountedUrlRef.current = ''
        setWebviewReady(false)
        webviewRef.current = null
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setStatus(null)
        setLoading(false)
      }
    },
    [mountWebview, onUrlChange]
  )

  // MCP / 外部注入 URL
  useEffect(() => {
    if (!isTauriRuntime() || !loadedUrl) return
    if (lastMountedUrlRef.current === loadedUrl) return
    lastMountedUrlRef.current = loadedUrl
    void mountWebview(loadedUrl).catch(err => {
      lastMountedUrlRef.current = ''
      setError(err instanceof Error ? err.message : String(err))
    })
  }, [loadedUrl, webviewLabel, mountWebview])

  // 跟踪 host 位置变化：ResizeObserver + Dockview 布局桥已覆盖分屏/拖拽；无需常驻 rAF 轮询。
  useEffect(() => {
    if (!isTauriRuntime() || !webviewReady || !visible) return
    void syncBounds()
  }, [webviewReady, visible, syncBounds])

  // 尺寸同步
  useEffect(() => {
    if (!isTauriRuntime() || !webviewReady) return
    const onScroll = () => void syncBounds()
    const ro = new ResizeObserver(() => void syncBounds())
    if (hostRef.current) ro.observe(hostRef.current)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    void syncBounds()
    return () => {
      ro.disconnect()
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [webviewReady, syncBounds])

  // 切换 Dockview 标签：hide/show，不销毁
  useEffect(() => {
    if (!webviewReady || authPopup) return
    const wv = webviewRef.current
    if (!wv) return
    void (async () => {
      try {
        if (visible) {
          await wv.show()
          await syncBounds()
        } else {
          await wv.hide()
        }
      } catch {
        /* ignore */
      }
    })()
  }, [visible, webviewReady, syncBounds, authPopup])

  // 注册到 Dockview 布局桥：拖拽时隐藏，布局变化后同步位置
  useEffect(() => {
    if (!isTauriRuntime() || !webviewReady) return
    registerEmbeddedWebview(safeLabel, {
      syncBounds: () => void syncBounds(),
      setHidden: hidden => {
        const wv = webviewRef.current
        if (!wv || authPopup) return
        if (hidden) {
          void wv.hide()
        } else if (visibleRef.current) {
          void wv.show().then(() => syncBounds())
        }
      },
    })
    return () => unregisterEmbeddedWebview(safeLabel)
  }, [safeLabel, webviewReady, syncBounds, authPopup])

  useEffect(() => {
    return () => {
      mountGenRef.current += 1
      webviewRef.current = null
      setWebviewReady(false)
      void closeWebviewByLabel(safeLabel)
    }
  }, [safeLabel])

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault()
    void navigate(address)
  }

  const reloadPage = useCallback(() => {
    const target = address.trim() || loadedUrl
    if (!target) return
    void navigate(target)
  }, [address, loadedUrl, navigate])

  const copyUrl = useCallback(() => {
    const target = address.trim() || loadedUrl
    if (!target) return
    navigator.clipboard.writeText(target).catch(() => {})
  }, [address, loadedUrl])

  if (!isTauriRuntime()) {
    return (
      <div className={cn('p-4 text-sm text-muted-foreground', className)}>
        浏览器标签仅在桌面版可用。
      </div>
    )
  }

  return (
    <>
    <ContextMenu>
      <ContextMenuTrigger asChild>
    <div className={cn('flex h-full min-h-0 flex-col bg-background', className)}>
      <form
        onSubmit={handleSubmit}
        className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5"
      >
        <Input
          ref={addressRef}
          value={address}
          onChange={e => setAddress(e.target.value)}
          placeholder={
            profileId
              ? '经服务器访问，如 https://example.com 或 127.0.0.1:8080'
              : '输入 URL，如 https://example.com'
          }
          className="h-8 font-mono text-xs"
          disabled={loading}
        />
        <Button type="submit" size="sm" variant="secondary" className="h-8 px-2" disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
        </Button>
      </form>
      {error && <p className="shrink-0 px-3 py-1 text-xs text-destructive">{error}</p>}
      {status && !error && (
        <p className="shrink-0 px-3 py-1 text-xs text-muted-foreground">{status}</p>
      )}
      <div className="relative min-h-0 flex-1">
        {!loadedUrl && !loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background text-sm text-muted-foreground">
            在上方输入地址并回车
          </div>
        )}
        <div ref={hostRef} className="h-full w-full min-h-[200px]" />
      </div>
    </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onClick={reloadPage} disabled={!address.trim() && !loadedUrl}>
          重新加载
        </ContextMenuItem>
        <ContextMenuItem onClick={copyUrl} disabled={!address.trim() && !loadedUrl}>
          复制 URL
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => {
            addressRef.current?.focus()
            addressRef.current?.select()
          }}
        >
          编辑地址
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
    <Dialog
      open={!!authPopup}
      onOpenChange={open => {
        if (!open) void closeAuthPopup()
      }}
    >
      <DialogContent
        className="flex h-[min(720px,85vh)] w-[min(960px,calc(100%-2rem))] max-w-none flex-col gap-3 p-4 sm:max-w-none"
        showCloseButton
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>站点登录</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">
            {authPopup?.url}
          </DialogDescription>
        </DialogHeader>
        <div ref={authHostRef} className="min-h-0 flex-1 rounded-md border border-border bg-background" />
      </DialogContent>
    </Dialog>
    </>
  )
}
