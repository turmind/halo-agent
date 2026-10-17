import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync, symlinkSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  parseSessionHeader, isMountPoint, skipTemplateEntry, ensureSessionDir, buildWorkerArgv, workerEnv,
  workerPathToHost, rewriteMediaLines, mediaMapper, isContractPath, startAgentCoreFront, SESSION_HEADER,
} from '../src/a2a/agentcore-front.js'
import { FRONT_TOKEN_ENV, FRONT_TOKEN_HEADER, FRONT_URL_ENV } from '../src/a2a/agentcore-notify.js'

/**
 * AgentCore session-dirs mode (CONTRACT §1b v2): the root front validates the
 * session header, creates `<base>/<sid>` from `.template`, spawns the worker
 * in its own mount namespace and proxies to it. The namespace / setpriv part
 * runs only on a real microVM — here its argv is the testable unit, and the
 * front runs against a stand-in worker.
 */

const SID_A = 'job-english-coach-000000000000000000000'
const SID_B = 'user-bob-00000000000000000000000000000'

let base: string
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), 'halo-sdirs-'))) })
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('pure parts', () => {
  it('session header: 33–256 chars, [A-Za-z0-9] first, then [A-Za-z0-9_-]; missing / bad → error', () => {
    expect(parseSessionHeader(SID_A)).toEqual({ sid: SID_A })
    expect(parseSessionHeader('a'.repeat(256))).toEqual({ sid: 'a'.repeat(256) })
    for (const bad of [undefined, '', 'a'.repeat(32), 'a'.repeat(257), `.${'a'.repeat(40)}`, `-${'a'.repeat(40)}`, `${'a'.repeat(40)}/x`, `${'a'.repeat(40)}..`, `${'a'.repeat(40)} `, [SID_A, SID_B]]) {
      expect('error' in parseSessionHeader(bad as never), String(bad)).toBe(true)
    }
    expect((parseSessionHeader(undefined) as { error: string }).error).toMatch(/missing x-amzn-bedrock-agentcore-runtime-session-id/)
  })

  it('mount point from mountinfo: field 5, octal escapes; a subdir of a mount is not one', () => {
    const info = [
      '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/root rw',
      '95 22 0:50 / /mnt/efs rw,relatime shared:40 - nfs4 fs-1.efs.amazonaws.com:/ rw',
      '96 22 0:51 / /mnt/with\\040space rw - tmpfs tmpfs rw',
    ].join('\n')
    expect(isMountPoint('/mnt/efs', info)).toBe(true)
    expect(isMountPoint('/mnt/with space', info)).toBe(true)
    expect(isMountPoint('/mnt/efs/x', info)).toBe(false)
    expect(isMountPoint('/mnt', info)).toBe(false)
  })

  it('contract paths are exact', () => {
    expect(isContractPath('POST', '/')).toBe(true)
    expect(isContractPath('POST', '/invocations')).toBe(true)
    expect(isContractPath('GET', '/ping')).toBe(true)
    expect(isContractPath('GET', '/.well-known/agent-card.json')).toBe(true)
    for (const [m, p] of [['POST', '//'], ['POST', '/invocations/'], ['GET', '/'], ['PUT', '/'], ['GET', '//ping']]) expect(isContractPath(m, p), `${m} ${p}`).toBe(false)
  })

  it('template filter: sessions, sqlite files + sidecars, runtime.lock, the lease', () => {
    for (const rel of ['.halo/sessions', '.halo/halo.db', '.halo/a2a.db-wal', '.halo/runs.db-shm', 'data/x.db', '.halo/runtime.lock', '.halo/agentcore.lease', '.halo/agentcore.lease.abc.tmp']) expect(skipTemplateEntry(rel), rel).toBe(true)
    for (const rel of ['.halo', '.halo/agents', '.halo/agents/coach/agent.yaml', '.halo/sessions-notes.md', 'INSTRUCTIONS.md', 'scripts/tts_polly.py', 'data/x.dbx']) expect(skipTemplateEntry(rel), rel).toBe(false)
  })

  it('worker argv: unshare -m private → bind at /workspace → umount -l base → setpriv drop; paths as args, not in the script', () => {
    const argv = buildWorkerArgv({ base: '/mnt/efs', sessionDir: `/mnt/efs/${SID_A}`, uid: 1000, gid: 1000, command: ['/usr/bin/node', '/usr/lib/halo/dist/index.js', 'agentcore', '--workspace', '/workspace', '-p', '9100'] })
    expect(argv.slice(0, 6)).toEqual(['unshare', '-m', '--propagation', 'private', 'sh', '-c'])
    const script = argv[6]
    const lines = script.split('\n')
    expect(lines[1]).toBe('mkdir -p /workspace && mount --bind "$src" /workspace || exit 91')
    expect(lines[2]).toBe('umount -l "$base" || exit 93')
    expect(lines[3]).toBe('[ ! -e "$src" ] || exit 94')
    expect(lines[4]).toBe('exec setpriv --reuid=1000 --regid=1000 --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs -- "$@"')
    expect(script).not.toContain('/mnt/efs')
    expect(script).not.toContain(SID_A)
    expect(argv.slice(7)).toEqual(['halo-worker', `/mnt/efs/${SID_A}`, '/mnt/efs', '/usr/bin/node', '/usr/lib/halo/dist/index.js', 'agentcore', '--workspace', '/workspace', '-p', '9100'])
  })

  it('worker env: allowlist only — channel secrets and the notify command never pass', () => {
    const env = workerEnv({
      PATH: '/usr/bin', AWS_REGION: 'ap-northeast-1', AWS_DEFAULT_REGION: 'ap-northeast-1', HALO_LOG_LEVEL: 'info',
      HALO_A2A_ACCESS: 'full', HALO_A2A_PUBLIC_URL: 'https://x', OTEL_SERVICE_NAME: 's', AGENT_OBSERVABILITY_ENABLED: 'true',
      AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.2/x',
      FEISHU_APP_SECRET: 's1', SLACK_BOT_TOKEN: 's2', TELEGRAM_BOT_TOKEN: 's3', WECOM_WEBHOOK_KEY: 's4', WECOM_BOT_SECRET: 's5',
      HALO_AGENTCORE_NOTIFY: 'python3 /opt/notify.py', HALO_AGENTCORE_SESSION_DIRS: '1', HALO_WORKSPACE: '/mnt/efs', HALO_PORT: '8080', HOME: '/root', HALO_PASSWORD: 'p',
    }, { url: 'http://127.0.0.1:4000', token: 't0k' })
    expect(env).toEqual({
      PATH: '/usr/bin', AWS_REGION: 'ap-northeast-1', AWS_DEFAULT_REGION: 'ap-northeast-1', HALO_LOG_LEVEL: 'info',
      HALO_A2A_ACCESS: 'full', HALO_A2A_PUBLIC_URL: 'https://x', OTEL_SERVICE_NAME: 's', AGENT_OBSERVABILITY_ENABLED: 'true',
      AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.2/x',
      HOME: '/home/node', HALO_HOME: '/home/node/.halo', [FRONT_URL_ENV]: 'http://127.0.0.1:4000', [FRONT_TOKEN_ENV]: 't0k',
    })
    expect(workerEnv({}, { url: 'u', token: 't' }).PATH).toMatch(/\/usr\/bin/)
  })

  it('MEDIA rewrite: /workspace/… → the host session dir; outside, `..` escapes, symlinks out and dirs are dropped', () => {
    const dir = join(base, SID_A)
    mkdirSync(join(dir, 'out'), { recursive: true })
    mkdirSync(join(base, SID_B))
    writeFileSync(join(dir, 'out', 'a.mp3'), 'x')
    writeFileSync(join(base, SID_B, 'secret.txt'), 'b')
    symlinkSync(join(base, SID_B, 'secret.txt'), join(dir, 'out', 'link.txt'))
    expect(workerPathToHost('/workspace/out/a.mp3', dir)).toBe(join(dir, 'out', 'a.mp3'))
    expect(workerPathToHost('/workspace/../mnt/x', dir)).toBeNull()
    expect(workerPathToHost('/workspacex/a', dir)).toBeNull()
    const text = [
      'Today\'s phrase.',
      'MEDIA:/workspace/out/a.mp3',
      'MEDIA: /workspace/out/a.mp3 ',
      `MEDIA:/workspace/../${SID_B}/secret.txt`,
      'MEDIA:/workspace/out/link.txt',
      'MEDIA:/workspace/out',
      `MEDIA:${base}/${SID_B}/secret.txt`,
      'not MEDIA:/workspace/out/a.mp3',
    ].join('\n')
    expect(rewriteMediaLines(text, mediaMapper(dir)).split('\n')).toEqual([
      'Today\'s phrase.',
      `MEDIA:${dir}/out/a.mp3`,
      `MEDIA:${dir}/out/a.mp3`,
      '[file not attached: secret.txt — not a file in this workspace]',
      '[file not attached: link.txt — not a file in this workspace]',
      '[file not attached: out — not a file in this workspace]',
      '[file not attached: secret.txt — not a file in this workspace]',
      'not MEDIA:/workspace/out/a.mp3',
    ])
  })

  it('new session dir: template copied minus sessions / dbs / lock / lease; an existing dir is left alone', () => {
    const t = join(base, '.template')
    mkdirSync(join(t, '.halo', 'agents', 'coach'), { recursive: true })
    mkdirSync(join(t, '.halo', 'sessions', 'default'), { recursive: true })
    mkdirSync(join(t, 'scripts'))
    writeFileSync(join(t, 'INSTRUCTIONS.md'), 'i')
    writeFileSync(join(t, 'scripts', 'tts_polly.py'), 'p')
    writeFileSync(join(t, '.halo', 'agents', 'coach', 'agent.yaml'), 'name: coach')
    writeFileSync(join(t, '.halo', 'sessions', 'default', 's.ui.jsonl'), '{}')
    for (const f of ['halo.db', 'halo.db-wal', 'a2a.db', 'runtime.lock', 'agentcore.lease']) writeFileSync(join(t, '.halo', f), 'x')

    expect(ensureSessionDir(base, SID_A, null)).toBe(true)
    const dir = join(base, SID_A)
    expect(readFileSync(join(dir, 'INSTRUCTIONS.md'), 'utf8')).toBe('i')
    expect(readFileSync(join(dir, 'scripts', 'tts_polly.py'), 'utf8')).toBe('p')
    expect(existsSync(join(dir, '.halo', 'agents', 'coach', 'agent.yaml'))).toBe(true)
    expect(readdirSync(join(dir, '.halo')).sort()).toEqual(['agents'])
    // No temp dir left behind; existing dir untouched on the next call.
    expect(readdirSync(base).sort()).toEqual(['.template', SID_A])
    writeFileSync(join(dir, 'mine.txt'), 'kept')
    writeFileSync(join(t, 'INSTRUCTIONS.md'), 'changed')
    expect(ensureSessionDir(base, SID_A, null)).toBe(false)
    expect(readFileSync(join(dir, 'INSTRUCTIONS.md'), 'utf8')).toBe('i')
    expect(existsSync(join(dir, 'mine.txt'))).toBe(true)
    // No template → an empty dir.
    rmSync(t, { recursive: true })
    expect(ensureSessionDir(base, SID_B, null)).toBe(true)
    expect(readdirSync(join(base, SID_B))).toEqual([])
  })
})

