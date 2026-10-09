import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseAllowlist, checkAddress, checkUrl } from '../src/a2a/url-policy.js'
import { DEFAULT_A2A_URL_ALLOWLIST as DEFAULT_URL_ALLOWLIST } from '../src/config.js'
import { resolveExposedWorkspace, relUrlPath, samePath, buildCard } from '../src/a2a/exposure.js'
import { backoffMs, verdict } from '../src/a2a/push.js'
import { createA2ADb, setA2ADb, getA2ADb } from '../src/db/a2a-db.js'
import { createTask, transition, interim, getTask, putPushConfig, listTasks, parsePageToken, onTaskEvent, completeTask } from '../src/a2a/tasks.js'
import { taskJson } from '../src/a2a/wire.js'

/**
 * A2A building blocks (plans/a2a.md): URL policy, exposed-workspace resolver,
 * push retry policy, and the task state machine (guarded transitions + outbox
 * dedupe). Route-level behaviour lives in a2a-routes.test.ts.
 */

describe('url policy', () => {
  const def = parseAllowlist(DEFAULT_URL_ALLOWLIST)
  const u = (s: string) => new URL(s)

  it('default list: tailnet allowed over plain http', () => {
    expect(DEFAULT_URL_ALLOWLIST).toBe('100.64.0.0/10,*.ts.net')
    expect(checkAddress('100.91.6.4', u('http://ec2.nase-bluegill.ts.net:8527/x'), def)).toBeNull()
    expect(checkAddress('100.91.6.4', u('http://100.91.6.4:8527/x'), def)).toBeNull()
  })

  // Owner decision 2026-10-09: loopback is NOT trusted by default (push
  // configs + outbound alike) — a local peer must be listed explicitly.
  it('loopback push urls: refused by default, accepted once listed', async () => {
    const loop = ['http://127.0.0.1:18931/x', 'http://[::1]:18931/x', 'http://localhost:18931/x']
    for (const url of loop) expect(await checkUrl(url, def)).toMatch(/private address/)
    const listed = parseAllowlist(`${DEFAULT_URL_ALLOWLIST},127.0.0.0/8,::1/128`)
    for (const url of loop) expect(await checkUrl(url, listed)).toBeNull()
    // Listing one family doesn't open the other.
    const v4only = parseAllowlist(`${DEFAULT_URL_ALLOWLIST},127.0.0.0/8`)
    expect(await checkUrl('http://127.0.0.1:18931/x', v4only)).toBeNull()
    expect(await checkUrl('http://[::1]:18931/x', v4only)).toMatch(/private address/)
  })

  it('private ranges are refused unless listed; link-local is refused even when listed', () => {
    expect(checkAddress('10.0.0.1', u('http://10.0.0.1/'), def)).toMatch(/private address/)
    expect(checkAddress('172.31.7.121', u('http://172.31.7.121:8527/'), def)).toMatch(/private address/)
    const vpc = parseAllowlist(`${DEFAULT_URL_ALLOWLIST},172.31.0.0/16,169.254.0.0/16`)
    expect(checkAddress('172.31.7.121', u('http://172.31.7.121:8527/'), vpc)).toBeNull()
    expect(checkAddress('169.254.169.254', u('http://169.254.169.254/'), vpc)).toMatch(/link-local/)
    expect(checkAddress('fe80::1', u('http://[fe80::1]/'), vpc)).toMatch(/link-local/)
  })

  it('public addresses: https fine, plain http only for listed hosts', () => {
    expect(checkAddress('93.184.216.34', u('https://example.com/hook'), def)).toBeNull()
    expect(checkAddress('93.184.216.34', u('http://example.com/hook'), def)).toMatch(/plain http/)
    const hosted = parseAllowlist('example.com')
    expect(checkAddress('93.184.216.34', u('http://example.com/hook'), hosted)).toBeNull()
  })

  it('*.ts.net matches subdomains only', () => {
    const l = parseAllowlist('*.ts.net')
    expect(checkAddress('93.184.216.34', u('http://a.ts.net/'), l)).toBeNull()
    expect(checkAddress('93.184.216.34', u('http://evilts.net/'), l)).toMatch(/plain http/)
  })

  it('checkUrl refuses non-http schemes, userinfo and literal private IPs', async () => {
    expect(await checkUrl('ftp://127.0.0.1/', def)).toMatch(/only http/)
    expect(await checkUrl('http://u:p@127.0.0.1/', def)).toMatch(/credentials/)
    expect(await checkUrl('http://169.254.169.254/latest/meta-data', def)).toMatch(/link-local/)
    expect(await checkUrl('http://10.0.0.1/', def)).toMatch(/private/)
    expect(await checkUrl('http://127.0.0.1:9/', def)).toMatch(/private address/)
    expect(await checkUrl('http://127.0.0.1:9/', parseAllowlist('127.0.0.1'))).toBeNull()
  })
})

