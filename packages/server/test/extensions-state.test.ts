import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { disabledExtensionIds, extensionStatePath, ExtensionStateError, forgetExtension, setExtensionDisabled } from '../src/extensions/state.js'

/**
 * extensions/state.ts — the on / off switch store (`extensions/.state.json`):
 * target-state writes that skip when nothing changes, tmp + rename, other
 * per-id fields preserved, and a file that isn't a JSON object is read as
 * "everything on" but never overwritten.
 */

let home: string
const prevHome = process.env.HOME
const read = () => JSON.parse(fs.readFileSync(extensionStatePath(), 'utf-8')) as Record<string, unknown>

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-ext-state-'))
  process.env.HOME = home
})
afterEach(() => {
  process.env.HOME = prevHome
  fs.rmSync(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('extension on / off state', () => {
  it('lives beside the extension dirs, dot-named', () => {
    expect(extensionStatePath()).toBe(path.join(home, '.halo', 'global', 'extensions', '.state.json'))
  })

  it('no file = nothing off; switching off writes { id: { disabled: true } }', () => {
    expect([...disabledExtensionIds()]).toEqual([])
    expect(setExtensionDisabled('glb', true)).toBe(true)
    expect(read()).toEqual({ glb: { disabled: true } })
    expect([...disabledExtensionIds()]).toEqual(['glb'])
    // No stray tmp file left behind.
    expect(fs.readdirSync(path.dirname(extensionStatePath()))).toEqual(['.state.json'])
  })

  it('same target state again = false and no write', () => {
    setExtensionDisabled('glb', true)
    const before = fs.statSync(extensionStatePath()).mtimeMs
    const spy = vi.spyOn(fs, 'renameSync')
    expect(setExtensionDisabled('glb', true)).toBe(false)
    expect(setExtensionDisabled('obj', false)).toBe(false) // never off → already on
    expect(spy).not.toHaveBeenCalled()
    expect(fs.statSync(extensionStatePath()).mtimeMs).toBe(before)
  })

  it('switching on drops an empty entry but keeps other fields', () => {
    setExtensionDisabled('glb', true)
    setExtensionDisabled('glb', false)
    expect(read()).toEqual({})
    fs.writeFileSync(extensionStatePath(), JSON.stringify({ glb: { disabled: true, source: 'x' } }))
    expect(setExtensionDisabled('glb', false)).toBe(true)
    expect(read()).toEqual({ glb: { source: 'x' } })
    expect(setExtensionDisabled('glb', true)).toBe(true)
    expect(read()).toEqual({ glb: { source: 'x', disabled: true } })
  })

  it('a hand edit is picked up (read from disk, not memory)', () => {
    setExtensionDisabled('glb', true)
    fs.writeFileSync(extensionStatePath(), JSON.stringify({ obj: { disabled: true }, ipynb: { disabled: false } }) + '   ')
    expect([...disabledExtensionIds()]).toEqual(['obj'])
  })

  it('a file swapped in by rename with the same mtime and size is still re-read (inode in the cache key)', () => {
    setExtensionDisabled('glb', true)
    const file = extensionStatePath()
    const t = new Date('2026-01-01T00:00:00Z') // whole second: survives utimes exactly
    fs.utimesSync(file, t, t)
    const st = fs.statSync(file)
    expect([...disabledExtensionIds()]).toEqual(['glb'])
    const tmp = `${file}.other`
    fs.writeFileSync(tmp, fs.readFileSync(file, 'utf-8').replace('glb', 'obj'))
    fs.utimesSync(tmp, t, t)
    fs.renameSync(tmp, file)
    expect([fs.statSync(file).mtimeMs, fs.statSync(file).size]).toEqual([st.mtimeMs, st.size])
    expect([...disabledExtensionIds()]).toEqual(['obj'])
  })

  it('a rename that fails (Windows lock) falls back to an in-place write, leaving no tmp file', () => {
    setExtensionDisabled('glb', true)
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('EPERM') })
    expect(setExtensionDisabled('obj', true)).toBe(true)
    vi.restoreAllMocks()
    expect(read()).toEqual({ glb: { disabled: true }, obj: { disabled: true } })
    expect(fs.readdirSync(path.dirname(extensionStatePath()))).toEqual(['.state.json'])
  })

  it('forgetExtension drops the whole entry; nothing stored = false', () => {
    fs.mkdirSync(path.dirname(extensionStatePath()), { recursive: true })
    fs.writeFileSync(extensionStatePath(), JSON.stringify({ glb: { disabled: true, source: 'x' }, obj: { disabled: true } }))
    expect(forgetExtension('glb')).toBe(true)
    expect(read()).toEqual({ obj: { disabled: true } })
    expect(forgetExtension('glb')).toBe(false)
  })

  it('a file that is not a JSON object reads as all-on, refuses writes, and is never overwritten', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fs.mkdirSync(path.dirname(extensionStatePath()), { recursive: true })
    fs.writeFileSync(extensionStatePath(), '{ broken')
    expect([...disabledExtensionIds()]).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[Extensions\] .*not a JSON object/))
    expect(() => setExtensionDisabled('glb', true)).toThrow(ExtensionStateError)
    expect(forgetExtension('glb')).toBe(false) // uninstall must not fail on it
    expect(fs.readFileSync(extensionStatePath(), 'utf-8')).toBe('{ broken')
    fs.writeFileSync(extensionStatePath(), '[1]')
    expect(() => setExtensionDisabled('glb', true)).toThrow(ExtensionStateError)
  })
})
