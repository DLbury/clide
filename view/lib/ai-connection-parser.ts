/**
 * AI connection intent parser — extracts server connection parameters from natural language.
 */

import type { Session } from './types'

export interface ConnectionIntent {
  type: Session['type']
  name?: string
  host?: string
  port?: number
  user?: string
  authMethod?: Session['authMethod']
  serialPort?: string
  baudRate?: number
  confidence: 'high' | 'medium' | 'low'
  missingFields: string[]
}

const IP_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/
const HOST_PATTERN = /\b([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)\b/
const PORT_PATTERN = /(?:端口|port)\s*[:：]?\s*(\d{1,5})/i
const USER_PATTERN = /(?:用户|username|user)\s*[:：]?\s*([a-zA-Z0-9_.-]+)/i

function detectConnectionType(message: string): Session['type'] {
  const lower = message.toLowerCase()
  if (/telnet|交换机|路由器/.test(lower)) return 'telnet'
  if (/串口|serial|com\d|ttyusb|ttyacm/.test(lower)) return 'serial'
  if (/docker|容器/.test(lower)) return 'docker'
  if (/wsl|子系统/.test(lower)) return 'wsl'
  if (/vnc|远程桌面/.test(lower) && !/rdp|windows/.test(lower)) return 'vnc'
  if (/rdp|远程桌面|windows/.test(lower)) return 'rdp'
  if (/本地|local/.test(lower)) return 'local'
  return 'ssh'
}

function extractHost(message: string): string | undefined {
  const ipMatch = message.match(IP_PATTERN)
  if (ipMatch) return ipMatch[0]

  const hostMatch = message.match(HOST_PATTERN)
  if (hostMatch && !hostMatch[1].includes('example')) {
    return hostMatch[1]
  }

  const connectMatch = message.match(/(?:连接|connect(?: to)?|登录|login)\s+([^\s,，。]+)/i)
  if (connectMatch) {
    const candidate = connectMatch[1].replace(/[。.!！?？]$/, '')
    if (candidate.length > 1) return candidate
  }

  return undefined
}

function extractPort(message: string, type: Session['type']): number | undefined {
  const portMatch = message.match(PORT_PATTERN)
  if (portMatch) return parseInt(portMatch[1])

  const defaults: Partial<Record<Session['type'], number>> = {
    ssh: 22,
    telnet: 23,
    vnc: 5900,
    rdp: 3389,
  }
  return defaults[type]
}

function extractUser(message: string): string | undefined {
  const userMatch = message.match(USER_PATTERN)
  if (userMatch) return userMatch[1]

  const atMatch = message.match(/([a-zA-Z0-9_.-]+)@/)
  if (atMatch) return atMatch[1]

  return undefined
}

export function parseConnectionIntent(message: string): ConnectionIntent {
  const type = detectConnectionType(message)
  const host = extractHost(message)
  const port = extractPort(message, type)
  const user = extractUser(message)

  const missingFields: string[] = []
  if (type === 'serial') {
    if (!/com\d|tty|\/dev\//i.test(message)) {
      missingFields.push('serialPort')
    }
  } else if (type !== 'local') {
    if (!host) missingFields.push('host')
  }

  if (type === 'ssh' && !user) {
    missingFields.push('user')
  }

  let confidence: ConnectionIntent['confidence'] = 'high'
  if (missingFields.length > 0) confidence = 'medium'
  if (!host && type !== 'local' && type !== 'serial') confidence = 'low'

  const serialMatch = message.match(/(?:com\d+|\/dev\/tty\w+)/i)

  return {
    type,
    name: host ? `${type.toUpperCase()} - ${host}` : undefined,
    host: type === 'serial' ? serialMatch?.[0] : host,
    port,
    user: user ?? (type === 'ssh' ? 'root' : undefined),
    authMethod: /密钥|key|公钥/.test(message) ? 'key' : 'password',
    serialPort: serialMatch?.[0],
    baudRate: /115200/.test(message) ? 115200 : 9600,
    confidence,
    missingFields,
  }
}

export interface AiConnectionResponse {
  content: string
  connectionIntent?: ConnectionIntent
  action?: 'connect' | 'list_sessions' | 'new_session' | 'help'
  sessionId?: string
}

export function generateConnectionResponse(
  message: string,
  availableSessions: { id: string; name: string; host: string; type: string; status: string }[]
): AiConnectionResponse {
  const lower = message.toLowerCase()

  if (/帮助|help|怎么用|如何使用/.test(lower)) {
    return {
      content: `我可以帮你连接服务器。你可以这样说：

• "连接到 192.168.1.100"
• "SSH 登录 dev@staging.example.com 端口 2222"
• "连接本地终端"
• "列出所有服务器"
• "连接 Dev Server"（使用已有会话）

也可以点击左侧服务器列表直接连接。`,
      action: 'help',
    }
  }

  if (/列出|显示|有哪些|所有.*服务器|会话列表/.test(lower)) {
    if (availableSessions.length === 0) {
      return {
        content: '当前没有保存的服务器会话。你可以说 "连接到 192.168.1.100" 来创建新连接，或点击左侧 + 按钮手动添加。',
        action: 'list_sessions',
      }
    }

    const list = availableSessions
      .map(s => `• ${s.name} (${s.type.toUpperCase()} → ${s.host}) [${s.status === 'connected' ? '已连接' : '未连接'}]`)
      .join('\n')

    return {
      content: `已保存的服务器会话：\n\n${list}\n\n说 "连接 [会话名称]" 即可快速连接。`,
      action: 'list_sessions',
    }
  }

  const sessionMatch = availableSessions.find(s =>
    lower.includes(s.name.toLowerCase()) ||
    lower.includes(s.host.toLowerCase())
  )

  if (/连接|登录|connect|打开/.test(lower) && sessionMatch && !parseConnectionIntent(message).host) {
    return {
      content: `好的，正在连接到 **${sessionMatch.name}** (${sessionMatch.host})...`,
      action: 'connect',
      sessionId: sessionMatch.id,
    }
  }

  const intent = parseConnectionIntent(message)

  if (intent.type === 'local' || /本地/i.test(lower)) {
    return {
      content: '正在打开本地终端...',
      action: 'connect',
      connectionIntent: { ...intent, type: 'local', host: 'localhost', confidence: 'high', missingFields: [] },
    }
  }

  if (intent.missingFields.includes('host')) {
    return {
      content: `我理解你想建立 ${intent.type.toUpperCase()} 连接。请提供主机地址，例如：

• "连接到 192.168.1.100"
• "SSH 登录 staging.example.com，用户 dev"`,
      connectionIntent: intent,
    }
  }

  if (intent.missingFields.includes('user') && intent.type === 'ssh') {
    return {
      content: `已识别主机 **${intent.host}**（${intent.type.toUpperCase()}，端口 ${intent.port}）。请提供用户名，例如 "用户 root" 或 "dev@${intent.host}"。`,
      connectionIntent: intent,
    }
  }

  const authHint = intent.authMethod === 'key' ? '，使用密钥认证' : ''
  return {
    content: `准备连接：

• 类型: ${intent.type.toUpperCase()}
• 主机: ${intent.host}${intent.port ? `:${intent.port}` : ''}
• 用户: ${intent.user ?? '（无需）'}${authHint}

点击下方按钮确认连接，或在消息中补充更多信息。`,
    connectionIntent: intent,
    action: 'connect',
  }
}

export function intentToSessionData(intent: ConnectionIntent): Omit<import('./types').Session, 'id' | 'status' | 'lastActive'> {
  const base = {
    name: intent.name ?? `${intent.type}-${intent.host ?? 'session'}`,
    host: intent.host ?? 'localhost',
    type: intent.type,
  }

  switch (intent.type) {
    case 'ssh':
      return {
        ...base,
        port: intent.port ?? 22,
        user: intent.user ?? 'root',
        authMethod: intent.authMethod ?? 'password',
      }
    case 'telnet':
      return {
        ...base,
        port: intent.port ?? 23,
        user: intent.user,
      }
    case 'serial':
      return {
        ...base,
        host: intent.serialPort ?? '/dev/ttyUSB0',
        serialPort: intent.serialPort ?? '/dev/ttyUSB0',
        baudRate: intent.baudRate ?? 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
      }
    case 'vnc':
    case 'rdp':
      return {
        ...base,
        port: intent.port,
        user: intent.user,
      }
    default:
      return base
  }
}
