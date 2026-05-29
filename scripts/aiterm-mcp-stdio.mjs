#!/usr/bin/env node
/**
 * Claude Code 项目级 MCP（stdio）→ 转发到 AITerm 桌面版 IDE WebSocket 桥接。
 * 桥接未就绪时保持进程存活并周期性重试，避免 Claude 会话里完全没有 aiterm 工具。
 */
import fs from 'fs'
import path from 'path'
import os from 'os'
import readline from 'readline'

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_NAME = 'aiterm'
const RETRY_MS = 2500

function log(msg) {
  process.stderr.write(`[aiterm-mcp] ${msg}\n`)
}

function notifyToolsChanged() {
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n'
  )
}

function findBridge() {
  const envPort = process.env.AITERM_IDE_PORT
  const envToken = process.env.AITERM_IDE_AUTH_TOKEN
  if (envPort && envToken) {
    return { port: Number(envPort), authToken: envToken }
  }

  const ideDir = path.join(os.homedir(), '.claude', 'ide')
  if (!fs.existsSync(ideDir)) {
    throw new Error('未找到 ~/.claude/ide，请先启动 AITerm 并开启 Claude Code 桥接')
  }

  const locks = fs
    .readdirSync(ideDir)
    .filter(f => f.endsWith('.lock'))
    .map(f => {
      const full = path.join(ideDir, f)
      try {
        const data = JSON.parse(fs.readFileSync(full, 'utf8'))
        return { file: f, mtime: fs.statSync(full).mtimeMs, data }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .filter(
      x =>
        (x.data.ideName === 'clide' ||
          x.data.ideName === 'AI Terminal' ||
          x.data.ideName === 'AITerm') &&
        x.data.transport === 'ws'
    )

  if (locks.length === 0) {
    throw new Error(
      '未找到 AITerm IDE 桥接 lock 文件。请先启动 AITerm 并确认 AI 侧栏桥接已就绪。'
    )
  }

  locks.sort((a, b) => b.mtime - a.mtime)
  const best = locks[0]
  const port = Number(String(best.file).replace(/\.lock$/, ''))
  const authToken = best.data.authToken
  if (!port || !authToken) {
    throw new Error('AITerm lock 文件缺少 port 或 authToken')
  }
  return { port, authToken }
}

function createWsRpc(port, authToken) {
  let ws
  let nextId = 1
  const pending = new Map()

  const connect = () =>
    new Promise((resolve, reject) => {
      ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { 'x-claude-code-ide-authorization': authToken },
      })

      const timeout = setTimeout(() => reject(new Error('连接 AITerm 桥接超时')), 8000)

      ws.addEventListener('open', () => {
        clearTimeout(timeout)
        resolve()
      })
      ws.addEventListener('error', () => {
        clearTimeout(timeout)
        reject(new Error(`无法连接 AITerm IDE 桥接 ws://127.0.0.1:${port}`))
      })
      ws.addEventListener('message', ev => {
        let msg
        try {
          msg = JSON.parse(String(ev.data))
        } catch {
          return
        }
        if (msg.id !== undefined && msg.id !== null) {
          const handler = pending.get(msg.id)
          if (handler) {
            pending.delete(msg.id)
            handler(msg)
          }
        }
      })
    })

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, msg => {
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)))
        else resolve(msg.result)
      })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }))
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`AITerm 桥接请求超时: ${method}`))
        }
      }, 120000)
    })

  const notify = (method, params) => {
    ws.send(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }))
  }

  return { connect, request, notify, close: () => ws?.close() }
}

async function bootstrapUpstream(rpc) {
  await rpc.connect()
  await rpc.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'aiterm-mcp-stdio', version: '0.1.0' },
  })
  rpc.notify('notifications/initialized', {})
  const list = await rpc.request('tools/list', {})
  return list?.tools ?? []
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function replyError(id, code, message) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'
  )
}

