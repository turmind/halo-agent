import { describe, it, expect, vi } from 'vitest'
import type { ExtensionInfo, ExtensionsUpdateStatus } from '@turmind/halo-core/protocol'
import { CHECK_CONCURRENCY, createExtensionsChecker } from '../src/updates/extension-check.js'
import { CHECK_TTL_MS, MANUAL_COOLDOWN_MS } from '../src/updates/core-check.js'
import type { UpdateJsonResult } from '../src/updates/extension-fetch.js'

/**
 * Contract for the `extensions` update scope (updates/extension-check.ts):
 * every installed extension (the caller passes on + off) reads its own
 * update.json, ≤ 4 at a time; the core checker's cadence (24 h / 60 s, one
 * in flight, failures cached, no timer); verdicts per row (newer → available,
 * same or older → current, minHalo → needs-halo, 404 → not-found, no URL →
 * no-source); a snapshot change re-judges from the cache with no network and
 * pushes only when the list changed; checkOne is a fresh read.
 */

const ext = (id: string, version = '1.0.0', extra: Partial<ExtensionInfo> = {}): ExtensionInfo => ({
  id, name: id, version, extensions: ['.x'], entry: 'index.html', priority: 'default', capabilities: [], bundle: false, installedAt: 0, ...extra,
})
const found = (id: string, version: string, minHalo?: string): UpdateJsonResult => ({
  info: { id, version, url: `https://h/${id}.zip`, sha256: 'a'.repeat(64), ...(minHalo ? { minHalo } : {}) },
})

function harness(opts: { installed: ExtensionInfo[]; answers: Record<string, UpdateJsonResult>; haloVersion?: string; urls?: Record<string, string | null> }) {
  let t = 1_000_000
  let installed = opts.installed
  const fetch = vi.fn(async (id: string, _url: string) => opts.answers[id] ?? { error: 'gone', code: 'not-found' as const })
  const changes: ExtensionsUpdateStatus[] = []
  const checker = createExtensionsChecker({
    haloVersion: opts.haloVersion ?? '2.0.0',
    installed: () => installed,
    resolveUrl: (e) => (opts.urls && e.id in opts.urls ? opts.urls[e.id]! : `https://hub/${e.id}/update.json`),
    fetchUpdateJson: fetch,
    now: () => t,
    onChange: (s) => changes.push(s),
  })
  return { checker, fetch, changes, advance: (ms: number) => { t += ms }, setInstalled: (l: ExtensionInfo[]) => { installed = l } }
}

