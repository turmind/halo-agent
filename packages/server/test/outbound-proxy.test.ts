import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import net, { type AddressInfo, type Socket } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { cleanChildEnv } from '../src/child-env.js'
import { outboundProxy, bypassesProxy, maskProxyCredential, type OutboundProxy } from '../src/outbound-proxy.js'
import { buildBwrapArgs, getSandboxBackend, initBwrapCheck, sandboxExec, seatbeltEnv } from '../src/tools/sandbox.js'
import { createWorkspaceTools } from '../src/tools/workspace-tools.js'
import { createSettingsRoutes } from '../src/routes/settings.js'
import { send } from '../src/a2a/outbound.js'
import { policyRequest } from '../src/a2a/http.js'
import { config } from '../src/config.js'

// Pass-through, so a test can make one outboundProxy() read differ from the
// next (a settings save landing mid-command) — see the snapshot test.
const hook = vi.hoisted(() => ({ next: null as null | (() => unknown) }))
vi.mock('../src/outbound-proxy.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/outbound-proxy.js')>()
  return { ...orig, outboundProxy: () => (hook.next ? hook.next() : orig.outboundProxy()) }
})

/**
 * Settings → outbound proxy (`general.outbound_proxy.*`): spawned children get
 * http(s)_proxy / HTTP(S)_PROXY / no_proxy from cleanChildEnv (and the bwrap /
 * Seatbelt envs), web_fetch and A2A remotes go through an undici ProxyAgent.
 * The integration half runs real curl / fetch against a forward proxy on
 * 127.0.0.1 with a target that does not resolve — an answer means the request
 * really went through the proxy, not just that a variable was set.
 */

const SETTINGS = path.join(homedir(), '.halo', 'secrets', 'settings.yaml')
const PROXY_VARS = ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY'] as const
const TARGET = 'http://halo-proxy-test.invalid/'
const TOKEN = 'us er:p@ss/w:rd'
const TOKEN_FORMS = [TOKEN, encodeURIComponent('us er'), encodeURIComponent('p@ss/w:rd'), Buffer.from(TOKEN).toString('base64')]

