/**
 * Generate NSIS installer sidebar/header BMPs from the app logo.
 * Run: node scripts/generate-nsis-images.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const logo = path.join(root, 'view/public/icon-rounded.png')
const outDir = path.join(root, 'src-tauri/icons/nsis')
const tmpDir = path.join(outDir, '.tmp')

if (!fs.existsSync(logo)) {
  console.error(`Logo not found: ${logo}`)
  process.exit(1)
}

fs.mkdirSync(outDir, { recursive: true })
fs.mkdirSync(tmpDir, { recursive: true })

async function writeSizedPng(name, width, height) {
  const out = path.join(tmpDir, `${name}.png`)
  await sharp(logo)
    .resize(width, height, { fit: 'cover', position: 'centre', background: { r: 255, g: 255, b: 255 } })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .png()
    .toFile(out)
  return out
}

function pngToBmp(pngPath, bmpPath) {
  const ps = `
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile('${pngPath.replace(/'/g, "''")}')
$img.Save('${bmpPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Bmp)
$img.Dispose()
`
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout)
    process.exit(1)
  }
}

const specs = [
  ['installer-sidebar', 164, 314],
  ['installer-header', 150, 57],
  ['uninstaller-header', 150, 57],
]

for (const [name, w, h] of specs) {
  const png = await writeSizedPng(name, w, h)
  const bmp = path.join(outDir, `${name}.bmp`)
  pngToBmp(png, bmp)
  console.log(`Wrote ${bmp}`)
}

fs.rmSync(tmpDir, { recursive: true, force: true })
