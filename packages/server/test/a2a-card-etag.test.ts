import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { compressResponses } from '../src/middleware/compress.js'
import type { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'
import { createA2ARoutes } from '../src/a2a/routes.js'
import type { A2AStrategies } from '../src/a2a/exposure.js'

/**
 * Contract: the agent card answers a 304 whenever If-None-Match weakly
 * matches its ETag (RFC 9110), behind the same `compressResponses(1024)`
 * index.ts mounts globally.
 *  - the tag is weak, and one tag covers the card gzipped or not: a 200 in
 *    either form and its 304 carry the same `W/"…"`;
 *  - a card under 1 KiB goes out uncompressed with Content-Length (set by
 *    the global middleware), a larger one is gzipped;
 *  - auth runs first: a failed auth with a matching tag is 401, never 304.
 */

const CARD = '/a2a/x/.well-known/agent-card.json'
const GZIP = { 'accept-encoding': 'gzip' }

let ws: string

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'halo-a2a-card-etag-')))
  mkdirSync(join(ws, '.halo'), { recursive: true })
})
afterEach(() => rmSync(ws, { recursive: true, force: true }))

function writeCard(skillCount: number): void {
  const skills = Array.from({ length: skillCount }, (_, i) => ({
    id: `skill-${i}`, name: `Skill ${i}`, description: `Does thing number ${i}`, tags: ['t'],
  }))
  writeFileSync(join(ws, '.halo', 'agent-card.json'), JSON.stringify({ name: 'n', description: 'd', skills }))
}

function app(authOk = true): Hono {
  const strategies: A2AStrategies = {
    authenticate: () => authOk
      ? { ok: true, caller: { accountId: 'acc', label: 'acc', accessLevel: 'full' }, workspace: ws }
      : { ok: false, status: 401 },
    interfaceUrl: () => 'http://h/a2a/x/',
  }
  // GET card never touches the registry.
  const registry = {} as unknown as SessionManagerRegistry
  const a = new Hono()
  a.use('/*', compressResponses(1024))
  a.route('/a2a', createA2ARoutes({ registry, strategies, ownsRuntimes: false }))
  return a
}

describe('agent card ETag', () => {
  it('small card + gzip: not compressed, W/ tag, Content-Length; its 304 carries the same tag', async () => {
    writeCard(0)
    const a = app()
    const r = await a.request(CARD, { headers: GZIP })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-encoding')).toBeNull()
    const etag = r.headers.get('etag')!
    expect(etag.startsWith('W/"')).toBe(true)
    const body = await r.text()
    expect(r.headers.get('content-length')).toBe(String(Buffer.byteLength(body)))
    expect(JSON.parse(body).name).toBe('n')
    expect((await a.request(CARD)).headers.get('etag')).toBe(etag)

    const r2 = await a.request(CARD, { headers: { ...GZIP, 'if-none-match': etag } })
    expect(r2.status).toBe(304)
    expect(r2.headers.get('etag')).toBe(etag)
    expect(await r2.text()).toBe('')
  })

  it('large card: gzipped and plain share one W/ tag; its 304 carries the same tag', async () => {
    writeCard(40)
    const a = app()
    const r = await a.request(CARD, { headers: GZIP })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-encoding')).toBe('gzip')
    const etag = r.headers.get('etag')!
    expect(etag.startsWith('W/"')).toBe(true)
    const plain = await a.request(CARD)
    expect(plain.headers.get('content-encoding')).toBeNull()
    expect(plain.headers.get('etag')).toBe(etag)

    const r2 = await a.request(CARD, { headers: { ...GZIP, 'if-none-match': etag } })
    expect(r2.status).toBe(304)
    expect(r2.headers.get('etag')).toBe(etag)
    expect(await r2.text()).toBe('')
  })

  it('the tag without W/, a list and * → 304; a stale tag → full 200', async () => {
    writeCard(40)
    const a = app()
    const r = await a.request(CARD)
    const etag = r.headers.get('etag')!
    const full = await r.text()

    for (const inm of [etag.replace(/^W\//, ''), `W/"zzz", ${etag}`, '*']) {
      const hit = await a.request(CARD, { headers: { 'if-none-match': inm } })
      expect(hit.status, inm).toBe(304)
    }

    const stale = await a.request(CARD, { headers: { 'if-none-match': '"stale"' } })
    expect(stale.status).toBe(200)
    expect(await stale.text()).toBe(full)
  })

  it('failed auth with a matching tag (or *) → 401, not 304', async () => {
    writeCard(0)
    const etag = (await app().request(CARD)).headers.get('etag')!
    const denied = app(false)
    for (const inm of [etag, '*']) {
      const r = await denied.request(CARD, { headers: { 'if-none-match': inm } })
      expect(r.status, inm).toBe(401)
    }
  })
})
