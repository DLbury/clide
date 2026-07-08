const STORAGE_KEY = 'aiterm-command-history-v1'
const MAX_ENTRIES = 1000

type CommandHistoryStore = Record<string, string[]>

function readStore(): CommandHistoryStore {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as CommandHistoryStore
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeStore(store: CommandHistoryStore): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    /* ignore */
  }
}

/** sessionId = terminal PTY id (profile::shell) */
export function getCommandHistory(sessionId: string): string[] {
  const list = readStore()[sessionId]
  return Array.isArray(list) ? list : []
}

export function appendCommandHistory(sessionId: string, command: string): void {
  const trimmed = command.trim()
  if (!trimmed || trimmed.length > 4096) return
  const store = readStore()
  const prev = store[sessionId] ?? []
  if (prev[prev.length - 1] === trimmed) return
  const next = [...prev.filter(c => c !== trimmed), trimmed].slice(-MAX_ENTRIES)
  store[sessionId] = next
  writeStore(store)
}

export function clearCommandHistory(sessionId: string): void {
  const store = readStore()
  delete store[sessionId]
  writeStore(store)
}

/** 解析 xterm onData 流，提取 Enter 提交的行（近似，不含完整行编辑） */
export class CommandLineTracker {
  private buffer = ''

  feed(data: string): string | null {
    let submitted: string | null = null
    for (const char of data) {
      if (char === '\r' || char === '\n') {
        submitted = this.buffer.trim()
        this.buffer = ''
      } else if (char === '\x7f' || char === '\b') {
        this.buffer = this.buffer.slice(0, -1)
      } else if (char === '\x03') {
        this.buffer = ''
      } else if (char === '\x1b') {
        /* escape sequence — 不追加 */
      } else if (char >= ' ' || char === '\t') {
        this.buffer += char
      }
    }
    return submitted || null
  }

  reset(): void {
    this.buffer = ''
  }

  currentLine(): string {
    return this.buffer
  }
}
