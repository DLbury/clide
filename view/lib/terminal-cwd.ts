/** 从终端输出解析当前工作目录（OSC 7 / PWD 提示） */
const OSC7_RE =
  /\x1b\]7;(?:file:\/\/[^/\x07\x1b]*)?([^\x07\x1b]+)(?:\x07|\x1b\\)/g

const PWD_PROMPT_RE = /(?:^|\n)(?:PWD|pwd)[:=]\s*(\S+)/g

export function isWindowsShellPath(path: string): boolean {
  return /^[A-Za-z]:\//.test(path.replace(/\\/g, '/'))
}

export function joinRemotePath(base: string, segment: string): string {
  const cleanBase = base.replace(/\/+$/, '') || '/'
  const cleanSeg = segment.replace(/^\/+/, '').replace(/\/+$/, '')
  if (!cleanSeg) return cleanBase || '/'
  if (cleanBase === '/') return `/${cleanSeg}`
  return `${cleanBase}/${cleanSeg}`
}

export type RemoteShellPlatform = 'windows' | 'unix'

export function usesWindowsShellCommands(
  sessionType?: string,
  remotePlatform?: RemoteShellPlatform
): boolean {
  return sessionType === 'local' || (sessionType === 'ssh' && remotePlatform === 'windows')
}

export function defaultRemoteHome(
  user?: string,
  remotePlatform?: RemoteShellPlatform
): string {
  if (remotePlatform === 'windows') {
    return user ? `C:/Users/${user}` : 'C:/Users'
  }
  return user ? `/home/${user}` : '~'
}

export function shellHomeDir(
  sessionType: string,
  options?: { user?: string; remotePath?: string; remotePlatform?: RemoteShellPlatform }
): string {
  if (sessionType === 'local') {
    return options?.remotePath?.replace(/\\/g, '/') ?? '~'
  }
  if (sessionType === 'ssh') {
    return defaultRemoteHome(options?.user, options?.remotePlatform)
  }
  return '~'
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b./g, '')
}

/** 解析终端输出片段中的 cwd（取最后一次 OSC7） */
export function extractCwdFromTerminalChunk(chunk: string): string | null {
  let last: string | null = null
  for (const match of chunk.matchAll(OSC7_RE)) {
    const raw = match[1]
    if (!raw) continue
    try {
      const decoded = decodeURIComponent(raw)
      last = normalizeRemoteCwd(decoded)
    } catch {
      last = normalizeRemoteCwd(raw)
    }
  }
  if (last) return last

  const pwdMatches = [...chunk.matchAll(PWD_PROMPT_RE)]
  if (pwdMatches.length > 0) {
    return normalizeRemoteCwd(pwdMatches[pwdMatches.length - 1][1])
  }
  return null
}

/** 从带标记的 pwd 探测输出中提取绝对路径 */
export function extractCwdFromProbeOutput(
  chunk: string,
  marker: string
): string | null {
  const plain = stripAnsi(chunk).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const start = plain.lastIndexOf(marker)
  if (start < 0) return null
  const afterStart = plain.slice(start + marker.length)
  const end = afterStart.indexOf(marker)
  const body = end >= 0 ? afterStart.slice(0, end) : afterStart
  const lines = body
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)

  for (const line of lines) {
    if (line === marker) continue
    if (line === 'pwd' || line === 'Get-Location' || /ProviderPath/i.test(line)) {
      continue
    }
    if (line.startsWith('/') || isWindowsShellPath(line)) {
      return normalizeRemoteCwd(line.replace(/\\/g, '/'))
    }
  }
  return null
}

