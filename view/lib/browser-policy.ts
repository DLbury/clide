const INTERNAL_DOMAIN_SUFFIXES = [
  '.local',
  '.internal',
  '.intranet',
  '.lan',
  '.corp',
  '.home',
  '.private',
  '.localdomain',
  '.localhost',
] as const

export const BROWSER_POLICY_HINT =
  '浏览器仅允许访问内网地址和内网域名（私有 IP、localhost、无点短名、*.local / *.internal / *.lan 等）'

function isCgnatV4(a: number, b: number): boolean {
  return a === 100 && (b & 0xc0) === 64
}

function parseIpv4(host: string): number[] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const octets = m.slice(1).map(n => Number.parseInt(n, 10))
  if (octets.some(n => n > 255)) return null
  return octets
}

function isInternalIpv4(octets: number[]): boolean {
  const [a, b] = octets
  if (a === 10) return true
  if (a === 127) return true
  if (a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (isCgnatV4(a, b)) return true
  return false
}

function isInternalIpv6Host(host: string): boolean | null {
  if (!host.includes(':')) return null
  const lower = host.toLowerCase()
  if (lower === '::1' || lower === '::') return true
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true
  if (lower.startsWith('fe80')) return true
  return false
}

export function isInternalBrowserHost(host: string): boolean {
  const trimmed = host.trim().replace(/\.$/, '')
  if (!trimmed) return false

  const bare =
    trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed

  const ipv4 = parseIpv4(bare)
  if (ipv4) return isInternalIpv4(ipv4)

  const ipv6 = isInternalIpv6Host(bare)
  if (ipv6 !== null) return ipv6

  const lower = bare.toLowerCase()
  if (lower === 'localhost') return true

  if (!lower.includes('.')) return true

  return INTERNAL_DOMAIN_SUFFIXES.some(
    suffix => lower.endsWith(suffix) || lower === suffix.slice(1)
  )
}

export function assertInternalBrowserUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('URL 无效')
  }
  const scheme = parsed.protocol.replace(':', '').toLowerCase()
  if (scheme !== 'http' && scheme !== 'https') {
    throw new Error('浏览器仅支持 http/https 协议')
  }
  if (!parsed.hostname) {
    throw new Error('URL 缺少主机名')
  }
  if (!isInternalBrowserHost(parsed.hostname)) {
    throw new Error(`${BROWSER_POLICY_HINT}，禁止访问: ${parsed.hostname}`)
  }
}

export function assertInternalBrowserHost(host: string): void {
  if (!isInternalBrowserHost(host)) {
    throw new Error(`${BROWSER_POLICY_HINT}，禁止访问: ${host}`)
  }
}
