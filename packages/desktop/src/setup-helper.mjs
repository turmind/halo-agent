#!/usr/bin/env node
// Helper executed by the bundled node binary (NOT Electron) — it has
// matching ABI for better-sqlite3 etc. and full ESM support. The main
// process spawns it with the password on stdin so the password never
// shows up in `ps` listings.
//
// Argv: <command>
//   command = "init"          → seed ~/.halo/ from templates + jwt secret
//   command = "set-password"  → read password from stdin, hash + persist
//
// Resolves @turmind/halo-server modules from the bundled server-runtime so the
// helper has no deps of its own.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Try multiple candidate locations. We don't know if we're packaged or in
// dev — walk up looking for either layout.
function findServerRuntime() {
  const candidates = [
    // Packaged: .../Halo.app/Contents/Resources/server-runtime/
    ...walkUp(__dirname, 6).map((d) => path.join(d, 'server-runtime')),
    // Dev: packages/desktop/src/.. -> packages/desktop/.. -> packages/server
    path.resolve(__dirname, '..', '..', 'server'),
  ]
  for (const c of candidates) {
    if (tryStat(path.join(c, 'dist', 'init.js'))) return c
  }
  throw new Error(`server-runtime not found from ${__dirname}\ntried:\n  ${candidates.join('\n  ')}`)
}

function walkUp(start, depth) {
  const out = []
  let dir = start
  for (let i = 0; i < depth; i++) {
    out.push(dir)
    const next = path.dirname(dir)
    if (next === dir) break
    dir = next
  }
  return out
}

function tryStat(p) {
  try { return fs.statSync(p).isFile() } catch { return false }
}

const serverRuntimeRoot = findServerRuntime()

async function loadServerModule(rel) {
  return import(pathToFileURL(path.join(serverRuntimeRoot, rel)).href)
}

const cmd = process.argv[2]
// os.homedir() correctly resolves on Win (USERPROFILE) and unix (HOME).
const haloHome = path.join(os.homedir(), '.halo')

if (cmd === 'init') {
  const init = await loadServerModule('dist/init.js')
  const setupConfig = await loadServerModule('dist/setup-config.js')
  const passwordHash = await loadServerModule('dist/middleware/password-hash.js')
  init.ensureHaloHome(haloHome)
  if (!setupConfig.configLeafSet('server.jwt_secret')) {
    setupConfig.updateConfigLeaves({ 'server.jwt_secret': passwordHash.generateJwtSecret() })
  }
  console.log('ok')
  process.exit(0)
}

if (cmd === 'set-password') {
  const passwordHash = await loadServerModule('dist/middleware/password-hash.js')
  const setupConfig = await loadServerModule('dist/setup-config.js')
  const chunks = []
  process.stdin.on('data', (c) => chunks.push(c))
  process.stdin.on('end', async () => {
    const plain = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
    if (!plain || plain.length < 4) {
      console.error('password must be at least 4 chars')
      process.exit(2)
    }
    const hash = await passwordHash.hashPassword(plain)
    const updates = { 'server.password': hash }
    if (!setupConfig.configLeafSet('server.jwt_secret')) {
      updates['server.jwt_secret'] = passwordHash.generateJwtSecret()
    }
    setupConfig.updateConfigLeaves(updates)
    console.log('ok')
    process.exit(0)
  })
} else {
  console.error(`unknown command: ${cmd}`)
  process.exit(1)
}
