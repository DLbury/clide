import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const root = process.cwd()
const src = path.resolve(root, 'icon.jpg')
const outTauri = path.resolve(root, 'src-tauri/icons')
const outWeb = path.resolve(root, 'view/public')

if (!fs.existsSync(src)) {
  throw new Error(`icon source not found: ${src}`)
}

fs.mkdirSync(outTauri, { recursive: true })
fs.mkdirSync(outWeb, { recursive: true })

const roundMask = (size, radius) =>
  Buffer.from(
    `<svg width="${size}" height="${size}"><rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}"/></svg>`
  )

const sizes = [32, 128, 256]

for (const s of sizes) {
  const buf = await sharp(src)
    .resize(s, s, { fit: 'cover' })
    .composite([{ input: roundMask(s, Math.round(s * 0.22)), blend: 'dest-in' }])
    .png()
    .toBuffer()
  fs.writeFileSync(path.join(outTauri, `${s}x${s}.png`), buf)
}

const buf2x = await sharp(src)
  .resize(256, 256, { fit: 'cover' })
  .composite([{ input: roundMask(256, 56), blend: 'dest-in' }])
  .png()
  .toBuffer()
fs.writeFileSync(path.join(outTauri, '128x128@2x.png'), buf2x)

const ico = await pngToIco(
  sizes.map(s => fs.readFileSync(path.join(outTauri, `${s}x${s}.png`)))
)
fs.writeFileSync(path.join(outTauri, 'icon.ico'), ico)

const webRounded = await sharp(src)
  .resize(180, 180, { fit: 'cover' })
  .composite([{ input: roundMask(180, 40), blend: 'dest-in' }])
  .png()
  .toBuffer()
fs.writeFileSync(path.join(outWeb, 'icon-rounded.png'), webRounded)

console.log('rounded icons generated')
