import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { extensionSessionAccess } from '../src/extensions/session-access.js'
import { cleanChildEnv } from '../src/child-env.js'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { NOTIFY_MAX_TEXT_BYTES } from '@turmind/halo-core/protocol'
import { createNotifyRoutes } from '../src/routes/notify.js'
import { _setLocalNotifyToken, localNotifyWorkspaceToken } from '../src/local-notify.js'
import { createEvoDb, setEvoDb, evolutionRuns, type EvoDb } from '../src/db/evo-db.js'
import { agentSessions } from '../src/db/schema.js'
import { getSandboxBackend, initBwrapCheck, sandboxExec, buildSeatbeltProfile } from '../src/tools/sandbox.js'
import { createWorkspaceTools } from '../src/tools/workspace-tools.js'
import { config } from '../src/config.js'
import type { ToolDef } from '../src/agents/runtime/types.js'
import { installCronHarness, teardownCronHarness, until, type CronHarness } from './helpers/cron-harness.js'

/**
 * `POST /api/notify` (`halo notify`): loopback + per-boot token auth, delivery
 * through SessionManager.deliverMessage (idle → new turn, busy → merged, a
 * stopped sub-session woken and reporting to its parent), no pre-compact evo;
 * and all three levels' shell_exec env / hint while the token exists.
 * Real SessionManager + the cron harness's stub agent.
 */

const TOKEN = 'test-notify-token'
const bwrap = process.platform === 'linux' && await initBwrapCheck() && getSandboxBackend() === 'bwrap'
let tmpHome: string
let ws: string
let h: CronHarness
let evoDb: EvoDb
let app: Hono
const realHome = process.env.HOME

beforeEach(() => {
  // A readonly workspace under /tmp is hidden by bwrap's private tmpfs.
  // Keep the fixture outside it, without changing the sandbox's mounts.
  const tmp = path.resolve(import.meta.dirname, '../../../.halo/tmp')
  fs.mkdirSync(tmp, { recursive: true })
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'halo-notify-')))
  process.env.HOME = tmpHome
  ws = path.join(tmpHome, 'ws')
  evoDb = createEvoDb(path.join(tmpHome, 'global'))
  setEvoDb(evoDb)
  fs.mkdirSync(path.join(ws, '.halo'), { recursive: true })
  fs.writeFileSync(path.join(ws, '.halo', 'settings.yaml'), 'general:\n  evolution:\n    level: L3\n')
  h = installCronHarness(ws)
  _setLocalNotifyToken(TOKEN, 'http://127.0.0.1:1')
  app = new Hono().route('/api', createNotifyRoutes({ registry: { getOrCreate: () => h.sm } }))
})

afterEach(() => {
  _setLocalNotifyToken(null)
  teardownCronHarness()
  process.env.HOME = realHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

function notify(body: unknown, opts: { token?: string | null; remote?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers }
  const token = opts.token === undefined ? TOKEN : opts.token
  if (token !== null) headers.authorization = `Bearer ${token}`
  return Promise.resolve(app.request('/api/notify', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) },
    { incoming: { socket: { remoteAddress: opts.remote ?? '127.0.0.1' } } }))
}
const sessions = () => (h.sm as unknown as { sessions: Map<string, { parentId: string | null; compactedThisTurn: boolean }> }).sessions
const row = (id: string) => h.sm.getDb().select().from(agentSessions).where(eq(agentSessions.id, id)).get()!
function holdNextTurn(): () => void {
  let release!: () => void
  h.turns.push({ gate: new Promise<void>((r) => { release = r }) })
  return release
}

