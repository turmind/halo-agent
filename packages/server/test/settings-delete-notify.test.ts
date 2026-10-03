import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'

/**
 * DELETE /settings must fire onSettingsChange listeners like PUT/PATCH do
 * (the sandbox hidden-paths reload hangs off it), and stay silent when the
 * key was already absent.
 *
 * GLOBAL_SETTINGS_PATH resolves from os.homedir() at module load → redirect
 * HOME to a temp dir BEFORE the dynamic import.
 */

let tmpHome: string
let realHome: string | undefined
let settingsPath: string
let app: ReturnType<typeof import('../src/routes/settings.js')['createSettingsRoutes']>
let notified = 0

beforeAll(async () => {
  realHome = process.env.HOME
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-settings-notify-'))
  process.env.HOME = tmpHome
  settingsPath = path.join(tmpHome, '.halo', 'secrets', 'settings.yaml')
  const mod = await import('../src/routes/settings.js')
  mod.onSettingsChange(() => { notified++ })
  app = mod.createSettingsRoutes()
})

afterAll(() => {
  process.env.HOME = realHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

beforeEach(() => {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, YAML.stringify({ sandbox: { hiddenDirs: ['secret'], keep: 1 } }))
  notified = 0
})

const del = (key: string) => app.request('/settings', {
  method: 'DELETE',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ scope: 'global', key }),
})

describe('DELETE /settings → onSettingsChange', () => {
  it('notifies after removing an existing key', async () => {
    const res = await del('sandbox.hiddenDirs')
    expect(res.status).toBe(200)
    expect(YAML.parse(fs.readFileSync(settingsPath, 'utf-8'))).toEqual({ sandbox: { keep: 1 } })
    expect(notified).toBe(1)
  })

  it('stays silent when the leaf key is absent', async () => {
    const res = await del('sandbox.missing')
    expect(res.status).toBe(200)
    expect(notified).toBe(0)
  })

  it('stays silent when an intermediate key is absent', async () => {
    const res = await del('nope.missing')
    expect(res.status).toBe(200)
    expect(notified).toBe(0)
  })
})

describe('DELETE /settings rejects globalOnly keys at workspace scope (same as PUT/PATCH)', () => {
  let ws: string
  let wsSettingsPath: string
  const WS_TREE = { general: { theme: 'light' }, sandbox: { keep: 1 } }

  beforeAll(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-settings-delete-ws-'))
    wsSettingsPath = path.join(ws, '.halo', 'settings.yaml')
  })

  afterAll(() => {
    fs.rmSync(ws, { recursive: true, force: true })
  })

  beforeEach(() => {
    fs.mkdirSync(path.dirname(wsSettingsPath), { recursive: true })
    fs.writeFileSync(wsSettingsPath, YAML.stringify(WS_TREE))
    fs.writeFileSync(settingsPath, YAML.stringify({ general: { theme: 'warm' } }))
  })

  const delAt = (scope: 'global' | 'workspace', key: string) => app.request('/settings', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scope === 'workspace' ? { scope, projectId: ws, key } : { scope, key }),
  })

  it('workspace scope + globalOnly key → 400, file untouched', async () => {
    const before = fs.readFileSync(wsSettingsPath, 'utf-8')
    const res = await delAt('workspace', 'general.theme')
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('general.theme is global-only and cannot be set per workspace')
    expect(fs.readFileSync(wsSettingsPath, 'utf-8')).toBe(before)
    expect(notified).toBe(0)
  })

  it('global scope deletes the same key', async () => {
    const res = await delAt('global', 'general.theme')
    expect(res.status).toBe(200)
    expect(YAML.parse(fs.readFileSync(settingsPath, 'utf-8'))).toEqual({ general: {} })
  })

  it('workspace scope still deletes an ordinary key', async () => {
    const res = await delAt('workspace', 'sandbox.keep')
    expect(res.status).toBe(200)
    expect(YAML.parse(fs.readFileSync(wsSettingsPath, 'utf-8'))).toEqual({ general: { theme: 'light' }, sandbox: {} })
  })
})