let bump = 0
/** Write the global settings.yaml and push its mtime forward (the cache key). */
function writeSettings(tree: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true })
  fs.writeFileSync(SETTINGS, YAML.stringify(tree))
  const t = Date.now() / 1000 + ++bump * 10
  fs.utimesSync(SETTINGS, t, t)
}
const proxySettings = (proxy: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  writeSettings({ general: { outbound_proxy: proxy, ...extra } })

const savedEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of PROXY_VARS) { savedEnv[k] = process.env[k]; delete process.env[k] }
})
afterEach(() => {
  for (const k of PROXY_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  writeSettings({})
})

describe('cleanChildEnv × outbound proxy', () => {
  it('off: no proxy vars; enabled with an empty url reads as off', () => {
    proxySettings({ enabled: false, url: 'http://127.0.0.1:12334' })
    for (const k of PROXY_VARS) expect(cleanChildEnv()).not.toHaveProperty(k)
    proxySettings({ enabled: true, url: '' })
    for (const k of PROXY_VARS) expect(cleanChildEnv()).not.toHaveProperty(k)
    expect(outboundProxy()).toBeNull()
  })

  it('off leaves inherited proxy vars alone; on sets lower + upper case', () => {
    process.env.http_proxy = 'http://operator.example:3128'
    proxySettings({ enabled: false, url: 'http://127.0.0.1:12334' })
    expect(cleanChildEnv().http_proxy).toBe('http://operator.example:3128')
    proxySettings({ enabled: true, url: 'http://127.0.0.1:12334' })
    const env = cleanChildEnv()
    for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) expect(env[k]).toBe('http://127.0.0.1:12334')
    expect(env.no_proxy).toBe('localhost,127.0.0.1,::1')
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1')
  })

  it('no_proxy merges the server\'s inherited NO_PROXY / no_proxy after the loopback defaults, deduped', () => {
    process.env.NO_PROXY = 'corp.internal, localhost'
    process.env.no_proxy = '.svc.cluster.local'
    proxySettings({ enabled: true, url: 'http://127.0.0.1:12334' })
    expect(cleanChildEnv().NO_PROXY).toBe('localhost,127.0.0.1,::1,corp.internal,.svc.cluster.local')
    expect(cleanChildEnv().no_proxy).toBe(cleanChildEnv().NO_PROXY)
  })

  it('the token is percent-encoded into the env URL (user:password, or a bare token as user)', () => {
    proxySettings({ enabled: true, url: 'http://127.0.0.1:12334', token: TOKEN })
    const url = cleanChildEnv().https_proxy!
    expect(url).toBe('http://us%20er:p%40ss%2Fw%3Ard@127.0.0.1:12334')
    expect(decodeURIComponent(new URL(url).username)).toBe('us er')
    expect(decodeURIComponent(new URL(url).password)).toBe('p@ss/w:rd')
    proxySettings({ enabled: true, url: 'http://127.0.0.1:12334', token: 'tok' })
    expect(cleanChildEnv().http_proxy).toBe('http://tok:@127.0.0.1:12334')
    expect(outboundProxy()!.authorization).toBe(`Basic ${Buffer.from('tok:').toString('base64')}`)
  })

  it('a saved change reaches the next spawn without a restart (mtime cache)', () => {
    proxySettings({ enabled: true, url: 'http://127.0.0.1:1111' })
    expect(cleanChildEnv().http_proxy).toBe('http://127.0.0.1:1111')
    proxySettings({ enabled: true, url: 'http://127.0.0.1:2222' })
    expect(cleanChildEnv().http_proxy).toBe('http://127.0.0.1:2222')
    proxySettings({ enabled: false, url: 'http://127.0.0.1:2222' })
    expect(cleanChildEnv()).not.toHaveProperty('http_proxy')
  })

  it('unchanged settings resolve once (the parse is cached, not repeated per spawn)', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      proxySettings({ enabled: true, url: 'http://127.0.0.1:3333' })
      for (let i = 0; i < 20; i++) cleanChildEnv()
      expect(log.mock.calls.filter((c) => String(c[0]).startsWith('[OutboundProxy]'))).toHaveLength(1)
    } finally { log.mockRestore() }
  })

  it('a hand-edited url with credentials is ignored (proxy off) and its secret never logged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      proxySettings({ enabled: true, url: 'http://bob:hunter2@127.0.0.1:12334' })
      expect(cleanChildEnv()).not.toHaveProperty('http_proxy')
      expect(warn.mock.calls.flat().join(' ')).not.toContain('hunter2')
    } finally { warn.mockRestore() }
  })

  it('the Seatbelt env carries the same vars; the shared bwrap prefix (file helpers too) carries none', () => {
    proxySettings({ enabled: true, url: 'http://127.0.0.1:12334', token: 'tok' })
    const sb = seatbeltEnv()
    for (const k of PROXY_VARS) expect(sb[k]).toBe(cleanChildEnv()[k])
    // sandboxExec appends them for the user's command only — the bwrap
    // shell_exec run below is the proof that they arrive.
    expect(buildBwrapArgs({ workspaceRoot: tmpdir(), accessLevel: 'workspace' }).join(' ')).not.toMatch(/_proxy|127\.0\.0\.1:12334/i)
    proxySettings({ enabled: false })
    expect(seatbeltEnv()).not.toHaveProperty('http_proxy')
  })

  it('bypassesProxy follows curl: domain + subdomains, one leading dot ignored, IPs and CIDRs, lone *', () => {
    const list = ['localhost', '127.0.0.1', '::1', '.corp.example', 'svc.local', '10.0.0.0/8', 'fd00::/8', '192.168.1.5']
    for (const h of ['localhost', '127.0.0.1', '[::1]', 'corp.example', 'a.corp.example', 'A.Corp.Example.', 'svc.local', 'x.svc.local',
      '10.1.2.3', '[fd12::1]', '192.168.1.5']) expect(bypassesProxy(h, list), h).toBe(true)
    for (const h of ['example.com', '127.0.0.2', 'notsvc.local', 'corp.example.org', '11.0.0.1', '[fe80::1]', '192.168.1.6', '[::2]']) expect(bypassesProxy(h, list), h).toBe(false)
    // `*.x` is no wildcard and `host:port` never matches — curl does the same.
    expect(bypassesProxy('a.corp.example', ['*.corp.example'])).toBe(false)
    expect(bypassesProxy('corp.example', ['corp.example:8080'])).toBe(false)
    expect(bypassesProxy('10.0.0.1', ['10.0.0.1:80'])).toBe(false)
    // An IP entry never matches a name, a bracketed v6 entry matches nothing.
    expect(bypassesProxy('localhost', ['127.0.0.1'])).toBe(false)
    expect(bypassesProxy('[::1]', ['[::1]'])).toBe(false)
    expect(bypassesProxy('anything', ['*'])).toBe(true)
    expect(bypassesProxy('anything', ['localhost', '*'])).toBe(false)
  })

  it('an inherited NO_PROXY=* stays a lone * (curl ignores * inside a list)', () => {
    process.env.NO_PROXY = '*'
    proxySettings({ enabled: true, url: 'http://127.0.0.1:12334' })
    expect(cleanChildEnv().NO_PROXY).toBe('*')
    expect(bypassesProxy('example.com', outboundProxy()!.noProxy)).toBe(true)
  })

  it('a <<ENV>> token expands to the variable; an unset one stays literal', () => {
    process.env.HALO_TEST_PROXY_TOKEN = 'envuser:envpass'
    try {
      proxySettings({ enabled: true, url: 'http://127.0.0.1:12334', token: '<<HALO_TEST_PROXY_TOKEN>>' })
      expect(cleanChildEnv().http_proxy).toBe('http://envuser:envpass@127.0.0.1:12334')
      expect(outboundProxy()!.authorization).toBe(`Basic ${Buffer.from('envuser:envpass').toString('base64')}`)
      delete process.env.HALO_TEST_PROXY_TOKEN
      proxySettings({ enabled: true, url: 'http://127.0.0.1:12334', token: '<<HALO_TEST_PROXY_TOKEN>>' })
      expect(outboundProxy()!.credential!.raw).toBe('<<HALO_TEST_PROXY_TOKEN>>')
    } finally { delete process.env.HALO_TEST_PROXY_TOKEN }
  })

  it('maskProxyCredential: a short token\'s URL and base64 forms go at any length; alone it needs 4 chars', () => {
    proxySettings({ enabled: true, url: 'http://127.0.0.1:12334', token: 'ab' })
    const p = outboundProxy()
    const b64 = Buffer.from('ab:').toString('base64')
    expect(maskProxyCredential(`x=http://ab:@127.0.0.1:12334 auth=Basic ${b64} about`, p)).toBe('x=http://***@127.0.0.1:12334 auth=Basic *** about')
    proxySettings({ enabled: true, url: 'http://127.0.0.1:12334', token: 'longer-tok' })
    expect(maskProxyCredential('echo longer-tok', outboundProxy())).toBe('echo ***')
  })
})