describe('auth', () => {
  beforeEach(() => h.seedSession('s1'))

  it('no token on this server (CLI / AgentCore): 404', async () => {
    _setLocalNotifyToken(null)
    expect((await notify({ workspace: ws, session: 's1', text: 'hi' })).status).toBe(404)
  })

  it.each([['missing', null], ['wrong', 'nope'], ['wrong length', TOKEN + 'x']])('%s bearer token: 401, nothing delivered', async (_n, token) => {
    expect((await notify({ workspace: ws, session: 's1', text: 'hi' }, { token })).status).toBe(401)
    expect(h.inputs).toEqual([])
  })

  it('workspace tokens are the specified hex HMAC, normalized by realpath', async () => {
    const alias = path.join(tmpHome, 'alias')
    fs.symlinkSync(ws, alias)
    const token = localNotifyWorkspaceToken(alias)!
    expect(token).toBe(crypto.createHmac('sha256', TOKEN).update(ws).digest('hex'))
    expect((await notify({ workspace: alias, session: 's1', text: 'self' }, { token })).status).toBe(200)
    await until(() => h.inputs.length === 1 && !sessions().has('s1'))
    expect(h.inputs[0]).toContain('[Script notice] self')
  })

  it.each([undefined, { session: 's1' }])('a workspace token wakes another full session, with or without legacy source.session: %j', async (legacy) => {
    h.seedSession('s2')
    const body = { workspace: ws, session: 's2', text: 'hi', source: { workspace: ws, ...legacy } }
    expect((await notify(body, { token: localNotifyWorkspaceToken(ws)! })).status).toBe(200)
    await until(() => h.inputs.length === 1 && !sessions().has('s2'))
    expect(h.inputs[0]).toContain('[Script notice] hi')
  })

  it('a verified workspace token cannot change workspace; boot token can', async () => {
    const otherWs = path.join(tmpHome, 'other')
    fs.mkdirSync(path.join(otherWs, '.halo'), { recursive: true })
    fs.writeFileSync(path.join(otherWs, '.halo', 'halo.db'), '')
    const body = { workspace: otherWs, session: 's1', text: 'hi', source: { workspace: ws } }
    const res = await notify(body, { token: localNotifyWorkspaceToken(ws)! })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'this token can only wake sessions in its own workspace' })
    expect(h.inputs).toEqual([])
    expect((await notify(body)).status).toBe(200)
    await until(() => h.inputs.length === 1 && !sessions().has('s1'))
  })

  it('wrong hex, changed source, or a stale token: 401 (no token identity is guessed)', async () => {
    const source = { workspace: ws, session: 's1' }
    const token = localNotifyWorkspaceToken(ws)!
    expect((await notify({ ...source, text: 'hi', source }, { token: '0'.repeat(64) })).status).toBe(401)
    expect((await notify({ ...source, text: 'hi', source: { workspace: tmpHome } }, { token })).status).toBe(401)
    _setLocalNotifyToken('next-boot')
    expect((await notify({ ...source, text: 'hi' }, { token })).status).toBe(401)
    expect(h.inputs).toEqual([])
  })

  it('workspace tokens also require loopback and no proxy headers', async () => {
    const token = localNotifyWorkspaceToken(ws)!
    const body = { workspace: ws, session: 's1', text: 'hi' }
    expect((await notify(body, { token, remote: '10.0.0.1' })).status).toBe(403)
    expect((await notify(body, { token, headers: { forwarded: 'for=127.0.0.1' } })).status).toBe(403)
  })

  it.each(['10.0.0.5', '::ffff:192.168.1.2', '2001:db8::1'])('non-loopback peer %s: 403 even with the token', async (remote) => {
    expect((await notify({ workspace: ws, session: 's1', text: 'hi' }, { remote })).status).toBe(403)
  })

  it.each(['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-proto'])('a proxied loopback request (%s): 403', async (header) => {
    expect((await notify({ workspace: ws, session: 's1', text: 'hi' }, { headers: { [header]: '10.0.0.5' } })).status).toBe(403)
  })

  it.each(['::1', '::ffff:127.0.0.1', '127.0.0.2'])('loopback %s with the token: delivered', async (remote) => {
    expect((await notify({ workspace: ws, session: 's1', text: 'hi' }, { remote })).status).toBe(200)
  })
})

