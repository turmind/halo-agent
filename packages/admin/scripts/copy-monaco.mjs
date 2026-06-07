#!/usr/bin/env node
/**
 * Copy Monaco's self-contained `min/vs` into the static export at out/monaco/vs.
 *
 * Why: @monaco-editor/react loads Monaco from a CDN (jsdelivr) by default. The
 * packaged desktop app runs offline, so the CDN fetch fails and the find widget
 * renders with broken codicon glyphs (the "garbled search box" bug). We instead
 * configure the loader to read from `/monaco/vs` (see code-editor.tsx) — served
 * by the in-app Hono server from out/ — so Monaco is fully local.
 *
 * The min build inlines the codicon font as a base64 data: URI inside
 * editor.main.css, so copying the directory is enough — no separate font step.
 *
 * Runs after `next build`. Both downstream consumers (desktop stage-runtime,
 * cli build-bundle) copy out/ wholesale, so they pick this up for free.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ADMIN_ROOT = path.resolve(__dirname, '..')

// Resolve the installed monaco-editor regardless of pnpm's nested store layout.
const require = createRequire(import.meta.url)
const monacoPkg = require.resolve('monaco-editor/package.json')
const VS_SRC = path.join(path.dirname(monacoPkg), 'min', 'vs')
const VS_DST = path.join(ADMIN_ROOT, 'out', 'monaco', 'vs')

if (!fs.existsSync(VS_SRC)) {
  console.error(`[copy-monaco] missing ${VS_SRC} — is monaco-editor installed?`)
  process.exit(1)
}
if (!fs.existsSync(path.join(ADMIN_ROOT, 'out'))) {
  console.error('[copy-monaco] out/ not found — run `next build` first')
  process.exit(1)
}

fs.rmSync(VS_DST, { recursive: true, force: true })
fs.cpSync(VS_SRC, VS_DST, { recursive: true })
console.log(`[copy-monaco] copied min/vs → out/monaco/vs`)
