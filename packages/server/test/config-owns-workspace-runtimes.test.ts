import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Contract: a HALO_BADGE=DEV server never owns workspace runtimes (no
 * `.halo/runtime.lock` claim, no boot cleanup) — prod alone does. Read from
 * env on every access; trimmed, case-insensitive; any other value → owner.
 */

let config: typeof import('../src/config.js')['config']
let home: string

beforeAll(async () => {
  home = fs.mkdtempSync(join(tmpdir(), 'halo-owns-runtimes-'))
  vi.stubEnv('HOME', home)
  config = (await import('../src/config.js')).config
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('config.server.ownsWorkspaceRuntimes', () => {
  it('HALO_BADGE unset → owner', () => {
    vi.stubEnv('HALO_BADGE', undefined)
    expect(config.server.ownsWorkspaceRuntimes).toBe(true)
  })

  it('HALO_BADGE=DEV → not owner', () => {
    vi.stubEnv('HALO_BADGE', 'DEV')
    expect(config.server.ownsWorkspaceRuntimes).toBe(false)
  })

  it('" dev " (padded, lower-case) → not owner', () => {
    vi.stubEnv('HALO_BADGE', ' dev ')
    expect(config.server.ownsWorkspaceRuntimes).toBe(false)
  })

  it('any other badge (STAGING) → owner', () => {
    vi.stubEnv('HALO_BADGE', 'STAGING')
    expect(config.server.ownsWorkspaceRuntimes).toBe(true)
  })
})
