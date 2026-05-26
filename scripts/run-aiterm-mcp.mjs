#!/usr/bin/env node
/** 自定位启动器：不依赖 ${CLAUDE_PROJECT_DIR}，供 .mcp.json 或 claude mcp add 使用 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(here, 'aiterm-mcp-stdio.mjs')
const root = path.join(here, '..')

const child = spawn(process.execPath, [script], {
  stdio: 'inherit',
  cwd: root,
  env: process.env,
})

child.on('exit', code => process.exit(code ?? 0))
child.on('error', err => {
  process.stderr.write(`[aiterm-mcp] 启动失败: ${err.message}\n`)
  process.exit(1)
})