async function main() {
  let rpc = null
  let upstreamTools = []
  let connecting = false
  let lastToolCount = 0
  let upstreamKey = ''

  async function ensureUpstream(forceReconnect = false) {
    if (connecting) return upstreamTools
    connecting = true
    try {
      const { port, authToken } = findBridge()
      const key = `${port}:${authToken}`

      if (
        !forceReconnect &&
        rpc &&
        upstreamKey === key &&
        upstreamTools.length > 0
      ) {
        return upstreamTools
      }

      if (!rpc || forceReconnect || upstreamKey !== key) {
        if (rpc) {
          rpc.close()
          rpc = null
        }
        log(`桥接 ws://127.0.0.1:${port}`)
        const nextRpc = createWsRpc(port, authToken)
        const tools = await bootstrapUpstream(nextRpc)
        rpc = nextRpc
        upstreamKey = key
        upstreamTools = tools
      } else if (!upstreamTools.length) {
        const tools = await rpc.request('tools/list', {})
        upstreamTools = tools?.tools ?? []
      }

      if (upstreamTools.length !== lastToolCount) {
        lastToolCount = upstreamTools.length
        log(`已加载 ${upstreamTools.length} 个工具`)
        if (upstreamTools.length > 0) notifyToolsChanged()
      }
    } catch (e) {
      if (rpc) {
        rpc.close()
        rpc = null
      }
      upstreamKey = ''
      if (upstreamTools.length > 0) {
        upstreamTools = []
        lastToolCount = 0
        notifyToolsChanged()
      }
      log(`上游未就绪（${RETRY_MS}ms 后重试）: ${e.message}`)
    } finally {
      connecting = false
    }
    return upstreamTools
  }

  const retryTimer = setInterval(() => {
    // 仅在未连通/无工具时重试，避免运行中工具调用被重连打断。
    if (!rpc || upstreamTools.length === 0) {
      void ensureUpstream()
    }
  }, RETRY_MS)
  void ensureUpstream()

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

  rl.on('line', async line => {
    if (!line.trim()) return
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }

    const { id, method, params } = msg

    try {
      if (method === 'initialize') {
        reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: SERVER_NAME, version: '0.1.0' },
        })
        void ensureUpstream()
        return
      }

      if (method === 'notifications/initialized') {
        void ensureUpstream()
        return
      }

      if (method === 'tools/list') {
        // 如果正在连接且当前无工具，等待连接完成（最多 10s）
        if (connecting && upstreamTools.length === 0) {
          let waited = 0
          while (connecting && upstreamTools.length === 0 && waited < 10000) {
            await new Promise(r => setTimeout(r, 100))
            waited += 100
          }
        }
        const tools = await ensureUpstream()
        reply(id, { tools })
        return
      }

      if (method === 'prompts/list') {
        reply(id, { prompts: [] })
        return
      }

      if (method === 'resources/list') {
        reply(id, { resources: [] })
        return
      }

      if (method === 'tools/call') {
        const tools = await ensureUpstream()
        if (!rpc || tools.length === 0) {
          replyError(
            id,
            -32603,
            'AITerm IDE 桥接未就绪，无法执行工具。请确认应用已启动且侧栏显示 IDE 桥接已就绪。'
          )
          return
        }
        let result
        try {
          result = await rpc.request('tools/call', params)
        } catch {
          // 上游连接偶发失效时强制重连并重试一次。
          const refreshed = await ensureUpstream(true)
          if (!rpc || refreshed.length === 0) {
            throw new Error('AITerm IDE 桥接暂不可用，请重试')
          }
          result = await rpc.request('tools/call', params)
        }
        reply(id, result)
        return
      }

      if (id !== undefined) {
        replyError(id, -32601, `Method not found: ${method}`)
      }
    } catch (e) {
      if (id !== undefined) {
        replyError(id, -32603, e.message || String(e))
      }
    }
  })

  rl.on('close', () => {
    clearInterval(retryTimer)
    rpc?.close()
    process.exit(0)
  })
}

main().catch(e => {
  log(e.message)
  process.exit(1)
})
