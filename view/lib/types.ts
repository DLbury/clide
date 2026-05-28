export interface Session {
  id: string
  name: string
  host: string
  type: 'ssh' | 'telnet' | 'serial' | 'local' | 'docker' | 'wsl' | 'vnc' | 'rdp'
  status: 'connected' | 'disconnected' | 'connecting'
  lastActive: Date
  port?: number
  user?: string
  // SSH specific
  authMethod?: 'password' | 'key' | 'none' | 'ssh-agent' | 'env-var' | 'keychain'
  password?: string
  privateKeyPath?: string
  // 新认证方式配置
  authConfig?: AuthConfig
  // Serial specific
  baudRate?: number
  dataBits?: number
  stopBits?: number
  parity?: 'none' | 'odd' | 'even'
  serialPort?: string
}

/** 认证配置接口 */
export interface AuthConfig {
  /** 认证类型 */
  type: 'password-env' | 'password-keychain' | 'password-plain' | 'key-env' | 'key-path' | 'ssh-agent' | 'default-keys'
  /** 环境变量名（用于 password-env 和 key-env） */
  envVar?: string
  /** Keychain/Credential 目标名称 */
  keychainTarget?: string
  /** Keychain/Credential 账户名 */
  keychainAccount?: string
  /** 明文密码（不推荐） */
  plainPassword?: string
  /** 密钥路径 */
  keyPath?: string
}

export interface FileItem {
  id: string
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  modified?: Date
  permissions?: string
  owner?: string
  isExpanded?: boolean
  children?: FileItem[]
}

export interface OpenFile {
  id: string
  path: string
  name: string
  content: string
  language: string
  isModified: boolean
}

export interface TerminalTab {
  id: string
  sessionId: string
  title: string
  isActive: boolean
  history: TerminalLine[]
  viewMode: 'terminal' | 'sftp' | 'editor'
}

export interface TerminalLine {
  id: string
  type: 'input' | 'output' | 'error' | 'ai-response' | 'system' | 'ai-action'
  content: string
  timestamp: Date
  isAiSuggestion?: boolean
}

import type { ConnectionIntent } from './ai-connection-parser'

export interface ChatToolPart {
  id: string
  name: string
  input?: unknown
  output?: string
  error?: string
  status: 'pending' | 'running' | 'completed' | 'error'
}

export interface ChatTaskPart {
  id: string
  title: string
  description?: string
  status: 'pending' | 'completed'
}

export type ChatMessagePart =
  | { kind: 'reasoning'; content: string }
  | { kind: 'text'; content: string }
  | { kind: 'tool'; toolId: string }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  /** 时间线渲染：按流式事件顺序插入文本/思考/工具 */
  parts?: ChatMessagePart[]
  /** 思考 / reasoning 过程 */
  reasoning?: string
  /** 工具调用明细 */
  tools?: ChatToolPart[]
  /** 任务队列（由工具步骤派生） */
  tasks?: ChatTaskPart[]
  command?: string // AI 建议执行的命令
  connectionIntent?: ConnectionIntent
  sessionId?: string
}

export interface AIAssistant {
  isEnabled: boolean
  isThinking: boolean
  lastSuggestion?: string
}

export interface SessionFolder {
  id: string
  name: string
  sessions: Session[]
  isExpanded: boolean
}

/** 新建/编辑会话表单提交 */
export interface SessionFormPayload {
  session: Omit<Session, 'id' | 'status' | 'lastActive'>
  folderId: string
}
