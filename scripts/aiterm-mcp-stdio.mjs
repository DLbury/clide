#!/usr/bin/env node
/**
 * Claude Code 项目级 MCP（stdio）→ 转发到 AITerm 桌面版 IDE WebSocket 桥接。
 * 需先启动 AITerm 并开启 Claude Code 桥接（绿点已连接）。
 */
import fs from 'fs'
import path from 'path'
import os from 'os'
import readline from 'readline'

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_NAME = 'aiterm'

function log(msg) {
  process.stderr.write(`[aiterm-mcp] ${msg}\n`)
}

function findBridge() {
  const envPort = process.env.AITERM_IDE_PORT
  const envToken = process.env.AITERM_IDE_AUTH_TOKEN
  if (envPort && envToken) {
    return { port: Number(envPort), authToken: envToken }
  }

  const ideDir = path.join(os.homedir(), '.claude', 'ide')
  if (!fs.existsSync(ideDir)) {
    throw new Error('未找到 ~/.claude/ide，请先启动 clide 并开启 Claude Code 桥接')
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
      '未找到 clide IDE 桥接 lock 文件。请先启动 clide 并确认 AI 侧栏桥接已连接（绿点）。'
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
  const { port, authToken } = findBridge()
  log(`桥接 ws://127.0.0.1:${port}`)

  const rpc = createWsRpc(port, authToken)
  let upstreamTools = []

  try {
    upstreamTools = await bootstrapUpstream(rpc)
    log(`已加载 ${upstreamTools.length} 个工具`)
  } catch (e) {
    log(`上游连接失败: ${e.message}`)
    process.exit(1)
  }

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
        return
      }

      if (method === 'notifications/initialized') {
        return
      }

      if (method === 'tools/list') {
        reply(id, { tools: upstreamTools })
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
        const result = await rpc.request('tools/call', params)
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
    rpc.close()
    process.exit(0)
  })
}

main().catch(e => {
  log(e.message)
  process.exit(1)
})
