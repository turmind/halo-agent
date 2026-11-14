import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { buildBackendBwrapArgs, initBwrapCheck, getSandboxBackend } from '../src/tools/sandbox.js'

/**
 * Write isolation of extension backends (extensions/backend.ts under bwrap,
 * Linux only): the backend writes its data dir, the socket dir and a private
 * /tmp; every other path is read-only (EROFS) and nothing it tries outside
 * reaches the host. Everything here lives in one temp dir under /var/tmp,
 * used as HOME: the scratch HOME of setup-home.ts sits under /tmp, which the
 * sandbox replaces with its own tmpfs, so writes there would not show what
 * they do to a real HOME. Skipped where bwrap can't run (macOS, Windows, CI
 * without user namespaces) — the argv test still runs there.
 */

describe('buildBackendBwrapArgs', () => {
  it('read-only root, private /tmp, extension dir re-bound read-only, writable dirs after both', () => {
    const args = buildBackendBwrapArgs(['/d/data', '/tmp/halo-ext-1'], '/tmp/exts/vi')
    expect(args.slice(0, 8)).toEqual(['--ro-bind', '/', '/', '--tmpfs', '/tmp', '--ro-bind', '/tmp/exts/vi', '/tmp/exts/vi'])
    expect(args.join(' ')).toContain('--bind /d/data /d/data --bind /tmp/halo-ext-1 /tmp/halo-ext-1')
    expect(args.join(' ')).toContain('--setenv TMPDIR /tmp --chdir /tmp/exts/vi --die-with-parent')
    expect(args).not.toContain('--clearenv')
  })
})

const bwrap = process.platform === 'linux' && await initBwrapCheck() && getSandboxBackend() === 'bwrap'

/** Tries each write on request and reports `ok` / the error code. */
const PROBE_SRC = `
const http = require('node:http'), fs = require('node:fs'), os = require('node:os')
const probes = JSON.parse(process.env.PROBES)
http.createServer((req, res) => {
  const out = {}
  for (const [k, p] of Object.entries(probes)) { try { fs.writeFileSync(p === 'TMP' ? os.tmpdir() + '/probe.txt' : p, 'x'); out[k] = 'ok' } catch (e) { out[k] = e.code } }
  out.ownDir = (() => { try { fs.writeFileSync(process.env.HALO_EXT_DATA_DIR + '/models.part', 'x'); return 'ok' } catch (e) { return e.code } })()
  out.tmpdir = os.tmpdir()
  res.end(JSON.stringify(out))
}).listen(process.env.HALO_EXT_SOCKET, () => process.send({ type: 'ready' }))
process.on('SIGTERM', () => { fs.writeFileSync(process.env.HALO_EXT_DATA_DIR + '/sigterm', String(process.pid)); process.exit(0) })
`

const PROBE_EXT = { id: 'probe', name: 'probe', version: '1.0.0', extensions: [], entry: 'index.html', priority: 'default', capabilities: [], bundle: false, installedAt: 1, backend: { entry: 'backend/main.cjs' } } as never

describe.skipIf(!bwrap)('extension backend under bwrap', () => {
  let home: string
  let root: string
  let outside: string
  const prevHome = process.env.HOME
  let backends: ReturnType<typeof import('../src/extensions/backend.js').createExtensionBackends>

  beforeAll(async () => {
    const { createExtensionBackends } = await import('../src/extensions/backend.js')
    const { confirmExtensionBackend } = await import('../src/extensions/state.js')
    home = fs.mkdtempSync('/var/tmp/halo-ext-sbx-')
    process.env.HOME = home
    root = path.join(home, '.halo', 'global', 'extensions')
    outside = fs.mkdtempSync(path.join(home, 'outside-'))
    fs.mkdirSync(path.join(root, 'probe', 'backend'), { recursive: true })
    fs.writeFileSync(path.join(root, 'probe', 'backend', 'main.cjs'), PROBE_SRC)
    confirmExtensionBackend('probe')
    backends = createExtensionBackends({ extensionDir: (id) => path.join(root, id), lookup: (id) => (id === 'probe' ? PROBE_EXT : undefined) })
  })

  afterAll(async () => {
    await backends.close()
    process.env.HOME = prevHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('writes its data dir and a private /tmp; the extension dir, HOME and other dirs are read-only', async () => {
    const hostTmp = path.join('/tmp', `ext-sbx-probe-${process.pid}.txt`)
    process.env.PROBES = JSON.stringify({
      extDir: path.join(root, 'probe', 'x.txt'),
      home: path.join(os.homedir(), 'x.txt'),
      outside: path.join(outside, 'x.txt'),
      halo: path.join(os.homedir(), '.halo', 'global', 'x.txt'),
      tmp: hostTmp,
      tmpdir: 'TMP',
    })
    const b = await backends.acquire(PROBE_EXT)
    delete process.env.PROBES
    const out = await new Promise<Record<string, string>>((resolve, reject) => {
      http.get({ socketPath: b.socket, path: '/' }, (res) => {
        let body = ''
        res.on('data', (d) => { body += d })
        res.on('end', () => resolve(JSON.parse(body)))
      }).on('error', reject)
    })
    backends.release(b)
    expect(out).toEqual({ extDir: 'EROFS', home: 'EROFS', outside: 'EROFS', halo: 'EROFS', tmp: 'ok', tmpdir: '/tmp', ownDir: 'ok' })
    // Nothing reached the host except the data dir write.
    expect(fs.existsSync(path.join(outside, 'x.txt'))).toBe(false)
    expect(fs.existsSync(hostTmp)).toBe(false)
    expect(fs.readFileSync(path.join(os.homedir(), '.halo', 'global', 'extension-data', 'probe', 'models.part'), 'utf-8')).toBe('x')
  })

  it('stopping it reaches the backend itself (graceful SIGTERM, not bwrap\'s SIGKILL) and leaves no process behind', async () => {
    const pids = backends.list().map((b) => b.pid!)
    expect(pids).toHaveLength(1)
    await backends.close()
    const marker = path.join(home, '.halo', 'global', 'extension-data', 'probe', 'sigterm')
    expect(fs.existsSync(marker)).toBe(true)
    const nodePid = Number(fs.readFileSync(marker, 'utf-8'))
    expect(nodePid).not.toBe(pids[0]) // bwrap's pid vs the node it runs
    await new Promise((r) => setTimeout(r, 200))
    for (const pid of [...pids, nodePid]) expect(() => process.kill(pid, 0)).toThrow()
  })
})
