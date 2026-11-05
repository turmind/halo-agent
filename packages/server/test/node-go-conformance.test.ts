import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { AddressInfo, Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { Hono } from 'hono'
import { createAdaptorServer } from '@hono/node-server'
import { createChannelDb } from '../src/db/channel-db.js'
import { insertNodeAccount, deleteNodeAccount } from '../src/nodes/accounts.js'
import { createNodeHub, setNodeHub } from '../src/nodes/hub.js'
import { createNodeRoutes } from '../src/nodes/routes.js'
import { createUpgradeRouter } from '../src/ws/upgrade-router.js'
import { clearFailures, recordFailure } from '../src/middleware/brute-force.js'
import * as P from '../src/nodes/protocol.js'

/**
 * Go `halo-node` (packages/node-go) vs the TS `halo node` — the live oracle
 * (plan node-go.md §3). Both run as external processes against one real hub;
 * every case in packages/node-go/conformance/cases/*.json goes to both and the
 * normalized results, written files and `[Node]` log lines must match.
 *   HALO_NODE_GO_BIN=<binary> [HALO_NODE_GO_EXEC="qemu-arm"] [HALO_NODE_GO_SMOKE=1]
 * Skipped without HALO_NODE_GO_BIN, so the main CI is unaffected.
 */

const GO_BIN = process.env.HALO_NODE_GO_BIN
const GO_EXEC = (process.env.HALO_NODE_GO_EXEC ?? '').split(' ').filter(Boolean)
const SMOKE = process.env.HALO_NODE_GO_SMOKE === '1'
const here = path.dirname(fileURLToPath(import.meta.url))
const CASES_DIR = path.join(here, '../../node-go/conformance/cases')
const TS_MAIN = path.join(here, 'helpers/ts-node-main.ts')
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
// qemu-user is 5-20x slower to start and run.
const SLOW = GO_EXEC.length > 0 ? 4 : 1

type Side = 'ts' | 'go'
const SIDES: Side[] = ['ts', 'go']
type Result = { ok: true; text: string } | { ok: false; error: string }
type Entry =
  | { file: string; text?: string; hex?: string; parts?: [string, number][]; pct?: boolean }
  | { dir: string; pct?: boolean }
  | { symlink: string; to: string }
  | { seq: string; pad: number; count: number; text: string }
  | { chmod: string; mode: string }
  | { sparse: string; size: number; text?: string }
interface Case {
  name: string
  calls: { op: string; args: Record<string, unknown> }[]
  setup?: Entry[]
  after?: string[]
  tags?: string[]
  known?: string
  expectGo?: Result[]
}
interface Group {
  group: string
  config: { mode: 'folder' | 'whole'; shell: boolean; env?: Record<string, string> }
  tree: string
  cases: Case[]
}

// ── hub ────────────────────────────────────────────────────────────────────

let tmp = ''
let ws = ''
let db: ReturnType<typeof createChannelDb>
let server: http.Server
let port = 0
let hub: ReturnType<typeof createNodeHub>
let sockets = new Set<Socket>()
/** Per bearer token: handshake headers, the close frame and the text messages each machine sent
 *  (`frames[i]`: how many frames text message i came in). */
interface Seen { headers: http.IncomingHttpHeaders; close?: { code: number; reason: string }; texts: string[]; frames: number[] }
const seen = new Map<string, Seen>()

/** Client→server frames off the raw socket (masked, never compressed); fragments are reassembled. */
function tapFrames(sock: Duplex, rec: Seen): void {
  let buf = Buffer.alloc(0)
  let parts: Buffer[] | null = null // a text message whose FIN frame hasn't come yet
  sock.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d])
    for (;;) {
      if (buf.length < 2) return
      let len = buf[1] & 0x7f
      let off = 2
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
      const masked = (buf[1] & 0x80) !== 0
      const mask = masked ? buf.subarray(off, off + 4) : null
      off += masked ? 4 : 0
      if (buf.length < off + len) return
      const payload = Buffer.from(buf.subarray(off, off + len))
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
      const opcode = buf[0] & 0x0f
      const fin = (buf[0] & 0x80) !== 0
      if (opcode === 8) rec.close = { code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005, reason: payload.subarray(2).toString() }
      else if (opcode === 1 || (opcode === 0 && parts)) {
        parts = [...(opcode === 1 ? [] : parts!), payload]
        if (fin) { rec.texts.push(Buffer.concat(parts).toString('latin1')); rec.frames.push(parts.length); parts = null }
      }
      buf = buf.subarray(off + len)
    }
  })
}