/** A stand-in worker: a small node server on the worker port that answers
 *  /ping, echoes requests, streams SSE, and posts /ready + /notify to the
 *  front exactly as the real worker does (agentcore-notify.ts postToFront). */
const FAKE_WORKER = `
const http = require('node:http')
const front = process.env.${FRONT_URL_ENV}, token = process.env.${FRONT_TOKEN_ENV}
const post = (route, body) => fetch(front + route, { method: 'POST', headers: { 'content-type': 'application/json', '${FRONT_TOKEN_HEADER}': token }, body: JSON.stringify(body) })
let busy = false
http.createServer(async (req, res) => {
  let body = ''
  for await (const c of req) body += c
  if (req.url === '/ping') return res.end(JSON.stringify({ status: busy ? 'HealthyBusy' : 'Healthy' }))
  if (req.url === '/' && req.headers.accept === 'text/event-stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: one\\n\\n')
    setTimeout(() => { res.write('data: two\\n\\n'); res.end() }, 150)
    return
  }
  if (req.url === '/invocations') {
    busy = true
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'accepted', session: 'inv_1', id: null, echo: JSON.parse(body), sid: req.headers['x-amzn-bedrock-agentcore-runtime-session-id'], env: Object.keys(process.env).sort() }))
    setTimeout(async () => { busy = false; await post('/notify', { id: 'i1', session: 'inv_1', status: 'ok', text: 'done\\nMEDIA:/workspace/out/a.mp3' }) }, 100)
    return
  }
  res.writeHead(418); res.end('{}')
}).listen(Number(process.env.WORKER_PORT), '127.0.0.1', () => { post('/ready', {}) })
`