describe('request validation', () => {
  beforeEach(() => h.seedSession('s1'))

  it.each([['not JSON', 'nope'], ['no text', { workspace: 'x', session: 's1' }], ['blank text', { workspace: 'x', session: 's1', text: '  ' }], ['no session', { workspace: 'x', text: 'hi' }]])('%s: 400', async (_n, body) => {
    expect((await notify(body)).status).toBe(400)
  })

  it('text over the byte limit: 413, not cut', async () => {
    const res = await notify({ workspace: ws, session: 's1', text: 'é'.repeat(NOTIFY_MAX_TEXT_BYTES / 2 + 1) })
    expect(res.status).toBe(413)
    expect(h.inputs).toEqual([])
  })

  it('a directory that is not a Halo workspace: 404, no .halo/ scaffolded', async () => {
    const plain = fs.mkdtempSync(path.join(tmpHome, 'plain-'))
    expect((await notify({ workspace: plain, session: 's1', text: 'hi' })).status).toBe(404)
    expect((await notify({ workspace: path.join(tmpHome, 'missing'), session: 's1', text: 'hi' })).status).toBe(404)
    expect(fs.existsSync(path.join(plain, '.halo'))).toBe(false)
  })

  it('unknown or archived session: 404', async () => {
    expect((await notify({ workspace: ws, session: 'nope', text: 'hi' })).status).toBe(404)
    h.sm.getDb().update(agentSessions).set({ archivedAt: 1 }).where(eq(agentSessions.id, 's1')).run()
    const res = await notify({ workspace: ws, session: 's1', text: 'hi' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'session archived: s1' })
  })

  it('a sub-session whose parent is gone or archived: 404', async () => {
    h.sm.getDb().insert(agentSessions).values({ id: 'gone>c1', parentId: 'gone', agentId: 'default', agentName: 'default', description: '', createdAt: 1, updatedAt: 1 }).run()
    expect((await notify({ workspace: ws, session: 'gone>c1', text: 'hi' })).status).toBe(404)
    h.sm.getDb().update(agentSessions).set({ archivedAt: 1 }).where(eq(agentSessions.id, 's1')).run()
    h.sm.getDb().insert(agentSessions).values({ id: 's1>c1', parentId: 's1', agentId: 'default', agentName: 'default', description: '', createdAt: 1, updatedAt: 1 }).run()
    const res = await notify({ workspace: ws, session: 's1>c1', text: 'hi' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'parent session gone: s1' })
  })
})

describe('delivery', () => {
  it('an idle root: a new turn with the labelled text, the same text in its UI log', async () => {
    h.seedSession('s1')
    const res = await notify({ workspace: ws, session: 's1', text: 'build finished' })
    expect(await res.json()).toEqual({ ok: true, state: 'running' })
    await until(() => h.inputs.length === 1 && !sessions().has('s1'))
    expect(h.inputs[0]).toContain('[Script notice] build finished')
    const log = fs.readdirSync(path.join(ws, '.halo', 'sessions'), { recursive: true }).map(String).find((f) => f.endsWith('.ui.jsonl'))!
    expect(fs.readFileSync(path.join(ws, '.halo', 'sessions', log), 'utf-8')).toContain('[Script notice] build finished')
  })

  it('a running session: queued, merged into the running turn', async () => {
    h.seedSession('s1')
    const release = holdNextTurn()
    const stamp = h.sm.appendUserMessage('s1', 'working')
    await h.sm.sendUserMessage('s1', 'working', undefined, undefined, stamp)
    await until(() => h.inputs.length === 1)
    expect(await (await notify({ workspace: ws, session: 's1', text: 'tests green' })).json()).toEqual({ ok: true, state: 'queued' })
    release()
    await until(() => h.inputs.length === 2 && !sessions().has('s1'))
    expect(h.inputs[1]).toContain('[Script notice] tests green')
  })

  it('a stopped sub-session: woken (stoppedAt cleared), its turn end reports to the parent', async () => {
    h.seedSession('p1')
    h.seedSession('p1>c1')
    sessions().get('p1>c1')!.parentId = 'p1'
    h.sm.getDb().update(agentSessions).set({ parentId: 'p1', stoppedAt: 5 }).where(eq(agentSessions.id, 'p1>c1')).run()
    h.turns.push({ reply: 'child saw it' }, { reply: 'parent got it' })
    expect((await notify({ workspace: ws, session: 'p1>c1', text: 'job 42 done' })).status).toBe(200)
    await until(() => h.inputs.length === 2)
    expect(h.inputs[0]).toContain('[Script notice] job 42 done')
    expect(h.inputs[1]).toContain('child saw it')
    await until(() => row('p1>c1').stoppedAt !== null && row('p1>c1').stoppedAt !== 5)
  })

  it('the turn it opens never enqueues pre-compact evo', async () => {
    h.seedSession('s1')
    const release = holdNextTurn()
    await notify({ workspace: ws, session: 's1', text: 'long job done' })
    await until(() => h.inputs.length === 1)
    const session = sessions().get('s1')!
    session.compactedThisTurn = true
    release()
    await until(() => !sessions().has('s1'))
    expect(session.compactedThisTurn).toBe(false)
    expect(evoDb.select().from(evolutionRuns).all()).toEqual([])
  })
})

