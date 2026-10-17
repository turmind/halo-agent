import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync, symlinkSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  parseSessionHeader, mountLayers, skipTemplateEntry, ensureSessionDir, buildSetupCommands, runViewSetup, buildWorkerCommand, workerEnv,
  copyMediaFile, copyMediaLines, isContractPath, startAgentCoreFront, SESSION_HEADER,
} from '../src/a2a/agentcore-front.js'
import { FRONT_TOKEN_ENV, FRONT_TOKEN_HEADER, FRONT_URL_ENV } from '../src/a2a/agentcore-notify.js'

/**
 * AgentCore session-dirs mode (CONTRACT §1b, boss 11:45Z / 12:18Z): the root
 * front validates the session header, creates `<base>/<sid>` from
 * `.template`, binds it at /workspace + unmounts the base (in its own
 * namespace, once), spawns the worker via setpriv and proxies to it.
 * mount / setpriv run only on a real microVM — here
 * their argv is the testable unit, and the front runs against a stand-in
 * view setup and worker.
 */

const SID_A = 'job-english-coach-000000000000000000000'
const SID_B = 'user-bob-00000000000000000000000000000'

/** /mnt/efs as the rebuilt R1 image has it: the platform's overlay bind, nfs4 on top. */
const TWO_LAYERS = [
  '551 527 0:22 /mnt/efs /mnt/efs rw,noatime master:1 - overlay overlayfs:/overlay/root rw,lowerdir=/,upperdir=/overlay/root,workdir=/overlay/work',
  '495 551 0:50 / /mnt/efs rw,relatime master:255 - nfs4 127.0.0.1:/ rw,vers=4.1,port=20641',
]

/** A mock mountinfo over `layers` on /mnt/efs: each `umount -l` pops the top
 *  one (none when `stuck`); every argv run is recorded. */
function stackedBase(layers: string[], o: { stuck?: boolean } = {}) {
  const stack = [...layers]
  const calls: string[][] = []
  const deps = {
    mountinfo: () => ['22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/root rw', ...stack].join('\n'),
    exec: async (argv: string[]) => {
      calls.push(argv)
      if (argv[0] === 'umount' && !o.stuck) stack.pop()
    },
  }
  return { deps, calls }
}

