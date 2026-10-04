import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { refreshTemplatesIfOutdated, readSeedVersion, TEMPLATE_VERSION } from '../src/init.js'

/**
 * `refreshTemplatesIfOutdated` — the startup check shared by the server and
 * the CLI. It runs `ensureHaloHome` only when an already-seeded home is behind
 * TEMPLATE_VERSION; equal or never-seeded (stamp 0) homes are left untouched.
 */

/** The `.halo` dir itself, matching the HALO_HOME the callers pass. */
let home: string

beforeEach(() => {
  home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'halo-refresh-')), '.halo')
  fs.mkdirSync(path.join(home, 'global'), { recursive: true })
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(path.dirname(home), { recursive: true, force: true })
})

function stamp(v: number): void {
  fs.writeFileSync(path.join(home, 'global', '.template-version'), String(v))
}

describe('refreshTemplatesIfOutdated', () => {
  it('refreshes and re-stamps when the seed is behind', () => {
    stamp(TEMPLATE_VERSION - 1)
    refreshTemplatesIfOutdated(home, 'Test')
    expect(readSeedVersion(home)).toBe(TEMPLATE_VERSION)
    expect(fs.readFileSync(path.join(home, 'global', 'models', 'anthropic.yaml'), 'utf-8')).toMatch(/^runtime: anthropic-messages$/m)
    expect(console.log).toHaveBeenCalledWith(`[Test] Templates outdated (v${TEMPLATE_VERSION - 1} → v${TEMPLATE_VERSION}), refreshing ~/.halo/global/`)
  })

  it('is a no-op when the seed is current', () => {
    stamp(TEMPLATE_VERSION)
    refreshTemplatesIfOutdated(home, 'Test')
    expect(fs.existsSync(path.join(home, 'global', 'models'))).toBe(false)
    expect(console.log).not.toHaveBeenCalled()
  })

  it('is a no-op on a never-seeded home (stamp 0)', () => {
    refreshTemplatesIfOutdated(home, 'Test')
    expect(fs.existsSync(path.join(home, 'global', '.template-version'))).toBe(false)
    expect(fs.existsSync(path.join(home, 'global', 'models'))).toBe(false)
  })
})
