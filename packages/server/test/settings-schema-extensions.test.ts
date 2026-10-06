import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Extension manifest `settings` → one Settings section per extension
 * (namespace `ext-<id>`, source `extension`, every field global-only,
 * secrets masked) — and the generic settings routes store / reject values
 * under that namespace like any other.
 *
 * HOME is redirected BEFORE the dynamic imports (settings paths and the
 * extensions root resolve from os.homedir()).
 */

let tmpHome: string
let realHome: string | undefined
let schema: typeof import('../src/settings-schema.js')
let app: ReturnType<typeof import('../src/routes/settings.js')['createSettingsRoutes']>

beforeAll(async () => {
  realHome = process.env.HOME
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-settings-ext-'))
  process.env.HOME = tmpHome
  const registry = await import('../src/extensions/registry.js')
  const dir = path.join(registry.extensionsRoot(), 'htrans')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.html'), '')
  fs.writeFileSync(path.join(dir, 'halo-extension.json'), JSON.stringify({
    id: 'htrans', name: 'Meeting Recorder', version: '1.0.0', description: 'Record + transcribe',
    extensions: ['.htrans'], entry: 'index.html', bundle: true, capabilities: ['media', 'transcribe'],
    settings: {
      params: [{ key: 'region', default: 'us-east-1' }, { key: 'auto_languages', default: 'zh-CN,en-US' }],
      secrets: [{ key: 'access_key_id' }, { key: 'secret_access_key' }, { key: 'session_token' }],
    },
  }))
  // A settings-less extension contributes no section.
  const plain = path.join(registry.extensionsRoot(), 'glb')
  fs.mkdirSync(plain, { recursive: true })
  fs.writeFileSync(path.join(plain, 'index.html'), '')
  fs.writeFileSync(path.join(plain, 'halo-extension.json'), JSON.stringify({ id: 'glb', name: 'GLB', version: '1.0.0', extensions: ['.glb'], entry: 'index.html' }))
  registry.scanExtensions()
  schema = await import('../src/settings-schema.js')
  app = (await import('../src/routes/settings.js')).createSettingsRoutes()
})

afterAll(() => {
  process.env.HOME = realHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe('extension settings sections', () => {
  it('one section per extension with settings, ext-<id> namespace, global-only, secrets marked', () => {
    const ext = schema.loadSettingsSchema().filter((s) => s.source === 'extension')
    expect(ext).toHaveLength(1)
    expect(ext[0]).toMatchObject({ namespaceId: 'ext-htrans', displayName: 'Meeting Recorder', description: 'Record + transcribe' })
    expect(ext[0].fields.map((f) => [f.kind, f.key, f.globalOnly, f.secret === true])).toEqual([
      ['param', 'region', true, false],
      ['param', 'auto_languages', true, false],
      ['secret', 'access_key_id', true, true],
      ['secret', 'secret_access_key', true, true],
      ['secret', 'session_token', true, true],
    ])
    expect(ext[0].fields[0].default).toBe('us-east-1')
  })

  it('PATCH stores ext-<id>.secrets.* globally; GET masks it; workspace scope is refused', async () => {
    const patch = (body: Record<string, unknown>) => app.request('/settings', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    expect((await patch({ scope: 'global', key: 'ext-htrans.secrets.access_key_id', value: 'AKIAEXAMPLE1234' })).status).toBe(200)
    const ws = await patch({ scope: 'workspace', projectId: tmpHome, key: 'ext-htrans.params.region', value: 'eu-west-1' })
    expect(ws.status).toBe(400)

    const res = await app.request('/settings/schema')
    const body = await res.json() as { sections: Array<{ namespaceId: string; fields: Array<{ key: string; value: string | null; hasValue: boolean }> }>; orphans: unknown[] }
    const sec = body.sections.find((s) => s.namespaceId === 'ext-htrans')!
    const f = sec.fields.find((x) => x.key === 'access_key_id')!
    expect(f.hasValue).toBe(true)
    expect(f.value).not.toContain('EXAMPLE')
    expect(body.orphans).toEqual([])
  })
})
