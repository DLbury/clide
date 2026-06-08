/**
 * 开发模式入口：探测可用端口，同步 devUrl 与 Next.js -p，再启动 tauri dev。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_PORT = 13800
const MAX_PORT = 13810

function isPortFree(port) {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

async function findPort(start, end) {
  for (let port = start; port <= end; port++) {
    if (await isPortFree(port)) return port
  }
  throw new Error(`端口 ${start}-${end} 均被占用，请先释放或扩大扫描范围`)
}

const port = await findPort(DEFAULT_PORT, MAX_PORT)
const devUrl = `http://localhost:${port}`

if (port !== DEFAULT_PORT) {
  console.log(
    `[tauri-dev] 端口 ${DEFAULT_PORT} 已占用，切换到 ${port}（devUrl 与 Next.js 已同步）`
  )
} else {
  console.log(`[tauri-dev] 使用端口 ${port}`)
}

// beforeDevCommand 的 cwd 是项目根目录（非 src-tauri），勿用 ../scripts
const beforeDevCommand = `node scripts/start-next-dev.mjs ${port}`

// Windows 命令行内联 JSON 会丢引号，写入临时配置文件再传给 --config
const configPath = path.join(root, '.tauri-dev.config.json')
fs.writeFileSync(
  configPath,
  JSON.stringify(
    {
      build: {
        devUrl,
        beforeDevCommand,
      },
    },
    null,
    2
  )
)

// Windows 上 spawn npx.cmd 会 EINVAL，直接 node 调用 @tauri-apps/cli
const tauriCli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
if (!fs.existsSync(tauriCli)) {
  console.error('[tauri-dev] 未找到 Tauri CLI，请先运行 npm install')
  process.exit(1)
}

const child = spawn(
  process.execPath,
  [tauriCli, 'dev', '--config', configPath],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, CLIDE_DEV_PORT: String(port) },
  }
)

child.on('exit', code => process.exit(code ?? 0))
