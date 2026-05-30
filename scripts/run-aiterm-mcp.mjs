#!/usr/bin/env node
/** 自定位启动器：将 stdin/stdout 转发到 aiterm-mcp-stdio（全平台统一 pipe，避免 inherit 丢协议） */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Windows: Node 会把 `D:\work\...` 误解析为盘符 `D:`，argv 须用正斜杠绝对路径 */
function nodeMainArg(filePath) {
  return path.resolve(filePath).replace(/\\/g, '/')
}

const here = path.dirname(fileURLToPath(import.meta.url))
const script = nodeMainArg(path.join(here, 'aiterm-mcp-stdio.mjs'))
const root = path.resolve(path.join(here, '..'))

const child = spawn(process.execPath, [script], {
  stdio: ['pipe', 'pipe', 'inherit'],
  cwd: root,
  env: process.env,
  windowsHide: true,
})

process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)

for (const stream of [process.stdin, child.stdin, child.stdout, process.stdout]) {
  stream?.on('error', () => {})
}

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0))
})
child.on('error', err => {
  process.stderr.write(`[aiterm-mcp] 启动失败: ${err.message}\n`)
  process.exit(1)
})
