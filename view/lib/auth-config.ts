import type { AuthConfig, Session } from '@/lib/types'
import { getRuntimePassword } from '@/lib/runtime-password'
import { getStoredPassword } from '@/lib/password-vault-local'

export function authConfigFromSession(session: Session): AuthConfig | undefined {
  if (session.authConfig) return session.authConfig
  if (session.authMethod === 'password' && session.password) {
    return { type: 'password-plain', plainPassword: session.password }
  }
  if (session.authMethod === 'key' && session.privateKeyPath) {
    return { type: 'key-path', keyPath: session.privateKeyPath }
  }
  if (session.authMethod === 'env-var') {
    return { type: 'password-env', envVar: session.password || 'SSH_PASSWORD' }
  }
  if (session.authMethod === 'ssh-agent') {
    return { type: 'ssh-agent' }
  }
  return undefined
}

export function authMethodFromConfig(config: AuthConfig): Session['authMethod'] {
  switch (config.type) {
    case 'password-plain':
    case 'password-env':
    case 'password-keychain':
      return 'password'
    case 'key-path':
    case 'key-env':
      return 'key'
    case 'ssh-agent':
      return 'ssh-agent'
    case 'default-keys':
      return 'none'
    default:
      return 'none'
  }
}

export function validateAuthConfig(config: AuthConfig): string | null {
  switch (config.type) {
    case 'password-env':
    case 'key-env':
      return config.envVar?.trim() ? null : '请填写环境变量名'
    case 'password-keychain':
      return config.keychainTarget?.trim() ? null : '请填写凭据目标名（Windows 凭据管理器）'
    case 'password-plain':
      return config.plainPassword ? null : '请填写密码'
    case 'key-path':
      return config.keyPath?.trim() ? null : '请填写私钥路径'
    default:
      return null
  }
}

/** MCP / Rust vault 使用的 profileId，与侧边栏会话 id 一致 */
export function defaultKeychainTarget(profileId: string): string {
  return `aiterm-${profileId}`
}

export function newSessionId(): string {
  return `s-${crypto.randomUUID()}`
}

/** 当前会话是否使用密码认证且尚无可用密码（需弹窗输入） */
export function sessionNeedsPasswordPrompt(session: Session): boolean {
  if (session.type !== 'ssh') return false
  if (getRuntimePassword(session.id) || getStoredPassword(session.id)) return false
  if (session.password || session.authConfig?.plainPassword) return false

  const auth = authConfigFromSession(session)
  if (
    auth?.type === 'password-env' ||
    auth?.type === 'password-keychain' ||
    auth?.type === 'key-env' ||
    auth?.type === 'key-path' ||
    auth?.type === 'ssh-agent'
  ) {
    return false
  }

  if (session.authMethod === 'password') return true
  if (session.authConfig?.type === 'password-plain') return true
  if (auth?.type === 'password-plain') return true

  // 「暂无 / 默认密钥」：仍可能实际需要密码，连接时让用户输入或选默认密钥
  if (
    session.authMethod === 'none' ||
    session.authMethod === undefined ||
    session.authConfig?.type === 'default-keys'
  ) {
    return true
  }

  return false
}

/** 连接密码弹窗是否显示「使用默认密钥」 */
export function sessionAllowsDefaultKeysFallback(session: Session): boolean {
  return (
    session.type === 'ssh' &&
    (session.authMethod === 'none' ||
      session.authMethod === undefined ||
      session.authConfig?.type === 'default-keys')
  )
}

/** 后端返回的错误是否属于 SSH 认证失败（应提示用户重新输入密码或换认证方式） */
export function isSshAuthFailureError(message: string): boolean {
  const m = message.trim()
  if (!m) return false
  const patterns = [
    /SSH 认证失败/,
    /密码认证失败/,
    /密码认证需要/,
    /密钥认证失败/,
    /密钥认证需要/,
    /无法读取私钥/,
    /无法解析私钥/,
    /私钥格式无效/,
    /默认密钥认证失败/,
    /未配置认证方式/,
    /Permission denied/i,
    /Authentication failed/i,
    /All configured authentication methods failed/i,
  ]
  return patterns.some(p => p.test(m))
}

/** 将用户刚输入的密码挂到会话对象（仅内存，供 registerProfileAuth / 连接） */
export function sessionWithRuntimePassword(session: Session, password: string): Session {
  return {
    ...session,
    authMethod: 'password',
    password: undefined,
    authConfig: { type: 'password-plain', plainPassword: password },
  }
}

export function resolveSessionForConnect(session: Session): Session {
  const pw = getRuntimePassword(session.id) ?? getStoredPassword(session.id)
  if (pw) return sessionWithRuntimePassword(session, pw)
  return session
}
