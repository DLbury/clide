/**
 * CI: prepare TAURI_SIGNING_PRIVATE_KEY for tauri build.
 * Tauri expects the private key as base64 (same as `tauri signer generate` output file).
 * Falls back to disabling updater artifacts when the secret is missing or invalid.
 */
import fs from 'node:fs'
import path from 'node:path'

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

function isPrivateSigningKeyText(text) {
  if (!text.startsWith('untrusted comment:')) return false
  if (text.includes('minisign public key')) return false
  return (
    text.includes('minisign private key') ||
    text.includes('rsign encrypted secret key')
  )
}

/** Tauri bundler reads base64-encoded key material (not decoded minisign text). */
function normalizeKeyToBase64(raw) {
  let text = raw.trim()
  if (!text.includes('\n') && text.includes('\\n')) {
    text = text.replace(/\\n/g, '\n')
  }

  if (text.startsWith('untrusted comment:')) {
    if (!isPrivateSigningKeyText(text)) return null
    return Buffer.from(`${text.trimEnd()}\n`, 'utf8').toString('base64')
  }

  const compact = text.replace(/\s+/g, '')
  try {
    const decoded = Buffer.from(compact, 'base64').toString('utf8')
    if (isPrivateSigningKeyText(decoded)) {
      return compact
    }
  } catch {
    /* not base64 */
  }

  return null
}

if (!keyFromEnv) {
  disableUpdaterArtifacts('No TAURI_SIGNING_PRIVATE_KEY secret configured.')
  process.exit(0)
}

const keyBase64 = normalizeKeyToBase64(keyFromEnv)
if (!keyBase64) {
  disableUpdaterArtifacts(
    'Invalid TAURI_SIGNING_PRIVATE_KEY: must be the updater PRIVATE key ' +
      '(base64 file from `tauri signer generate`, or plain minisign private key text). ' +
      'Do not paste the public key from tauri.conf.json.'
  )
  process.exit(0)
}

// Tauri expects TAURI_SIGNING_PRIVATE_KEY to contain the base64 key content directly,
// not a file path. Write the base64 content to the env var.
console.log(`Updater signing key prepared (base64, ${keyBase64.length} chars)`)

appendGithubEnv(`TAURI_SIGNING_PRIVATE_KEY=${keyBase64}`)
if (passwordFromEnv) {
  appendGithubEnv(`TAURI_SIGNING_PRIVATE_KEY_PASSWORD=${passwordFromEnv}`)
}
