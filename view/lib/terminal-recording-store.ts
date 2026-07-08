type CastStream = 'o' | 'i'

type CastEvent =
  | { kind: 'stream'; at: number; stream: CastStream; data: string }
  | { kind: 'resize'; at: number; width: number; height: number }

interface RecordingState {
  active: boolean
  startedAt: number
  width: number
  height: number
  events: CastEvent[]
}

const recordings = new Map<string, RecordingState>()
const listeners = new Set<() => void>()

function notify() {
  listeners.forEach(fn => {
    try {
      fn()
    } catch {
      /* ignore */
    }
  })
}

export function subscribeTerminalRecording(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function isTerminalRecording(sessionId: string): boolean {
  return recordings.get(sessionId)?.active ?? false
}

export function hasTerminalRecordingData(sessionId: string): boolean {
  return (recordings.get(sessionId)?.events.length ?? 0) > 0
}

export function startTerminalRecording(
  sessionId: string,
  width: number,
  height: number
): void {
  recordings.set(sessionId, {
    active: true,
    startedAt: Date.now(),
    width: Math.max(width, 1),
    height: Math.max(height, 1),
    events: [],
  })
  notify()
}

export function stopTerminalRecording(sessionId: string): void {
  const rec = recordings.get(sessionId)
  if (!rec) return
  rec.active = false
  notify()
}

export function clearTerminalRecording(sessionId: string): void {
  if (recordings.delete(sessionId)) notify()
}

export function updateTerminalRecordingSize(
  sessionId: string,
  width: number,
  height: number
): void {
  const rec = recordings.get(sessionId)
  if (!rec) return
  const w = Math.max(width, 1)
  const h = Math.max(height, 1)
  if (rec.active && (rec.width !== w || rec.height !== h)) {
    rec.events.push({
      kind: 'resize',
      at: Date.now(),
      width: w,
      height: h,
    })
  }
  rec.width = w
  rec.height = h
}

export function getTerminalRecordingEventCount(sessionId: string): number {
  return recordings.get(sessionId)?.events.length ?? 0
}

export function appendTerminalRecordingEvent(
  sessionId: string,
  stream: CastStream,
  data: string
): void {
  if (!data) return
  const rec = recordings.get(sessionId)
  if (!rec?.active) return
  rec.events.push({
    kind: 'stream',
    at: Date.now(),
    stream,
    data,
  })
}

export function exportTerminalCast(sessionId: string, title?: string): string | null {
  const rec = recordings.get(sessionId)
  if (!rec || rec.events.length === 0) return null

  const header = {
    version: 2,
    width: rec.width,
    height: rec.height,
    timestamp: Math.floor(rec.startedAt / 1000),
    ...(title ? { title } : {}),
    env: { TERM: 'xterm-256color', SHELL: '/bin/bash' },
  }

  const lines: string[] = [JSON.stringify(header)]
  for (const event of rec.events) {
    const rel = (event.at - rec.startedAt) / 1000
    if (event.kind === 'resize') {
      lines.push(JSON.stringify([rel, 'r', `${event.width}x${event.height}`]))
    } else {
      lines.push(JSON.stringify([rel, event.stream, event.data]))
    }
  }
  return `${lines.join('\n')}\n`
}

export function downloadTerminalCast(sessionId: string, title?: string): boolean {
  const cast = exportTerminalCast(sessionId, title)
  if (!cast) return false
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `terminal-${sessionId.replace(/::/g, '-')}-${stamp}.cast`
  const blob = new Blob([cast], { type: 'application/x-asciicast+json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
  return true
}
