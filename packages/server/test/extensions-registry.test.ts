import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseManifest, scanExtensions, getSnapshot, getExtension, getInstalledExtension, snapshotKey, readExtensionDir, extensionsRoot } from '../src/extensions/registry.js'
import { setExtensionDisabled } from '../src/extensions/state.js'

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

  // Activity-bar entry: halo-hub pack.mjs mirrors these messages verbatim.
  it('activity: valid fields kept, order defaults to 100, unknown keys ignored, absent = no field', () => {
    expect(parse({})).not.toHaveProperty('activity')
    expect(parse({ activity: {} })).toMatchObject({ activity: { order: 100 } })
    expect((parse({ activity: { extra: 1 } }) as { activity: object }).activity).toEqual({ order: 100 })
    const full = { icon: 'assets/icon.svg', title: 'City', title_zh: '城市', description: 'd', description_zh: '描述', order: 0 }
    expect((parse({ activity: full }) as { activity: object }).activity).toEqual(full)
    expect(parse({ activity: { icon: 'ICON.PNG', order: 1000, description: '' } })).toMatchObject({ activity: { icon: 'ICON.PNG', order: 1000, description: '' } })
  })

  it('activity: every malformed field is a manifest error with the exact message', () => {
    expect(errorOf(parse({ activity: [] }))).toBe('activity must be an object')
    expect(errorOf(parse({ activity: null }))).toBe('activity must be an object')
    expect(errorOf(parse({ activity: 'x' }))).toBe('activity must be an object')
    const iconErr = 'activity.icon must be a relative .svg or .png path inside the extension directory'
    for (const icon of [1, '', '/icon.svg', '../icon.svg', 'a/../../icon.svg', 'a\\..\\icon.svg', 'icon.gif', 'icon']) {
      expect(errorOf(parse({ activity: { icon } }))).toBe(iconErr)
    }
    expect(errorOf(parse({ activity: { title: '' } }))).toBe('activity.title must be a non-empty string (≤ 64 chars)')
    expect(errorOf(parse({ activity: { title: '  ' } }))).toBe('activity.title must be a non-empty string (≤ 64 chars)')
    expect(errorOf(parse({ activity: { title: 'x'.repeat(65) } }))).toBe('activity.title must be a non-empty string (≤ 64 chars)')
    expect(errorOf(parse({ activity: { title_zh: 3 } }))).toBe('activity.title_zh must be a non-empty string (≤ 64 chars)')
    expect(errorOf(parse({ activity: { description: 'x'.repeat(201) } }))).toBe('activity.description must be a string (≤ 200 chars)')
    expect(errorOf(parse({ activity: { description_zh: false } }))).toBe('activity.description_zh must be a string (≤ 200 chars)')
    for (const order of [-1, 1001, 1.5, '5', null]) {
      expect(errorOf(parse({ activity: { order } }))).toBe('activity.order must be an integer 0–1000')
    }
  })

  it('activity: icon must exist inside the extension dir (same check as entry)', () => {
    const seen: string[] = []
    const onlyEntry = (p: string) => { seen.push(p); return p === 'index.html' }
    expect(errorOf(parse({ activity: { icon: 'icon.svg' } }, 'glb', onlyEntry))).toBe('activity icon not found: icon.svg')
    expect(seen).toContain('icon.svg')
  })

  it('extensions: [] allowed only with activity or chatbar; key still required and must be an array', () => {
    const arrErr = 'extensions must be an array (empty is fine with activity or chatbar)'
    expect(parse({ extensions: [], activity: {} })).toMatchObject({ extensions: [], activity: { order: 100 } })
    expect(parse({ extensions: [], chatbar: {} })).toMatchObject({ extensions: [], chatbar: { height: 160, order: 100 } })
    expect(errorOf(parse({ extensions: [] }))).toBe('extensions must be a non-empty array')
    for (const extra of [{ activity: {} }, { chatbar: {} }]) {
      const noKey: Record<string, unknown> = { ...ok, ...extra }
      delete noKey.extensions
      expect(errorOf(parseManifest(noKey, 'glb', entryYes))).toBe(arrErr)
      expect(errorOf(parse({ extensions: '.glb', ...extra }))).toBe(arrErr)
      // entries are still validated when present
      expect(errorOf(parse({ extensions: ['glb'], ...extra }))).toMatch(/"glb"/)
    }
    // activity, then chatbar, are checked before extensions (pack.mjs mirrors the order)
    expect(errorOf(parse({ extensions: [], activity: [] }))).toBe('activity must be an object')
    expect(errorOf(parse({ extensions: [], chatbar: [] }))).toBe('chatbar must be an object')
    expect(errorOf(parse({ activity: [], chatbar: [] }))).toBe('activity must be an object')
  })

  // Chat-bar button: halo-hub pack.mjs mirrors these messages verbatim.
  it('chatbar: valid fields kept, height 160 / order 100 by default, unknown keys ignored, absent = no field', () => {
    expect(parse({})).not.toHaveProperty('chatbar')
    expect((parse({ chatbar: {} }) as { chatbar: object }).chatbar).toEqual({ height: 160, order: 100 })
    // description is not a chatbar field — ignored like any unknown key
    expect((parse({ chatbar: { extra: 1, description: 'd' } }) as { chatbar: object }).chatbar).toEqual({ height: 160, order: 100 })
    const full = { icon: 'assets/mic.svg', title: 'Voice', title_zh: '语音输入', height: 80, order: 0 }
    expect((parse({ chatbar: full }) as { chatbar: object }).chatbar).toEqual(full)
    expect(parse({ chatbar: { icon: 'MIC.PNG', height: 480, order: 1000 } })).toMatchObject({ chatbar: { icon: 'MIC.PNG', height: 480, order: 1000 } })
    // both entry kinds on one extension
    expect(parse({ activity: {}, chatbar: {} })).toMatchObject({ activity: { order: 100 }, chatbar: { height: 160, order: 100 } })
  })

  it('chatbar: every malformed field is a manifest error with the exact message', () => {
    for (const chatbar of [[], null, 'x', 1]) expect(errorOf(parse({ chatbar }))).toBe('chatbar must be an object')
    const iconErr = 'chatbar.icon must be a relative .svg or .png path inside the extension directory'
    for (const icon of [1, '', '/mic.svg', '../mic.svg', 'a/../../mic.svg', 'a\\..\\mic.svg', 'mic.gif', 'mic']) {
      expect(errorOf(parse({ chatbar: { icon } }))).toBe(iconErr)
    }
    expect(errorOf(parse({ chatbar: { title: '' } }))).toBe('chatbar.title must be a non-empty string (≤ 64 chars)')
    expect(errorOf(parse({ chatbar: { title: '  ' } }))).toBe('chatbar.title must be a non-empty string (≤ 64 chars)')
    expect(errorOf(parse({ chatbar: { title: 'x'.repeat(65) } }))).toBe('chatbar.title must be a non-empty string (≤ 64 chars)')
    expect(errorOf(parse({ chatbar: { title_zh: 3 } }))).toBe('chatbar.title_zh must be a non-empty string (≤ 64 chars)')
    for (const height of [79, 481, 160.5, '160', null, 0]) {
      expect(errorOf(parse({ chatbar: { height } }))).toBe('chatbar.height must be an integer 80–480')
    }
    for (const order of [-1, 1001, 1.5, '5', null]) {
      expect(errorOf(parse({ chatbar: { order } }))).toBe('chatbar.order must be an integer 0–1000')
    }
    const seen: string[] = []
    const onlyEntry = (p: string) => { seen.push(p); return p === 'index.html' }
    expect(errorOf(parse({ chatbar: { icon: 'mic.svg' } }, 'glb', onlyEntry))).toBe('chatbar icon not found: mic.svg')
    expect(seen).toContain('mic.svg')
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
    expect(scanExtensions()).toEqual({ extensions: [], disabled: [], errors: [] })
  })

  it('a switched-off extension moves to `disabled`; getExtension skips it, getInstalledExtension finds it', () => {
    writeExt('glb', { ...ok })
    writeExt('obj', { ...ok, id: 'obj' })
    writeExt('broken', '{ not json')
    setExtensionDisabled('glb', true)
    setExtensionDisabled('broken', true) // an error row stays an error row
    const snap = scanExtensions()
    expect(snap.extensions.map((e) => e.id)).toEqual(['obj'])
    expect(snap.disabled.map((e) => e.id)).toEqual(['glb'])
    expect(snap.errors.map((e) => e.id)).toEqual(['broken'])
    expect(getExtension('glb')).toBeUndefined()
    expect(getInstalledExtension('glb')?.version).toBe('1.0.0')
    expect(getInstalledExtension('obj')?.id).toBe('obj')
    expect(getInstalledExtension('broken')).toBeUndefined()
  })

  it('snapshotKey changes when an extension is switched off and back on', () => {
    writeExt('glb', { ...ok })
    const on = snapshotKey(scanExtensions())
    setExtensionDisabled('glb', true)
    const off = snapshotKey(scanExtensions())
    expect(off).not.toBe(on)
    setExtensionDisabled('glb', false)
    expect(snapshotKey(scanExtensions())).toBe(on)
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

  it('activity icon is checked on disk: a file inside the dir passes, missing / a directory fails', () => {
    writeExt('city', { ...ok, id: 'city', extensions: [], activity: { icon: 'assets/icon.svg' } }, { 'index.html': '<html>', 'assets/icon.svg': '<svg/>' })
    writeExt('noicon', { ...ok, id: 'noicon', extensions: [], activity: { icon: 'icon.svg' } })
    writeExt('diricon', { ...ok, id: 'diricon', extensions: [], activity: { icon: 'd.svg' } }, { 'index.html': '<html>', 'd.svg/x': '' })
    const snap = scanExtensions()
    expect(snap.extensions.map((e) => e.id)).toEqual(['city'])
    expect(snap.extensions[0]).toMatchObject({ extensions: [], activity: { icon: 'assets/icon.svg', order: 100 } })
    expect(snap.errors.find((e) => e.id === 'noicon')?.error).toBe('activity icon not found: icon.svg')
    expect(snap.errors.find((e) => e.id === 'diricon')?.error).toBe('activity icon not found: d.svg')
  })

  it('chatbar icon is checked on disk the same way', () => {
    writeExt('voice', { ...ok, id: 'voice', extensions: [], chatbar: { icon: 'mic.svg', height: 200 } }, { 'index.html': '<html>', 'mic.svg': '<svg/>' })
    writeExt('nomic', { ...ok, id: 'nomic', extensions: [], chatbar: { icon: 'mic.svg' } })
    const snap = scanExtensions()
    expect(snap.extensions.map((e) => e.id)).toEqual(['voice'])
    expect(snap.extensions[0]).toMatchObject({ extensions: [], chatbar: { icon: 'mic.svg', height: 200, order: 100 } })
    expect(snap.errors.find((e) => e.id === 'nomic')?.error).toBe('chatbar icon not found: mic.svg')
  })

  it('readExtensionDir accepts an explicit id for not-yet-renamed staging dirs', () => {
    const dir = writeExt('.tmp-unpack-x', { ...ok })
    expect(readExtensionDir(dir)).toMatchObject({ error: expect.stringMatching(/id mismatch/) })
    expect(readExtensionDir(dir, 'glb')).toMatchObject({ id: 'glb', version: '1.0.0' })
  })
})