describe('settings routes × outbound proxy', () => {
  const app = createSettingsRoutes()
  const call = (method: 'PUT' | 'PATCH', body: Record<string, unknown>) => app.request('/settings', {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'global', ...body }),
  })

  it('PATCH / PUT refuse a url with userinfo (pointing at Token), a non-http(s) scheme or garbage; accept http(s)', async () => {
    const res = await call('PATCH', { key: 'general.outbound_proxy.url', value: 'http://bob:hunter2@127.0.0.1:12334' })
    expect(res.status).toBe(400)
    const { error } = await res.json() as { error: string }
    expect(error).toContain('Token')
    expect(error).not.toContain('hunter2')
    for (const value of ['socks5://127.0.0.1:1080', 'not a url', 'http://bob@127.0.0.1:1']) {
      expect((await call('PATCH', { key: 'general.outbound_proxy.url', value })).status).toBe(400)
    }
    expect((await call('PUT', { settings: { general: { outbound_proxy: { url: 'https://u:p@proxy.example:443' } } } })).status).toBe(400)
    expect(fs.readFileSync(SETTINGS, 'utf-8')).not.toContain('hunter2')
    for (const value of ['http://127.0.0.1:12334', 'https://proxy.example:8443', '']) {
      expect((await call('PATCH', { key: 'general.outbound_proxy.url', value })).status).toBe(200)
    }
  })

  it('the three fields are global-only, and GET masks the token', async () => {
    expect((await call('PATCH', { key: 'general.outbound_proxy.token', value: TOKEN })).status).toBe(200)
    const schema = await (await app.request('/settings/schema')).json() as { sections: Array<{ namespaceId: string; fields: Array<{ key: string; type?: string; secret?: boolean; globalOnly?: boolean; value: string | null; placeholder?: string }> }> }
    const general = schema.sections.find((s) => s.namespaceId === 'general')!
    const f = (k: string) => general.fields.find((x) => x.key === `outbound_proxy.${k}`)!
    expect(f('enabled').type).toBe('boolean')
    expect(f('url').placeholder).toBe('http://127.0.0.1:12334')
    expect(f('token').secret).toBe(true)
    for (const k of ['enabled', 'url', 'token']) expect(f(k).globalOnly).toBe(true)
    const shown = f('token').value!
    expect(shown).not.toBe(TOKEN)
    for (const form of TOKEN_FORMS) expect(JSON.stringify(schema)).not.toContain(form)
    expect(shown).toMatch(/\*/)
  })
})

