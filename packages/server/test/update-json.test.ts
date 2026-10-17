import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  checkPackageHash, defaultHubBase, haloBaseVersion, judgeUpdate, parseUpdateJson, updateJsonUrl,
  type UpdateInfo,
} from '../src/updates/update-json.js'

/**
 * Contract for the update.json protocol rules (updates/update-json.ts):
 * where the file lives (manifest `source`, else `<hub base>/<id>/update.json`),
 * which fields it must carry, relative `url` resolution, the semver /
 * minHalo verdict (never a downgrade), and the two package gates (sha256,
 * manifest id + version).
 */

const SHA = 'a'.repeat(64)
const FILE = 'https://raw.githubusercontent.com/turmind/halo-hub/main/extensions/glb/update.json'
const good = { id: 'glb', version: '1.2.0', url: 'glb-1.2.0.zip', sha256: SHA }

function info(over: Partial<UpdateInfo> = {}): UpdateInfo {
  return { id: 'glb', version: '1.2.0', url: 'https://x.test/glb.zip', sha256: SHA, ...over }
}

describe('haloBaseVersion', () => {
  it('keeps a release version as is', () => {
    expect(haloBaseVersion('2.0.1')).toBe('2.0.1')
    expect(haloBaseVersion('1.5.3-alpha')).toBe('1.5.3-alpha')
  })
  it('strips the build sha and -dirty a source / desktop build stamps', () => {
    expect(haloBaseVersion('2.0.1-af6fd16')).toBe('2.0.1')
    expect(haloBaseVersion('2.0.1-af6fd16-dirty')).toBe('2.0.1')
    expect(haloBaseVersion('1.5.3-alpha-af6fd16')).toBe('1.5.3-alpha')
  })
  it('has no base version for dev / garbage', () => {
    expect(haloBaseVersion('dev')).toBeNull()
    expect(haloBaseVersion('')).toBeNull()
  })
})

describe('defaultHubBase', () => {
  it('maps the hub_repo forms ext.sh accepts to the GitHub raw extensions/ dir', () => {
    const want = 'https://raw.githubusercontent.com/turmind/halo-hub/main/extensions'
    expect(defaultHubBase('')).toBe(want)
    expect(defaultHubBase('{{extension.params.hub_repo}}')).toBe(want)
    expect(defaultHubBase('turmind/halo-hub')).toBe(want)
    expect(defaultHubBase('https://github.com/turmind/halo-hub')).toBe(want)
    expect(defaultHubBase('https://github.com/turmind/halo-hub.git')).toBe(want)
    expect(defaultHubBase('https://github.com/turmind/halo-hub/')).toBe(want)
  })
  it('has no default for a non-GitHub hub', () => {
    expect(defaultHubBase('https://gitea.example.com/me/hub')).toBeNull()
    expect(defaultHubBase('git@github.com:me/hub.git')).toBeNull()
    expect(defaultHubBase('/srv/hub')).toBeNull()
  })
})

describe('updateJsonUrl', () => {
  it('prefers the manifest source', () => {
    expect(updateJsonUrl('glb', 'https://cdn.example.com/glb/update.json', 'https://hub.test/ext')).toBe('https://cdn.example.com/glb/update.json')
  })
  it('falls back to <hub base>/<id>/update.json, trailing slashes trimmed', () => {
    expect(updateJsonUrl('glb', undefined, 'https://hub.test/ext/')).toBe('https://hub.test/ext/glb/update.json')
  })
  it('is null with neither', () => {
    expect(updateJsonUrl('glb', undefined, null)).toBeNull()
    expect(updateJsonUrl('glb', undefined, '  ')).toBeNull()
  })
})

