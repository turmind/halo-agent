import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import JSZip from 'jszip'
import type { Hono } from 'hono'

/**
 * Contract for Settings → "Sync latest models" (POST /api/models/update,
 * models/hub-update.ts), with httpsGet mocked — GitHub is never contacted:
 *  - the newest non-draft / non-prerelease `models-v<digit>` release with a
 *    `.zip` asset is the one downloaded;
 *  - a plan that needs consent writes nothing and lists the endpoint changes;
 *    `confirm: true` fetches + plans again and writes;
 *  - a non-GitHub hub_repo → 400, a second sync while one runs → 409, a hub
 *    failure → 502;
 *  - zip entries land flat under their basename (no path escapes models.d's
 *    temp dir), the temp dir is removed.
 * Own temp HOME (paths / settings resolve homedir() at call time) set before
 * the dynamic imports.
 */

const get = vi.hoisted(() => ({ fn: null as null | ((url: string) => Promise<unknown>) }))
vi.mock('../src/updates/https-get.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/updates/https-get.js')>()
  return { ...orig, httpsGet: (url: string) => get.fn!(url) }
})

const BUNDLED = path.resolve(import.meta.dirname, '..', 'templates', 'models')
const API = 'https://api.github.com/repos/turmind/halo-hub/releases?per_page=100'
let tmpHome: string
let hubDir: string
let modelsDir: string
let app: Hono
let hits: string[]

const kimi = () => YAML.parse(fs.readFileSync(path.join(BUNDLED, 'kimi.yaml'), 'utf-8')) as Record<string, unknown>
const KIMI_REV = kimi().revision as number
const ok = (body: Buffer | string) => ({ status: 200, url: '', headers: {}, body: Buffer.from(body) })
const release = (tag: string, extra: Record<string, unknown> = {}, asset = `${tag}.zip`) =>
  ({ tag_name: tag, draft: false, prerelease: false, assets: [{ name: asset, browser_download_url: `https://dl.example/${tag}/${asset}` }], ...extra })

async function zipOf(files: Record<string, Record<string, unknown> | string>): Promise<Buffer> {
  const z = new JSZip()
  for (const [name, data] of Object.entries(files)) z.file(name, typeof data === 'string' ? data : YAML.stringify(data))
  return z.generateAsync({ type: 'nodebuffer' })
}

/** Serve `releases` from the API URL and `zips[url]` from asset URLs. */
function hub(releases: unknown[], zips: Record<string, Buffer>): void {
  get.fn = async (url) => {
    hits.push(url)
    if (url === API) return ok(JSON.stringify(releases))
    if (zips[url]) return ok(zips[url]!)
    return { status: 404, url, headers: {}, body: Buffer.alloc(0) }
  }
}

const post = (body?: unknown) => app.request('/models/update', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
})
const setHubRepo = (v: string | null) => {
  const file = path.join(tmpHome, '.halo', 'secrets', 'settings.yaml')
  fs.writeFileSync(file, YAML.stringify(v === null ? {} : { extension: { params: { hub_repo: v } } }))
  const t = Date.now() / 1000 + ++bump * 10
  fs.utimesSync(file, t, t)
}
let bump = 0
const halotmp = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('halo-models-'))

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-models-sync-'))
  process.env.HOME = tmpHome
  modelsDir = path.join(tmpHome, '.halo', 'global', 'models')
  hubDir = path.join(tmpHome, '.halo', 'global', 'models.d')
  fs.mkdirSync(path.join(tmpHome, '.halo', 'secrets'), { recursive: true })
  const { createUpdateRoutes } = await import('../src/routes/updates.js')
  app = createUpdateRoutes()
})

afterAll(() => fs.rmSync(tmpHome, { recursive: true, force: true }))

beforeEach(() => {
  hits = []
  for (const d of [modelsDir, hubDir]) fs.rmSync(d, { recursive: true, force: true })
  fs.cpSync(BUNDLED, modelsDir, { recursive: true })
  setHubRepo(null)
})

