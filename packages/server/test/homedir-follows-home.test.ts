import { describe, it, expect, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os, { homedir } from 'node:os'
import path from 'node:path'

/**
 * setup-home.ts makes os.homedir() follow $HOME (Windows reads USERPROFILE,
 * so a test's HOME redirect would otherwise leave it on the real ~/.halo).
 * On POSIX the real homedir already reads HOME, so the replacement itself
 * is asserted too: HOME wins over a different USERPROFILE, and the named
 * `import { homedir }` binding src modules use is the patched function.
 */

const realHome = process.env.HOME
const realProfile = process.env.USERPROFILE
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-homedir-'))

afterEach(() => {
  process.env.HOME = realHome
  if (realProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = realProfile
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('os.homedir follows HOME in tests', () => {
  it('is replaced, named binding included, and prefers HOME over USERPROFILE', () => {
    expect(os.homedir.name).toBe('homedirFromEnv')
    expect(homedir).toBe(os.homedir)
    process.env.HOME = path.join(tmp, 'home')
    process.env.USERPROFILE = path.join(tmp, 'profile')
    expect(os.homedir()).toBe(path.join(tmp, 'home'))
  })

  it('src modules resolve ~/.halo under the redirected HOME', async () => {
    process.env.HOME = tmp
    const { haloHome } = await import('../src/paths.js')
    expect(haloHome()).toBe(path.join(tmp, '.halo'))
  })
})
