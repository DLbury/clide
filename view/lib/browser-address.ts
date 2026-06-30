/** 解析地址栏输入：SSH 下 host:port 走隧道，其余按 URL 加载。 */
import { assertInternalBrowserHost, assertInternalBrowserUrl } from '@/lib/browser-policy'

export function parseBrowserAddress(
  input: string,
  sshProfileId?: string
): { url: string; tunnel?: { remoteHost: string; remotePort: number; path?: string } } {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error('请输入地址')
  }

  const hostPort = trimmed.match(/^([^/\s:?#]+):(\d+)(\/.*)?$/)
  if (hostPort && sshProfileId) {
    const remoteHost = hostPort[1]
    const remotePort = Number.parseInt(hostPort[2], 10)
    const path = hostPort[3] ? hostPort[3].slice(1) : undefined
    if (!Number.isFinite(remotePort) || remotePort < 1 || remotePort > 65535) {
      throw new Error('端口号无效')
    }
    assertInternalBrowserHost(remoteHost)
    return { url: '', tunnel: { remoteHost, remotePort, path } }
  }

  if (/^https?:\/\//i.test(trimmed)) {
    if (sshProfileId) {
      try {
        const u = new URL(trimmed)
        const isLoopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
        if (isLoopback && u.port) {
          assertInternalBrowserHost(u.hostname)
          return {
            url: '',
            tunnel: {
              remoteHost: u.hostname,
              remotePort: Number.parseInt(u.port, 10),
              path: `${u.pathname}${u.search}`.replace(/^\//, '') || undefined,
            },
          }
        }
      } catch {
        /* fall through */
      }
    }
    assertInternalBrowserUrl(trimmed)
    return { url: trimmed }
  }

  const url = `http://${trimmed}`
  assertInternalBrowserUrl(url)
  return { url }
}

/**
 * 归一化地址栏输入为可加载的 URL（仅允许内网地址与内网域名）。
 */
export function normalizeBrowserUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error('请输入地址')
  }
  if (/^https?:\/\//i.test(trimmed)) {
    assertInternalBrowserUrl(trimmed)
    return trimmed
  }
  const url = `http://${trimmed}`
  assertInternalBrowserUrl(url)
  return url
}

export function tabTitleFromUrl(url: string): string {
  if (!url.trim()) return '浏览器'
  try {
    const u = new URL(url)
    return u.host || url
  } catch {
    return url.length > 32 ? `${url.slice(0, 32)}…` : url
  }
}
