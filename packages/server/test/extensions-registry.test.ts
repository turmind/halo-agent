import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseManifest, scanExtensions, getSnapshot, getExtension, snapshotKey, readExtensionDir, extensionsRoot } from '../src/extensions/registry.js'

/**
 * Contract: `~/.halo/global/extensions/<id>/` is the install. The scanner is
 * the single validator every install path (admin upload, ext.sh, manual cp)
 * is judged by — so its rules are pinned here field by field — and an
 * invalid directory is still LISTED (errors[]) rather than silently dropped.
 * Dot-prefixed dirs (`.tmp-*` / `.old-*` staging) are never listed.
 *
 * HOME is redirected so extensionsRoot() lands in a temp dir.
 */

const ok = {
  id: 'glb', name: 'GLB Viewer', version: '1.0.0', extensions: ['.glb'], entry: 'index.html',
}
const entryYes = () => true
const entryNo = () => false

function parse(over: Record<string, unknown>, dir = 'glb', exists = entryYes) {
  return parseManifest({ ...ok, ...over }, dir, exists)
}
function errorOf(r: ReturnType<typeof parseManifest>): string {
  return 'error' in r ? r.error : ''
}

describe('parseManifest', () => {
  it('accepts a minimal manifest with defaults filled in', () => {
    const r = parse({})
    expect(r).toEqual({ id: 'glb', name: 'GLB Viewer', version: '1.0.0', extensions: ['.glb'], entry: 'index.html', priority: 'default', capabilities: [], bundle: false })
  })

  it('keeps optional fields when present', () => {
    const r = parse({ description: 'd', priority: 'option', capabilities: ['save', 'save'], homepage: 'https://x', license: 'MIT' })
    expect(r).toMatchObject({ description: 'd', priority: 'option', capabilities: ['save'], homepage: 'https://x', license: 'MIT' })
  })

  it('rejects non-objects', () => {
    expect(errorOf(parseManifest(null, 'glb', entryYes))).toMatch(/JSON object/)
    expect(errorOf(parseManifest([], 'glb', entryYes))).toMatch(/JSON object/)
    expect(errorOf(parseManifest('x', 'glb', entryYes))).toMatch(/JSON object/)
  })

  it('id: slug only, must equal the directory name', () => {
    expect(errorOf(parse({ id: 'GLB' }))).toMatch(/^id must match/)
    expect(errorOf(parse({ id: '.tmp-glb' }))).toMatch(/^id must match/)
    expect(errorOf(parse({ id: 'a/b' }))).toMatch(/^id must match/)
    expect(errorOf(parse({ id: 'x'.repeat(65) }))).toMatch(/^id must match/)
    expect(errorOf(parse({}, 'other'))).toMatch(/id mismatch/)
  })

  it('name / version / description shape', () => {
    expect(errorOf(parse({ name: '' }))).toMatch(/name/)
    expect(errorOf(parse({ name: 'x'.repeat(65) }))).toMatch(/name/)
    expect(errorOf(parse({ version: '1.0' }))).toMatch(/version/)
    expect(errorOf(parse({ version: 'v1.0.0' }))).toMatch(/version/)
    expect(parse({ version: '1.0.0-beta.1' })).not.toHaveProperty('error')
    expect(errorOf(parse({ description: 'x'.repeat(201) }))).toMatch(/description/)
  })

  it('extensions: non-empty, lowercase, with the dot', () => {
    expect(errorOf(parse({ extensions: [] }))).toMatch(/non-empty/)
    expect(errorOf(parse({ extensions: ['glb'] }))).toMatch(/"glb"/)
    expect(errorOf(parse({ extensions: ['.GLB'] }))).toMatch(/"\.GLB"/)
    expect(errorOf(parse({ extensions: ['.drawio.png'] }))).toMatch(/drawio/)
    expect(errorOf(parse({ extensions: [1] }))).toMatch(/"1"/)
  })

  it('entry: relative, no traversal, must exist', () => {
    expect(errorOf(parse({ entry: '/index.html' }))).toMatch(/entry must be/)
    expect(errorOf(parse({ entry: '../index.html' }))).toMatch(/entry must be/)
    expect(errorOf(parse({ entry: 'a\\..\\b.html' }))).toMatch(/entry must be/)
    expect(errorOf(parse({ entry: '' }))).toMatch(/entry must be/)
    expect(errorOf(parse({}, 'glb', entryNo))).toMatch(/entry not found: index.html/)
    expect(parse({ entry: 'dist/index.html' })).not.toHaveProperty('error')
  })

  it('priority and capabilities are closed enums', () => {
    expect(errorOf(parse({ priority: 'exclusive' }))).toMatch(/priority/)
    expect(errorOf(parse({ capabilities: 'save' }))).toMatch(/capabilities must be an array/)
    expect(errorOf(parse({ capabilities: ['readRelative'] }))).toMatch(/unknown capability: readRelative/)
  })

  it('homepage must be http(s)', () => {
    expect(errorOf(parse({ homepage: 'ftp://x' }))).toMatch(/homepage/)
    expect(errorOf(parse({ license: 3 }))).toMatch(/license/)
  })

  // htrans protocol §1: bundle / platforms / media.
  it('bundle: optional boolean, default false, incompatible with save', () => {
    expect(parse({ bundle: true, extensions: ['.htrans'] })).toMatchObject({ bundle: true })
    expect(parse({ bundle: false })).toMatchObject({ bundle: false })
    expect(errorOf(parse({ bundle: 'yes' }))).toBe('bundle must be a boolean')
    expect(errorOf(parse({ bundle: 1 }))).toBe('bundle must be a boolean')
    expect(errorOf(parse({ bundle: true, capabilities: ['save'] }))).toBe('bundle extensions cannot declare save')
    expect(parse({ bundle: false, capabilities: ['save'] })).not.toHaveProperty('error')
  })

  it('capability media is accepted (and de-duplicated); unknown still rejected', () => {
    expect(parse({ bundle: true, capabilities: ['media', 'media'] })).toMatchObject({ capabilities: ['media'] })
    expect(parse({ capabilities: ['save', 'media'] })).toMatchObject({ capabilities: ['save', 'media'] })
    expect(errorOf(parse({ capabilities: ['camera'] }))).toMatch(/unknown capability: camera/)
  })

  it('platforms: omitted = absent; non-empty array of known values, de-duplicated', () => {
    expect(parse({})).not.toHaveProperty('platforms')
    expect(parse({ platforms: ['desktop-mac', 'desktop-win', 'desktop-mac'] })).toMatchObject({ platforms: ['desktop-mac', 'desktop-win'] })
    expect(parse({ platforms: ['web', 'desktop-mac', 'desktop-win', 'desktop-linux'] })).not.toHaveProperty('error')
    expect(errorOf(parse({ platforms: [] }))).toBe('platforms must be a non-empty array')
    expect(errorOf(parse({ platforms: 'web' }))).toBe('platforms must be a non-empty array')
    expect(errorOf(parse({ platforms: ['ios'] }))).toBe('unknown platform: ios')
    expect(errorOf(parse({ platforms: [1] }))).toBe('unknown platform: 1')
    expect(errorOf(parse({ platforms: ['Web'] }))).toBe('unknown platform: Web')
  })

  // Rev 2026-10-06: transcribe capability + extension-declared settings.
  it('capability transcribe is accepted', () => {
    expect(parse({ capabilities: ['media', 'transcribe'] })).toMatchObject({ capabilities: ['media', 'transcribe'] })
  })

  it('capability fs-read is accepted for bundle and non-bundle extensions', () => {
    expect(parse({ bundle: true, capabilities: ['fs-read'] })).toMatchObject({ bundle: true, capabilities: ['fs-read'] })
    expect(parse({ capabilities: ['fs-read', 'fs-read'] })).toMatchObject({ bundle: false, capabilities: ['fs-read'] })
    expect(errorOf(parse({ capabilities: ['workspace-write'] }))).toMatch(/unknown capability: workspace-write/)
  })

  it('settings: declarations parsed (values never), scalar defaults stringified, empty = absent', () => {
    const r = parse({
      settings: {
        params: [{ key: 'region', default: 'us-east-1', description: 'AWS region', description_zh: '区域' }, { key: 'rate', default: 16000, type: 'int' }],
        secrets: [{ key: 'access_key_id' }, { key: 'mode', type: 'enum', options: ['a', 'b'] }],
      },
    })
    expect(r).toMatchObject({
      settings: {
        params: [{ key: 'region', default: 'us-east-1', description: 'AWS region', description_zh: '区域' }, { key: 'rate', default: '16000', type: 'int' }],
        secrets: [{ key: 'access_key_id' }, { key: 'mode', type: 'enum', options: ['a', 'b'] }],
      },
    })
    expect(parse({})).not.toHaveProperty('settings')
    expect(parse({ settings: {} })).not.toHaveProperty('settings')
    expect(parse({ settings: { params: [] } })).not.toHaveProperty('settings')
  })

  it('settings: malformed = manifest error', () => {
    expect(errorOf(parse({ settings: [] }))).toBe('settings must be an object')
    expect(errorOf(parse({ settings: { params: {} } }))).toBe('settings.params must be an array')
    expect(errorOf(parse({ settings: { secrets: ['k'] } }))).toBe('settings.secrets entries must be objects')
    expect(errorOf(parse({ settings: { params: [{ key: 'Region' }] } }))).toMatch(/settings key "Region" must match/)
    expect(errorOf(parse({ settings: { params: [{ key: '1x' }] } }))).toMatch(/settings key "1x" must match/)
    expect(errorOf(parse({ settings: { params: [{ key: 'a.b' }] } }))).toMatch(/settings key "a.b" must match/)
    expect(errorOf(parse({ settings: { params: [{}] } }))).toMatch(/settings key "undefined" must match/)
    expect(errorOf(parse({ settings: { params: [{ key: 'k' }], secrets: [{ key: 'k' }] } }))).toBe('duplicate settings key: k')
    expect(errorOf(parse({ settings: { params: [{ key: 'k', description: 1 }] } }))).toBe('settings k.description must be a string')
    expect(errorOf(parse({ settings: { params: [{ key: 'k', default: {} }] } }))).toBe('settings k.default must be a scalar')
    expect(errorOf(parse({ settings: { params: [{ key: 'k', type: 'date' }] } }))).toMatch(/settings k.type must be one of/)
    expect(errorOf(parse({ settings: { params: [{ key: 'k', options: [] }] } }))).toMatch(/settings k.options must be/)
    expect(errorOf(parse({ settings: { params: [{ key: 'k', type: 'enum' }] } }))).toBe('settings k: type enum requires options')
  })
})

