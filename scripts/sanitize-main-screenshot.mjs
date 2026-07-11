import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const root = process.cwd()
const input = process.argv[2]

if (!input) {
  console.error('Usage: node scripts/sanitize-main-screenshot.mjs <source-screenshot.png>')
  process.exit(1)
}

const source = path.resolve(input)
const base = sharp(source)
const meta = await base.metadata()
if (!meta.width || !meta.height) {
  throw new Error(`Cannot read image metadata: ${source}`)
}

function svgText(text, x, y, options = {}) {
  const {
    size = 13,
    color = '#a1a1aa',
    weight = 500,
    family = 'Arial, sans-serif',
  } = options
  return `<text x="${x}" y="${y}" fill="${color}" font-size="${size}" font-weight="${weight}" font-family="${family}">${escapeXml(text)}</text>`
}

function redact(x, y, width, height, label, options = {}) {
  const fill = options.fill ?? '#050807'
  const stroke = options.stroke ?? 'none'
  const rx = options.rx ?? 5
  const textX = options.textX ?? x + 7
  const textY = options.textY ?? y + Math.min(height - 6, 17)
  const color = options.color ?? '#8f9b96'
  const size = options.size ?? 12
  const family = options.family ?? 'Arial, sans-serif'
  return `
    <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" fill="${fill}" stroke="${stroke}"/>
    ${label ? svgText(label, textX, textY, { color, size, family }) : ''}
  `
}

function escapeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const overlay = `
<svg width="${meta.width}" height="${meta.height}" viewBox="0 0 ${meta.width} ${meta.height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="50" y="281" width="128" height="198" rx="6" fill="#020504"/>
  <rect x="50" y="281" width="126" height="40" rx="5" fill="#020504"/>
  ${svgText('dev-node', 58, 299, { color: '#f6fff9', size: 13, weight: 700 })}
  ${svgText('dev@localhost', 58, 316, { color: '#8f9b96', size: 12 })}
  <rect x="50" y="334" width="126" height="40" rx="5" fill="#020504"/>
  ${svgText('server-a', 58, 352, { color: '#f6fff9', size: 13, weight: 700 })}
  ${svgText('ops@server-a', 58, 369, { color: '#8f9b96', size: 12 })}
  <rect x="50" y="386" width="126" height="40" rx="5" fill="#020504"/>
  ${svgText('server-b', 58, 404, { color: '#f6fff9', size: 13, weight: 700 })}
  ${svgText('ubuntu@server-b', 58, 421, { color: '#8f9b96', size: 12 })}
  <rect x="50" y="438" width="126" height="40" rx="5" fill="#020504"/>
  ${svgText('server-c', 58, 456, { color: '#f6fff9', size: 13, weight: 700 })}
  ${svgText('root@server-c', 58, 473, { color: '#8f9b96', size: 12 })}
  ${redact(54, 494, 140, 20, 'root@server-d')}
  ${redact(0, 877, 192, 22, 'root@server-d', { fill: '#020504', textX: 30, textY: 893, color: '#d7ede3', size: 12 })}
  ${redact(160, 45, 44, 18, 'prod', { fill: '#121212', textX: 160, textY: 59, color: '#f6fff9', size: 13 })}

  ${redact(528, 112, 220, 28, 'root@prod-server:~#', { fill: '#202020', textX: 529, textY: 128, color: '#00ff9c', size: 13, family: 'Consolas, monospace' })}
  ${redact(642, 288, 112, 20, '10.0.0.24', { fill: '#202020', textX: 643, textY: 302, color: '#00ff9c', size: 13, family: 'Consolas, monospace' })}
  ${redact(877, 306, 154, 18, '10.0.0.24', { fill: '#202020', textX: 878, textY: 319, color: '#00ff9c', size: 13, family: 'Consolas, monospace' })}
  ${redact(528, 706, 380, 20, 'Welcome to Linux compute instance !', { fill: '#202020', textX: 529, textY: 720, color: '#00ff9c', size: 13, family: 'Consolas, monospace' })}
  ${redact(758, 742, 176, 20, '10.0.0.7', { fill: '#202020', textX: 759, textY: 756, color: '#00ff9c', size: 13, family: 'Consolas, monospace' })}
  ${redact(528, 758, 222, 22, 'root@prod-server:~#', { fill: '#202020', textX: 529, textY: 772, color: '#00ff9c', size: 13, family: 'Consolas, monospace' })}

  <rect x="24" y="473" width="224" height="47" rx="7" fill="#06251a" opacity=".88"/>
  ${svgText('server-d', 55, 491, { color: '#f6fff9', size: 14, weight: 700 })}
  ${svgText('root@server-d', 55, 511, { color: '#8f9b96', size: 12 })}

  <rect x="526" y="104" width="702" height="676" rx="0" fill="none" stroke="#34d399" stroke-opacity=".08"/>
  <rect x="1228" y="72" width="1" height="804" fill="#262a2c"/>
</svg>
`

const sanitized = await base
  .composite([{ input: Buffer.from(overlay), top: 0, left: 0 }])
  .png({ compressionLevel: 9 })
  .toBuffer()

await writeFile(path.join(root, 'docs/assets/main-screen-redacted.png'), sanitized)

const heroWidth = 1536
const heroHeight = 1024
const screenshot = await sharp(sanitized)
  .resize({ width: 1416, height: 820, fit: 'contain', withoutEnlargement: false })
  .png()
  .toBuffer()

const heroSvg = `
<svg width="${heroWidth}" height="${heroHeight}" viewBox="0 0 ${heroWidth} ${heroHeight}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="50%" cy="0%" r="90%">
      <stop offset="0%" stop-color="#0e5f43" stop-opacity=".42"/>
      <stop offset="52%" stop-color="#07100d" stop-opacity=".76"/>
      <stop offset="100%" stop-color="#050606"/>
    </radialGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="32" stdDeviation="28" flood-color="#000000" flood-opacity=".62"/>
    </filter>
    <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
      <path d="M32 0H0V32" fill="none" stroke="#ffffff" stroke-opacity=".035"/>
    </pattern>
  </defs>
  <rect width="1536" height="1024" fill="#050606"/>
  <rect width="1536" height="1024" fill="url(#glow)"/>
  <rect width="1536" height="1024" fill="url(#grid)"/>
  <text x="76" y="92" fill="#71f09e" font-size="64" font-weight="800" font-family="Arial, sans-serif">Clide</text>
  <text x="76" y="132" fill="#edf8f2" font-size="28" font-weight="700" font-family="Arial, sans-serif">Secure AI SSH terminal with real production UI</text>
  <text x="76" y="166" fill="#aeb9b4" font-size="20" font-family="Arial, sans-serif">Sensitive hosts, usernames, and IP addresses are redacted for public sharing.</text>
  <g transform="translate(60 186)" filter="url(#shadow)">
    <rect x="0" y="0" width="1416" height="820" rx="22" fill="#0a0d0e" stroke="#283336"/>
  </g>
</svg>
`

const hero = await sharp(Buffer.from(heroSvg))
  .composite([{ input: screenshot, top: 186, left: 60 }])
  .png({ compressionLevel: 9 })
  .toBuffer()

await Promise.all([
  writeFile(path.join(root, 'landing/assets/hero.png'), hero),
  writeFile(path.join(root, 'docs/assets/readme-hero.png'), hero),
])

console.log('Generated redacted screenshots:')
console.log('- docs/assets/main-screen-redacted.png')
console.log('- landing/assets/hero.png')
console.log('- docs/assets/readme-hero.png')
