/**
 * One-off: set GitHub Actions secret (requires GITHUB_TOKEN with repo scope).
 * Usage: GITHUB_TOKEN=... node scripts/set-github-signing-secret.mjs [key-file]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sodium = require('tweetsodium')

const token = process.env.GITHUB_TOKEN
if (!token) {
  console.error('GITHUB_TOKEN is required')
  process.exit(1)
}

const repo = process.env.GITHUB_REPO ?? 'DLbury/clide'
const secretName = process.env.SECRET_NAME ?? 'TAURI_SIGNING_PRIVATE_KEY'
const defaultKey = path.join(os.homedir(), '.tauri', 'clide-updater-ci.key')
const keyFile = process.argv[2] ?? defaultKey

if (!fs.existsSync(keyFile)) {
  console.error(`Key file not found: ${keyFile}`)
  process.exit(1)
}

const secretValue = fs.readFileSync(keyFile, 'utf8').trim()
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
}

const pkRes = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/public-key`, {
  headers,
})
if (!pkRes.ok) {
  console.error('Failed to fetch public key:', await pkRes.text())
  process.exit(1)
}
const { key, key_id } = await pkRes.json()

const messageBytes = Buffer.from(secretValue)
const keyBytes = Buffer.from(key, 'base64')
const encryptedBytes = sodium.seal(messageBytes, keyBytes)
const encrypted = Buffer.from(encryptedBytes).toString('base64')

const putRes = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/${secretName}`, {
  method: 'PUT',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ encrypted_value: encrypted, key_id }),
})

if (!putRes.ok) {
  console.error(`Failed to set ${secretName}:`, await putRes.text())
  process.exit(1)
}

console.log(`Set ${secretName} for ${repo} from ${keyFile}`)

// Remove password secret if present (passwordless CI key)
const delRes = await fetch(
  `https://api.github.com/repos/${repo}/actions/secrets/TAURI_SIGNING_PRIVATE_KEY_PASSWORD`,
  { method: 'DELETE', headers }
)
if (delRes.status === 204) {
  console.log('Removed TAURI_SIGNING_PRIVATE_KEY_PASSWORD (not needed for CI key)')
} else if (delRes.status === 404) {
  console.log('TAURI_SIGNING_PRIVATE_KEY_PASSWORD was not set')
}