describe('parseUpdateJson', () => {
  it('accepts a good file and resolves a relative url against the file URL', () => {
    const r = parseUpdateJson(good, FILE, 'glb')
    expect(r).toEqual({ id: 'glb', version: '1.2.0', url: 'https://raw.githubusercontent.com/turmind/halo-hub/main/extensions/glb/glb-1.2.0.zip', sha256: SHA })
  })
  it('resolves ../ and keeps an absolute url', () => {
    expect((parseUpdateJson({ ...good, url: '../../dist/glb.zip' }, FILE, 'glb') as UpdateInfo).url)
      .toBe('https://raw.githubusercontent.com/turmind/halo-hub/main/dist/glb.zip')
    expect((parseUpdateJson({ ...good, url: 'https://github.com/turmind/halo-hub/releases/download/glb-v1.2.0/glb-1.2.0.zip' }, FILE, 'glb') as UpdateInfo).url)
      .toBe('https://github.com/turmind/halo-hub/releases/download/glb-v1.2.0/glb-1.2.0.zip')
  })
  it('lower-cases sha256, keeps minHalo, ignores unknown fields', () => {
    const r = parseUpdateJson({ ...good, sha256: SHA.toUpperCase(), minHalo: '2.1.0', notes: 'x' }, FILE, 'glb') as UpdateInfo
    expect(r.sha256).toBe(SHA)
    expect(r.minHalo).toBe('2.1.0')
    expect(r).not.toHaveProperty('notes')
  })
  it.each([
    ['not an object', [], /JSON object/],
    ['id mismatch', { ...good, id: 'glb-viewer' }, /does not match "glb"/],
    ['version not semver', { ...good, version: 'v1.2.0' }, /version must be semver/],
    ['version with build metadata', { ...good, version: '1.2.0+abc' }, /version must be semver/],
    ['url missing', { ...good, url: '' }, /url is required/],
    ['url not https', { ...good, url: 'http://x.test/glb.zip' }, /must be https/],
    ['url resolves off https', { ...good, url: 'file:///etc/hosts' }, /must be https/],
    ['sha256 missing', { ...good, sha256: undefined }, /sha256 must be 64 hex/],
    ['sha256 short', { ...good, sha256: 'abc' }, /sha256 must be 64 hex/],
    ['minHalo not semver', { ...good, minHalo: '2.1' }, /minHalo must be semver/],
  ])('rejects %s', (_name, raw, msg) => {
    const r = parseUpdateJson(raw, FILE, 'glb')
    expect('error' in r && r.error).toMatch(msg)
  })
})

describe('judgeUpdate', () => {
  it('offers a strictly newer version', () => {
    expect(judgeUpdate('1.1.0', info(), '2.0.1')).toEqual({ kind: 'available', version: '1.2.0' })
  })
  it('never offers the same or an older version (no downgrade)', () => {
    expect(judgeUpdate('1.2.0', info(), '2.0.1')).toEqual({ kind: 'current' })
    expect(judgeUpdate('1.3.0', info(), '2.0.1')).toEqual({ kind: 'current' })
  })
  it('orders prereleases by semver', () => {
    expect(judgeUpdate('1.2.0-beta.1', info(), '2.0.1').kind).toBe('available')
    expect(judgeUpdate('1.2.0', info({ version: '1.2.0-beta.2' }), '2.0.1').kind).toBe('current')
  })
  it('holds back an update whose minHalo is above this Halo', () => {
    expect(judgeUpdate('1.1.0', info({ minHalo: '2.1.0' }), '2.0.1')).toEqual({ kind: 'needs-halo', version: '1.2.0', minHalo: '2.1.0' })
    expect(judgeUpdate('1.1.0', info({ minHalo: '2.1.0' }), '2.0.1-af6fd16').kind).toBe('needs-halo')
  })
  it('lets it through when this Halo meets minHalo, and on a dev build', () => {
    expect(judgeUpdate('1.1.0', info({ minHalo: '2.0.1' }), '2.0.1').kind).toBe('available')
    expect(judgeUpdate('1.1.0', info({ minHalo: '9.0.0' }), 'dev').kind).toBe('available')
  })
  it('is current when not even newer, whatever minHalo says', () => {
    expect(judgeUpdate('1.2.0', info({ minHalo: '9.0.0' }), '2.0.1')).toEqual({ kind: 'current' })
  })
})

describe('package gates', () => {
  it('checkPackageHash accepts the matching bytes only', () => {
    const zip = Buffer.from('zip bytes')
    const sha = createHash('sha256').update(zip).digest('hex')
    expect(checkPackageHash(zip, info({ sha256: sha }))).toBeNull()
    expect(checkPackageHash(zip, info())).toMatch(/sha256 mismatch/)
  })
})
