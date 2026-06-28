import { isTauriRuntime } from '@/lib/tauri-env'

export interface TunnelInfo {
  id: string
  profileId: string
  remoteHost: string
  remotePort: number
  localPort: number
  localUrl: string
  status: string
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) {
    throw new Error('SSH 隧道仅在 Tauri 桌面版可用')
  }
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke<T>(cmd, args)
}

export async function startTunnel(options: {
  profileId: string
  remoteHost: string
  remotePort: number
  localPort?: number
  path?: string
}): Promise<TunnelInfo> {
  return invoke<TunnelInfo>('tunnel_start', {
    profileId: options.profileId,
    remoteHost: options.remoteHost,
    remotePort: options.remotePort,
    localPort: options.localPort ?? null,
    path: options.path ?? null,
  })
}

export async function stopTunnel(tunnelId: string): Promise<boolean> {
  return invoke<boolean>('tunnel_stop', { tunnelId })
}

export async function listTunnels(profileId?: string): Promise<TunnelInfo[]> {
  return invoke<TunnelInfo[]>('tunnel_list', { profileId: profileId ?? null })
}

export interface SocksInfo {
  id: string
  profileId: string
  localHost: string
  localPort: number
  status: string
}

/** 为某个 SSH 配置启动（或复用）本地 SOCKS5 代理，浏览器流量经服务器出口。 */
export async function startSocksProxy(profileId: string): Promise<SocksInfo> {
  return invoke<SocksInfo>('socks_start', { profileId })
}

export async function stopSocksProxy(socksId: string): Promise<boolean> {
  return invoke<boolean>('socks_stop', { socksId })
}

export async function stopSocksForProfile(profileId: string): Promise<void> {
  await invoke<void>('socks_stop_for_profile', { profileId })
}