describe('scanExtensions (on-disk)', () => {
  let home: string
  const prevHome = process.env.HOME

  function writeExt(id: string, manifest: Record<string, unknown> | string, files: Record<string, string> = { 'index.html': '<html>' }) {
    const dir = path.join(extensionsRoot(), id)
    fs.mkdirSync(dir, { recursive: true })
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      fs.writeFileSync(path.join(dir, rel), content)
    }
    fs.writeFileSync(path.join(dir, 'halo-extension.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
    return dir
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-ext-registry-'))
    process.env.HOME = home
  })
  afterEach(() => {
    process.env.HOME = prevHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('root resolves under HOME and a missing root scans as empty', () => {
    expect(extensionsRoot()).toBe(path.join(home, '.halo', 'global', 'extensions'))
    expect(scanExtensions()).toEqual({ extensions: [], errors: [] })
  })

  it('lists valid dirs, keeps invalid ones as errors, skips dot-dirs and files', () => {
    writeExt('glb', { ...ok })
    writeExt('bad-id', { ...ok, id: 'glb' })          // manifest id ≠ dir name
    writeExt('noentry', { ...ok, id: 'noentry' }, {}) // entry missing
    writeExt('broken', '{ not json')
    fs.mkdirSync(path.join(extensionsRoot(), 'nomanifest'))
    fs.mkdirSync(path.join(extensionsRoot(), '.tmp-glb-abc123'))
    fs.mkdirSync(path.join(extensionsRoot(), '.old-glb-abc123'))
    fs.mkdirSync(path.join(extensionsRoot(), 'Bad Name'))
    fs.writeFileSync(path.join(extensionsRoot(), 'stray.zip'), 'x')

    const snap = scanExtensions()
    expect(snap.extensions.map((e) => e.id)).toEqual(['glb'])
    expect(snap.extensions[0]).toMatchObject({ id: 'glb', version: '1.0.0', priority: 'default', capabilities: [] })
    expect(snap.extensions[0].installedAt).toBeGreaterThan(0)
    expect(snap.errors.map((e) => e.id).sort()).toEqual(['Bad Name', 'bad-id', 'broken', 'noentry', 'nomanifest'])
    expect(snap.errors.find((e) => e.id === 'bad-id')?.error).toMatch(/id mismatch/)
    expect(snap.errors.find((e) => e.id === 'noentry')?.error).toMatch(/entry not found/)
    expect(snap.errors.find((e) => e.id === 'broken')?.error).toMatch(/unreadable/)
    expect(snap.errors.find((e) => e.id === 'nomanifest')?.error).toMatch(/missing/)
    expect(snap.errors.find((e) => e.id === 'Bad Name')?.error).toMatch(/not a valid extension id/)
    // cached snapshot + lookup
    expect(getSnapshot()).toBe(snap)
    expect(getExtension('glb')?.entry).toBe('index.html')
    expect(getExtension('bad-id')).toBeUndefined()
  })

  it('snapshotKey changes on version / install and is stable across rescans', () => {
    writeExt('glb', { ...ok })
    const k1 = snapshotKey(scanExtensions())
    expect(snapshotKey(scanExtensions())).toBe(k1)
    writeExt('glb', { ...ok, version: '1.1.0' })
    expect(snapshotKey(scanExtensions())).not.toBe(k1)
  })

  it('readExtensionDir accepts an explicit id for not-yet-renamed staging dirs', () => {
    const dir = writeExt('.tmp-unpack-x', { ...ok })
    expect(readExtensionDir(dir)).toMatchObject({ error: expect.stringMatching(/id mismatch/) })
    expect(readExtensionDir(dir, 'glb')).toMatchObject({ id: 'glb', version: '1.0.0' })
  })
})