/** 向 PTY 写入以探测当前 cwd 的命令（带唯一标记） */
export function formatShellPwdProbeCommand(
  marker: string,
  sessionType?: string,
  remotePlatform?: RemoteShellPlatform
): string {
  const safe = marker.replace(/'/g, "''")
  if (usesWindowsShellCommands(sessionType, remotePlatform)) {
    return (
      `Write-Output '${safe}'; ` +
      `(Get-Location).ProviderPath; ` +
      `Write-Output '${safe}'\n`
    )
  }
  const unixSafe = marker.replace(/'/g, `'\\''`)
  return `printf '%s\\n' '${unixSafe}'; pwd; printf '%s\\n' '${unixSafe}'\n`
}

function normalizeRemoteCwd(path: string): string {
  let p = path.trim()
  if (p.startsWith('file://')) {
    try {
      const url = new URL(p)
      p = url.pathname || '/'
    } catch {
      p = p.replace(/^file:\/\/[^/]*/, '') || '/'
    }
  }
  if (!p.startsWith('/')) return p
  return p.replace(/\/+$/, '') || '/'
}

/** 从用户输入的命令推断 cd 目标（单行） */
export function parseCdTargetFromCommand(
  command: string,
  currentCwd: string,
  homeDir: string
): string | null {
  const line = command
    .replace(/\x1b/g, '')
    .trim()
    .replace(/\r/g, '')
    .split('\n')[0]
    ?.trim()
  if (!line) return null

  const cdOnly = line.match(/^cd\s+(.+)$/)
  if (cdOnly) {
    return resolveCdOperand(cdOnly[1].trim(), currentCwd, homeDir)
  }

  const cdChain = line.match(/^cd\s+([^;&|]+)(?:\s*[;&|]|$)/)
  if (cdChain) {
    return resolveCdOperand(cdChain[1].trim(), currentCwd, homeDir)
  }

  if (/^cd\s*$/.test(line)) {
    return homeDir
  }

  return null
}

function resolveCdOperand(
  operand: string,
  currentCwd: string,
  homeDir: string
): string | null {
  let target = operand.replace(/^['"]|['"]$/g, '').trim()
  if (!target || target === '~') return homeDir
  if (target === '-') return null
  if (target.startsWith('~/')) {
    return joinRemotePath(homeDir, target.slice(2))
  }
  if (target.startsWith('/')) {
    return normalizeRemoteCwd(target)
  }
  if (isWindowsShellPath(target)) {
    return target.replace(/\\/g, '/')
  }
  if (isWindowsShellPath(currentCwd) || isWindowsShellPath(homeDir)) {
    const base = (currentCwd || homeDir).replace(/\\/g, '/')
    const seg = target.replace(/\\/g, '/')
    if (seg.includes(':')) return seg
    return joinRemotePath(base, seg)
  }
  return joinRemotePath(currentCwd || homeDir, target)
}

/** 累积 PTY 用户输入，在换行时返回完整一行（用于解析 cd） */
export function consumeTerminalInputLine(
  buffers: Map<string, string>,
  sessionId: string,
  data: string
): string | null {
  if (data === '\x03') {
    buffers.set(sessionId, '')
    return null
  }

  let line = buffers.get(sessionId) ?? ''

  for (const ch of data) {
    if (ch === '\r' || ch === '\n') {
      buffers.set(sessionId, '')
      return line
    }
    if (ch === '\x7f' || ch === '\b') {
      line = line.slice(0, -1)
      continue
    }
    if (ch === '\x1b') {
      line = ''
      continue
    }
    if (ch >= ' ' || ch === '\t') {
      line += ch
    }
  }

  buffers.set(sessionId, line)
  return null
}

/** 生成写入 PTY 的 cd 命令 */
export function formatShellCdCommand(
  cwd: string,
  sessionType?: string,
  remotePlatform?: RemoteShellPlatform
): string {
  const normalized = cwd.replace(/\\/g, '/')
  if (
    usesWindowsShellCommands(sessionType, remotePlatform) ||
    isWindowsShellPath(normalized)
  ) {
    const escaped = normalized.replace(/'/g, "''")
    return `Set-Location '${escaped}'\n`
  }
  const escaped = normalized.replace(/'/g, "'\\''")
  return `cd '${escaped}'\n`
}

/** 将远程绝对路径转为 loadRemoteFiles 可用的 path 参数 */
export function remotePathForListApi(absPath: string, user?: string): string {
  const normalized = absPath.replace(/\\/g, '/')
  if (/^[A-Za-z]:\//.test(normalized)) return normalized
  const home = defaultRemoteHome(user)
  if (absPath === home) return '~'
  if (user && absPath.startsWith(`/home/${user}/`)) {
    return `~/${absPath.slice(`/home/${user}/`.length)}`
  }
  return absPath
}