// ── integration: a real forward proxy on 127.0.0.1 ───────────────────────

interface Seen { method: string; target: string; auth?: string }
let proxy: http.Server
let inner: http.Server
let direct: http.Server
let silent: net.Server
let proxyPort: number
let directPort: number
let silentPort: number
const seen: Seen[] = []
const sockets = new Set<Socket>()

function listen(server: http.Server, host: string): Promise<number> {
  server.on('connection', (s: Socket) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  return new Promise((r) => server.listen(0, host, () => r((server.address() as AddressInfo).port)))
}

// Top-level: it.skipIf below reads the backend at collection time.
await initBwrapCheck()

beforeAll(async () => {
  // Absolute-URI GET (curl's plain-http form) answers itself; CONNECT (undici,
  // curl for https) is handed to `inner` as if the tunnel reached the target.
  // `/hop` (through the tunnel) redirects into no_proxy, `/out` (a direct
  // hit) out of it — web_fetch must re-route each hop.
  inner = http.createServer((req, res) => {
    if (req.url === '/hop') { res.writeHead(302, { location: `http://127.0.0.1:${proxyPort}/landed` }); res.end(); return }
    res.end('via-proxy')
  })
  proxy = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', target: req.url ?? '', auth: req.headers['proxy-authorization'] })
    // Its own host: a tunnel to TARGET left open by an earlier test would be reused.
    if (req.url === '/out') { res.writeHead(302, { location: 'http://halo-proxy-out.invalid/' }); res.end(); return }
    res.end(req.url === '/landed' ? 'landed-direct' : 'via-proxy')
  })
  proxy.on('connect', (req: http.IncomingMessage, sock: Socket) => {
    seen.push({ method: 'CONNECT', target: req.url ?? '', auth: req.headers['proxy-authorization'] })
    sockets.add(sock)
    sock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    inner.emit('connection', sock)
  })
  direct = http.createServer((_req, res) => res.end('direct'))
  // A proxy that accepts the TCP connection and never answers the CONNECT.
  silent = net.createServer((s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.resume() })
  proxyPort = await listen(proxy, '127.0.0.1')
  directPort = await listen(direct, '127.0.0.2')
  silentPort = await new Promise((r) => silent.listen(0, '127.0.0.1', () => r((silent.address() as AddressInfo).port)))
})

afterAll(async () => {
  writeSettings({})
  for (const s of sockets) s.destroy()
  await Promise.all([proxy, inner, direct, silent].map((s) => new Promise((r) => s.close(r))))
})

