import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Contract: getOrCreate scaffolds `.halo/` (ensureWorkspaceHalo) only when it
 * builds a manager. A cache hit — every later inbound message / A2A POST for
 * the workspace — is realpath + Map lookup, no mkdir / self.html copy (those
 * are ~14ms of metadata round trips per call on NFS/EFS).
 *
 * Mutation check: move ensureWorkspaceHalo back above the cache lookup → the
 * "hit" case goes red (the removed dir is recreated).
 *
 * HOME is redirected BEFORE the dynamic import: SessionManager reads config
 * from os.homedir() at module load.
 */

let realHome: string | undefined
let tmpHome: string
let Registry: typeof import('../src/agents/session-manager-registry.js')['SessionManagerRegistry']

beforeAll(async () => {
  realHome = process.env.HOME
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-registry-home-'))
  process.env.HOME = tmpHome
  Registry = (await import('../src/agents/session-manager-registry.js')).SessionManagerRegistry
})

afterAll(() => {
  process.env.HOME = realHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe('SessionManagerRegistry.getOrCreate', () => {
  it('scaffolds .halo/ on the build, not on a cache hit', () => {
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'halo-registry-ws-')))
    const registry = new Registry()
    const sm = registry.getOrCreate(ws)
    const tmpDir = path.join(ws, '.halo', 'tmp')
    expect(fs.existsSync(tmpDir)).toBe(true)

    fs.rmSync(tmpDir, { recursive: true })
    expect(registry.getOrCreate(ws)).toBe(sm)
    expect(fs.existsSync(tmpDir)).toBe(false)

    // A fresh registry (= a new process) builds again → scaffolds again.
    new Registry().getOrCreate(ws)
    expect(fs.existsSync(tmpDir)).toBe(true)
  })

  it('still resolves the path on a hit: a symlink to the workspace hits the same manager', () => {
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'halo-registry-ws-')))
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'halo-registry-link-')), 'ws')
    fs.symlinkSync(ws, link)
    const registry = new Registry()
    const sm = registry.getOrCreate(ws)
    expect(registry.getOrCreate(link)).toBe(sm)
    expect(registry.list().map((e) => e.workspacePath)).toEqual([ws])
  })
})