describe('extensions checker', () => {
  it('judges every installed extension, sorted by id', async () => {
    const h = harness({
      installed: [ext('voice', '1.0.0'), ext('glb', '1.0.0'), ext('drawio', '2.0.0'), ext('city', '1.0.0'), ext('local', '1.0.0'), ext('bad', '1.0.0')],
      answers: {
        glb: found('glb', '1.1.0'),
        drawio: found('drawio', '1.9.0'), // older than installed: never a downgrade
        city: found('city', '1.2.0', '2.1.0'),
        bad: { error: 'update.json is not valid JSON', code: 'invalid' },
      },
      urls: { local: null },
    })
    const first = h.checker.getStatus(false)
    expect(first.checking).toBe(true)
    expect(first.extensions.every((e) => e.state === 'unknown')).toBe(true)
    await h.checker.settled()
    expect(h.changes).toHaveLength(1)
    expect(h.changes[0]).toEqual({
      checking: false,
      checkedAt: 1_000_000,
      extensions: [
        { id: 'bad', installed: '1.0.0', state: 'invalid', error: 'update.json is not valid JSON' },
        { id: 'city', installed: '1.0.0', state: 'needs-halo', latest: '1.2.0', minHalo: '2.1.0' },
        { id: 'drawio', installed: '2.0.0', state: 'current', latest: '1.9.0' },
        { id: 'glb', installed: '1.0.0', state: 'available', latest: '1.1.0' },
        { id: 'local', installed: '1.0.0', state: 'no-source' },
        { id: 'voice', installed: '1.0.0', state: 'not-found', error: 'gone' },
      ],
    })
    // no-source never reaches the network
    expect(h.fetch.mock.calls.map((c) => c[0]).sort()).toEqual(['bad', 'city', 'drawio', 'glb', 'voice'])
  })

  it('a fetch that throws still settles the check (checking:false), the others still judged', async () => {
    const installed = [ext('a'), ext('boom'), ext('c')]
    const checker = createExtensionsChecker({
      haloVersion: '2.0.0',
      installed: () => installed,
      resolveUrl: (e) => `https://hub/${e.id}/update.json`,
      fetchUpdateJson: async (id) => { if (id === 'boom') throw new TypeError('Cannot convert object to primitive value'); return found(id, '1.1.0') },
    })
    expect(checker.getStatus(false).checking).toBe(true)
    await checker.settled()
    const s = checker.getStatus(false)
    expect(s.checking).toBe(false)
    expect(s.checkedAt).not.toBeNull()
    expect(s.extensions.map((e) => `${e.id}:${e.state}`)).toEqual(['a:available', 'boom:unknown', 'c:available'])
  })

  it('the hostile {"id":{"toString":0}} update.json reads as invalid end to end', async () => {
    const { parseUpdateJson } = await import('../src/updates/update-json.js')
    const checker = createExtensionsChecker({
      haloVersion: '2.0.0',
      installed: () => [ext('glb')],
      resolveUrl: () => 'https://hub/glb/update.json',
      // the real parser on the hostile body (the network half is in updates-https.test.ts)
      fetchUpdateJson: async (id) => {
        const parsed = parseUpdateJson(JSON.parse('{"id":{"toString":0},"version":"1.1.0","url":"x.zip","sha256":"' + 'a'.repeat(64) + '"}'), 'https://hub/glb/update.json', id)
        return 'error' in parsed ? { error: parsed.error, code: 'invalid' as const } : { info: parsed }
      },
    })
    checker.getStatus(false)
    await checker.settled()
    expect(checker.getStatus(false)).toMatchObject({ checking: false, extensions: [{ id: 'glb', state: 'invalid', error: 'update.json id {"toString":0} does not match "glb"' }] })
  })

  it('a dev Halo is not held back by minHalo', async () => {
    const h = harness({ installed: [ext('city')], answers: { city: found('city', '1.2.0', '9.0.0') }, haloVersion: 'dev' })
    h.checker.getStatus(false)
    await h.checker.settled()
    expect(h.changes[0].extensions[0].state).toBe('available')
  })

  it(`at most ${CHECK_CONCURRENCY} reads at a time`, async () => {
    let active = 0
    let peak = 0
    const installed = Array.from({ length: 10 }, (_, i) => ext(`e${i}`))
    const checker = createExtensionsChecker({
      haloVersion: '2.0.0',
      installed: () => installed,
      resolveUrl: (e) => `https://hub/${e.id}/update.json`,
      fetchUpdateJson: async (id) => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 5))
        active--
        return found(id, '1.0.0')
      },
    })
    checker.getStatus(false)
    await checker.settled()
    expect(peak).toBe(CHECK_CONCURRENCY)
    expect(checker.getStatus(false).extensions).toHaveLength(10)
  })

  it('24 h cache for a page open, 60 s cooldown for the button, one check in flight', async () => {
    const h = harness({ installed: [ext('glb')], answers: { glb: found('glb', '1.1.0') } })
    h.checker.getStatus(false)
    h.checker.getStatus(true) // in flight → no second run
    await h.checker.settled()
    expect(h.fetch).toHaveBeenCalledTimes(1)

    h.advance(MANUAL_COOLDOWN_MS - 1)
    expect(h.checker.getStatus(true).checking).toBe(false)
    h.advance(1)
    expect(h.checker.getStatus(true).checking).toBe(true)
    await h.checker.settled()
    expect(h.fetch).toHaveBeenCalledTimes(2)

    h.advance(CHECK_TTL_MS - 1)
    expect(h.checker.getStatus(false).checking).toBe(false)
    h.advance(1)
    expect(h.checker.getStatus(false).checking).toBe(true)
    await h.checker.settled()
    expect(h.fetch).toHaveBeenCalledTimes(3)
  })

  it('a snapshot change re-judges from the cache with no network, and pushes only when the list changed', async () => {
    const h = harness({ installed: [ext('glb', '1.0.0')], answers: { glb: found('glb', '1.1.0') } })
    h.checker.rejudge() // before the first check: nothing to say
    expect(h.changes).toHaveLength(0)
    h.checker.getStatus(false)
    await h.checker.settled()
    expect(h.changes).toHaveLength(1)

    h.checker.rejudge() // same snapshot → silent
    expect(h.changes).toHaveLength(1)

    h.setInstalled([ext('glb', '1.1.0'), ext('new')]) // updated + a fresh install
    h.checker.rejudge()
    expect(h.fetch).toHaveBeenCalledTimes(1)
    expect(h.changes).toHaveLength(2)
    expect(h.changes[1].extensions).toEqual([
      { id: 'glb', installed: '1.1.0', state: 'current', latest: '1.1.0' },
      { id: 'new', installed: '1.0.0', state: 'unknown' },
    ])
  })

  it('checkOne is a fresh read: info only on `available`, cache refreshed and pushed', async () => {
    const answers: Record<string, UpdateJsonResult> = { glb: found('glb', '1.0.0') }
    const h = harness({ installed: [ext('glb', '1.0.0')], answers })
    h.checker.getStatus(false)
    await h.checker.settled()
    expect(h.changes[0].extensions[0].state).toBe('current')

    const none = await h.checker.checkOne(ext('glb', '1.0.0'))
    expect(none).toEqual({ entry: { id: 'glb', installed: '1.0.0', state: 'current', latest: '1.0.0' } })
    expect(h.changes).toHaveLength(1)

    answers.glb = found('glb', '1.1.0')
    const yes = await h.checker.checkOne(ext('glb', '1.0.0'))
    expect(yes.entry.state).toBe('available')
    expect(yes.info).toMatchObject({ version: '1.1.0' })
    expect(h.fetch).toHaveBeenCalledTimes(3)
    expect(h.changes).toHaveLength(2)
    expect(h.changes[1].extensions[0]).toMatchObject({ state: 'available', latest: '1.1.0' })
  })
})
