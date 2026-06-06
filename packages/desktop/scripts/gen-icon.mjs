#!/usr/bin/env node
/**
 * Generate platform-specific app icons from packages/admin/src/app/icon.svg.
 *
 * Output:
 *   resources/icon.icns           — macOS .app/.dmg icon (when on macOS)
 *   resources/icon.ico            — Windows .exe icon (when png-to-ico installed)
 *   resources/icon.png            — 512x512 PNG (used by alert overlay etc.)
 *
 * The .icns step needs macOS-only `iconutil`. We skip it gracefully on other
 * hosts so a Windows / Linux dev can still produce icon.ico + icon.png.
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = path.resolve(__dirname, '..')
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '..', '..')
const SVG_SRC = path.join(REPO_ROOT, 'packages', 'admin', 'src', 'app', 'icon.svg')
const RES_DIR = path.join(DESKTOP_ROOT, 'resources')
const ICONSET = path.join(RES_DIR, 'Halo.iconset')

const SIZES = [
  ['icon_16x16.png',       16],
  ['icon_16x16@2x.png',    32],
  ['icon_32x32.png',       32],
  ['icon_32x32@2x.png',    64],
  ['icon_128x128.png',    128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png',    256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png',    512],
  ['icon_512x512@2x.png',1024],
]

if (!fs.existsSync(SVG_SRC)) {
  console.error(`[gen-icon] missing ${SVG_SRC}`)
  process.exit(1)
}

fs.mkdirSync(RES_DIR, { recursive: true })
fs.rmSync(ICONSET, { recursive: true, force: true })
fs.mkdirSync(ICONSET, { recursive: true })

const svgBuf = fs.readFileSync(SVG_SRC)

for (const [name, size] of SIZES) {
  await sharp(svgBuf, { density: 384 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(ICONSET, name))
}

// Render a generic 512 PNG too (for non-icns consumers like the alert overlay).
await sharp(svgBuf, { density: 384 })
  .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile(path.join(RES_DIR, 'icon.png'))

// .icns: macOS-only via iconutil. Skip on Win/Linux — electron-builder
// only needs it when actually building a Mac app.
if (process.platform === 'darwin') {
  console.log('[gen-icon] running iconutil')
  execSync(`iconutil -c icns "${ICONSET}" -o "${path.join(RES_DIR, 'icon.icns')}"`, { stdio: 'inherit' })
}

// .ico: render a 256x256 PNG (largest size Win uses for shell + taskbar)
// and assemble into a multi-resolution .ico via png-to-ico. Several sizes
// help Win pick crisp variants from quick-launch (16) to splash (256).
{
  const icoSizes = [16, 32, 48, 64, 128, 256]
  const icoPngs = []
  for (const sz of icoSizes) {
    const out = path.join(ICONSET, `ico_${sz}.png`)
    await sharp(svgBuf, { density: 384 })
      .resize(sz, sz, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(out)
    icoPngs.push(out)
  }
  try {
    const { default: pngToIco } = await import('png-to-ico')
    const buf = await pngToIco(icoPngs)
    fs.writeFileSync(path.join(RES_DIR, 'icon.ico'), buf)
    console.log('[gen-icon] wrote icon.ico')
  } catch (err) {
    console.warn(`[gen-icon] skipped icon.ico (png-to-ico not available): ${err && err.message || err}`)
  }
}

fs.rmSync(ICONSET, { recursive: true, force: true })

console.log('[gen-icon] done')
const wroteIcns = fs.existsSync(path.join(RES_DIR, 'icon.icns'))
const wroteIco = fs.existsSync(path.join(RES_DIR, 'icon.ico'))
if (wroteIcns) console.log(`  ${path.join(RES_DIR, 'icon.icns')}`)
if (wroteIco)  console.log(`  ${path.join(RES_DIR, 'icon.ico')}`)
console.log(`  ${path.join(RES_DIR, 'icon.png')}`)
