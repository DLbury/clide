/**
 * 在指定端口启动 Next.js dev server（由 tauri-dev.mjs 或 tauri.conf beforeDevCommand 调用）。
 * 用法: node scripts/start-next-dev.mjs [port]
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const port = process.argv[2] || process.env.CLIDE_DEV_PORT || '13800'
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const viewDir = path.join(root, 'view')
const require = createRequire(import.meta.url)

console.log(`[next-dev] http://localhost:${port}`)

function spawnNextDev() {
  try {
    require.resolve('next/package.json', { paths: [viewDir] })
    const nextBin = path.join(viewDir, 'node_modules', 'next', 'dist', 'bin', 'next')
    return spawn(process.execPath, [nextBin, 'dev', '-p', String(port)], {
      cwd: viewDir,
      stdio: 'inherit',
      env: { ...process.env, CLIDE_DEV_PORT: String(port) },
    })
  } catch {
    if (process.platform === 'win32') {
      return spawn('cmd.exe', ['/d', '/s', '/c', `npm run dev -- -p ${port}`], {
        cwd: viewDir,
        stdio: 'inherit',
        env: { ...process.env, CLIDE_DEV_PORT: String(port) },
      })
    }
    return spawn('npm', ['run', 'dev', '--', '-p', String(port)], {
      cwd: viewDir,
      stdio: 'inherit',
      env: { ...process.env, CLIDE_DEV_PORT: String(port) },
    })
  }
}

const child = spawnNextDev()
child.on('exit', code => process.exit(code ?? 0))
