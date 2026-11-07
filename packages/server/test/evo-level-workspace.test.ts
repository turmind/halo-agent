import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HALO_SECRETS_DIR, evoLevelFor } from '../src/config.js'

/**
 * `general.evolution.level` is read per workspace: `<ws>/.halo/settings.yaml`
 * over the global `~/.halo/secrets/settings.yaml` (HOME is the per-file
 * scratch dir of setup-home.ts).
 */

const globalSettings = path.join(HALO_SECRETS_DIR, 'settings.yaml')
let tmp: string

afterEach(() => {
  fs.rmSync(globalSettings, { force: true })
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('evoLevelFor', () => {
  it('a workspace value overrides the global one; a workspace without one reads the global', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-evo-level-'))
    fs.mkdirSync(HALO_SECRETS_DIR, { recursive: true })
    fs.writeFileSync(globalSettings, 'general:\n  evolution:\n    level: L2\n')
    const wsA = path.join(tmp, 'a')
    const wsB = path.join(tmp, 'b')
    fs.mkdirSync(path.join(wsA, '.halo'), { recursive: true })
    fs.mkdirSync(path.join(wsB, '.halo'), { recursive: true })
    fs.writeFileSync(path.join(wsA, '.halo', 'settings.yaml'), 'general:\n  evolution:\n    level: L0\n')
    expect(evoLevelFor(wsA)).toBe('L0')
    expect(evoLevelFor(wsB)).toBe('L2')
  })
})
