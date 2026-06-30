/**
 * CI: import TAURI_SIGNING_PRIVATE_KEY into a temp file for tauri build.
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

function normalizeKeyText(raw) {
  let text = raw
  if (!text.includes('\n') && text.includes('\\n')) {
    text = text.replace(/\\n/g, '\n')
  }
  return text.trimEnd() + '\n'
}

if (!keyFromEnv) {
  disableUpdaterArtifacts('No TAURI_SIGNING_PRIVATE_KEY secret configured.')
  process.exit(0)
}

const keyText = normalizeKeyText(keyFromEnv)
if (!keyText.startsWith('untrusted comment:')) {
  disableUpdaterArtifacts(
    'Invalid TAURI_SIGNING_PRIVATE_KEY: must be the full minisign PRIVATE key file ' +
      "(first line starts with 'untrusted comment: minisign private key'). " +
      'Do not paste the public key from tauri.conf.json. ' +
      'Generate: CI=true npx tauri signer generate -w clide-updater.key'
  )
  process.exit(0)
}

if (keyText.includes('minisign public key')) {
  disableUpdaterArtifacts(
    'TAURI_SIGNING_PRIVATE_KEY looks like a PUBLIC key. Paste the private key file instead.'
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
