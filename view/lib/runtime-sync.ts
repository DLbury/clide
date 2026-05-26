import { isTauriRuntime } from '@/lib/tauri-env'
import type { Session } from '@/lib/types'

export interface ShellSnapshot {
  id: string
  name: string
  terminalSessionId: string
  terminalStatus?: string
}

export interface ConnectionSnapshot {
  id: string
  profileId: string
  profileName: string
  host: string
  activeShellId: string
  shells: ShellSnapshot[]
}

export interface ProfileSnapshot {
  id: string
  name: string
  host: string
  user?: string
  type: string
  status: string
  port?: number
}

export interface RuntimeSnapshot {
  profiles: ProfileSnapshot[]
  connections: ConnectionSnapshot[]
  activeConnectionId?: string
  activeShellId?: string
}

export interface ToolActivityEvent {
  kind: string
  status?: string
  profileId?: string
  terminalSessionId?: string
  command?: string
  displayCommand?: string
  outputPreview?: string
  error?: string
}

export function buildRuntimeSnapshot(input: {
  folders: { sessions: Session[] }[]
  connections: Array<{
    id: string
    session: Session
    shells: ShellSnapshot[]
    activeShellId: string
  }>
  activeConnectionId: string | null
}): RuntimeSnapshot {
  const profiles: ProfileSnapshot[] = []
  for (const folder of input.folders) {
    for (const s of folder.sessions) {
      profiles.push({
        id: s.id,
        name: s.name,
        host: s.host,
        user: s.user,
        type: s.type,
        status: s.status,
        port: s.port,
      })
    }
  }

  const connections: ConnectionSnapshot[] = input.connections.map(c => ({
    id: c.id,
    profileId: c.session.id,
    profileName: c.session.name,
    host: c.session.host,
    activeShellId: c.activeShellId,
    shells: c.shells,
  }))

  const active = input.connections.find(c => c.id === input.activeConnectionId)

  return {
    profiles,
    connections,
    activeConnectionId: input.activeConnectionId ?? undefined,
    activeShellId: active?.activeShellId,
  }
}

export async function syncAppRuntime(snapshot: RuntimeSnapshot): Promise<void> {
  if (!isTauriRuntime()) return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('sync_app_runtime', { snapshot })
}

function authPayloadFromSession(session: Session) {
  const auth = session.authConfig
  if (auth) {
    const envVar =
      auth.type === 'password-keychain'
        ? auth.keychainTarget ?? null
        : auth.envVar ?? null
    return {
      profileId: session.id,
      type: auth.type,
      envVar,
      keyPath: auth.keyPath ?? null,
      password: auth.plainPassword ?? null,
    }
  }
  if (session.authMethod === 'password' && session.password) {
    return {
      profileId: session.id,
      type: 'password-plain',
      envVar: null,
      keyPath: null,
      password: session.password,
    }
  }
  if (session.authMethod === 'env-var') {
    return {
      profileId: session.id,
      type: 'password-env',
      envVar: session.password ?? 'SSH_PASSWORD',
      keyPath: null,
      password: null,
    }
  }
  if (session.authMethod === 'key' && session.privateKeyPath) {
    return {
      profileId: session.id,
      type: 'key-path',
      envVar: null,
      keyPath: session.privateKeyPath,
      password: null,
    }
  }
  if (session.authMethod === 'ssh-agent') {
    return {
      profileId: session.id,
      type: 'ssh-agent',
      envVar: null,
      keyPath: null,
      password: null,
    }
  }
  return {
    profileId: session.id,
    type: 'default-keys',
    envVar: null,
    keyPath: session.privateKeyPath ?? null,
    password: null,
  }
}

export async function registerProfileAuth(session: Session): Promise<void> {
  if (!isTauriRuntime()) return
  const payload = authPayloadFromSession(session)
  if (payload.type === 'password-plain' && !payload.password) {
    return
  }
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('register_profile_auth', { payload })
}

export async function listenToolActivity(
  handler: (event: ToolActivityEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  const unlisten = await listen<ToolActivityEvent>('claude:tool-activity', e => {
    handler(e.payload)
  })
  return unlisten
}

export async function listenClaudeToolRequest(
  handler: (payload: Record<string, unknown>) => void
): Promise<() => void> {
  if (!isTauriRuntime()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  const unlisten = await listen<Record<string, unknown>>('claude:tool-request', e => {
    handler(e.payload)
  })
  return unlisten
}

type ToolRequestHandler = (payload: Record<string, unknown>) => void

const toolRequestHandlers = new Set<ToolRequestHandler>()
let toolRequestListenerPromise: Promise<() => void> | null = null

/** 单例订阅 claude:tool-request，避免 useEffect 重复注册导致同一命令执行多次 */
export function subscribeClaudeToolRequest(handler: ToolRequestHandler): () => void {
  toolRequestHandlers.add(handler)
  if (!toolRequestListenerPromise) {
    toolRequestListenerPromise = listenClaudeToolRequest(payload => {
      for (const h of toolRequestHandlers) {
        h(payload)
      }
    })
  }
  return () => {
    toolRequestHandlers.delete(handler)
  }
}