describe('front', () => {
  let front: Awaited<ReturnType<typeof startAgentCoreFront>> | null = null
  let exits: number[] = []
  let spawned: Array<{ sessionDir: string; env: Record<string, string> }> = []
  let mounted = true
  const prevNotify = process.env.HALO_AGENTCORE_NOTIFY

  async function start(opts: { readyTimeoutMs?: number; worker?: string } = {}) {
    exits = []
    spawned = []
    process.env.HALO_AGENTCORE_NOTIFY = 'cat > "$HALO_WORKSPACE/notify.stdin"; printf "%s|%s|%s" "$HALO_SESSION_ID" "$HALO_RUN_STATUS" "$HALO_WORKSPACE" > "$HALO_WORKSPACE/notify.env"'
    const workerPort = 20000 + Math.floor(Math.random() * 20000)
    front = await startAgentCoreFront({
      base, port: 0, host: '127.0.0.1', workerPort, readyTimeoutMs: opts.readyTimeoutMs ?? 5000,
      isMounted: () => mounted,
      spawnWorker: ({ sessionDir, env, workerPort: wp }): ChildProcess => {
        spawned.push({ sessionDir, env })
        return spawn(process.execPath, ['-e', opts.worker ?? FAKE_WORKER], { env: { ...env, WORKER_PORT: String(wp) }, stdio: 'ignore' })
      },
      onWorkerExit: (code) => { exits.push(code) },
    })
    return `http://127.0.0.1:${(front.server.address() as { port: number }).port}`
  }

  afterEach(() => {
    front?.close()
    front = null
    mounted = true
    if (prevNotify === undefined) delete process.env.HALO_AGENTCORE_NOTIFY
    else process.env.HALO_AGENTCORE_NOTIFY = prevNotify
  })

  const inv = (url: string, sid?: string, body: unknown = { prompt: 'hi' }) =>
    fetch(`${url}/invocations`, { method: 'POST', headers: { 'content-type': 'application/json', ...(sid ? { [SESSION_HEADER]: sid } : {}) }, body: JSON.stringify(body) })

  async function until(cond: () => boolean, ms = 5000): Promise<void> {
    const end = Date.now() + ms
    while (!cond()) {
      if (Date.now() > end) throw new Error('timed out waiting')
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  it('first request: session dir created, worker spawned with the allowlisted env, request proxied; /ping passes the worker\'s answer through', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-secret'
    mkdirSync(join(base, '.template', 'out'), { recursive: true })
    writeFileSync(join(base, '.template', 'out', 'a.mp3'), 'x')
    try {
      const url = await start()
      expect(await (await fetch(`${url}/ping`)).json()).toEqual({ status: 'Healthy' })
      expect(spawned).toEqual([])

      const res = await inv(url, SID_A, { prompt: 'hi', id: 'e1' })
      expect(res.status).toBe(200)
      const body = await res.json() as { status: string; echo: unknown; sid: string; env: string[] }
      expect(body.status).toBe('accepted')
      expect(body.echo).toEqual({ prompt: 'hi', id: 'e1' })
      expect(body.sid).toBe(SID_A)
      expect(body.env).not.toContain('SLACK_BOT_TOKEN')
      expect(body.env).not.toContain('HALO_AGENTCORE_NOTIFY')
      expect(spawned).toHaveLength(1)
      expect(spawned[0].sessionDir).toBe(join(base, SID_A))
      expect(existsSync(join(base, SID_A))).toBe(true)
      expect(await (await fetch(`${url}/ping`)).json()).toEqual({ status: 'HealthyBusy' })

      // The worker's notify comes back over loopback: MEDIA mapped to the host
      // dir (out/a.mp3 came from .template), the hook run here.
      await until(() => existsSync(join(base, SID_A, 'notify.env')) && readFileSync(join(base, SID_A, 'notify.env'), 'utf8').length > 0)
      expect(readFileSync(join(base, SID_A, 'notify.env'), 'utf8')).toBe(`inv_1|ok|${join(base, SID_A)}`)
      expect(readFileSync(join(base, SID_A, 'notify.stdin'), 'utf8')).toBe(`done\nMEDIA:${join(base, SID_A)}/out/a.mp3`)
      let status = ''
      for (let i = 0; i < 100 && status !== 'Healthy'; i++) {
        status = ((await (await fetch(`${url}/ping`)).json()) as { status: string }).status
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(status).toBe('Healthy')
    } finally {
      delete process.env.SLACK_BOT_TOKEN
    }
  })

  it('a different session id later → 409, the worker is never switched; missing / bad header → 400', async () => {
    const url = await start()
    expect((await inv(url, SID_A)).status).toBe(200)
    const other = await inv(url, SID_B)
    expect(other.status).toBe(409)
    expect(((await other.json()) as { error: string }).error).toMatch(/never switches workspace/)
    expect((await inv(url)).status).toBe(400)
    expect((await inv(url, 'short')).status).toBe(400)
    expect(spawned).toHaveLength(1)
    expect(existsSync(join(base, SID_B))).toBe(false)
  })

  it('no header on the first request → 400 and nothing is created or spawned', async () => {
    const url = await start()
    const res = await inv(url)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/missing x-amzn-bedrock-agentcore-runtime-session-id/)
    expect(spawned).toEqual([])
    expect(readdirSync(base)).toEqual([])
  })

  it('base not mounted yet → 503 (fail closed), and the next request after the mount goes through', async () => {
    mounted = false
    const url = await start()
    const res = await inv(url, SID_A)
    expect(res.status).toBe(503)
    expect(spawned).toEqual([])
    expect(readdirSync(base)).toEqual([])
    mounted = true
    expect((await inv(url, SID_A)).status).toBe(200)
  })

  it('A2A SSE streams through the proxy chunk by chunk', async () => {
    const url = await start()
    const res = await fetch(`${url}/`, { method: 'POST', headers: { accept: 'text/event-stream', [SESSION_HEADER]: SID_A }, body: '{}' })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const reader = res.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toBe('data: one\n\n') // arrived before the worker wrote the second event
    let rest = ''
    for (;;) { const r = await reader.read(); if (r.done) break; rest += new TextDecoder().decode(r.value) }
    expect(rest).toBe('data: two\n\n')
  })

  it('the loopback endpoint refuses a wrong token', async () => {
    await start()
    const lb = `http://127.0.0.1:${(front!.loopback.address() as { port: number }).port}`
    expect((await fetch(`${lb}/notify`, { method: 'POST', headers: { [FRONT_TOKEN_HEADER]: 'nope' }, body: '{}' })).status).toBe(403)
    expect((await fetch(`${lb}/notify`, { method: 'POST', body: '{}' })).status).toBe(403)
  })

  it('worker exits → the front reports it (and exits); a worker never ready → 503 and keeps refusing', async () => {
    const url = await start({ worker: 'process.exit(7)' })
    expect((await inv(url, SID_A)).status).toBe(503)
    await until(() => exits.length > 0)
    expect(exits).toEqual([7])
    front!.close()

    const url2 = await start({ worker: 'setInterval(() => {}, 1000)', readyTimeoutMs: 200 })
    const r1 = await inv(url2, SID_A)
    expect(r1.status).toBe(503)
    expect(((await r1.json()) as { error: string }).error).toMatch(/not ready after/)
    expect((await inv(url2, SID_A)).status).toBe(503)
    expect(spawned).toHaveLength(1)
    expect(exits).toEqual([])
  })

  it('404 off the contract paths, before any header check', async () => {
    const url = await start()
    expect((await fetch(`${url}/api/health`)).status).toBe(404)
    expect((await fetch(`${url}//`, { method: 'POST' })).status).toBe(404)
    expect(spawned).toEqual([])
  })
})