async function startServer(onPort = 0): Promise<void> {
  let app: Hono | null = null
  server = createAdaptorServer({ fetch: (req: Request, env: unknown) => app!.fetch(req, env) }) as http.Server
  sockets = new Set()
  server.on('connection', (s: Socket) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise<void>((r) => server.listen(onPort, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
  hub = createNodeHub({ db, port })
  setNodeHub(hub)
  app = new Hono()
  app.route('/api', createNodeRoutes({ db, hub }))
  const handle = hub.handleUpgrade
  server.on('upgrade', createUpgradeRouter(new Map([[P.NODE_WS_PATH, (req: http.IncomingMessage, sock: Duplex, head: Buffer) => {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '')
    const rec: Seen = { headers: req.headers, texts: [], frames: [] }
    seen.set(token, rec)
    tapFrames(sock, rec)
    handle(req, sock, head)
  }]])))
}

async function stopServer(): Promise<void> {
  hub.close()
  // Let the 1001 close handshake finish before the sockets go (else a side may see 1006).
  await sleep(200)
  for (const s of sockets) s.destroy()
  await new Promise<void>((r) => server.close(() => r()))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Set by spawnSide when a machine binary can't be started at all; every wait fails on it at once. */
let spawnFailure: Error | undefined
async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms * SLOW
  while (!cond()) {
    if (spawnFailure) throw spawnFailure
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(20)
  }
}

function account(name: string, workspace = ws): { token: string; accountId: string } {
  const r = insertNodeAccount(db, { workspacePath: workspace, name })
  if ('error' in r) throw new Error(r.error)
  return r
}

// ── machines ───────────────────────────────────────────────────────────────

interface Proc { side: Side; child: ChildProcess; out: string[]; err: string; exit: Promise<number>; code?: number }

/** Every machine process ever spawned; the outermost afterAll SIGKILLs the survivors, pass or fail. */
const live = new Set<ChildProcess>()

function spawnSide(side: Side, args: string[], env: Record<string, string>, cwd: string): Proc {
  const cmd = side === 'ts'
    ? [process.execPath, '--import', TSX, TS_MAIN, ...args]
    : [...GO_EXEC, GO_BIN!, ...args]
  const child = spawn(cmd[0], cmd.slice(1), {
    cwd,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  live.add(child)
  let partial = ''
  const exit = new Promise<number>((resolve, reject) => {
    // ENOENT / EACCES: no 'exit' ever comes. Reject `exit` and trip until(), so nothing waits out its timeout.
    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnFailure ??= new Error(`cannot start the ${side} machine (${cmd.slice(0, side === 'go' ? GO_EXEC.length + 1 : 1).join(' ')}): ${err.code ?? err.message} — check HALO_NODE_GO_BIN / HALO_NODE_GO_EXEC`)
      reject(spawnFailure)
    })
    // 'close', not 'exit': stdout is drained by then, so an unterminated last line lands in `out` too.
    child.on('close', (code, sig) => {
      live.delete(child)
      if (partial) p.out.push(partial)
      resolve(p.code = code ?? (sig ? 128 : -1))
    })
  })
  exit.catch(() => {}) // awaited by the tests; this only keeps an unawaited one from being "unhandled"
  const p: Proc = { side, child, out: [], err: '', exit }
  child.stdout!.on('data', (d: Buffer) => {
    const lines = (partial + d.toString()).split('\n')
    partial = lines.pop()!
    p.out.push(...lines)
  })
  child.stderr!.on('data', (d: Buffer) => { p.err += d.toString() })
  return p
}

/** kill() on a spawn that failed but hasn't emitted 'error' yet (pid undefined) signals pid 0 —
 *  this whole process group, vitest included. A child that never started has nothing to stop. */
const signal = (c: ChildProcess, sig: NodeJS.Signals) => { if (c.pid !== undefined) c.kill(sig) }

async function term(p: Proc): Promise<number> {
  signal(p.child, 'SIGTERM')
  return p.exit
}

/** `<T>/ts` and `<T>/go` have equal length, so even truncated texts line up. */
const sideDir = (side: Side) => path.join(tmp, side)
function norm(s: string, side: Side): string {
  const d = sideDir(side)
  return s.split(`${d}/root`).join('<ROOT>').split(`${d}/home`).join('<HOME>').split(d).join('<TMP>')
    .split(`127.0.0.1:${port}`).join('<HUB>')
    .replace(/connected as "[a-z0-9-]+"/g, 'connected as "<NAME>"')
    .replace(/reconnecting in \d+\.\ds/g, 'reconnecting in <N>s')
    // D1: the could-not-connect error text is Node's / Go's own.
    .replace(/could not connect \(.*\)/g, 'could not connect (<D1>)')
}
const logLines = (p: Proc, from = 0) => p.out.slice(from).filter((l) => /^\[(Node|WorkspaceTools)\]/.test(l)).map((l) => norm(l, p.side))

function expand(v: unknown, side: Side): unknown {
  const d = sideDir(side)
  if (typeof v === 'string') return v.split('<ROOT>').join(`${d}/root`).split('<TMP>').join(d)
  if (Array.isArray(v)) return v.map((x) => expand(x, side))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x, side)]))
  return v
}

