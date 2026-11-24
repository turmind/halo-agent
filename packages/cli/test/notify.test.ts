import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { execFile } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

/**
 * `halo notify`: flags / env fallback, the client-side size check, the token
 * file, and one line per failure. Runs src/index.ts in a child process (temp
 * HOME, no setup — notify skips the setup gate) against a local http stub
 * standing in for the server's POST /api/notify.
 */

const CLI_ROOT = path.resolve(import.meta.dirname, '..')
let home: string
let stub: http.Server
let url: string
let reply: { status: number; body: unknown } = { status: 200, body: { ok: true, state: 'running' } }
const seen: Array<{ auth: string | undefined; body: unknown }> = []

function runHalo(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const base = { ...process.env, HOME: home, USERPROFILE: home }
    delete base.HALO_WORKSPACE
    delete base.HALO_SESSION_ID
    delete base.HALO_NOTIFY_TOKEN
    delete base.HALO_NOTIFY_URL
    execFile(process.execPath, ['--import', 'tsx', 'src/index.ts', 'notify', ...args],
      { cwd: CLI_ROOT, timeout: 20_000, env: { ...base, ...env } },
      (err, _stdout, stderr) => resolve({ code: err ? Number((err as { code?: unknown }).code ?? 1) : 0, stderr }))
  })
}
const tokenFile = () => path.join(home, '.halo', 'secrets', 'notify.json')
function writeToken(u = url, token = 'tok'): void {
  fs.mkdirSync(path.dirname(tokenFile()), { recursive: true })
  fs.writeFileSync(tokenFile(), JSON.stringify({ url: u, token }))
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-cli-notify-'))
  stub = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, body: req.url === '/api/notify' ? JSON.parse(raw) : null })
      res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body))
    })
  })
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise((r) => stub.close(r))
  fs.rmSync(home, { recursive: true, force: true })
})
beforeEach(() => {
  seen.length = 0
  reply = { status: 200, body: { ok: true, state: 'running' } }
  fs.rmSync(path.join(home, '.halo'), { recursive: true, force: true })
})

describe('halo notify', () => {
  it('flags: posts { workspace (absolute), session, text } with the token, exit 0', async () => {
    writeToken()
    const r = await runHalo(['--workspace', '.', '-s', 'root>sub', 'build', 'done'])
    expect(r).toEqual({ code: 0, stderr: '' })
    expect(seen).toEqual([{ auth: 'Bearer tok', body: { workspace: CLI_ROOT, session: 'root>sub', text: 'build done' } }])
  })

  it('no flags: $HALO_WORKSPACE / $HALO_SESSION_ID; a flag wins over its variable', async () => {
    writeToken()
    expect((await runHalo(['hi'], { HALO_WORKSPACE: '/w', HALO_SESSION_ID: 's1' })).code).toBe(0)
    expect((await runHalo(['--session', 's2', 'hi'], { HALO_WORKSPACE: '/w', HALO_SESSION_ID: 's1' })).code).toBe(0)
    expect(seen.map((s) => s.body)).toEqual([{ workspace: '/w', session: 's1', text: 'hi' }, { workspace: '/w', session: 's2', text: 'hi' }])
  })

  it.each(['missing', 'malformed', 'different'])('env credentials win over a %s token file, including explicit target overrides', async (file) => {
    if (file !== 'missing') writeToken('http://127.0.0.1:1', 'file-token')
    if (file === 'malformed') fs.writeFileSync(tokenFile(), '{')
    const env = { HALO_WORKSPACE: '/own', HALO_SESSION_ID: 'own', HALO_NOTIFY_URL: url, HALO_NOTIFY_TOKEN: 'session-token' }
    expect(await runHalo(['-w', '/other', '-s', 'other', 'hi'], env)).toEqual({ code: 0, stderr: '' })
    expect(seen).toEqual([{ auth: 'Bearer session-token', body: { workspace: '/other', session: 'other', text: 'hi', source: { workspace: '/own', session: 'own' } } }])
  })

  it.each(['HALO_NOTIFY_URL', 'HALO_NOTIFY_TOKEN'])('only %s is set: still reads the token file', async (key) => {
    writeToken()
    expect((await runHalo(['-w', '/w', '-s', 's1', 'hi'], { [key]: 'unused' })).code).toBe(0)
    expect(seen[0].auth).toBe('Bearer tok')
  })

  it.each([
    ['no text', ['-w', '/w', '-s', 's1'], {}, 'no text'],
    ['no workspace', ['hi'], { HALO_SESSION_ID: 's1' }, 'no workspace — pass --workspace or set $HALO_WORKSPACE'],
    ['no session', ['hi'], { HALO_WORKSPACE: '/w' }, 'no session — pass --session or set $HALO_SESSION_ID'],
    ['text over 8192 bytes', ['-w', '/w', '-s', 's1', 'é'.repeat(4097)], {}, 'text is 8194 bytes; the limit is 8192'],
  ])('%s: exit 1, one line, nothing sent', async (_n, args, env, msg) => {
    writeToken()
    const r = await runHalo(args, env)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(msg)
    expect(r.stderr.trim().split('\n')).toHaveLength(1)
    expect(seen).toEqual([])
  })

  it('no token file: says the server is not running', async () => {
    const r = await runHalo(['-w', '/w', '-s', 's1', 'hi'])
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/no Halo server found .*notify\.json missing.*halo server start/)
  })

  it('a stale token file (nothing listening): says the server is not running', async () => {
    const dead = http.createServer()
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r))
    const deadUrl = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`
    await new Promise((r) => dead.close(r))
    writeToken(deadUrl)
    const r = await runHalo(['-w', '/w', '-s', 's1', 'hi'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(`Halo server not running (nothing listening at ${deadUrl})`)
  })

  it('401: authentication failed', async () => {
    writeToken()
    reply = { status: 401, body: { error: 'unauthorized' } }
    const r = await runHalo(['-w', '/w', '-s', 's1', 'hi'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('authentication failed')
  })

  it.each([[403, 'this token can only wake its own session'], [404, 'session not found: s1'], [413, 'text is 9000 bytes; the limit is 8192'], [503, 'server is shutting down']])('%i: the server\'s reason, exit 1', async (status, error) => {
    writeToken()
    reply = { status, body: { error } }
    const r = await runHalo(['-w', '/w', '-s', 's1', 'hi'])
    expect(r).toEqual({ code: 1, stderr: `halo notify: ${error}\n` })
  })

  it('--help prints its own page', async () => {
    const r = await runHalo(['--help'])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('Usage: halo notify')
  })
})
