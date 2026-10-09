import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { createA2ADb, setA2ADb, getA2ADb } from '../src/db/a2a-db.js'
import { createTask, getTask, completeTask, transition } from '../src/a2a/tasks.js'
import { stopPushSender } from '../src/a2a/push.js'
import { createA2ARoutes } from '../src/a2a/routes.js'
import { buildCard, type A2AStrategies } from '../src/a2a/exposure.js'
import { taskJson } from '../src/a2a/wire.js'
import { MAX_IMAGE_BYTES } from '../src/a2a/files.js'
import { buildA2ATools, createA2APushRoutes, setA2AOutboundRegistry, send as sendOut, isLeaseBusy, type Remote } from '../src/a2a/outbound.js'
import type { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'
import { SessionManager } from '../src/agents/session-manager.js'
import type { ToolDef } from '../src/agents/bedrock-agent.js'

/**
 * A2A image parts (plans/a2a.md §5 "Image parts"): inbound raw / url images,
 * limits and refusals, MEDIA: result attachments, ListTasks omission, the
 * result_files migration, a2a_send `files`, and the caller-side report saving.
 */

// 1×1 PNG; a JPEG / GIF only need their magic bytes for the sniffer.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)])
const b64 = (b: Buffer) => b.toString('base64')
/** A PNG of `n` bytes (valid magic, padded). */
const bigPng = (n: number) => Buffer.concat([PNG, Buffer.alloc(n - PNG.length)])

let dir: string
let ws: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'halo-a2a-files-db-'))
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'halo-a2a-files-ws-')))
  setA2ADb(createA2ADb(dir))
})
afterEach(() => {
  stopPushSender()
  getA2ADb()?.close()
  setA2ADb(null)
  rmSync(dir, { recursive: true, force: true })
  rmSync(ws, { recursive: true, force: true })
})

/** Loopback listed in the scratch HOME's global settings (it is not in the default allowlist). */
function allowLoopback(): void {
  mkdirSync(join(homedir(), '.halo', 'secrets'), { recursive: true })
  writeFileSync(join(homedir(), '.halo', 'secrets', 'settings.yaml'), 'general:\n  a2a:\n    url_allowlist: 127.0.0.0/8\n')
}
function clearSettings(): void {
  rmSync(join(homedir(), '.halo', 'secrets', 'settings.yaml'), { force: true })
  rmSync(join(homedir(), '.halo', 'secrets', 'a2a-remotes.yaml'), { force: true })
}

// ── inbound ───────────────────────────────────────────────────────────

