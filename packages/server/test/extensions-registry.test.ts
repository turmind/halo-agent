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
    expect(r).toEqual({ id: 'glb', name: 'GLB Viewer', version: '1.0.0', extensions: ['.glb'], entry: 'index.html', priority: 'default', capabilities: [] })
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