describe('shell_exec env + hint', () => {
  const builder = () => (h.sm as unknown as { agentBuilder: { resolveBaseToolSet(a: unknown): { workspaceTools: ToolDef[] } } }).agentBuilder
  const shellOf = (sessionId: string, accessLevel: 'readonly' | 'workspace' | null) =>
    builder().resolveBaseToolSet({ agentId: 'default', sessionId, modelId: 'test-model', accessLevel, yamlConfig: { tools: ['shell_exec'] } }).workspaceTools.find((t) => t.name === 'shell_exec')!
  const PRINT = 'printf "%s|%s" "${HALO_SESSION_ID-unset}" "${HALO_WORKSPACE-unset}"'
  // Run from inside a Halo session's shell, vitest inherits that session's
  // target; HALO_WORKSPACE is not stripped from children (AgentCore needs it).
  const inherited = { HALO_WORKSPACE: process.env.HALO_WORKSPACE, HALO_SESSION_ID: process.env.HALO_SESSION_ID }
  beforeEach(() => { delete process.env.HALO_WORKSPACE; delete process.env.HALO_SESSION_ID })
  afterEach(() => { for (const [k, v] of Object.entries(inherited)) if (v !== undefined) process.env[k] = v })
  // The background paragraph without notify: poll with follow-up calls.
  const POLL = 'then poll the log file or process status with follow-up shell_exec calls'
  const expectNotifyRecipe = (description: string) => {
    expect(description).toContain('halo notify')
    expect(description).toContain('instead of polling')
    expect(description).toContain('>/dev/null 2>&1 &')
    expect(description).not.toContain(POLL)
  }
  const expectPollRecipe = (description: string) => {
    expect(description).toContain(POLL)
    expect(description).not.toContain('halo notify')
  }

  it('a full sub-session: HALO_SESSION_ID (full path) + HALO_WORKSPACE, and the notify recipe instead of polling', async () => {
    const shell = shellOf('p1>c1', null)
    expectNotifyRecipe(shell.description)
    expect(await shell.callback({ command: PRINT })).toBe(`p1>c1|${ws}`)
  })

  it('the recipe as written returns at once, and its notify runs when the job ends', async () => {
    // A stub `halo` records what the recipe's notify would send.
    fs.mkdirSync(path.join(ws, '.halo', 'tmp'), { recursive: true })
    const bin = fs.mkdtempSync(path.join(tmpHome, 'bin-'))
    const out = path.join(tmpHome, 'notified')
    fs.writeFileSync(path.join(bin, 'halo'), `#!/bin/sh\nprintf '%s|%s|%s' "$HALO_SESSION_ID" "$1" "$2" > ${out}\n`, { mode: 0o755 })
    const realPath = process.env.PATH
    process.env.PATH = `${bin}:${realPath}`
    try {
      const shell = shellOf('s1', null)
      const recipe = shell.description.split('\n').find((l) => l.trimStart().startsWith('nohup '))!.trim()
      const started = Date.now()
      await shell.callback({ command: recipe.replace('<command>', 'sleep 2').replaceAll('<name>', 'job') })
      // Not held open by the background job's pipes.
      expect(Date.now() - started).toBeLessThan(1500)
      await until(() => fs.existsSync(out), 6000)
      expect(fs.readFileSync(out, 'utf-8')).toBe('s1|notify|job done: 0')
    } finally {
      process.env.PATH = realPath
    }
  })

  it.skipIf(!bwrap).each(['workspace', 'readonly'] as const)('%s: only the four notify variables, no extension grant, token masked', async (accessLevel) => {
    const issue = vi.spyOn(extensionSessionAccess, 'shellContext')
    const shell = shellOf('p1>c1', accessLevel)
    expectNotifyRecipe(shell.description)
    expect(await shell.callback({ command: PRINT })).toBe(`p1>c1|${ws}`)
    const output = await shell.callback({ command: 'env' })
    expect(output).toContain('HALO_NOTIFY_URL=http://127.0.0.1:1')
    expect(output).toContain('HALO_NOTIFY_TOKEN=***')
    expect(output).not.toContain(localNotifyWorkspaceToken(ws))
    expect(issue).not.toHaveBeenCalled()
    const token = localNotifyWorkspaceToken(ws)!
    const env = { HALO_WORKSPACE: ws, HALO_SESSION_ID: 'p1>c1', HALO_NOTIFY_URL: 'http://127.0.0.1:1', HALO_NOTIFY_TOKEN: token, HALO_EXT_BACKENDS: 'no', HALO_EXT_NODE: 'no', EXTRA: 'no' }
    const raw = await sandboxExec('env', { workspaceRoot: ws, accessLevel, env })
    for (const key of ['HALO_WORKSPACE', 'HALO_SESSION_ID', 'HALO_NOTIFY_URL', 'HALO_NOTIFY_TOKEN'] as const) expect(raw.stdout).toContain(`${key}=${env[key]}`)
    expect(raw.stdout).not.toMatch(/HALO_EXT_|EXTRA=/)
    const digestCommand = `node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.env.HALO_NOTIFY_TOKEN).digest("hex"))'`
    const expectedDigest = crypto.createHash('sha256').update(token).digest('hex')
    for (const id of ['p1>c1', 'another-root']) {
      expect(await shellOf(id, accessLevel).callback({ command: digestCommand })).toBe(expectedDigest)
    }
  })

  it.each(['full', 'workspace', 'readonly'] as const)('%s: exact notify paragraph', (accessLevel) => {
    const paragraph = createWorkspaceTools(ws, { accessLevel, notifyHint: true }).find((t) => t.name === 'shell_exec')!.description.split('\n\n').at(-1)
    expect(paragraph).toBe([
      `Commands are killed after ${config.timeout.shellExec / 1000}s; run anything longer in the background. If you`,
      'need to know when it finishes, end the job with `halo notify` (it wakes this',
      'session) instead of polling:',
      ...(accessLevel === 'readonly' ? [
        'The workspace is read-only; only the exit code comes back.',
        `  nohup sh -c '<command> >/dev/null 2>&1; halo notify "<name> done: $?"' >/dev/null 2>&1 &`,
      ] : [`  nohup sh -c '<command> > .halo/tmp/<name>.log 2>&1; halo notify "<name> done: $?"' >/dev/null 2>&1 &`]),
    ].join('\n'))
  })

  it.skipIf(!bwrap).each(['workspace', 'readonly'] as const)('%s: real CLI + bwrap wakes same-workspace sessions over HTTP, other workspace refused', async (accessLevel) => {
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
    await new Promise<void>((r) => server.once('listening', r))
    _setLocalNotifyToken(TOKEN, `http://127.0.0.1:${(server.address() as { port: number }).port}`)
    h.seedSession('s1', { accessLevel }); h.seedSession('s2')
    const bin = path.join(ws, 'bin')
    fs.mkdirSync(bin)
    fs.mkdirSync(path.join(ws, '.halo', 'tmp'), { recursive: true })
    const cli = path.resolve(import.meta.dirname, '../../cli')
    fs.writeFileSync(path.join(bin, 'halo'), `#!/bin/sh\nexec '${process.execPath}' --import '${cli}/node_modules/tsx/dist/loader.mjs' '${cli}/src/index.ts' "$@"\n`, { mode: 0o755 })
    try {
      const shell = shellOf('s1', accessLevel)
      const recipe = shell.description.split('\n').find((l) => l.trimStart().startsWith('nohup '))!.trim()
      const started = Date.now()
      expect(await shell.callback({ command: `PATH="${bin}:$PATH" ` + recipe.replace('<command>', 'sleep 2').replaceAll('<name>', 'job') })).toBe('(no output)')
      expect(Date.now() - started).toBeLessThan(1500)
      await until(() => h.inputs.length === 1 && !sessions().has('s1'), 15_000)
      expect(h.inputs[0]).toContain('[Script notice] job done: 0')
      expect(fs.existsSync(path.join(ws, '.halo', 'tmp', 'job.log'))).toBe(accessLevel === 'workspace')
      expect(await shell.callback({ command: `"${bin}/halo" notify -s s2 "same workspace"` })).toBe('(no output)')
      await until(() => h.inputs.length === 2 && !sessions().has('s2'))
      expect(h.inputs[1]).toContain('[Script notice] same workspace')
      expect(await shell.callback({ command: `"${bin}/halo" notify -w "${tmpHome}" -s s2 wrong` })).toContain('this token can only wake sessions in its own workspace')
      expect(h.inputs).toHaveLength(2)
    } finally {
      await new Promise<void>((r, reject) => server.close((err) => err ? reject(err) : r()))
    }
  }, 25_000)

  it('inherited notify credentials are stripped, including from full shells', async () => {
    vi.stubEnv('HALO_NOTIFY_TOKEN', 'inherited-token'); vi.stubEnv('HALO_NOTIFY_URL', 'http://inherited')
    expect(cleanChildEnv()).not.toHaveProperty('HALO_NOTIFY_TOKEN')
    expect(cleanChildEnv()).not.toHaveProperty('HALO_NOTIFY_URL')
    expect(await shellOf('s1', null).callback({ command: 'printf "%s|%s" "${HALO_NOTIFY_TOKEN-unset}" "${HALO_NOTIFY_URL-unset}"' })).toBe('unset|unset')
    vi.unstubAllEnvs()
  })

  it.each(['workspace', 'readonly'] as const)('Seatbelt %s permits loopback and executing halo without changing its profile', (accessLevel) => {
    const profile = buildSeatbeltProfile({ workspaceRoot: ws, accessLevel })
    expect(profile).toContain('(allow default)')
    expect(profile).not.toMatch(/deny (network|process)/)
  })

  it.each([null, ...bwrap ? ['workspace', 'readonly'] as const : []])('no token (CLI / TUI / AgentCore), %s: neither, the poll recipe', async (accessLevel) => {
    _setLocalNotifyToken(null)
    const shell = shellOf('s1', accessLevel)
    expectPollRecipe(shell.description)
    expect(await shell.callback({ command: PRINT })).toBe('unset|unset')
  })

  it('createWorkspaceTools without notifyHint (preview / CLI callers): the poll paragraph, unchanged', () => {
    expect(createWorkspaceTools(ws).find((t) => t.name === 'shell_exec')!.description).toContain([
      `Commands are killed after ${config.timeout.shellExec / 1000}s. For anything that may run`,
      'longer (big builds, long test suites, deploys), start it in the background',
      'and return immediately — e.g. `nohup <command> > .halo/tmp/xxx.log 2>&1 &` —',
      'then poll the log file or process status with follow-up shell_exec calls',
      'instead of letting a single call sit past the timeout.',
    ].join('\n'))
    expectPollRecipe(createWorkspaceTools(ws).find((t) => t.name === 'shell_exec')!.description)
  })

  it('Windows: every level keeps polling (the nohup line cannot run under cmd)', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    for (const level of [null, 'workspace', 'readonly'] as const) expectPollRecipe(shellOf('s1', level).description)
  })

  it.skipIf(!bwrap)('a boot-recovered non-full session resolves the listener URL at invocation', async () => {
    _setLocalNotifyToken(TOKEN)
    const shell = shellOf('s1', 'workspace')
    _setLocalNotifyToken(TOKEN, 'http://127.0.0.1:43210')
    expect(await shell.callback({ command: 'printf "%s" "$HALO_NOTIFY_URL"' })).toBe('http://127.0.0.1:43210')
  })
})
