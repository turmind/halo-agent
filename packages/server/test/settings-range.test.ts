import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'

/**
 * Schema fields with `min` / `max` (evolution.auto_apply_threshold: 0–100)
 * are range-checked on PUT / PATCH: out of range → 400, file untouched.
 *
 * GLOBAL_SETTINGS_PATH resolves from os.homedir() at module load → redirect
 * HOME to a temp dir BEFORE the dynamic import.
 */

const KEY = 'general.evolution.auto_apply_threshold'
let tmpHome: string
let realHome: string | undefined
let settingsPath: string
let app: ReturnType<typeof import('../src/routes/settings.js')['createSettingsRoutes']>

beforeAll(async () => {
  realHome = process.env.HOME
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-settings-range-'))
  process.env.HOME = tmpHome
  settingsPath = path.join(tmpHome, '.halo', 'secrets', 'settings.yaml')
  app = (await import('../src/routes/settings.js')).createSettingsRoutes()
})

afterAll(() => {
  process.env.HOME = realHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

beforeEach(() => {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, YAML.stringify({ general: { evolution: { auto_apply_threshold: 80 } } }))
})

const send = (method: 'PUT' | 'PATCH', body: Record<string, unknown>) => app.request('/settings', {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ scope: 'global', ...body }),
})
const stored = () => YAML.parse(fs.readFileSync(settingsPath, 'utf-8')).general.evolution.auto_apply_threshold

describe('settings range check (min / max)', () => {
  it('PATCH accepts the bounds and rejects outside them', async () => {
    for (const v of [0, 100, '90']) expect((await send('PATCH', { key: KEY, value: v })).status).toBe(200)
    for (const v of [-1, 101, 'abc']) {
      const res = await send('PATCH', { key: KEY, value: v })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe(`${KEY} must be a number between 0 and 100`)
    }
    expect(stored()).toBe('90')
  })

  it('PUT rejects an out-of-range nested value and leaves the file alone', async () => {
    const res = await send('PUT', { settings: { general: { evolution: { auto_apply_threshold: 150 } } } })
    expect(res.status).toBe(400)
    expect(stored()).toBe(80)
    expect((await send('PUT', { settings: { general: { evolution: { auto_apply_threshold: 70 } } } })).status).toBe(200)
    expect(stored()).toBe(70)
  })

  it('unbounded keys are not checked', async () => {
    expect((await send('PATCH', { key: 'general.evolution.max_concurrent_run', value: 999 })).status).toBe(200)
  })
})