describe('exposed-workspace resolver', () => {
  let base: string
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'halo-a2a-base-')))
    mkdirSync(join(base, 'A', 'B', '.halo'), { recursive: true })
    writeFileSync(join(base, 'A', 'B', '.halo', 'agent-card.json'), '{}')
    mkdirSync(join(base, 'plain', '.halo'), { recursive: true })
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it('resolves a nested exposed dir, refuses unexposed / traversal / empty segments', () => {
    expect(resolveExposedWorkspace(base, 'A/B')).toBe(join(base, 'A', 'B'))
    expect(resolveExposedWorkspace(base, 'plain')).toBeNull()
    expect(resolveExposedWorkspace(base, 'A/../A/B')).toBeNull()
    expect(resolveExposedWorkspace(base, 'A//B')).toBeNull()
    expect(resolveExposedWorkspace(base, '%2e%2e/x')).toBeNull()
    expect(resolveExposedWorkspace(base, 'A%2FB')).toBeNull()
    expect(resolveExposedWorkspace(base, '')).toBeNull()
  })

  it('a symlink pointing outside the base is not found', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'halo-a2a-out-')))
    mkdirSync(join(outside, '.halo'))
    writeFileSync(join(outside, '.halo', 'agent-card.json'), '{}')
    symlinkSync(outside, join(base, 'link'))
    try {
      expect(resolveExposedWorkspace(base, 'link')).toBeNull()
    } finally { rmSync(outside, { recursive: true, force: true }) }
  })

  it('url path: posix + win32 separators, encoding, outside-base → null', () => {
    expect(relUrlPath('/home/u', '/home/u/A/B', 'linux')).toBe('A/B')
    expect(relUrlPath('/home/u', '/home/u/my ws', 'linux')).toBe('my%20ws')
    expect(relUrlPath('/home/u', '/srv/x', 'linux')).toBeNull()
    expect(relUrlPath('C:\\Users\\u', 'C:\\Users\\u\\A\\B', 'win32')).toBe('A/B')
    expect(samePath('C:\\Users\\U\\A', 'c:/users/u/a', 'win32')).toBe(true)
    expect(samePath('/home/U', '/home/u', 'linux')).toBe(false)
  })

  it('card: server fills interfaces / capabilities / security; user fields kept', () => {
    writeFileSync(join(base, 'A', 'B', '.halo', 'agent-card.json'), JSON.stringify({ name: 'B', description: 'd', skills: [{ id: 's', name: 'S', description: 'x', tags: [] }] }))
    const card = buildCard(join(base, 'A', 'B'), 'http://h/a2a/A/B/', { streaming: true }) as Record<string, any>
    expect(card.supportedInterfaces).toEqual([{ url: 'http://h/a2a/A/B/', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }])
    expect(card.capabilities).toEqual({ streaming: true, pushNotifications: true, extendedAgentCard: false })
    expect(card.securitySchemes.bearer).toEqual({ httpAuthSecurityScheme: { scheme: 'Bearer' } })
    expect(card.skills[0].id).toBe('s')
    writeFileSync(join(base, 'A', 'B', '.halo', 'agent-card.json'), JSON.stringify({ name: 'B' }))
    expect(() => buildCard(join(base, 'A', 'B'), 'http://h/', { streaming: false })).toThrow(/skills/)
  })
})

describe('push retry policy', () => {
  it('2xx done, 4xx dead except 408/429, the rest retries', () => {
    expect(verdict(200)).toBe('done')
    expect(verdict(204)).toBe('done')
    expect(verdict(404)).toBe('dead')
    expect(verdict(401)).toBe('dead')
    expect(verdict(408)).toBe('retry')
    expect(verdict(429)).toBe('retry')
    expect(verdict(503)).toBe('retry')
    expect(verdict(null)).toBe('retry')
  })
  it('backoff doubles from 5 s and caps at 10 min (±20 %)', () => {
    expect(backoffMs(1, 0.5)).toBe(5000)
    expect(backoffMs(2, 0.5)).toBe(10000)
    expect(backoffMs(4, 0.5)).toBe(40000)
    expect(backoffMs(20, 0.5)).toBe(600000)
    expect(backoffMs(1, 0)).toBe(4000)
    expect(backoffMs(1, 1)).toBe(6000)
  })
})

