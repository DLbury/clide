/** 从终端输出解析当前工作目录（OSC 7 / PWD 提示） */
const OSC7_RE =
  /\x1b\]7;(?:file:\/\/[^/\x07\x1b]*)?([^\x07\x1b]+)(?:\x07|\x1b\\)/g

const PWD_PROMPT_RE = /(?:^|\n)(?:PWD|pwd)[:=]\s*(\/[^\s\r\n]+)/g

export function joinRemotePath(base: string, segment: string): string {
  const cleanBase = base.replace(/\/+$/, '') || '/'
  const cleanSeg = segment.replace(/^\/+/, '').replace(/\/+$/, '')
  if (!cleanSeg) return cleanBase || '/'
  if (cleanBase === '/') return `/${cleanSeg}`
  return `${cleanBase}/${cleanSeg}`
}

export function defaultRemoteHome(user?: string): string {
  return user ? `/home/${user}` : '~'
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
    return pwdMatches[pwdMatches.length - 1][1]
  }
  return null
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
  return joinRemotePath(currentCwd || homeDir, target)
}

/** 将远程绝对路径转为 loadRemoteFiles 可用的 path 参数 */
export function remotePathForListApi(absPath: string, user?: string): string {
  const home = defaultRemoteHome(user)
  if (absPath === home) return '~'
  if (user && absPath.startsWith(`/home/${user}/`)) {
    return `~/${absPath.slice(`/home/${user}/`.length)}`
  }
  return absPath
}
