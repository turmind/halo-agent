import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSettingsRoutes } from '../src/routes/settings.js'

/**
 * GET /settings/schema flags each field's `<<X>>` placeholders whose env var
 * is unset in the server process (`envMissing`, names only), so the Settings
 * page can warn before a model call fails. Covers the three cases: variable
 * missing, variable set, no placeholder at all.
 */

const MISSING = 'HALO_TEST_SETTINGS_MISSING_KEY'
const PRESENT = 'HALO_TEST_SETTINGS_PRESENT_KEY'

let ws: string

beforeAll(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-settings-env-'))
  fs.mkdirSync(path.join(ws, '.halo'), { recursive: true })
  fs.writeFileSync(path.join(ws, '.halo', 'settings.yaml'), [
    'minimax:', '  secrets:', `    api_key: <<${MISSING}>>`,
    'kimi:', '  secrets:', `    api_key: <<${PRESENT}>>`,
    'deepseek:', '  secrets:', '    api_key: sk-plain-value-1234',
  ].join('\n'))
  process.env[PRESENT] = 'present-value'
  delete process.env[MISSING]
})

afterAll(() => {
  delete process.env[PRESENT]
  fs.rmSync(ws, { recursive: true, force: true })
})

describe('settings schema envMissing', () => {
  it('lists unset placeholder vars by name only; [] when set or no placeholder', async () => {
    const res = await createSettingsRoutes().request(`/settings/schema?projectId=${encodeURIComponent(ws)}`)
    const body = await res.json() as { sections: Array<{ namespaceId: string; fields: Array<{ key: string; value: string | null; envMissing: string[] }> }> }
    const field = (ns: string) => body.sections.find((s) => s.namespaceId === ns)!.fields.find((f) => f.key === 'api_key')!

    expect(field('minimax').envMissing).toEqual([MISSING])
    expect(field('minimax').value).toBe(`<<${MISSING}>>`)

    expect(field('kimi').envMissing).toEqual([])
    expect(JSON.stringify(body)).not.toContain('present-value')

    expect(field('deepseek').envMissing).toEqual([])
    expect(field('deepseek').value).not.toContain('plain-value')
  })
})
