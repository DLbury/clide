'use client'

import { useCallback, useEffect, useState } from 'react'
import type { Session, SessionFolder } from '@/lib/types'

const STORAGE_KEY = 'aiterm-sessions-v1'

type StoredSession = Omit<Session, 'lastActive' | 'status'> & {
  lastActive: string
  status?: Session['status']
}

type StoredFolder = Omit<SessionFolder, 'sessions'> & {
  sessions: StoredSession[]
}

function repairStoredSession(raw: StoredSession): StoredSession {
  if (raw.authConfig?.type === 'password-plain') {
    return { ...raw, authMethod: 'password' }
  }
  if (raw.authConfig?.type === 'default-keys') {
    return { ...raw, authMethod: 'none' }
  }
  if (raw.authMethod === 'none' && !raw.authConfig) {
    return { ...raw, authConfig: { type: 'default-keys' } }
  }
  if (raw.authMethod === 'password' && !raw.authConfig) {
    return { ...raw, authConfig: { type: 'password-plain' } }
  }
  return raw
}

function deserializeSession(raw: StoredSession): Session {
  const needsPassword =
    raw.authMethod === 'password' || raw.authConfig?.type === 'password-plain'

  const session: Session = {
    ...raw,
    status: 'disconnected',
    lastActive: new Date(raw.lastActive),
    password: undefined,
    privateKeyPath: undefined,
  }

  // 保留「需要密码」标记，但不持久化明文；连接时弹窗输入
  if (needsPassword && !raw.authConfig?.plainPassword && !raw.password) {
    session.authMethod = 'password'
    session.authConfig = { type: 'password-plain' }
  }

  return session
}

function serializeSession(session: Session): StoredSession {
  const {
    status: _status,
    lastActive,
    password: _password,
    privateKeyPath: _privateKeyPath,
    authConfig,
    ...rest
  } = session
  const safeAuth = authConfig
    ? {
        ...authConfig,
        ...(authConfig.type === 'password-plain' ? { plainPassword: undefined } : {}),
      }
    : undefined
  return {
    ...rest,
    password: undefined,
    privateKeyPath: undefined,
    authConfig: safeAuth,
    lastActive: lastActive.toISOString(),
  }
}

const HIDDEN_SESSION_IDS = new Set(['__default_local_shell__'])

function deserializeFolders(raw: StoredFolder[]): SessionFolder[] {
  return raw.map(folder => ({
    ...folder,
    sessions: folder.sessions
      .filter(s => !HIDDEN_SESSION_IDS.has(s.id))
      .map(s => deserializeSession(repairStoredSession(s))),
  }))
}

function serializeFolders(folders: SessionFolder[]): StoredFolder[] {
  return folders.map(folder => ({
    ...folder,
    sessions: folder.sessions.map(serializeSession),
  }))
}

export function loadSessionFolders(): SessionFolder[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as StoredFolder[]
    if (!Array.isArray(parsed)) return []
    return deserializeFolders(parsed)
  } catch {
    return []
  }
}

export function saveSessionFolders(folders: SessionFolder[]): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeFolders(folders)))
}

/** 无文件夹时创建默认分组，便于录入第一个会话 */
export function ensureDefaultFolder(folders: SessionFolder[]): SessionFolder[] {
  if (folders.length > 0) return folders
  return [
    {
      id: `folder-${Date.now()}`,
      name: '我的会话',
      sessions: [],
      isExpanded: true,
    },
  ]
}

export function useSessionFolders() {
  // Start empty on both server and client to avoid hydration mismatch
  const [folders, setFolders] = useState<SessionFolder[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    // Load from localStorage only on client side after hydration
    setFolders(loadSessionFolders())
    setLoaded(true)
  }, [])

  useEffect(() => {
    if (!loaded) return
    saveSessionFolders(folders)
  }, [folders, loaded])

  const updateFolders = useCallback(
    (updater: SessionFolder[] | ((prev: SessionFolder[]) => SessionFolder[])) => {
      setFolders(prev => {
        const next = typeof updater === 'function' ? updater(prev) : updater
        return next
      })
    },
    []
  )

  return { folders, setFolders: updateFolders, loaded }
}