function resetTree(side: Side, entries: Entry[]): void {
  const d = sideDir(side)
  for (const sub of ['root', 'outside', 'home']) {
    const dir = path.join(d, sub)
    if (fs.existsSync(dir)) {
      execFileSync('chmod', ['-R', 'u+rwx', dir])
      for (const e of fs.readdirSync(dir)) fs.rmSync(path.join(dir, e), { recursive: true, force: true })
    } else fs.mkdirSync(dir, { recursive: true })
  }
  const at = (rel: string, pct?: boolean): string | Buffer => pct
    ? Buffer.concat([Buffer.from(`${d}/`), Buffer.from(rel.replace(/%([0-9a-f]{2})/g, (_m, h: string) => `\\x${h}`).split(/(\\x[0-9a-f]{2})/).map((s) => s.startsWith('\\x') ? String.fromCharCode(parseInt(s.slice(2), 16)) : s).join(''), 'latin1')])
    : path.join(d, rel)
  const parentOf = (p: string | Buffer) => typeof p === 'string' ? path.dirname(p) : p.subarray(0, p.lastIndexOf(0x2f))
  const chmods: [string, number][] = []
  for (const e of entries) {
    if ('file' in e) {
      const p = at(e.file, e.pct)
      fs.mkdirSync(parentOf(p), { recursive: true })
      const data = e.hex !== undefined ? Buffer.from(e.hex, 'hex') : e.parts ? e.parts.map(([s, n]) => s.repeat(n)).join('') : e.text ?? ''
      fs.writeFileSync(p, data)
    } else if ('dir' in e) fs.mkdirSync(at(e.dir, e.pct), { recursive: true })
    else if ('symlink' in e) fs.symlinkSync(String(expand(e.to, side)), at(e.symlink) as string)
    else if ('seq' in e) {
      fs.mkdirSync(path.dirname(at(e.seq) as string), { recursive: true })
      for (let i = 0; i < e.count; i++) fs.writeFileSync(`${at(e.seq) as string}${String(i).padStart(e.pad, '0')}`, e.text)
    } else if ('sparse' in e) {
      // `text`, then a hole up to `size` bytes: past fs.readFile's limits without the
      // disk or the write. A text head of ≥512 bytes gets it past isBinary (no NUL in the first 512).
      fs.mkdirSync(path.dirname(at(e.sparse) as string), { recursive: true })
      fs.writeFileSync(at(e.sparse), e.text ?? '')
      fs.truncateSync(at(e.sparse) as string, e.size)
    } else chmods.push([at(e.chmod) as string, parseInt(e.mode, 8)])
  }
  for (const [p, m] of chmods) fs.chmodSync(p, m)
}