describe('task state machine', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'halo-a2a-db-'))
    setA2ADb(createA2ADb(dir))
  })
  afterEach(() => {
    getA2ADb()?.close()
    setA2ADb(null)
    rmSync(dir, { recursive: true, force: true })
  })

  const outbox = () => getA2ADb()!.prepare('SELECT task_id, config_id, event_key, payload FROM a2a_push_outbox ORDER BY id').all() as Array<{ event_key: string; payload: string }>

  it('first terminal writer wins; later transitions are no-ops; one push per (config, event)', () => {
    const t = createTask({ workspace: '/w', contextId: 'a2a_acc_1', accountId: 'acc', messageId: 'm1' })
    putPushConfig(t.id, { url: 'http://127.0.0.1:9/hook', token: 'tok' })
    putPushConfig(t.id, { url: 'http://127.0.0.1:9/hook', token: 'tok' }) // same url → same config
    const seen: string[] = []
    const off = onTaskEvent(t.id, (e) => seen.push(e.kind))
    expect(transition(t.id, 'canceled', { statusText: 'by caller' })?.state).toBe('canceled')
    expect(transition(t.id, 'completed', { result: 'late' })).toBeNull()
    off()
    expect(getTask(t.id)?.state).toBe('canceled')
    expect(seen).toEqual(['terminal'])
    const rows = outbox()
    expect(rows).toHaveLength(1)
    expect(rows[0].event_key).toBe('state:canceled')
    expect(JSON.parse(rows[0].payload).task.status.state).toBe('TASK_STATE_CANCELED')
  })

  it('interims push once each and keep WORKING; completion maps turnError to FAILED', () => {
    const t = createTask({ workspace: '/w', contextId: 'a2a_acc_2', accountId: 'acc', messageId: null })
    putPushConfig(t.id, { url: 'http://127.0.0.1:9/hook' })
    interim(t.id, 'answer to follow-up')
    expect(getTask(t.id)?.state).toBe('working')
    completeTask(t.id, { finalOutput: '', output: 'partial', turnError: 'boom', turnErrorKind: 'account' })
    const row = getTask(t.id)!
    expect(row.state).toBe('failed')
    expect(row.error_kind).toBe('account')
    const json = taskJson(row) as Record<string, any>
    expect(json.artifacts[0]).toMatchObject({ artifactId: 'partial' })
    expect(json.status.message.parts[0].text).toMatch(/NOT completed/)
    expect(outbox().map((r) => r.event_key)).toEqual(['interim:1', 'state:failed'])
  })

  it('completed result = finalOutput || output; artifact "result"', () => {
    const t = createTask({ workspace: '/w', contextId: 'c', accountId: 'acc', messageId: null })
    completeTask(t.id, { finalOutput: '', output: 'whole turn text', turnError: null, turnErrorKind: null })
    expect((taskJson(getTask(t.id)!) as Record<string, any>).artifacts).toEqual([{ artifactId: 'result', name: 'result', parts: [{ text: 'whole turn text' }] }])
  })

  it('ListTasks keyset paging: newest first, totalSize, "" on the last page', () => {
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const t = createTask({ workspace: '/w', contextId: `c${i}`, accountId: 'acc', messageId: null })
      getA2ADb()!.prepare('UPDATE a2a_tasks SET updated_at = ? WHERE id = ?').run(1000 + i, t.id)
      ids.push(t.id)
    }
    createTask({ workspace: '/other', contextId: 'x', accountId: 'acc', messageId: null })
    const p1 = listTasks({ workspace: '/w', accountId: 'acc' }, 2, null)
    expect(p1.total).toBe(5)
    expect(p1.rows.map((r) => r.id)).toEqual([ids[4], ids[3]])
    const p2 = listTasks({ workspace: '/w', accountId: 'acc' }, 2, parsePageToken(p1.next))
    expect(p2.rows.map((r) => r.id)).toEqual([ids[2], ids[1]])
    const p3 = listTasks({ workspace: '/w', accountId: 'acc' }, 2, parsePageToken(p2.next))
    expect(p3.rows.map((r) => r.id)).toEqual([ids[0]])
    expect(p3.next).toBe('')
    expect(listTasks({ workspace: '/w', accountId: 'acc', after: 1002 }, 50, null).rows).toHaveLength(2)
  })
})