let base: string
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), 'halo-sdirs-'))) })
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('pure parts', () => {
  it('session header: 33–255 chars (NAME_MAX — the dir name is the id), [A-Za-z0-9] first, then [A-Za-z0-9_-]; missing / bad → error', () => {
    expect(parseSessionHeader(SID_A)).toEqual({ sid: SID_A })
    expect(parseSessionHeader('a'.repeat(255))).toEqual({ sid: 'a'.repeat(255) })
    for (const bad of [undefined, '', 'a'.repeat(32), 'a'.repeat(256), 'a'.repeat(257), `.${'a'.repeat(40)}`, `-${'a'.repeat(40)}`, `${'a'.repeat(40)}/x`, `${'a'.repeat(40)}..`, `${'a'.repeat(40)} `, [SID_A, SID_B]]) {
      expect('error' in parseSessionHeader(bad as never), String(bad)).toBe(true)
    }
    expect((parseSessionHeader(undefined) as { error: string }).error).toMatch(/missing x-amzn-bedrock-agentcore-runtime-session-id/)
  })

  it('mount layers from mountinfo: field 5, octal escapes, stacked mounts counted; a subdir of a mount is not one', () => {
    const info = [
      '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/root rw',
      ...TWO_LAYERS,
      '96 22 0:51 / /mnt/with\\040space rw - tmpfs tmpfs rw',
    ].join('\n')
    expect(mountLayers('/mnt/efs', info)).toBe(2)
    expect(mountLayers('/mnt/with space', info)).toBe(1)
    expect(mountLayers('/mnt/efs/x', info)).toBe(0)
    expect(mountLayers('/mnt', info)).toBe(0)
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

  it('view setup: bind the session dir at /workspace (no iptables — the VM has no CAP_NET_ADMIN), then lazy-umount the base', async () => {
    expect(buildSetupCommands(`/mnt/efs/${SID_A}`)).toEqual([
      ['mkdir', '-p', '/workspace'],
      ['mount', '--bind', `/mnt/efs/${SID_A}`, '/workspace'],
    ])
    const one = stackedBase(TWO_LAYERS.slice(1))
    await runViewSetup('/mnt/efs', `/mnt/efs/${SID_A}`, one.deps)
    expect(one.calls).toEqual([...buildSetupCommands(`/mnt/efs/${SID_A}`), ['umount', '-l', '/mnt/efs']])
  })

  it('view setup: umount -l once per stacked layer (overlay bind under nfs4, as on the microVM)', async () => {
    const two = stackedBase(TWO_LAYERS)
    await runViewSetup('/mnt/efs', `/mnt/efs/${SID_A}`, two.deps)
    expect(two.calls.filter((a) => a[0] === 'umount')).toEqual([['umount', '-l', '/mnt/efs'], ['umount', '-l', '/mnt/efs']])
  })

  it('view setup: a layer that never pops → fails after 5 × umount -l, naming what is left', async () => {
    const stuck = stackedBase(TWO_LAYERS, { stuck: true })
    await expect(runViewSetup('/mnt/efs', `/mnt/efs/${SID_A}`, stuck.deps)).rejects.toThrow('/mnt/efs still has 2 mount(s) after 5 × umount -l')
    expect(stuck.calls.filter((a) => a[0] === 'umount')).toHaveLength(5)
  })

  it('worker command: setpriv uid AND gid 1000, no groups, every cap cleared, no_new_privs, then env -i <allowlist>', () => {
    const argv = buildWorkerCommand({ PATH: '/usr/bin', HOME: '/home/node', X: 'a b=c' }, ['/usr/bin/node', '/usr/lib/halo/bin/halo.js', 'agentcore', '--workspace', '/workspace', '-p', '9100'])
    expect(argv).toEqual([
      'setpriv', '--reuid=1000', '--regid=1000', '--clear-groups', '--inh-caps=-all', '--bounding-set=-all', '--no-new-privs',
      'env', '-i', 'PATH=/usr/bin', 'HOME=/home/node', 'X=a b=c',
      '/usr/bin/node', '/usr/lib/halo/bin/halo.js', 'agentcore', '--workspace', '/workspace', '-p', '9100',
    ])
  })

  it('worker env: allowlist only — channel secrets, model keys, the notify command and the password never pass; every OTEL_* and Halo\'s tuning knobs do', () => {
    const tuning = {
      HALO_MAX_CONTEXT_TOKENS: '200000', HALO_SHELL_TIMEOUT: '300000', HALO_WEB_FETCH_TIMEOUT: '20000', HALO_MODEL_TIMEOUT: '900000', HALO_SESSION_GRACE: '60000',
      HALO_TERMINAL_GRACE: '60000', HALO_MAX_CACHED_SESSIONS: '10', HALO_LOG_MAX_SIZE: '1048576', HALO_LOG_MAX_FILES: '2',
    }
    const env = workerEnv({
      PATH: '/usr/bin', AWS_REGION: 'ap-northeast-1', AWS_DEFAULT_REGION: 'ap-northeast-1', HALO_LOG_LEVEL: 'info',
      HALO_A2A_ACCESS: 'full', HALO_A2A_PUBLIC_URL: 'https://x', OTEL_SERVICE_NAME: 's', OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'true', AGENT_OBSERVABILITY_ENABLED: 'true',
      AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.2/x', ...tuning,
      FEISHU_APP_SECRET: 's1', SLACK_BOT_TOKEN: 's2', TELEGRAM_BOT_TOKEN: 's3', WECOM_WEBHOOK_KEY: 's4', WECOM_BOT_SECRET: 's5', OPENAI_API_KEY: 'sk-x',
      HALO_AGENTCORE_NOTIFY: 'python3 /opt/notify.py', HALO_AGENTCORE_SESSION_DIRS: '1', HALO_WORKSPACE: '/mnt/efs', HALO_PORT: '8080', HOME: '/root', HALO_PASSWORD: 'p',
      HALO_JWT_SECRET: 'j', HALO_BADGE: 'DEV',
    }, { url: 'http://127.0.0.1:4000', token: 't0k' })
    expect(env).toEqual({
      PATH: '/usr/bin', AWS_REGION: 'ap-northeast-1', AWS_DEFAULT_REGION: 'ap-northeast-1', HALO_LOG_LEVEL: 'info',
      HALO_A2A_ACCESS: 'full', HALO_A2A_PUBLIC_URL: 'https://x', OTEL_SERVICE_NAME: 's', OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'true', AGENT_OBSERVABILITY_ENABLED: 'true',
      AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.2/x', ...tuning,
      HOME: '/home/node', [FRONT_URL_ENV]: 'http://127.0.0.1:4000', [FRONT_TOKEN_ENV]: 't0k',
    })
    expect(workerEnv({}, { url: 'u', token: 't' }).PATH).toMatch(/\/usr\/bin/)
  })

  it('MEDIA copy: only a regular file opened under the root, ≤ the cap, is copied; symlinks out, dirs, oversize, relative and missing are dropped', async () => {
    const root = join(base, 'ws')
    const outside = join(base, 'outside')
    const dest = join(base, 'dest')
    mkdirSync(join(root, 'out'), { recursive: true })
    mkdirSync(outside)
    mkdirSync(dest, { mode: 0o700 })
    writeFileSync(join(root, 'out', 'a.mp3'), 'audio')
    writeFileSync(join(root, 'out', 'big.bin'), Buffer.alloc(64))
    writeFileSync(join(outside, 'secret.txt'), 'b')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'out', 'link.txt'))
    symlinkSync(outside, join(root, 'dirlink'))
    symlinkSync(join(root, 'out', 'a.mp3'), join(root, 'inner.mp3'))

    const one = (p: string, max?: number) => copyMediaFile(p, root, join(dest, `f${Math.random()}`), max)
    expect(await one(join(root, 'out', 'a.mp3'))).toBeNull()
    expect(await one(join(root, 'inner.mp3'))).toBeNull() // a symlink that stays inside is fine
    expect(await one(join(root, 'out', 'link.txt'))).toMatch(/not under/)
    expect(await one(join(root, 'dirlink', 'secret.txt'))).toMatch(/not under/)
    expect(await one(join(root, 'out', '..', '..', 'outside', 'secret.txt'))).toMatch(/not under/)
    expect(await one(join(root, 'out'))).toMatch(/not a regular file/)
    expect(await one(join(root, 'out', 'big.bin'), 63)).toMatch(/larger than 63 bytes/)
    expect(await one(join(root, 'out', 'big.bin'), 64)).toBeNull()
    expect(await one('out/a.mp3')).toMatch(/absolute/)
    expect(await one(join(root, 'nope.mp3'))).toMatch(/cannot open \(ENOENT\)/)
    expect(await one('/proc/1/environ')).toMatch(/not under|cannot open/)

    const text = [
      'Today\'s phrase.',
      `MEDIA:${root}/out/a.mp3`,
      `MEDIA: ${root}/out/a.mp3 `,
      `MEDIA:${root}/out/link.txt`,
      `MEDIA:${root}/out`,
      `not MEDIA:${root}/out/a.mp3`,
    ].join('\n')
    const rewritten = (await copyMediaLines(text, root, dest, 'inv_1')).split('\n')
    expect(rewritten).toEqual(['Today\'s phrase.', `MEDIA:${dest}/0/a.mp3`, `MEDIA:${dest}/1/a.mp3`, `not MEDIA:${root}/out/a.mp3`])
    expect(readFileSync(join(dest, '0', 'a.mp3'), 'utf8')).toBe('audio')
    expect(readdirSync(dest).filter((f) => !f.startsWith('f')).sort()).toEqual(['0', '1'])
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

  it('new session dir: ids up to 255 chars build — the temp dir name no longer carries the id (NAME_MAX)', () => {
    mkdirSync(join(base, '.template'))
    writeFileSync(join(base, '.template', 'INSTRUCTIONS.md'), 'i')
    for (const n of [241, 255]) {
      const sid = 'a'.repeat(n)
      expect('sid' in parseSessionHeader(sid), String(n)).toBe(true)
      expect(ensureSessionDir(base, sid, null), String(n)).toBe(true)
      expect(readFileSync(join(base, sid, 'INSTRUCTIONS.md'), 'utf8')).toBe('i')
    }
    expect(readdirSync(base).filter((f) => f.startsWith('.tmp-'))).toEqual([])
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
  if (req.url === '/' && req.headers['x-cut']) {
    // A stream that began, then the worker's socket dies mid-body.
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: one\\n\\n')
    setTimeout(() => res.socket.destroy(), 100)
    return
  }
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
    setTimeout(async () => { busy = false; await post('/notify', { id: 'i1', session: 'inv_1', status: 'ok', text: 'done\\nMEDIA:' + process.env.MEDIA_FILE }) }, 100)
    return
  }
  res.writeHead(418); res.end('{}')
}).listen(Number(process.env.WORKER_PORT), '127.0.0.1', () => { post('/ready', {}) })
`

describe('front', () => {
  let front: Awaited<ReturnType<typeof startAgentCoreFront>> | null = null
  let exits: number[] = []
  let spawned: Array<{ env: Record<string, string> }> = []
  let setups: Array<[string, string]> = []
  let mounted = true
  let setupFails = false
  let out = ''
  const prevNotify = process.env.HALO_AGENTCORE_NOTIFY

  // The hook (run by the front, as the deployer configured it) records what
  // it got: stdin, the validated env, its workspace's mode, each MEDIA file.
  const HOOK = [
    'cat > "$NOTIFY_OUT/stdin"',
    'printf "%s|%s" "$HALO_SESSION_ID" "$HALO_RUN_STATUS" > "$NOTIFY_OUT/env"',
    'printf "%s|%s|%s" "$HALO_WORKSPACE" "$(pwd)" "$(stat -c %a "$HALO_WORKSPACE")" > "$NOTIFY_OUT/ws"',
    'for f in $(sed -n "s/^MEDIA://p" "$NOTIFY_OUT/stdin"); do cat "$f" >> "$NOTIFY_OUT/media.part"; done',
    // Last, by rename: a reader never sees a half-written file.
    'mv "$NOTIFY_OUT/media.part" "$NOTIFY_OUT/media"',
  ].join('; ')

  // No bind mount here: the stand-in view is the session dir itself.
  async function start(opts: { readyTimeoutMs?: number; worker?: string } = {}) {
    // Per front: a closed front's SIGKILLed worker reports late, never into the next test.
    const myExits: number[] = []
    exits = myExits
    spawned = []
    setups = []
    out = join(base, '..', `${base.split('/').pop()}-out`)
    mkdirSync(out, { recursive: true })
    process.env.NOTIFY_OUT = out
    process.env.HALO_AGENTCORE_NOTIFY = HOOK
    const workerPort = 20000 + Math.floor(Math.random() * 20000)
    front = await startAgentCoreFront({
      base, port: 0, host: '127.0.0.1', workerPort, readyTimeoutMs: opts.readyTimeoutMs ?? 5000,
      viewRoot: join(base, SID_A),
      isMounted: () => mounted,
      setupView: async (b, dir) => {
        setups.push([b, dir])
        // The real setup over a base whose layers never pop.
        if (setupFails) await runViewSetup(b, dir, stackedBase(TWO_LAYERS.map((l) => l.replaceAll('/mnt/efs', b)), { stuck: true }).deps)
      },
      spawnWorker: ({ env, workerPort: wp }): ChildProcess => {
        spawned.push({ env })
        return spawn(process.execPath, ['-e', opts.worker ?? FAKE_WORKER], { env: { ...env, WORKER_PORT: String(wp), MEDIA_FILE: join(base, SID_A, 'out', 'a.mp3') }, stdio: 'ignore' })
      },
      onWorkerExit: (code) => { myExits.push(code) },
    })
    return `http://127.0.0.1:${(front.server.address() as { port: number }).port}`
  }

  afterEach(() => {
    front?.close()
    front = null
    mounted = true
    setupFails = false
    rmSync(out, { recursive: true, force: true })
    delete process.env.NOTIFY_OUT
    if (prevNotify === undefined) delete process.env.HALO_AGENTCORE_NOTIFY
    else process.env.HALO_AGENTCORE_NOTIFY = prevNotify
  })

  /** As the agent could: it can read the worker's env, so it has the token. */
  const loopbackPost = (route: string, body: unknown) =>
    fetch(`${spawned[0].env[FRONT_URL_ENV]}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', [FRONT_TOKEN_HEADER]: spawned[0].env[FRONT_TOKEN_ENV] }, body: JSON.stringify(body) })

  const inv = (url: string, sid?: string, body: unknown = { prompt: 'hi' }) =>
    fetch(`${url}/invocations`, { method: 'POST', headers: { 'content-type': 'application/json', ...(sid ? { [SESSION_HEADER]: sid } : {}) }, body: JSON.stringify(body) })

  async function until(cond: () => boolean, ms = 5000): Promise<void> {
    const end = Date.now() + ms
    while (!cond()) {
      if (Date.now() > end) throw new Error('timed out waiting')
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  it('first request: session dir created, view set up once, worker spawned with the allowlisted env, request proxied; /ping passes the worker\'s answer through', async () => {
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
      expect(setups).toEqual([[base, join(base, SID_A)]])
      expect(existsSync(join(base, SID_A))).toBe(true)
      expect(await (await fetch(`${url}/ping`)).json()).toEqual({ status: 'HealthyBusy' })

      // The worker's notify comes back over loopback; the hook runs here, its
      // MEDIA a copy (out/a.mp3 came from .template) in a 0700 dir that is
      // also its HALO_WORKSPACE + cwd, removed once the hook is done.
      await until(() => existsSync(join(out, 'ws')) && readFileSync(join(out, 'ws'), 'utf8').length > 0)
      await until(() => existsSync(join(out, 'media')))
      expect(readFileSync(join(out, 'env'), 'utf8')).toBe('inv_1|ok')
      const [ws, cwd, mode] = readFileSync(join(out, 'ws'), 'utf8').split('|')
      expect(cwd).toBe(ws)
      expect(mode).toBe('700')
      expect(readFileSync(join(out, 'stdin'), 'utf8')).toBe(`done\nMEDIA:${ws}/0/a.mp3`)
      expect(readFileSync(join(out, 'media'), 'utf8')).toBe('x')
      await until(() => !existsSync(ws))
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

  it('view setup fails (the base never unmounts) → 503 for this and every later request, the worker never spawned, setup never retried', async () => {
    setupFails = true
    const url = await start()
    const r1 = await inv(url, SID_A)
    expect(r1.status).toBe(503)
    expect(((await r1.json()) as { error: string }).error).toMatch(/still has 2 mount\(s\) after 5 × umount -l/)
    setupFails = false
    expect((await inv(url, SID_A)).status).toBe(503)
    expect(setups).toHaveLength(1)
    expect(spawned).toEqual([])
    expect(exits).toEqual([])
  })

  it('loopback /notify: every field is agent-controlled — session regex, status enum, string text; nothing after /ready but /notify', async () => {
    const url = await start()
    expect((await inv(url, SID_A)).status).toBe(200)
    for (const bad of [
      { session: 'inv_1; touch /tmp/x', status: 'ok', text: '' },
      { session: '$(id)', status: 'ok', text: '' },
      { session: 'a'.repeat(201), status: 'ok', text: '' },
      { session: 'inv_1', status: 'ok\nHALO_X=1', text: '' },
      { session: 'inv_1', status: 'done', text: '' },
      { session: 'inv_1', status: 'ok', text: ['x'] },
    ]) expect((await loopbackPost('/notify', bad)).status, JSON.stringify(bad)).toBe(400)
    expect((await loopbackPost('/ready', {})).status).toBe(404)
    expect((await loopbackPost('/run', { cmd: 'id' })).status).toBe(404)
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

  it('loopback /notify: a body that parses to null / an array / a scalar → 400, and the front keeps serving', async () => {
    const url = await start()
    expect((await inv(url, SID_A)).status).toBe(200)
    for (const bad of [null, [], [{ session: 'inv_1', status: 'ok', text: '' }], 42, 'inv_1', true]) {
      expect((await loopbackPost('/notify', bad)).status, JSON.stringify(bad)).toBe(400)
    }
    expect((await inv(url, SID_A)).status).toBe(200)
    expect((await loopbackPost('/notify', { session: 'inv_1', status: 'ok', text: 'x' })).status).toBe(202)
  })

  it('notify: the hook dir can\'t be made (tmp full) → logged, not run, and /ping stops reporting busy', async () => {
    const warn = vi.spyOn(console, 'warn')
    const prevTmp = process.env.TMPDIR
    try {
      const url = await start()
      process.env.TMPDIR = join(base, 'no-such-tmp')
      expect((await inv(url, SID_A)).status).toBe(200)
      await until(() => warn.mock.calls.some((c) => /notify inv_1: not run/.test(String(c[0]))))
      let status = ''
      for (let i = 0; i < 100 && status !== 'Healthy'; i++) {
        status = ((await (await fetch(`${url}/ping`)).json()) as { status: string }).status
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(status).toBe('Healthy')
      expect(existsSync(join(out, 'env'))).toBe(false)
    } finally {
      if (prevTmp === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = prevTmp
      warn.mockRestore()
    }
  })

  it('a worker stream cut after it began → the client\'s response ends too, and the front logs it', async () => {
    const warn = vi.spyOn(console, 'warn')
    try {
      const url = await start()
      const res = await fetch(`${url}/`, { method: 'POST', headers: { accept: 'text/event-stream', 'x-cut': '1', [SESSION_HEADER]: SID_A }, body: '{}' })
      const reader = res.body!.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: one\n\n')
      const drain = (async () => { for (;;) if ((await reader.read()).done) return 'done' })().catch(() => 'error')
      const end = await Promise.race([drain, new Promise((r) => setTimeout(() => r('hang'), 3000))])
      expect(end).not.toBe('hang')
      await until(() => warn.mock.calls.some((c) => /worker response cut off mid-stream/.test(String(c[0]))))
    } finally {
      warn.mockRestore()
    }
  })

  it('the client leaves while the worker is starting → nothing is proxied: the worker never sees a connection', async () => {
    const seen = join(base, 'seen.log')
    const url = await start({
      worker: `
const http = require('node:http'), fs = require('node:fs')
const log = (s) => fs.appendFileSync(${JSON.stringify(seen)}, s + '\\n')
const srv = http.createServer((req, res) => { log('req ' + req.url); res.end('{}') })
srv.on('connection', () => log('conn'))
srv.listen(Number(process.env.WORKER_PORT), '127.0.0.1', () => setTimeout(async () => {
  const r = await fetch(process.env.${FRONT_URL_ENV} + '/ready', { method: 'POST', headers: { '${FRONT_TOKEN_HEADER}': process.env.${FRONT_TOKEN_ENV} }, body: '{}' })
  log('ready ' + r.status)
}, 400))
`,
    })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    await expect(fetch(`${url}/invocations`, { method: 'POST', headers: { [SESSION_HEADER]: SID_A }, body: '{}', signal: ac.signal })).rejects.toThrow()
    await until(() => existsSync(seen) && readFileSync(seen, 'utf8').includes('ready 200'))
    await new Promise((r) => setTimeout(r, 200))
    expect(readFileSync(seen, 'utf8')).toBe('ready 200\n')
    // The next request is served as usual.
    expect((await inv(url, SID_A)).status).toBe(200)
    expect(readFileSync(seen, 'utf8')).toMatch(/conn\nreq \/invocations\n$/)
  })

  it('the worker exits while a notify hook runs → the front exits only once the hook is done', async () => {
    const url = await start({
      worker: `
const http = require('node:http')
const post = (route, body) => fetch(process.env.${FRONT_URL_ENV} + route, { method: 'POST', headers: { '${FRONT_TOKEN_HEADER}': process.env.${FRONT_TOKEN_ENV} }, body: JSON.stringify(body) })
http.createServer(async (req, res) => {
  for await (const _c of req) {}
  res.end('{}')
  if (req.url === '/invocations') { await post('/notify', { session: 'inv_1', status: 'ok', text: 'done' }); process.exit(3) }
}).listen(Number(process.env.WORKER_PORT), '127.0.0.1', () => { post('/ready', {}) })
`,
    })
    process.env.HALO_AGENTCORE_NOTIFY = 'sleep 1; touch "$NOTIFY_OUT/hookdone"'
    expect((await inv(url, SID_A)).status).toBe(200)
    await until(() => front!.worker()?.exitCode !== null)
    expect(exits).toEqual([])
    expect(existsSync(join(out, 'hookdone'))).toBe(false)
    await until(() => exits.length > 0)
    expect(existsSync(join(out, 'hookdone'))).toBe(true)
    expect(exits).toEqual([3])
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