describe('through the proxy, for real', () => {
  let ws: string
  beforeEach(() => {
    ws = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'halo-proxy-ws-')))
    seen.length = 0
  })
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }))

  const tool = (level: 'full' | 'workspace', name: string) => {
    const t = createWorkspaceTools(ws, { accessLevel: level, supportsVision: false }).find((x) => x.name === name)!
    return async (input: unknown) => String(await (t.callback as (i: unknown) => Promise<unknown>)(input))
  }
  const rejection = async (p: Promise<unknown>) => {
    try { await p } catch (err) { return err as Error & { cmd?: string; spawnargs?: string[] } }
    throw new Error('expected a rejection')
  }
  const on = (token?: string) => proxySettings({ enabled: true, url: `http://127.0.0.1:${proxyPort}`, ...(token ? { token } : {}) })

  const levels = ['full', 'workspace'] as const
  for (const level of levels) {
    it.skipIf(level === 'workspace' && getSandboxBackend() !== 'bwrap')(`shell_exec (${level}): curl answers via the proxy when on, cannot resolve when off`, async () => {
      const curl = `curl -sS --max-time 5 ${TARGET}`
      on(TOKEN)
      expect(await tool(level, 'shell_exec')({ command: curl })).toBe('via-proxy')
      expect(seen).toEqual([{ method: 'GET', target: TARGET, auth: `Basic ${Buffer.from(TOKEN).toString('base64')}` }])
      // A command echoing its env doesn't leak the credential into the tool result.
      const envOut = await tool(level, 'shell_exec')({ command: 'env | grep -i _proxy' })
      expect(envOut).toContain(`127.0.0.1:${proxyPort}`)
      for (const form of TOKEN_FORMS) expect(envOut).not.toContain(form)
      // Loopback stays direct even with the proxy on.
      seen.length = 0
      expect(await tool(level, 'shell_exec')({ command: `curl -sS --max-time 5 http://127.0.0.1:${proxyPort}/loop` })).toBe('via-proxy')
      expect(seen[0].target).toBe('/loop')

      proxySettings({ enabled: false, url: `http://127.0.0.1:${proxyPort}` })
      seen.length = 0
      const off = await tool(level, 'shell_exec')({ command: curl })
      expect(off).toContain('__TOOL_ERROR__')
      expect(off).toMatch(/resolve host/i)
      expect(seen).toEqual([])
    }, 30_000)

    it.skipIf(level === 'workspace' && getSandboxBackend() !== 'bwrap')(`shell_exec (${level}): a 2-char token is masked in env output, on success and on failure`, async () => {
      // Not alphanumeric, so it can't turn up in the mkdtemp path an error quotes.
      on('q!')
      const ok = await tool(level, 'shell_exec')({ command: 'env | grep -i _proxy' })
      const failed = await tool(level, 'shell_exec')({ command: 'env | grep -i _proxy; echo "$HTTPS_PROXY" >&2; exit 3' })
      expect(failed).toContain('__TOOL_ERROR__')
      for (const out of [ok, failed]) {
        expect(out).toContain(`http_proxy=http://***@127.0.0.1:${proxyPort}`)
        expect(out).not.toContain('q!')
        expect(out).not.toContain(Buffer.from('q!:').toString('base64'))
      }
    }, 30_000)
  }

  it('shell_exec takes one proxy snapshot: a save landing mid-command can\'t put an unmasked credential in the env', async () => {
    on('first-token')
    const first = outboundProxy()
    proxySettings({ enabled: true, url: `http://127.0.0.1:${proxyPort}`, token: 'second-token' })
    const second = outboundProxy()
    let reads = 0
    hook.next = () => (reads++ === 0 ? first : second) as OutboundProxy
    try {
      const out = await tool('full', 'shell_exec')({ command: 'env | grep -i _proxy' })
      expect(out).toContain(`http_proxy=http://***@127.0.0.1:${proxyPort}`)
      expect(out).not.toMatch(/first-token|second-token/)
    } finally { hook.next = null }
  }, 30_000)

  it.skipIf(getSandboxBackend() !== 'bwrap')('a bwrap failure\'s error never carries the bwrap argv — file_read and shell_exec, credential containing "bwrap"', async () => {
    const token = 'bwrap:s3cr3t-bwrap-pw'
    on(token)
    const proxyEnv = Object.fromEntries(PROXY_VARS.map((k) => [k, cleanChildEnv()[k]!]))
    expect(proxyEnv.http_proxy).toContain('s3cr3t')
    const leaks = (e: { message: string; cmd?: string; spawnargs?: string[] }) =>
      [e.message, e.cmd ?? '', (e.spawnargs ?? []).join(' ')].join('\n')
    const readErr = await rejection(tool('workspace', 'file_read')({ path: 'missing.txt' }))
    const execErr = await rejection(sandboxExec('echo boom >&2; exit 3', { workspaceRoot: ws, accessLevel: 'workspace', proxyEnv }))
    for (const e of [readErr, execErr]) {
      expect(leaks(e)).not.toMatch(/s3cr3t|--setenv|--ro-bind|--clearenv/)
      expect(e.message).toMatch(/^Command failed: /)
    }
    expect(execErr.message).toBe(`Command failed: bash -c cd "$1" && shift && echo boom >&2; exit 3 bash ${ws}\nboom\n`)
    expect(readErr.message).toContain('missing.txt')
    // The tool result says the same, masked on top.
    const shell = await tool('workspace', 'shell_exec')({ command: 'exit 3' })
    expect(shell).not.toMatch(/s3cr3t|--setenv/)
  }, 30_000)

  it('web_fetch: through the proxy (Proxy-Authorization) when on, fails when off; no_proxy hosts go direct', async () => {
    on(TOKEN)
    const out = await tool('full', 'web_fetch')({ url: TARGET })
    expect(out).toContain('Status: 200')
    expect(out).toContain('via-proxy')
    expect(seen).toEqual([{ method: 'CONNECT', target: 'halo-proxy-test.invalid:80', auth: `Basic ${Buffer.from(TOKEN).toString('base64')}` }])

    seen.length = 0
    expect(await tool('full', 'web_fetch')({ url: `http://127.0.0.1:${proxyPort}/loop` })).toContain('via-proxy')
    expect(seen[0]).toMatchObject({ method: 'GET', target: '/loop' })

    proxySettings({ enabled: false, url: `http://127.0.0.1:${proxyPort}` })
    seen.length = 0
    expect(await tool('full', 'web_fetch')({ url: TARGET })).toContain('__TOOL_ERROR__')
    expect(seen).toEqual([])
  }, 30_000)

  it('web_fetch re-routes every redirect hop: into no_proxy goes direct, out of it through the proxy', async () => {
    on(TOKEN)
    const into = await tool('full', 'web_fetch')({ url: `${TARGET}hop` })
    expect(into).toContain('landed-direct')
    expect(seen.map((s) => `${s.method} ${s.target}`)).toEqual(['CONNECT halo-proxy-test.invalid:80', 'GET /landed'])

    seen.length = 0
    const out = await tool('full', 'web_fetch')({ url: `http://127.0.0.1:${proxyPort}/out` })
    expect(out).toContain('via-proxy')
    expect(seen.map((s) => `${s.method} ${s.target}`)).toEqual(['GET /out', 'CONNECT halo-proxy-out.invalid:80'])
  }, 30_000)

  it('web_fetch refuses a caller Proxy-Authorization (any case) while the proxy is on — no_proxy hosts included', async () => {
    on(TOKEN)
    const out = await tool('full', 'web_fetch')({ url: `http://127.0.0.1:${proxyPort}/loop`, headers: { 'proxy-AUTHORIZATION': 'Basic x' } })
    expect(out).toContain('__TOOL_ERROR__')
    expect(out).toContain('Proxy-Authorization')
    expect(seen).toEqual([])
    proxySettings({ enabled: false, url: `http://127.0.0.1:${proxyPort}` })
    expect(await tool('full', 'web_fetch')({ url: `http://127.0.0.1:${proxyPort}/loop`, headers: { 'Proxy-Authorization': 'Basic x' } })).toContain('Status: 200')
  }, 30_000)

  it('a <<ENV>> token reaches the proxy as the variable\'s value', async () => {
    process.env.HALO_TEST_PROXY_TOKEN = 'envuser:envpass'
    try {
      on('<<HALO_TEST_PROXY_TOKEN>>')
      expect(await tool('full', 'web_fetch')({ url: TARGET })).toContain('via-proxy')
      expect(seen[0].auth).toBe(`Basic ${Buffer.from('envuser:envpass').toString('base64')}`)
    } finally { delete process.env.HALO_TEST_PROXY_TOKEN }
  }, 30_000)

  it('a proxy that never answers the CONNECT: A2A gives up at timeoutMs, and so does web_fetch', async () => {
    proxySettings({ enabled: true, url: `http://127.0.0.1:${silentPort}` }, { a2a: { url_allowlist: '127.0.0.0/8' } })
    let t = Date.now()
    await expect(policyRequest(`http://127.0.0.2:${directPort}/card`, { method: 'GET', timeoutMs: 400, viaProxy: true })).rejects.toThrow(/timeout after 400ms/)
    expect(Date.now() - t).toBeLessThan(2500)

    const saved = config.timeout.webFetch
    config.timeout.webFetch = 400
    try {
      t = Date.now()
      expect(await tool('full', 'web_fetch')({ url: TARGET })).toContain('timed out')
      expect(Date.now() - t).toBeLessThan(2500)
    } finally { config.timeout.webFetch = saved }
  }, 10_000)

  it('A2A: requests to a remote go via the proxy; the url_allowlist check still applies; push stays direct', async () => {
    const remote = { name: 'peer', card: `http://127.0.0.2:${directPort}/card`, auth: 'bearer' as const }
    const settings = (allowlist: string) => proxySettings(
      { enabled: true, url: `http://127.0.0.1:${proxyPort}`, token: TOKEN },
      { a2a: { url_allowlist: allowlist } },
    )
    const withSecret = (allowlist: string) => {
      settings(allowlist)
      const tree = YAML.parse(fs.readFileSync(SETTINGS, 'utf-8')) as Record<string, unknown>
      writeSettings({ ...tree, a2a: { secrets: { peer: 'bearer-tok' } } })
    }
    withSecret('127.0.0.0/8')
    const res = await send(ws, remote, 'GET', remote.card)
    expect(res.status).toBe(200)
    expect(res.body).toBe('via-proxy')
    expect(seen).toEqual([{ method: 'CONNECT', target: `127.0.0.2:${directPort}`, auth: `Basic ${Buffer.from(TOKEN).toString('base64')}` }])

    // Not in the allowlist → refused before anything reaches the proxy.
    withSecret('100.64.0.0/10')
    seen.length = 0
    await expect(send(ws, remote, 'GET', remote.card)).rejects.toMatchObject({ code: 'A2A_URL_REFUSED' })
    expect(seen).toEqual([])

    // Push webhooks (policyRequest without viaProxy) keep connecting directly.
    withSecret('127.0.0.0/8')
    const pushed = await policyRequest(remote.card, { method: 'POST', body: '{}', timeoutMs: 5000 })
    expect(pushed.body).toBe('direct')
    expect(seen).toEqual([])
  }, 30_000)

  it('no log line carries the token in any form', async () => {
    const spies = (['log', 'warn', 'error', 'debug', 'info'] as const).map((m) => vi.spyOn(console, m))
    try {
      on(TOKEN)
      cleanChildEnv()
      await tool('full', 'shell_exec')({ command: `curl -sS --max-time 5 ${TARGET}` })
      await tool('full', 'web_fetch')({ url: TARGET })
      proxySettings({ enabled: true, url: `http://u:${encodeURIComponent('p@ss/w:rd')}@127.0.0.1:${proxyPort}`, token: TOKEN })
      cleanChildEnv()
      const out = spies.flatMap((s) => s.mock.calls.flat().map(String)).join('\n')
      expect(out).toContain('[OutboundProxy]')
      for (const form of TOKEN_FORMS) expect(out).not.toContain(form)
    } finally { for (const s of spies) s.mockRestore() }
  }, 30_000)
})
