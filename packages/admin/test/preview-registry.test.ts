import { describe, it, expect, beforeEach } from 'vitest'
import type { ExtensionInfo } from '@turmind/halo-core/protocol'
import {
  register, setExtensions, resolve, resolvedKey, canPreview, isHeavyPreview, getVersion, subscribe,
} from '../src/features/editor/previews/registry'
import type { PreviewPlugin } from '../src/features/editor/previews/types'

/**
 * Contract: `resolve(ext)` orders candidates default-extensions (newest
 * install first) → built-in → option-extensions → text, and with no
 * extensions installed collapses to exactly the pre-extension behaviour
 * (`[builtin, text]` / `[text]`). Scanner errors never become candidates.
 */

function plugin(id: string, extensions: string[], heavy = false): PreviewPlugin {
  return { id, extensions, heavy, Component: (() => null) as unknown as PreviewPlugin['Component'] }
}

function ext(id: string, over: Partial<ExtensionInfo> = {}): ExtensionInfo {
  return {
    id, name: id, version: '1.0.0', extensions: ['.glb'], entry: 'index.html',
    priority: 'option', capabilities: [], installedAt: 1_000, ...over,
  }
}

const keys = (e: string) => resolve(e).map(resolvedKey)

beforeEach(() => {
  setExtensions({ extensions: [], errors: [] })
})

describe('resolve with no extensions installed', () => {
  it('unknown ext → [text]; built-in ext → [builtin, text]', () => {
    register(plugin('glb-builtin', ['glb']))
    expect(keys('nope')).toEqual(['text'])
    expect(keys('glb')).toEqual(['builtin:glb-builtin', 'text'])
    expect(canPreview('glb')).toBe(true)
    expect(canPreview('nope')).toBe(false)
  })

  it('normalizes case and a leading dot', () => {
    register(plugin('glb-builtin', ['glb']))
    expect(keys('.GLB')).toEqual(keys('glb'))
  })
})

describe('resolve ordering with extensions', () => {
  it('default (newest first) → builtin → option → text', () => {
    register(plugin('glb-builtin', ['glb']))
    setExtensions({
      extensions: [
        ext('old-default', { priority: 'default', installedAt: 100 }),
        ext('opt'),
        ext('new-default', { priority: 'default', installedAt: 200 }),
      ],
      errors: [],
    })
    expect(keys('glb')).toEqual([
      'extension:new-default', 'extension:old-default', 'builtin:glb-builtin', 'extension:opt', 'text',
    ])
  })

  it('option extension does not displace the built-in default', () => {
    register(plugin('glb-builtin', ['glb']))
    setExtensions({ extensions: [ext('opt')], errors: [] })
    expect(resolve('glb')[0].kind).toBe('builtin')
  })

  it('an extension for a type with no built-in makes it previewable', () => {
    setExtensions({ extensions: [ext('echo', { extensions: ['.echo'] })], errors: [] })
    expect(canPreview('echo')).toBe(true)
    expect(keys('echo')).toEqual(['extension:echo', 'text'])
  })

  it('scanner errors are listed nowhere in the candidates', () => {
    setExtensions({ extensions: [], errors: [{ id: 'broken', error: 'bad manifest' }] })
    expect(keys('glb').filter((k) => k.includes('broken'))).toEqual([])
  })
})

describe('isHeavyPreview', () => {
  it('follows the built-in flag when the built-in is the default', () => {
    register(plugin('pptx-builtin', ['pptx'], true))
    register(plugin('glb-builtin', ['glb']))
    expect(isHeavyPreview('pptx')).toBe(true)
    expect(isHeavyPreview('glb')).toBe(false)
  })

  it('read-only extension is heavy, save-capable extension is not', () => {
    setExtensions({
      extensions: [
        ext('viewer', { priority: 'default', extensions: ['.ro'] }),
        ext('editor', { priority: 'default', extensions: ['.rw'], capabilities: ['save'] }),
      ],
      errors: [],
    })
    expect(isHeavyPreview('ro')).toBe(true)
    expect(isHeavyPreview('rw')).toBe(false)
  })
})

describe('version signal', () => {
  it('setExtensions bumps the version and notifies subscribers', () => {
    let calls = 0
    const unsub = subscribe(() => { calls++ })
    const before = getVersion()
    setExtensions({ extensions: [ext('x')], errors: [] })
    expect(getVersion()).toBe(before + 1)
    expect(calls).toBe(1)
    unsub()
    setExtensions({ extensions: [], errors: [] })
    expect(calls).toBe(1)
  })
})
