#!/usr/bin/env node
/**
 * CI 用 npm ci：提高 fetch 重试，失败时清理 node_modules 后重试。
 * 缓解 Windows runner 上 EPERM / ECONNRESET 导致的安装失败。
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'

const ATTEMPTS = 3
const WAIT_MS = 20_000

for (const [key, value] of [
  ['fetch-retries', '5'],
  ['fetch-retry-mintimeout', '20000'],
  ['fetch-retry-maxtimeout', '120000'],
]) {
  execSync(`npm config set ${key} ${value}`, { stdio: 'inherit' })
}

function rmDir(dir) {
  if (!fs.existsSync(dir)) return
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main() {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`Retry ${attempt}/${ATTEMPTS}: cleaning node_modules...`)
        rmDir('node_modules')
        rmDir('view/node_modules')
      }
      execSync('npm ci --no-audit --no-fund', { stdio: 'inherit' })
      execSync('npm ci --prefix view --no-audit --no-fund', { stdio: 'inherit' })
      return
    } catch {
      console.error(`npm ci failed (attempt ${attempt}/${ATTEMPTS})`)
      if (attempt >= ATTEMPTS) process.exit(1)
      await sleep(WAIT_MS)
    }
  }
}

main()
