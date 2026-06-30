/**
 * CI: import TAURI_SIGNING_PRIVATE_KEY into a temp file for tauri build.
 * Supports plain minisign text, rsign encrypted keys, and base64-wrapped key files.
 * Falls back to disabling updater artifacts when the secret is missing or invalid.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const confPath = path.join('src-tauri', 'tauri.conf.json')
const keyFromEnv = process.env.SIGNING_KEY?.trim() ?? ''
const passwordFromEnv = process.env.SIGNING_PASSWORD?.trim() ?? ''
const githubEnv = process.env.GITHUB_ENV

function appendGithubEnv(line) {
  if (!githubEnv) return
  fs.appendFileSync(githubEnv, `${line}\n`)
}

function disableUpdaterArtifacts(reason) {
  console.warn(reason)
  console.warn('Disabling bundle.createUpdaterArtifacts for this build.')
  const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'))
  conf.bundle.createUpdaterArtifacts = false
  fs.writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`)
}

function decodeKeyInput(raw) {
  let text = raw
  if (!text.includes('\n') && text.includes('\\n')) {
    text = text.replace(/\\n/g, '\n')
  }

  if (!text.startsWith('untrusted comment:')) {
    const compact = text.replace(/\s+/g, '')
    try {
      const decoded = Buffer.from(compact, 'base64').toString('utf8')
      if (decoded.startsWith('untrusted comment:')) {
        console.log('Decoded base64-wrapped signing key.')
        text = decoded
      }
    } catch {
      /* not base64 */
    }
  }

  return text.trimEnd() + '\n'
}

function isPrivateSigningKey(text) {
  if (!text.startsWith('untrusted comment:')) return false
  if (text.includes('minisign public key')) return false
  return (
    text.includes('minisign private key') ||
    text.includes('rsign encrypted secret key')
  )
}

if (!keyFromEnv) {
  disableUpdaterArtifacts('No TAURI_SIGNING_PRIVATE_KEY secret configured.')
  process.exit(0)
}

const keyText = decodeKeyInput(keyFromEnv)
if (!isPrivateSigningKey(keyText)) {
  disableUpdaterArtifacts(
    'Invalid TAURI_SIGNING_PRIVATE_KEY: must be the updater PRIVATE key file ' +
      "(plain text or base64 of 'untrusted comment: ... secret key'). " +
      'Do not paste the public key from tauri.conf.json. ' +
      'Generate: CI=true npx tauri signer generate -w clide-updater.key'
  )
  process.exit(0)
}

const keyFile = path.join(os.tmpdir(), 'tauri-signing.key')
fs.writeFileSync(keyFile, keyText, { mode: 0o600 })
console.log(`Updater signing key written to ${keyFile}`)

appendGithubEnv(`TAURI_SIGNING_PRIVATE_KEY=${keyFile}`)
if (passwordFromEnv) {
  appendGithubEnv(`TAURI_SIGNING_PRIVATE_KEY_PASSWORD=${passwordFromEnv}`)
}