describe('POST /models/update', () => {
  it('picks the newest models-v<digit> release with a zip — skipping drafts, prereleases, other tags', async () => {
    const newer = { ...kimi(), revision: KIMI_REV + 1 }
    const releases = [
      release('glb-v1.2.0'),
      release('models-v2026.12.01', { draft: true }),
      release('models-v2026.11.30', { prerelease: true }),
      release('models-vnext'),
      release('models-v2026.11.20', {}, 'notes.txt'),
      release('models-v2026.11.10'),
      release('models-v2026.11.01'),
    ]
    hub(releases, { 'https://dl.example/models-v2026.11.10/models-v2026.11.10.zip': await zipOf({ 'kimi.yaml': newer }) })
    const res = await post({})
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(hits).toEqual([API, 'https://dl.example/models-v2026.11.10/models-v2026.11.10.zip'])
    expect(body).toMatchObject({ hub: 'turmind/halo-hub', release: 'models-v2026.11.10', needsConfirm: false, written: ['kimi'] })
    expect(body.summary).toBe('models: 1 installed (kimi), 0 up to date')
    expect(body.entries).toEqual([expect.objectContaining({ file: 'kimi.yaml', id: 'kimi', action: 'install', revision: KIMI_REV + 1 })])
    expect(JSON.stringify(body)).not.toContain('"raw"')
    expect(fs.readdirSync(hubDir)).toEqual(['kimi.yaml'])
  })

  it('a plan needing consent writes nothing; confirm fetches + plans again, then writes', async () => {
    const moved = { ...kimi(), revision: KIMI_REV + 1, defaultEndpoint: 'https://api.moonshot.ai/v1' }
    hub([release('models-v1')], { 'https://dl.example/models-v1/models-v1.zip': await zipOf({ 'kimi.yaml': moved, 'qwen.yaml': YAML.parse(fs.readFileSync(path.join(BUNDLED, 'qwen.yaml'), 'utf-8')) }) })
    const first = await (await post({})).json() as Record<string, unknown>
    expect(first).toMatchObject({ needsConfirm: true, written: [], summary: null })
    expect(first.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'kimi', action: 'install', needsConfirm: true, endpointChanges: ['defaultEndpoint: https://api.moonshot.cn/v1 → https://api.moonshot.ai/v1'] }),
      expect.objectContaining({ id: 'qwen', action: 'up-to-date' }),
    ]))
    expect(fs.existsSync(hubDir) ? fs.readdirSync(hubDir) : []).toEqual([])

    hits = []
    const second = await (await post({ confirm: true })).json() as Record<string, unknown>
    expect(hits).toHaveLength(2)
    expect(second).toMatchObject({ needsConfirm: false, written: ['kimi'], summary: 'models: 1 installed (kimi), 1 up to date' })
    expect(fs.readdirSync(hubDir)).toEqual(['kimi.yaml'])
    // A non-boolean confirm is not consent.
    fs.rmSync(hubDir, { recursive: true, force: true })
    expect(await (await post({ confirm: 'yes' })).json()).toMatchObject({ needsConfirm: true })
    expect(fs.existsSync(hubDir) ? fs.readdirSync(hubDir) : []).toEqual([])
  })

  it('refused entries come back with their reason (e.g. needs a newer Halo)', async () => {
    hub([release('models-v1')], { 'https://dl.example/models-v1/models-v1.zip': await zipOf({ 'kimi.yaml': { ...kimi(), runtime: 'grpc-magic', revision: KIMI_REV + 1 } }) })
    const body = await (await post()).json() as { entries: Array<Record<string, unknown>>; summary: string }
    expect(body.entries[0]).toMatchObject({ id: 'kimi', action: 'refuse', reason: 'unknown runtime "grpc-magic" — needs a newer halo' })
    expect(body.summary).toBe('models: 0 installed, 0 up to date, 1 refused (kimi)')
  })

  it('zip paths are flattened to their basename: nothing lands outside the temp dir, the temp dir is removed', async () => {
    const before = halotmp()
    const outside = path.join(tmpHome, 'escaped.yaml')
    const newer = { ...kimi(), revision: KIMI_REV + 1 }
    const zip = await zipOf({
      'models-2026/kimi.yaml': newer,
      [`../../../../../../..${outside}`]: { ...newer, id: 'escaped' },
      'README.md': '# not a provider',
    })
    hub([release('models-v1')], { 'https://dl.example/models-v1/models-v1.zip': zip })
    const body = await (await post({ confirm: true })).json() as { written: string[]; entries: Array<{ file: string }> }
    expect(fs.existsSync(outside)).toBe(false)
    expect(body.entries.map((e) => e.file)).toEqual(['escaped.yaml', 'kimi.yaml'])
    expect(body.written).toEqual(['escaped', 'kimi'])
    expect(fs.readdirSync(hubDir).sort()).toEqual(['escaped.yaml', 'kimi.yaml'])
    expect(halotmp()).toEqual(before)
  })

  it('a non-GitHub hub_repo → 400 pointing at /extension models; nothing fetched', async () => {
    get.fn = async (url) => { hits.push(url); throw new Error('unexpected fetch') }
    setHubRepo('https://gitea.example.com/team/hub')
    const res = await post({})
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toMatch(/GitHub hubs only.*\/extension models/)
    expect(hits).toEqual([])
    // owner/repo and the https GitHub form are GitHub.
    setHubRepo('acme/models-hub')
    hub([], {})
    expect((await post({})).status).toBe(502)
    expect(hits).toEqual(['https://api.github.com/repos/acme/models-hub/releases?per_page=100'])
  })

  it('a second sync while one runs → 409; the flag clears afterwards', async () => {
    let release1!: () => void
    const gate = new Promise<void>((r) => { release1 = r })
    const zip = await zipOf({ 'kimi.yaml': kimi() })
    get.fn = async (url) => {
      if (url === API) { await gate; return ok(JSON.stringify([release('models-v1')])) }
      return ok(zip)
    }
    const first = post({})
    await new Promise((r) => setTimeout(r, 20))
    const second = await post({})
    expect(second.status).toBe(409)
    expect(await second.json()).toEqual({ error: 'A model sync is already running' })
    release1()
    expect((await first).status).toBe(200)
    expect((await post({})).status).toBe(200)
  })

  it('hub failures → 502 with the reason: no models release, HTTP error, network error', async () => {
    hub([release('glb-v1')], {})
    let res = await post({})
    expect(res.status).toBe(502)
    expect((await res.json() as { error: string }).error).toBe('no models-v* release with a .zip asset in turmind/halo-hub')

    get.fn = async () => ({ status: 403, url: API, headers: {}, body: Buffer.alloc(0) })
    res = await post({})
    expect(res.status).toBe(502)
    expect((await res.json() as { error: string }).error).toMatch(/HTTP 403.*rate-limited/)

    const { HttpsGetError } = await import('../src/updates/https-get.js')
    get.fn = async () => { throw new HttpsGetError('timeout', 'timeout after 15000ms') }
    res = await post({})
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'timeout after 15000ms' })
  })
})