describe('inbound SendMessage with image parts', () => {
  let sm: SessionManager
  let sent: Array<{ sid: string; text: string; images?: Array<{ data: string; mimeType: string }> }>
  let appended: string[]
  let server: http.Server
  let base = ''
  let hits: string[]

  beforeEach(async () => {
    allowLoopback()
    sent = []
    appended = []
    hits = []
    sm = new SessionManager(ws)
    Object.assign(sm, {
      createSession: async () => {},
      appendUserMessage: (_sid: string, text: string) => { appended.push(text) },
      sendUserMessage: async (sid: string, text: string, images?: Array<{ data: string; mimeType: string }>) => { sent.push({ sid, text, images }); return 'running' },
    })
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '')
      if (req.url === '/a.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); return }
      if (req.url === '/notype') { res.writeHead(200); res.end(PNG); return }
      if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>'); return }
      if (req.url === '/big.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(bigPng(MAX_IMAGE_BYTES + 1)); return }
      res.writeHead(404); res.end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    clearSettings()
    await new Promise<void>((r) => server.close(() => r()))
  })

  function app() {
    const strategies: A2AStrategies = {
      authenticate: () => ({ ok: true, caller: { accountId: 'acc', label: 'acc', accessLevel: 'workspace' }, workspace: ws }),
      interfaceUrl: () => 'http://h/a2a/x/',
    }
    const registry = { getOrCreate: () => sm } as unknown as SessionManagerRegistry
    const a = new Hono()
    a.route('/a2a', createA2ARoutes({ registry, strategies, ownsRuntimes: true }))
    return a
  }
  const send = (parts: unknown[], messageId = `m-${Math.random()}`) => app().request('/a2a/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { role: 'ROLE_USER', messageId, parts }, configuration: { returnImmediately: true } } }),
  }).then((r) => r.json() as Promise<{ result?: { task: { id: string } }; error?: { code: number; message: string } }>)
  const taskCount = () => (getA2ADb()!.prepare('SELECT COUNT(*) AS n FROM a2a_tasks').get() as { n: number }).n
  const savedPath = (text: string) => /\[图片已保存: (.+)\]/.exec(text)?.[1] ?? ''

  it('raw image: saved under .halo/assets/a2a, passed as vision input, noted in both texts', async () => {
    const res = await send([{ text: 'what colour?' }, { raw: b64(PNG), mediaType: 'image/png', filename: 'dot.png' }])
    expect(res.error).toBeUndefined()
    expect(sent).toHaveLength(1)
    expect(sent[0].images).toEqual([{ data: b64(PNG), mimeType: 'image/png' }])
    const p = savedPath(appended[0])
    expect(p.startsWith(join(ws, '.halo', 'assets', 'a2a', 'inbound', 'acc'))).toBe(true)
    expect(p.endsWith('_dot.png')).toBe(true)
    expect(readFileSync(p).equals(PNG)).toBe(true)
    expect(appended[0]).toBe(`what colour?\n[图片已保存: ${p}]`)
    expect(sent[0].text.endsWith(`\n\nwhat colour?\n[图片已保存: ${p}]`)).toBe(true)
  })

  it('a mislabelled raw image takes the type its bytes say', async () => {
    await send([{ raw: b64(JPEG), mediaType: 'image/png' }])
    expect(sent[0].images?.[0].mimeType).toBe('image/jpeg')
    expect(savedPath(appended[0])).toMatch(/\.jpg$/)
  })

  it('image-only message: valid, the text is just the note', async () => {
    const res = await send([{ raw: b64(PNG), mediaType: 'image/png' }])
    expect(res.error).toBeUndefined()
    expect(appended[0]).toMatch(/^\[图片已保存: .+\.png\]$/)
    expect(sent[0].images).toHaveLength(1)
  })

  it('url image: fetched through the policy; mediaType from Content-Type when the part has none', async () => {
    const res = await send([{ text: 'look' }, { url: `${base}/a.png` }])
    expect(res.error).toBeUndefined()
    expect(hits).toEqual(['/a.png'])
    expect(sent[0].images).toEqual([{ data: b64(PNG), mimeType: 'image/png' }])
    expect(readFileSync(savedPath(appended[0])).equals(PNG)).toBe(true)
    // The part's mediaType stands in for a missing Content-Type.
    expect((await send([{ url: `${base}/notype`, mediaType: 'image/png' }])).error).toBeUndefined()
  })

  it('a messageId retry dedupes onto the task without fetching again', async () => {
    const parts = [{ text: 'look' }, { url: `${base}/a.png` }]
    const r1 = await send(parts, 'dup-1')
    const r2 = await send(parts, 'dup-1')
    expect(r2.result?.task.id).toBe(r1.result?.task.id)
    expect(hits).toEqual(['/a.png'])
    expect(sent).toHaveLength(1)
  })

  it('url failures → -32602 (or -32005 for a non-image), no task created', async () => {
    const cases: Array<[unknown, number, RegExp]> = [
      [{ url: `${base}/missing.png` }, -32602, /HTTP 404/],
      [{ url: `${base}/big.png` }, -32602, /larger than/],
      [{ url: `${base}/page` }, -32005, /text\/html/],
      [{ url: 'http://169.254.169.254/x.png' }, -32602, /link-local/],
    ]
    for (const [part, code, msg] of cases) {
      const res = await send([{ text: 'x' }, part])
      expect(res.error?.code).toBe(code)
      expect(res.error?.message).toMatch(msg)
    }
    expect(taskCount()).toBe(0)
    expect(sent).toHaveLength(0)
  })

  it('limits: >5 MB per image, >10 MB total → -32602, no task', async () => {
    const one = await send([{ raw: b64(bigPng(MAX_IMAGE_BYTES + 1)), mediaType: 'image/png' }])
    expect(one.error).toMatchObject({ code: -32602 })
    expect(one.error?.message).toMatch(/larger than 5 MB/)
    // 3 × 3.5 MB: under each cap and the 16 MB body, over the 10 MB total.
    const three = Array.from({ length: 3 }, () => ({ raw: b64(bigPng(3.5 * 1024 * 1024)), mediaType: 'image/png' }))
    const total = await send(three)
    expect(total.error).toMatchObject({ code: -32602 })
    expect(total.error?.message).toMatch(/10 MB in total/)
    expect(taskCount()).toBe(0)
  })

  it('unsupported mime, non-image bytes and data parts → -32005 naming the supported types', async () => {
    for (const part of [
      { raw: b64(Buffer.from('%PDF-1.4')), mediaType: 'application/pdf' },
      { raw: b64(Buffer.from('not an image')), mediaType: 'image/png' },
      { data: { a: 1 }, mediaType: 'application/json' },
      { url: `${base}/a.png`, mediaType: 'image/bmp' },
    ]) {
      const res = await send([{ text: 'x' }, part])
      expect(res.error?.code).toBe(-32005)
      expect(res.error?.message).toMatch(/image\/jpeg, image\/png, image\/gif, image\/webp/)
    }
    expect(taskCount()).toBe(0)
    expect(hits).toEqual([])
  })

  it('card advertises text + the four image types both ways', () => {
    mkdirSync(join(ws, '.halo'), { recursive: true })
    writeFileSync(join(ws, '.halo', 'agent-card.json'), JSON.stringify({ name: 'n', description: 'd', skills: [] }))
    const card = buildCard(ws, 'http://h/', { streaming: true })
    const modes = ['text/plain', 'image/jpeg', 'image/png', 'image/gif', 'image/webp']
    expect(card.defaultInputModes).toEqual(modes)
    expect(card.defaultOutputModes).toEqual(modes)
  })
})

