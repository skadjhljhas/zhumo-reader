import { chromium } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// User decision: retain the original 朱 character artwork. All generated sizes use this
// canonical bitmap, so an old exploratory SVG cannot silently become the app icon again.
const original = await readFile(resolve('resources/icon-original.png'))
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const pngs = new Map()
const style =
  '<style>html,body{margin:0;background:transparent}img{display:block;width:100vw;height:100vh}</style>'
try {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 1024 },
    deviceScaleFactor: 1
  })
  await page.setContent(
    style + '<img src="data:image/png;base64,' + original.toString('base64') + '">'
  )
  await page.locator('img').evaluate((img) => img.decode())
  for (const size of [16, 20, 24, 32, 40, 48, 64, 128, 256, 512, 1024]) {
    await page.setViewportSize({ width: size, height: size })
    pngs.set(size, await page.screenshot({ omitBackground: true }))
  }
} finally {
  await browser.close()
}
await mkdir('work/icon', { recursive: true })
for (const [size, bytes] of pngs) await writeFile(`work/icon/${size}.png`, bytes)
await writeFile('resources/icon.png', original)
await writeFile('build/icon.png', original)
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const header = Buffer.alloc(6 + sizes.length * 16)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
let offset = header.length
sizes.forEach((size, i) => {
  const start = 6 + i * 16,
    png = pngs.get(size)
  header[start] = size === 256 ? 0 : size
  header[start + 1] = header[start]
  header.writeUInt16LE(1, start + 4)
  header.writeUInt16LE(32, start + 6)
  header.writeUInt32LE(png.length, start + 8)
  header.writeUInt32LE(offset, start + 12)
  offset += png.length
})
await writeFile('build/icon.ico', Buffer.concat([header, ...sizes.map((size) => pngs.get(size))]))
const chunks = [
  [16, 'icp4'],
  [32, 'icp5'],
  [64, 'icp6'],
  [128, 'ic07'],
  [256, 'ic08'],
  [512, 'ic09'],
  [1024, 'ic10']
].map(([size, type]) => {
  const bytes = pngs.get(size),
    header = Buffer.alloc(8)
  header.write(type)
  header.writeUInt32BE(bytes.length + 8, 4)
  return Buffer.concat([header, bytes])
})
const icns = Buffer.alloc(8)
icns.write('icns')
icns.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4)
await writeFile('build/icon.icns', Buffer.concat([icns, ...chunks]))
console.log('Original 朱 character artwork rendered at 11 sizes; PNG, ICO and ICNS generated.')