/** One call to one machine; results normalized (paths, the machine's own name). */
async function callSide(side: Side, machine: string, op: string, args: Record<string, unknown>): Promise<Result> {
  const fix = (s: string) => norm(s, side).split(`"${machine}"`).join('"<NAME>"')
  try {
    return { ok: true, text: fix(await hub.call(ws, machine, op as P.NodeOp, expand(args, side) as Record<string, unknown>)) }
  } catch (err) {
    return { ok: false, error: fix(err instanceof Error ? err.message : String(err)) }
  }
}

/** Retry lines repeat a timing-dependent number of times: collapse adjacent duplicates. */
const dedupe = (ls: string[]) => ls.filter((l, i) => l !== ls[i - 1])

// ── cases ──────────────────────────────────────────────────────────────────

const trees = JSON.parse(fs.readFileSync(path.join(CASES_DIR, '_trees.json'), 'utf-8')) as Record<string, Entry[]>
const groups: Group[] = fs.readdirSync(CASES_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort()
  .flatMap((f) => JSON.parse(fs.readFileSync(path.join(CASES_DIR, f), 'utf-8')) as Group[])
  .map((g) => ({ ...g, cases: g.cases.filter((c) => !SMOKE || c.tags?.includes('smoke')) }))
  .filter((g) => g.cases.length > 0)

describe.skipIf(!GO_BIN)('node-go conformance', () => {
  beforeAll(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'halo-node-go-')))
    ws = path.join(tmp, 'ws')
    fs.mkdirSync(ws)
    db = createChannelDb(path.join(tmp, 'secrets'))
    await startServer()
  })
  afterAll(async () => {
    // Whatever a failed test left running (the group afterAlls only SIGTERM their own pair).
    const left = [...live]
    for (const c of left) signal(c, 'SIGKILL')
    await Promise.all(left.map((c) => new Promise((r) => c.exitCode !== null || c.signalCode !== null ? r(null) : c.once('close', r))))
    await stopServer()
    setNodeHub(null)
    if (tmp) { execFileSync('chmod', ['-R', 'u+rwx', tmp]); fs.rmSync(tmp, { recursive: true, force: true }) }
  })

  for (const g of groups) {
    describe(g.group, () => {
      const procs = {} as Record<Side, Proc>
      const ids = {} as Record<Side, string>
      const machine = (side: Side) => `${side}-${g.group}`
      let dirty = true

      beforeAll(async () => {
        for (const side of SIDES) {
          const { token, accountId } = account(machine(side))
          ids[side] = accountId
          resetTree(side, trees[g.tree])
          const d = sideDir(side)
          const args = ['--server', `http://127.0.0.1:${port}`, ...(g.config.mode === 'folder' ? ['--root', `${d}/root`] : []), ...(g.config.shell ? ['--allow-shell'] : [])]
          procs[side] = spawnSide(side, args, { HOME: `${d}/home`, HALO_NODE_TOKEN: token, ...g.config.env }, `${d}/root`)
        }
        dirty = false
        await until(() => SIDES.every((s) => {
          if (procs[s].code !== undefined) throw new Error(`${s} exited ${procs[s].code} before connecting:\n${procs[s].err}`)
          return procs[s].out.some((l) => l.startsWith('[Node] connected as'))
        }), 30_000, 'both machines online')
      }, 60_000 * SLOW)

      afterAll(async () => {
        const codes = await Promise.all(SIDES.map((s) => term(procs[s])))
        for (const s of SIDES) deleteNodeAccount(db, ids[s])
        expect(codes).toEqual([0, 0])
      }, 30_000 * SLOW)

      it('startup log', () => {
        expect(logLines(procs.go)).toEqual(logLines(procs.ts))
      })

      for (const c of g.cases) {
        it(c.name, async () => {
          if (dirty || c.setup) {
            for (const side of SIDES) resetTree(side, [...trees[g.tree], ...(c.setup ?? [])])
          }
          dirty = !!c.setup || c.calls.some((x) => x.op === 'write' || x.op === 'edit' || x.op === 'run')
          const call = (side: Side, op: string, args: Record<string, unknown>) => callSide(side, machine(side), op, args)
          if (c.known) {
            const res = { ts: [] as Result[], go: [] as Result[] }
            for (const x of c.calls) for (const s of SIDES) res[s].push(await call(s, x.op, x.args))
            expect(res.go, `known difference ${c.known}`).toEqual(c.expectGo)
            // Still a difference: once TS changes to match Go, this goes red — drop the `known` mark then.
            expect(res.ts, `known difference ${c.known} no longer differs`).not.toEqual(res.go)
            return
          }
          const mark = { ts: procs.ts.out.length, go: procs.go.out.length }
          const res = { ts: [] as Result[], go: [] as Result[] }
          for (const x of c.calls) {
            const [t, o] = await Promise.all(SIDES.map((s) => call(s, x.op, x.args)))
            res.ts.push(t)
            res.go.push(o)
          }
          expect(res.go).toEqual(res.ts)
          for (const f of c.after ?? []) {
            const read = (s: Side) => { const p = path.join(sideDir(s), f); return fs.existsSync(p) ? fs.readFileSync(p).toString('hex') : null }
            expect(read('go'), `after: ${f}`).toEqual(read('ts'))
          }
          await sleep(30) // stdout pipe vs the result frame
          expect(logLines(procs.go, mark.go)).toEqual(logLines(procs.ts, mark.ts))
        }, 60_000 * SLOW)
      }
    })
  }

  // ── process level (plan §3.4 step 4) ─────────────────────────────────────

  describe('proto', () => {
    let n = 0
    /** A fresh pair of accounts + processes; `args` beyond --server / --root. */
    function pair(opts: { args?: string[]; tokens?: Record<Side, string>; server?: string; shell?: boolean; workspace?: string; beforeSpawn?: () => void } = {}) {
      n++
      const accts = {} as Record<Side, { token: string; accountId: string }>
      const procs = {} as Record<Side, Proc>
      for (const side of SIDES) accts[side] = opts.tokens ? { token: opts.tokens[side], accountId: '' } : account(`p${n}-${side}`, opts.workspace)
      opts.beforeSpawn?.()
      for (const side of SIDES) {
        resetTree(side, [{ file: 'root/hello.txt', text: 'hello\n' }])
        const d = sideDir(side)
        const args = ['--server', opts.server ?? `http://127.0.0.1:${port}`, '--root', `${d}/root`, ...(opts.shell ? ['--allow-shell'] : []), ...(opts.args ?? [])]
        procs[side] = spawnSide(side, args, { HOME: `${d}/home`, HALO_NODE_TOKEN: accts[side].token }, `${d}/root`)
      }
      const logs = () => ({ ts: dedupe(logLines(procs.ts)), go: dedupe(logLines(procs.go)) })
      const has = (re: RegExp) => SIDES.every((s) => procs[s].out.some((l) => re.test(l)))
      return { accts, procs, logs, has, name: (s: Side) => `p${n}-${s}` }
    }
    const T = 60_000 * SLOW
    // Under qemu (smoke) only the handshake / stop path; the rest is platform-independent client logic.
    const full = SMOKE ? it.skip : it

    full('CLI argument errors: same message, exit 1 (prefix: D4)', async () => {
      const d = (s: Side) => sideDir(s)
      for (const side of SIDES) resetTree(side, [{ file: 'root/f.txt', text: '' }])
      const variants: [string, (s: Side) => string[], Record<string, string>][] = [
        ['no --server', () => [], { HALO_NODE_TOKEN: 'x' }],
        ['no token', () => ['--server', 'http://h'], {}],
        ['bad header', () => ['--server', 'http://h', '--header', 'novalue'], { HALO_NODE_TOKEN: 'x' }],
        ['header leading colon', () => ['--server', 'http://h', '--header', ': v'], { HALO_NODE_TOKEN: 'x' }],
        ['ftp scheme', () => ['--server', 'ftp://x'], { HALO_NODE_TOKEN: 'x' }],
        ['no scheme', () => ['--server', 'localhost:9527'], { HALO_NODE_TOKEN: 'x' }],
        ['invalid URL', () => ['--server', 'http//x'], { HALO_NODE_TOKEN: 'x' }],
        ['port over 65535', () => ['--server', 'http://h:65536'], { HALO_NODE_TOKEN: 'x' }],
        ['empty --token does not fall back to env', () => ['--server', 'http://h', '--token', ''], { HALO_NODE_TOKEN: 'x' }],
        // Thrown by new WebSocket (after the log lines), not by the arg parsing.
        ['header name not a token', () => ['--server', 'http://h', '--header', 'X Foo: v'], { HALO_NODE_TOKEN: 'x' }],
        ['header name empty after trim', () => ['--server', 'http://h', '--header', ' : v'], { HALO_NODE_TOKEN: 'x' }],
        ['header value with a control char', () => ['--server', 'http://h', '--header', 'X-A: a\x01b'], { HALO_NODE_TOKEN: 'x' }],
        ['token with a trailing CR (CRLF env file)', () => ['--server', 'http://h'], { HALO_NODE_TOKEN: 'abc\r' }],
        ['root missing', (s) => ['--server', 'http://h', '--root', `${d(s)}/root/nope`], { HALO_NODE_TOKEN: 'x' }],
        ['root is a file', (s) => ['--server', 'http://h', '--root', `${d(s)}/root/f.txt`], { HALO_NODE_TOKEN: 'x' }],
      ]
      for (const [what, args, env] of variants) {
        const out = await Promise.all(SIDES.map(async (s) => {
          const p = spawnSide(s, args(s), { HOME: `${d(s)}/home`, ...env }, `${d(s)}/root`)
          const code = await p.exit
          return { code, first: norm(p.err.split('\n')[0], s).replace(/^halo node: /, 'halo-node: ') }
        }))
        expect(out[1], what).toEqual(out[0])
        expect(out[0].code, what).toBe(1)
      }
    }, T)

    it('401 wrong token: fatal, exit 1, no retry', async () => {
      const p = pair({ tokens: { ts: 'wrong-token-ts', go: 'wrong-token-go' } })
      const codes = await Promise.all(SIDES.map((s) => p.procs[s].exit))
      clearFailures('node-token', '127.0.0.1')
      expect(codes).toEqual([1, 1])
      expect(p.logs().go).toEqual(p.logs().ts)
      expect(p.logs().ts.some((l) => l.includes('token rejected by the server (401)'))).toBe(true)
    }, T)

    full('429 locked out: retry after 60.0s; SIGTERM while waiting exits 0', async () => {
      for (let i = 0; i < 5; i++) recordFailure('node-token', '127.0.0.1')
      const p = pair()
      try {
        await until(() => p.has(/\(429\); reconnecting in 60\.0s/), 15_000, '429')
      } finally { clearFailures('node-token', '127.0.0.1') }
      expect(await Promise.all(SIDES.map((s) => term(p.procs[s])))).toEqual([0, 0])
      expect(p.logs().go).toEqual(p.logs().ts)
    }, T)

    full('404 workspace gone: fatal, exit 1', async () => {
      const gone = path.join(tmp, 'gone-ws')
      fs.mkdirSync(gone)
      const p = pair({ workspace: gone, beforeSpawn: () => fs.rmSync(gone, { recursive: true, force: true }) })
      const codes = await Promise.all(SIDES.map((s) => p.procs[s].exit))
      expect(codes).toEqual([1, 1])
      expect(p.logs().go).toEqual(p.logs().ts)
      expect(p.logs().ts.some((l) => l.includes('no longer exists on the server (404)'))).toBe(true)
    }, T)

    full('426 / other HTTP status from the upgrade (fake server)', async () => {
      for (const [status, fatal] of [[426, true], [503, false]] as const) {
        const fake = http.createServer()
        fake.on('upgrade', (_req, sock: Duplex) => sock.end(`HTTP/1.1 ${status} X\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`))
        await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r))
        const p = pair({ server: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, tokens: { ts: 't', go: 'g' } })
        if (fatal) expect(await Promise.all(SIDES.map((s) => p.procs[s].exit))).toEqual([1, 1])
        else {
          await until(() => p.has(/HTTP 503\); reconnecting/), 10_000, '503 retry')
          expect(await Promise.all(SIDES.map((s) => term(p.procs[s])))).toEqual([0, 0])
        }
        await new Promise<void>((r) => fake.close(() => r()))
        expect(p.logs().go, String(status)).toEqual(p.logs().ts)
      }
    }, T)

    full('301 from the upgrade: not followed, logged as refused, retried', async () => {
      const paths: string[] = []
      const fake = http.createServer((req, res) => { paths.push(req.url ?? ''); res.end() })
      fake.on('upgrade', (req, sock: Duplex) => {
        paths.push(req.url ?? '')
        sock.end(`HTTP/1.1 301 Moved\r\nLocation: /moved\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      })
      await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r))
      const p = pair({ server: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, tokens: { ts: 't', go: 'g' } })
      await until(() => p.has(/HTTP 301\); reconnecting/), 10_000, '301 retry')
      expect(await Promise.all(SIDES.map((s) => term(p.procs[s])))).toEqual([0, 0])
      await new Promise<void>((r) => fake.close(() => r()))
      expect(p.logs().go).toEqual(p.logs().ts)
      expect(paths.filter((u) => u !== P.NODE_WS_PATH)).toEqual([])
    }, T)

    full('409 token held by another process: retry; the holder stays', async () => {
      const p = pair()
      // Let both connect, then a second process per token must get 409.
      await until(() => p.has(/connected as/), 30_000, 'online')
      const q = SIDES.map((s) => spawnSide(s, ['--server', `http://127.0.0.1:${port}`, '--root', `${sideDir(s)}/root`], { HOME: `${sideDir(s)}/home`, HALO_NODE_TOKEN: p.accts[s].token }, `${sideDir(s)}/root`))
      await until(() => q.every((x) => x.out.some((l) => l.includes('already connected from another process'))), 15_000, '409')
      expect(await Promise.all(q.map(term))).toEqual([0, 0])
      expect(dedupe(logLines(q[1]))).toEqual(dedupe(logLines(q[0])))
      expect(hub.online().map((o) => o.name).sort()).toEqual(expect.arrayContaining([p.name('ts'), p.name('go')]))
      expect(await Promise.all(SIDES.map((s) => term(p.procs[s])))).toEqual([0, 0])
    }, T)

    full('4001 revoked: fatal, exit 1 after the running call is killed', async () => {
      const p = pair({ shell: true })
      await until(() => p.has(/connected as/), 30_000, 'online')
      const calls = SIDES.map((s) => hub.call(ws, p.name(s), 'run', { command: 'echo $$ > run.pid; sleep 30' }).catch((e: Error) => e.message))
      await until(() => SIDES.every((s) => fs.existsSync(path.join(sideDir(s), 'root/run.pid'))), 10_000, 'run started')
      for (const s of SIDES) { deleteNodeAccount(db, p.accts[s].accountId); hub.disconnect(p.accts[s].accountId) }
      expect(await Promise.all(SIDES.map((s) => p.procs[s].exit))).toEqual([1, 1])
      const errs = (await Promise.all(calls)).map((e, i) => String(e).split(p.name(SIDES[i])).join('<NAME>'))
      expect(errs[1]).toEqual(errs[0])
      expect(p.logs().go).toEqual(p.logs().ts)
      expect(p.logs().ts.some((l) => l.includes('token revoked'))).toBe(true)
    }, T)

    full('TCP dropped mid-run: 1006, the call stopped, reconnects', async () => {
      const p = pair({ shell: true })
      await until(() => p.has(/connected as/), 30_000, 'online')
      const calls = SIDES.map((s) => hub.call(ws, p.name(s), 'run', { command: 'echo $$ > run.pid; sleep 30' }).catch((e: Error) => e.message))
      await until(() => SIDES.every((s) => fs.existsSync(path.join(sideDir(s), 'root/run.pid'))), 10_000, 'run started')
      for (const s of sockets) s.destroy()
      await until(() => p.has(/connection lost \(1006\) — stopped 1 running call\(s\)/), 10_000, '1006')
      await Promise.all(calls)
      await until(() => SIDES.every((s) => p.procs[s].out.filter((l) => l.includes('connected as')).length === 2), 20_000, 'reconnected')
      for (const s of SIDES) {
        const pid = Number(fs.readFileSync(path.join(sideDir(s), 'root/run.pid'), 'utf-8'))
        await until(() => { try { process.kill(pid, 0); return false } catch { return true } }, 5_000, `${s} run killed`)
      }
      expect(await Promise.all(SIDES.map((s) => term(p.procs[s])))).toEqual([0, 0])
      expect(p.logs().go).toEqual(p.logs().ts)
    }, T)

    it('a result over 256K chars cut through a surrogate pair: the raw frame carries the lone \\ud83d escape', async () => {
      const p = pair()
      await until(() => p.has(/connected as/), 30_000, 'online')
      // read's "1\t" prefix is 2 units: the emoji's high surrogate lands on unit 262143, the last one kept.
      for (const s of SIDES) fs.writeFileSync(path.join(sideDir(s), 'root/huge.txt'), 'a'.repeat(262144 - 3) + '\u{1F600}tail\n')
      const texts = await Promise.all(SIDES.map((s) => hub.call(ws, p.name(s), 'read', { path: 'huge.txt' })))
      expect(texts[1]).toEqual(texts[0])
      expect(texts[0].charCodeAt(262143)).toBe(0xd83d)
      const total = '1\t'.length + 262144 - 3 + 2 + 'tail\n2\t'.length
      expect(texts[0].slice(262144)).toBe(`\n[Content truncated on the machine: ${total} chars total]`)
      // The frame as sent: JSON.stringify writes the lone surrogate as the escape `\ud83d`.
      const tail = (s: Side) => {
        const f = seen.get(p.accts[s].token)!.texts.find((t) => t.includes('Content truncated on the machine'))!
        return f.slice(f.indexOf('aaaa\\ud83d') )
      }
      expect(tail('ts')).toContain(`aaaa\\ud83d\\n[Content truncated on the machine: ${total} chars total]"`)
      expect(tail('go')).toEqual(tail('ts'))
      // Go sends a big reply in 32 KiB fragments, so a pong fits in between; ws sends one frame.
      const frames = (s: Side) => { const r = seen.get(p.accts[s].token)!; return r.frames[r.texts.findIndex((t) => t.includes('Content truncated on the machine'))] }
      expect(frames('ts')).toBe(1)
      expect(frames('go')).toBeGreaterThan(8)
      expect(await Promise.all(SIDES.map((s) => term(p.procs[s])))).toEqual([0, 0])
    }, T)

    full('hub restart: 1001, could-not-connect, reconnect, call works', async () => {
      const p = pair()
      await until(() => p.has(/connected as/), 30_000, 'online')
      const samePort = port
      await stopServer()
      await until(() => p.has(/connection lost \(1001 server shutting down\)/), 10_000, '1001')
      await until(() => p.has(/could not connect/), 10_000, 'could not connect')
      await startServer(samePort)
      await until(() => SIDES.every((s) => p.procs[s].out.filter((l) => l.includes('connected as')).length === 2), 20_000, 'reconnected')
      const r = await Promise.all(SIDES.map((s) => hub.call(ws, p.name(s), 'read', { path: 'hello.txt' })))
      expect(r).toEqual(['1\thello\n2\t', '1\thello\n2\t'])
      expect(await Promise.all(SIDES.map((s) => term(p.procs[s])))).toEqual([0, 0])
      expect(p.logs().go).toEqual(p.logs().ts)
    }, T)

    it('SIGTERM: close 1000 "node stopped", exit 0; --header incl. Host reaches the handshake', async () => {
      const p = pair({ args: ['--header', 'Host: example.test:1234', '--header', 'X-Probe: a:b:c', '--header', 'Cookie:  k=v '] })
      await until(() => p.has(/connected as/), 30_000, 'online')
      const pick = (s: Side) => {
        const h = seen.get(p.accts[s].token)!.headers
        return { host: h.host, probe: h['x-probe'], cookie: h.cookie, protocol: h[P.HEADER_PROTOCOL] }
      }
      expect(pick('ts')).toEqual({ host: 'example.test:1234', probe: 'a:b:c', cookie: 'k=v', protocol: '1' })
      expect(pick('go')).toEqual(pick('ts'))
      expect(await Promise.all(SIDES.map((s) => term(p.procs[s])))).toEqual([0, 0])
      await until(() => SIDES.every((s) => seen.get(p.accts[s].token)!.close !== undefined), 5_000, 'close frames')
      for (const s of SIDES) expect(seen.get(p.accts[s].token)!.close, s).toEqual({ code: 1000, reason: 'node stopped' })
      expect(p.logs().go).toEqual(p.logs().ts)
    }, T)
  })
})