// ── our results ───────────────────────────────────────────────────────

describe('result MEDIA: lines → artifact file parts', () => {
  const task = () => createTask({ workspace: ws, contextId: 'a2a_acc_r', accountId: 'acc', messageId: null })

  it('attached as { raw, mediaType, filename }, marker stripped; a refused path gets a note', () => {
    mkdirSync(join(ws, 'out'), { recursive: true })
    writeFileSync(join(ws, 'out', 'chart.png'), PNG)
    writeFileSync(join(ws, 'out', 'notes.txt'), 'hi')
    const t = task()
    completeTask(t.id, {
      finalOutput: `Here it is.\nMEDIA:${join(ws, 'out', 'chart.png')}\nMEDIA:${join(ws, 'out', 'notes.txt')}\nMEDIA:${join(ws, 'out', 'gone.png')}`,
      output: '', turnError: null, turnErrorKind: null, accessLevel: 'workspace',
    })
    const row = getTask(t.id)!
    expect(row.state).toBe('completed')
    expect(row.result).toBe('Here it is.\n\n[file not attached: notes.txt — not a supported image (image/jpeg, image/png, image/gif, image/webp)]\n[file not attached: gone.png — file not found]')
    const art = (taskJson(row) as { artifacts: Array<{ parts: unknown[] }> }).artifacts[0]
    expect(art.parts).toEqual([{ text: row.result }, { filename: 'chart.png', mediaType: 'image/png', raw: b64(PNG) }])
  })

  it('serialization never touches the disk: bytes are read once, at completion', () => {
    const f = join(ws, 'once.png')
    writeFileSync(f, PNG)
    const t = task()
    completeTask(t.id, { finalOutput: `MEDIA:${f}`, output: '', turnError: null, turnErrorKind: null, accessLevel: null })
    rmSync(f)
    const art = (taskJson(getTask(t.id)!) as { artifacts: Array<{ parts: Array<Record<string, unknown>> }> }).artifacts[0]
    expect(art.parts[1]).toMatchObject({ filename: 'once.png', raw: b64(PNG) })
    expect(art.parts[0]).toEqual({ text: '' })
  })

  it('sandbox: a workspace session cannot attach outside the workspace / temp dir (even via a symlink); full can', () => {
    // Everything in a test lives under the OS temp dir (which is allowed): point it elsewhere.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'halo-a2a-sbx-')))
    const realTmp = process.env.TMPDIR
    mkdirSync(join(root, 'tmp'))
    mkdirSync(join(root, 'other'))
    process.env.TMPDIR = join(root, 'tmp')
    try {
      const elsewhere = join(root, 'other', 'elsewhere.png')
      writeFileSync(elsewhere, PNG)
      symlinkSync(elsewhere, join(ws, 'link.png'))
      writeFileSync(join(ws, 'inside.png'), PNG)
      const t1 = task()
      completeTask(t1.id, { finalOutput: `x\nMEDIA:${elsewhere}\nMEDIA:${join(ws, 'link.png')}\nMEDIA:${join(ws, 'inside.png')}`, output: '', turnError: null, turnErrorKind: null, accessLevel: 'readonly' })
      const r1 = getTask(t1.id)!
      expect(JSON.parse(r1.result_files!).map((f: { filename: string }) => f.filename)).toEqual(['inside.png'])
      expect(r1.result).toBe('x\n\n[file not attached: elsewhere.png — outside the workspace and the temp dir]\n[file not attached: link.png — links outside the workspace and the temp dir]')
      const t2 = createTask({ workspace: ws, contextId: 'c2', accountId: 'acc', messageId: null })
      completeTask(t2.id, { finalOutput: `MEDIA:${elsewhere}`, output: '', turnError: null, turnErrorKind: null, accessLevel: null })
      expect(JSON.parse(getTask(t2.id)!.result_files!)).toHaveLength(1)
    } finally {
      if (realTmp === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = realTmp
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('limits: >5 MB file and past the 10 MB total are noted, not attached', () => {
    const files = ['a', 'b', 'c'].map((n) => { const f = join(ws, `${n}.png`); writeFileSync(f, bigPng(4 * 1024 * 1024)); return f })
    const big = join(ws, 'big.png')
    writeFileSync(big, bigPng(MAX_IMAGE_BYTES + 1))
    const t = task()
    completeTask(t.id, { finalOutput: [big, ...files].map((f) => `MEDIA:${f}`).join('\n'), output: '', turnError: null, turnErrorKind: null, accessLevel: 'workspace' })
    const row = getTask(t.id)!
    expect(JSON.parse(row.result_files!).map((f: { filename: string }) => f.filename)).toEqual(['a.png', 'b.png'])
    expect(row.result).toBe('[file not attached: big.png — larger than 5 MB]\n[file not attached: c.png — would exceed the 10 MB total]')
  })

  it('a failed turn attaches its partial output\'s images too ("partial" artifact)', () => {
    const f = join(ws, 'p.png')
    writeFileSync(f, PNG)
    const t = task()
    completeTask(t.id, { finalOutput: '', output: `half done\nMEDIA:${f}`, turnError: 'boom', turnErrorKind: null, accessLevel: 'workspace' })
    const art = (taskJson(getTask(t.id)!) as { artifacts: Array<{ artifactId: string; parts: unknown[] }> }).artifacts[0]
    expect(art.artifactId).toBe('partial')
    expect(art.parts).toEqual([{ text: 'half done' }, { filename: 'p.png', mediaType: 'image/png', raw: b64(PNG) }])
  })

  it('a task that is already terminal reads no files', () => {
    const f = join(ws, 'late.png')
    writeFileSync(f, PNG)
    const t = task()
    transition(t.id, 'canceled', { statusText: 'x' })
    completeTask(t.id, { finalOutput: `MEDIA:${f}`, output: '', turnError: null, turnErrorKind: null, accessLevel: null })
    expect(getTask(t.id)!.result_files).toBeNull()
  })

  it('push payload and ListTasks carry no file bytes (counted in halo/omittedFiles); GetTask does', async () => {
    const f = join(ws, 'l.png')
    writeFileSync(f, PNG)
    const t = task()
    // push config so the outbox records the payload (refused literal: no network).
    const { putPushConfig } = await import('../src/a2a/tasks.js')
    putPushConfig(t.id, { url: 'http://10.255.255.1/hook' })
    completeTask(t.id, { finalOutput: `done\nMEDIA:${f}`, output: '', turnError: null, turnErrorKind: null, accessLevel: null })
    const payload = JSON.parse((getA2ADb()!.prepare('SELECT payload FROM a2a_push_outbox WHERE task_id = ?').get(t.id) as { payload: string }).payload)
    expect(payload.task.artifacts[0]).toEqual({ artifactId: 'result', name: 'result', parts: [{ text: 'done' }], metadata: { 'halo/omittedFiles': 1 } })
    expect(JSON.stringify(payload)).not.toContain(b64(PNG))

    const strategies: A2AStrategies = {
      authenticate: () => ({ ok: true, caller: { accountId: 'acc', label: 'acc', accessLevel: 'full' }, workspace: ws }),
      interfaceUrl: () => 'http://h/',
    }
    const sm = new SessionManager(ws)
    const a = new Hono()
    a.route('/a2a', createA2ARoutes({ registry: { getOrCreate: () => sm } as unknown as SessionManagerRegistry, strategies, ownsRuntimes: true }))
    const rpc = (method: string, params: unknown) => a.request('/a2a/x', {
      method: 'POST', headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }).then((r) => r.json() as Promise<{ result: Record<string, any> }>)
    const list = await rpc('ListTasks', { includeArtifacts: true })
    expect(list.result.tasks[0].artifacts[0]).toEqual({ artifactId: 'result', name: 'result', parts: [{ text: 'done' }], metadata: { 'halo/omittedFiles': 1 } })
    const got = await rpc('GetTask', { id: t.id })
    expect(got.result.artifacts[0].parts).toEqual([{ text: 'done' }, { raw: b64(PNG), mediaType: 'image/png', filename: 'l.png' }])
  })
})

describe('a2a.db migration', () => {
  it('an old db (no result_files, user_version 0) gains the column; existing rows read null', () => {
    const old = mkdtempSync(join(tmpdir(), 'halo-a2a-old-'))
    getA2ADb()?.close()
    const legacy = new Database(join(old, 'a2a.db'))
    legacy.exec(`CREATE TABLE a2a_tasks (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, context_id TEXT NOT NULL, account_id TEXT NOT NULL,
      message_id TEXT, state TEXT NOT NULL, status_text TEXT, error_kind TEXT, result TEXT, interim_seq INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
    legacy.prepare(`INSERT INTO a2a_tasks (id, workspace, context_id, account_id, state, result, created_at, updated_at) VALUES ('t0', '/w', 'c', 'acc', 'completed', 'old', 1, 1)`).run()
    legacy.close()
    const db = createA2ADb(old)
    setA2ADb(db)
    const cols = (db.prepare('PRAGMA table_info(a2a_tasks)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toContain('result_files')
    expect(db.pragma('user_version', { simple: true })).toBe(1)
    expect((taskJson(getTask('t0')!) as { artifacts: unknown[] }).artifacts).toEqual([{ artifactId: 'result', name: 'result', parts: [{ text: 'old' }] }])
    // Re-open: the slot has run, nothing re-applied.
    db.close()
    setA2ADb(createA2ADb(old))
    expect(getA2ADb()!.pragma('user_version', { simple: true })).toBe(1)
    rmSync(old, { recursive: true, force: true })
  })
})

// ── outbound ──────────────────────────────────────────────────────────

describe('outbound: a2a_send files and report saving', () => {
  let remote: http.Server
  let rpcBodies: Array<Record<string, any>>
  let getTaskResult: Record<string, unknown>
  let reports: string[]
  let push: Hono

  beforeEach(async () => {
    rpcBodies = []
    reports = []
    remote = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const port = (remote.address() as AddressInfo).port
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ name: 'r', supportedInterfaces: [{ url: `http://127.0.0.1:${port}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] }))
          return
        }
        const j = JSON.parse(body) as Record<string, any>
        rpcBodies.push(j)
        const result = j.method === 'GetTask' ? getTaskResult : { task: { id: 'rt-1', contextId: 'rc-1', status: { state: 'TASK_STATE_WORKING' } } }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result }))
      })
    })
    await new Promise<void>((r) => remote.listen(0, '127.0.0.1', r))
    const port = (remote.address() as AddressInfo).port
    mkdirSync(join(homedir(), '.halo', 'secrets'), { recursive: true })
    writeFileSync(join(homedir(), '.halo', 'secrets', 'settings.yaml'),
      `general:\n  a2a:\n    url_allowlist: 127.0.0.0/8\n    public_url: http://127.0.0.1:1\na2a:\n  secrets:\n    peer: tok-${port}\n`)
    writeFileSync(join(homedir(), '.halo', 'secrets', 'a2a-remotes.yaml'), `remotes:\n  peer:\n    card: http://127.0.0.1:${port}/card-${port}\n`)
    setA2AOutboundRegistry({ getOrCreate: () => ({ appendUserMessage: () => {}, sendUserMessage: async (_s: string, m: string) => { reports.push(m); return 'running' } }) })
    push = new Hono()
    push.route('/', createA2APushRoutes())
  })
  afterEach(async () => {
    clearSettings()
    await new Promise<void>((r) => remote.close(() => r()))
  })

  const tool = (name: string, level: 'readonly' | 'workspace' | null = null): ToolDef => buildA2ATools(ws, 'caller-1', level).find((t) => t.name === name)!
  const call = async (name: string, input: unknown, level: 'readonly' | 'workspace' | null = null) => JSON.parse(await tool(name, level).callback(input) as string) as Record<string, any>

  it('remotes come only from ~/.halo/secrets/a2a-remotes.yaml; a <ws>/.halo/a2a-remotes.yaml is ignored', async () => {
    mkdirSync(join(ws, '.halo'), { recursive: true })
    writeFileSync(join(ws, '.halo', 'a2a-remotes.yaml'), 'remotes:\n  rogue:\n    card: https://example.com/card.json\n  peer:\n    card: https://example.com/peer-card.json\n')
    const r = await call('a2a_send', { remote: 'rogue', message: 'x' })
    expect(r.error).toBe('unknown remote "rogue" — configured: peer')
    expect((await call('a2a_list', {})).remotes.map((x: { name: string }) => x.name)).toEqual(['peer'])
    // `peer` still resolves to the global entry, not the workspace's card URL.
    expect((await call('a2a_send', { remote: 'peer', message: 'x' })).code).toBe(0)
    expect(rpcBodies.filter((b) => b.method === 'SendMessage')).toHaveLength(1)
    rmSync(join(homedir(), '.halo', 'secrets', 'a2a-remotes.yaml'))
    expect((await call('a2a_send', { remote: 'peer', message: 'x' })).error).toBe('unknown remote "peer" — configured: (none; add ~/.halo/secrets/a2a-remotes.yaml — full access to edit)')
  })

  it('files → { raw, mediaType, filename } parts after the text', async () => {
    const f = join(ws, 'q.png')
    writeFileSync(f, PNG)
    const r = await call('a2a_send', { remote: 'peer', message: 'what is this?', files: [f] })
    expect(r.code).toBe(0)
    const sendRpc = rpcBodies.find((b) => b.method === 'SendMessage')!
    expect(sendRpc.params.message.parts).toEqual([{ text: 'what is this?' }, { raw: b64(PNG), mediaType: 'image/png', filename: 'q.png' }])
  })

  it('a bad file is a tool error and nothing is sent', async () => {
    const txt = join(ws, 'a.txt')
    writeFileSync(txt, 'x')
    const big = join(ws, 'big.png')
    writeFileSync(big, bigPng(MAX_IMAGE_BYTES + 1))
    const fakePng = join(ws, 'fake.png')
    writeFileSync(fakePng, 'not png')
    const cases: Array<[unknown, RegExp]> = [
      ['relative.png', /path is not absolute/],
      [join(ws, 'missing.png'), /file not found/],
      [txt, /not a supported image/],
      [big, /larger than 5 MB/],
      [fakePng, /content is not a/],
    ]
    for (const [f, msg] of cases) {
      const r = await call('a2a_send', { remote: 'peer', message: 'x', files: [f] })
      expect(r.code).toBe(1)
      expect(r.error).toMatch(msg)
      expect(r.error).toMatch(/nothing was sent/)
    }
    const many = ['1', '2', '3'].map((n) => { const p = join(ws, `m${n}.png`); writeFileSync(p, bigPng(4 * 1024 * 1024)); return p })
    expect((await call('a2a_send', { remote: 'peer', message: 'x', files: many })).error).toMatch(/10 MB total/)
    expect(rpcBodies).toHaveLength(0)
  })

  it('files sandbox: a non-full caller cannot attach outside the workspace / temp dir (even via a symlink); full can', async () => {
    // Everything in a test lives under the OS temp dir (which is allowed): point it elsewhere.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'halo-a2a-out-sbx-')))
    const realTmp = process.env.TMPDIR
    mkdirSync(join(root, 'tmp'))
    mkdirSync(join(root, 'other'))
    process.env.TMPDIR = join(root, 'tmp')
    try {
      const elsewhere = join(root, 'other', 'elsewhere.png')
      writeFileSync(elsewhere, PNG)
      symlinkSync(elsewhere, join(ws, 'link.png'))
      writeFileSync(join(ws, 'inside.png'), PNG)
      writeFileSync(join(root, 'tmp', 'scratch.png'), PNG)
      for (const level of ['workspace', 'readonly'] as const) {
        const out = await call('a2a_send', { remote: 'peer', message: 'x', files: [elsewhere] }, level)
        expect(out.error).toBe(`files: ${elsewhere}: outside the workspace and the temp dir — nothing was sent`)
        const link = await call('a2a_send', { remote: 'peer', message: 'x', files: [join(ws, 'link.png')] }, level)
        expect(link.error).toMatch(/links outside the workspace and the temp dir — nothing was sent$/)
      }
      expect(rpcBodies).toHaveLength(0)
      const ok = await call('a2a_send', { remote: 'peer', message: 'x', files: [join(ws, 'inside.png'), join(root, 'tmp', 'scratch.png')] }, 'workspace')
      expect(ok.code).toBe(0)
      expect(await call('a2a_send', { remote: 'peer', message: 'x', files: [elsewhere, join(ws, 'link.png')] }, null)).toMatchObject({ code: 0 })
      const sent = rpcBodies.filter((b) => b.method === 'SendMessage').map((b) => b.params.message.parts.map((q: { filename?: string }) => q.filename).filter(Boolean))
      expect(sent).toEqual([['inside.png', 'scratch.png'], ['elsewhere.png', 'link.png']])
    } finally {
      if (realTmp === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = realTmp
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('[A2A report] + a2a_read: raw images saved with a path line, url parts listed, not fetched', async () => {
    await call('a2a_send', { remote: 'peer', message: 'draw' })
    const dispatch = getA2ADb()!.prepare('SELECT push_id, push_token FROM a2a_dispatches').get() as { push_id: string; push_token: string }
    const resultTask = {
      id: 'rt-1', contextId: 'rc-1', status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: [{ artifactId: 'result', name: 'result', parts: [
        { text: 'Here.' },
        { raw: b64(PNG), mediaType: 'image/png', filename: 'out.png' },
        { url: 'https://example.com/x.png', mediaType: 'image/png' },
        { raw: b64(Buffer.from('%PDF')), mediaType: 'application/pdf', filename: 'doc.pdf' },
      ] }],
    }
    // The push is a doorbell: the report comes from our GetTask.
    getTaskResult = resultTask
    const res = await push.request(`/a2a-push/${dispatch.push_id}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-a2a-notification-token': dispatch.push_token },
      body: JSON.stringify({ task: resultTask }),
    })
    expect(res.status).toBe(200)
    for (let i = 0; i < 50 && reports.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    expect(reports).toHaveLength(1)
    const report = reports[0]
    expect(report).toMatch(/^\[A2A report · remote peer · context rc-1 · task rt-1 · status: completed\]\n\nHere\.\n\n/)
    const saved = /\[图片已保存: (.+)\]/.exec(report)![1]
    expect(saved.startsWith(join(ws, '.halo', 'assets', 'a2a', 'inbound', 'peer'))).toBe(true)
    expect(readFileSync(saved).equals(PNG)).toBe(true)
    expect(report).toContain('[图片: https://example.com/x.png]')
    expect(report).toContain('[file not saved: doc.pdf — application/pdf is not a supported image]')

    const read = await call('a2a_read', { remote: 'peer', task_id: 'rt-1' })
    expect(read.result).toMatch(/^Here\.\n\n\[图片已保存: .+_out\.png\]/)
    expect(existsSync(/\[图片已保存: (.+?)\]/.exec(read.result)![1])).toBe(true)
  })
})

describe('outbound send(): lease-busy retry', () => {
  let server: http.Server
  let url = ''
  let replies: Array<{ status: number; body: unknown }> = []
  let hits = 0
  const remote: Remote = { name: 'r', card: '', auth: 'bearer' }
  const rpcErr = (status: number, code: number, message: string) => ({ status, body: { jsonrpc: '2.0', id: 1, error: { code, message } } })
  // The exact answer of a halo AgentCore container whose lease another microVM holds (agentcore.ts LEASE_BUSY).
  const busy = rpcErr(500, -32603, 'workspace is in use by another runtime session — call with the fixed runtime session id')
  const internal = rpcErr(500, -32603, 'internal error')
  const retryable = rpcErr(409, -32054, 'Session operation in progress, please retry')
  const ok = { status: 200, body: { jsonrpc: '2.0', id: 1, result: { ok: true } } }

  beforeEach(async () => {
    hits = 0
    mkdirSync(join(ws, '.halo'), { recursive: true })
    writeFileSync(join(ws, '.halo', 'settings.yaml'), 'a2a:\n  secrets:\n    r: tok\n')
    allowLoopback()
    server = http.createServer((req, res) => {
      req.resume()
      const r = replies[Math.min(hits, replies.length - 1)]
      hits++
      res.writeHead(r.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(r.body))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  })
  afterEach(async () => {
    clearSettings()
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('isLeaseBusy: only -32603 with the lease message', () => {
    expect(isLeaseBusy(JSON.stringify(busy.body))).toBe(true)
    expect(isLeaseBusy(JSON.stringify(internal.body))).toBe(false)
    expect(isLeaseBusy(JSON.stringify(rpcErr(500, -32000, busy.body.error.message).body))).toBe(false)
    expect(isLeaseBusy('not json')).toBe(false)
  })

  it('lease busy twice, then ok: backoff 5 s → 10 s', async () => {
    replies = [busy, busy, ok]
    const slept: number[] = []
    const res = await sendOut(ws, remote, 'POST', url, '{}', async (ms) => { slept.push(ms) })
    expect(res.status).toBe(200)
    expect(hits).toBe(3)
    expect(slept).toEqual([5000, 10000])
  })

  it('gives up after 4 lease retries (50 s) and returns the last answer', async () => {
    replies = [busy]
    const slept: number[] = []
    const res = await sendOut(ws, remote, 'POST', url, '{}', async (ms) => { slept.push(ms) })
    expect(res.status).toBe(500)
    expect(isLeaseBusy(res.body)).toBe(true)
    expect(hits).toBe(5)
    expect(slept).toEqual([5000, 10000, 15000, 20000])
  })

  it('a plain -32603 is not retried; the conflict schedule is its own', async () => {
    replies = [internal, ok]
    const slept: number[] = []
    expect((await sendOut(ws, remote, 'POST', url, '{}', async (ms) => { slept.push(ms) })).status).toBe(500)
    expect(hits).toBe(1)
    expect(slept).toEqual([])
    hits = 0
    replies = [retryable, busy, retryable, ok]
    expect((await sendOut(ws, remote, 'POST', url, '{}', async (ms) => { slept.push(ms) })).status).toBe(200)
    expect(slept).toEqual([500, 5000, 1000])
  })

  it('an aborted tool call stops waiting and returns the last answer', async () => {
    replies = [busy]
    const ctl = new AbortController()
    const t0 = Date.now()
    setTimeout(() => ctl.abort(), 50)
    const res = await sendOut(ws, remote, 'POST', url, '{}', undefined, ctl.signal)
    expect(isLeaseBusy(res.body)).toBe(true)
    expect(hits).toBe(1)
    expect(Date.now() - t0).toBeLessThan(3000)
  })

  it('Stop ends a retried card fetch: a2a_send / a2a_read / a2a_stop return promptly, no RPC sent', async () => {
    replies = [busy]
    // A fresh card URL per tool, so the in-process card cache can't answer.
    const port = (server.address() as AddressInfo).port
    writeFileSync(join(homedir(), '.halo', 'secrets', 'a2a-remotes.yaml'),
      `remotes:\n${['s', 'g', 'c'].map((n) => `  r${n}:\n    card: http://127.0.0.1:${port}/card-${n}-${Date.now()}\n`).join('')}`)
    writeFileSync(join(homedir(), '.halo', 'secrets', 'settings.yaml'),
      `general:\n  a2a:\n    url_allowlist: 127.0.0.0/8\n    public_url: http://127.0.0.1:1\na2a:\n  secrets:\n    rs: t\n    rg: t\n    rc: t\n`)
    const tools = buildA2ATools(ws, 'caller-1', null)
    for (const [name, input] of [['a2a_send', { remote: 'rs', message: 'x' }], ['a2a_read', { remote: 'rg', task_id: 't' }], ['a2a_stop', { remote: 'rc', task_id: 't' }]] as const) {
      hits = 0
      const ctl = new AbortController()
      const t0 = Date.now()
      setTimeout(() => ctl.abort(), 50)
      const out = JSON.parse(await tools.find((t) => t.name === name)!.callback(input, ctl.signal) as string) as { code: number; error: string }
      expect(out.code).toBe(1)
      expect(out.error).toMatch(/^card fetch .*: HTTP 500/)
      expect(hits).toBe(1)
      expect(Date.now() - t0).toBeLessThan(3000)
    }
  })
})
