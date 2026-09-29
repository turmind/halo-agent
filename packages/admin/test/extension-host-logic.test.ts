import { describe, it, expect } from 'vitest'
import type { ExtensionCapability, ExtensionClientFrame, ExtensionTheme } from '@turmind/halo-core/protocol'
import {
  initialHostState, isClientFrame, onClientFrame, onLoaded, onPutResult, onConflictChoice,
  onFileChanged, onSaveRequest, onThemeChange, registerExtensionHost, getExtensionHost,
  type HostState, type HostEffect,
} from '../src/features/editor/previews/extension-host-logic'

/**
 * Contract (design §6.4): the extension host is a pure state machine over
 * postMessage frames. Nothing is posted before `ready`; `dirty`/`save` are
 * refused without the `save` capability; a 409 asks once and errors the
 * second time; the host's own save echo is not a reload.
 */

const ctx = { file: { name: 'a.echo', path: 'dir/a.echo', size: 3, ext: 'echo' }, theme: 'dark' as ExtensionTheme }
const buf = () => new ArrayBuffer(4)

function ready(caps: ExtensionCapability[] = ['save'], mtime: number | null = 1000): HostState {
  return { ...initialHostState(caps), ready: true, mtime }
}
type Bare<T> = T extends unknown ? Omit<T, 'haloExt'> : never // distributive: keeps each variant's fields
const frame = (f: Bare<ExtensionClientFrame>) => ({ haloExt: 1, ...f } as ExtensionClientFrame)
const types = (effects: HostEffect[]) => effects.map((e) => e.type)
const posted = (effects: HostEffect[]) => effects.flatMap((e) => (e.type === 'post' ? [e.frame.type] : []))

describe('isClientFrame', () => {
  it('accepts only haloExt:1 objects with a string type', () => {
    expect(isClientFrame({ haloExt: 1, type: 'ready', protocol: 1 })).toBe(true)
    expect(isClientFrame({ type: 'ready' })).toBe(false)
    expect(isClientFrame({ haloExt: 2, type: 'ready' })).toBe(false)
    expect(isClientFrame('ready')).toBe(false)
    expect(isClientFrame(null)).toBe(false)
  })
})

describe('ready handshake', () => {
  it('ready → init (with capabilities + theme) then load; duplicate ready only warns', () => {
    const s0 = initialHostState(['save'])
    const step = onClientFrame(s0, frame({ type: 'ready', protocol: 1 }), ctx)
    expect(step.state.ready).toBe(true)
    expect(types(step.effects)).toEqual(['post', 'load'])
    const init = step.effects[0]
    expect(init.type === 'post' && init.frame.type === 'init' && init.frame.capabilities).toEqual(['save'])
    expect(init.type === 'post' && init.frame.type === 'init' && init.frame.theme).toBe('dark')
    const again = onClientFrame(step.state, frame({ type: 'ready', protocol: 1 }), ctx)
    expect(types(again.effects)).toEqual(['warn'])
  })

  it('nothing is posted before ready: theme change and save request are no-ops', () => {
    const s0 = initialHostState(['save'])
    expect(onThemeChange(s0, 'light').effects).toEqual([])
    expect(onSaveRequest({ ...s0, dirty: true }).effects).toEqual([])
    expect(onFileChanged(s0, 5000).effects).toEqual([])
  })
})

describe('dirty', () => {
  it('dirty before ready is ignored (warn only, state unchanged)', () => {
    const s0 = initialHostState(['save'])
    const step = onClientFrame(s0, frame({ type: 'dirty', dirty: true }), ctx)
    expect(step.state).toBe(s0)
    expect(types(step.effects)).toEqual(['warn'])
  })

  it('dirty from an extension without save capability is ignored', () => {
    const step = onClientFrame(ready([]), frame({ type: 'dirty', dirty: true }), ctx)
    expect(step.state.dirty).toBe(false)
    expect(types(step.effects)).toEqual(['warn'])
  })

  it('dirty toggles set-modified once per transition', () => {
    const s1 = onClientFrame(ready(), frame({ type: 'dirty', dirty: true }), ctx)
    expect(s1.state.dirty).toBe(true)
    expect(s1.effects).toEqual([{ type: 'set-modified', modified: true }])
    const same = onClientFrame(s1.state, frame({ type: 'dirty', dirty: true }), ctx)
    expect(same.effects).toEqual([])
    const s2 = onClientFrame(s1.state, frame({ type: 'dirty', dirty: false }), ctx)
    expect(s2.effects).toEqual([{ type: 'set-modified', modified: false }])
  })
})

describe('save', () => {
  it('save without the capability is answered with save-error denied and never PUT', () => {
    const step = onClientFrame(ready([]), frame({ type: 'save', buffer: buf() }), ctx)
    expect(step.state.saving).toBe(false)
    expect(types(step.effects)).toEqual(['post', 'warn'])
    const post = step.effects[0]
    expect(post.type === 'post' && post.frame.type === 'save-error' && post.frame.reason).toBe('denied')
  })

  it('save PUTs with the mtime of the bytes currently held as expectMtime', () => {
    const b = buf()
    const step = onClientFrame(ready(['save'], 1234), frame({ type: 'save', buffer: b }), ctx)
    expect(step.state.saving).toBe(true)
    expect(step.effects).toEqual([{ type: 'put', buffer: b, expectMtime: 1234 }])
  })

  it('a second save while one is in flight is dropped', () => {
    const inFlight = onClientFrame(ready(), frame({ type: 'save', buffer: buf() }), ctx).state
    const step = onClientFrame(inFlight, frame({ type: 'save', buffer: buf() }), ctx)
    expect(types(step.effects)).toEqual(['warn'])
  })

  it('save request is only forwarded when ready + dirty + save-capable + not saving', () => {
    expect(posted(onSaveRequest({ ...ready(), dirty: true }).effects)).toEqual(['save-request'])
    expect(onSaveRequest(ready()).effects).toEqual([])                               // not dirty
    expect(onSaveRequest({ ...ready([]), dirty: true }).effects).toEqual([])         // no capability
    expect(onSaveRequest({ ...ready(), dirty: true, saving: true }).effects).toEqual([])
  })
})

describe('PUT outcome', () => {
  const saving: HostState = { ...ready(['save'], 1000), dirty: true, saving: true }

  it('200 → saved frame, dirty cleared, mtime advanced to the server value', () => {
    const step = onPutResult(saving, buf(), { ok: true, mtime: 2000 })
    expect(step.state).toMatchObject({ saving: false, dirty: false, retried: false, mtime: 2000 })
    expect(posted(step.effects)).toEqual(['saved'])
    expect(step.effects).toContainEqual({ type: 'set-modified', modified: false })
  })

  it('409 first time → confirm-conflict with the disk mtime, nothing posted, still dirty', () => {
    const b = buf()
    const step = onPutResult(saving, b, { ok: false, status: 409, mtime: 3000 })
    expect(step.state).toMatchObject({ saving: false, dirty: true, retried: false })
    expect(step.effects).toEqual([{ type: 'confirm-conflict', buffer: b, diskMtime: 3000 }])
  })

  it('overwrite → PUT again with the disk mtime and retried=true; second 409 → save-error conflict', () => {
    const b = buf()
    const first = onPutResult(saving, b, { ok: false, status: 409, mtime: 3000 })
    const retry = onConflictChoice(first.state, 'overwrite', b, 3000)
    expect(retry.state).toMatchObject({ saving: true, retried: true })
    expect(retry.effects).toEqual([{ type: 'put', buffer: b, expectMtime: 3000 }])

    const second = onPutResult(retry.state, b, { ok: false, status: 409, mtime: 4000 })
    expect(second.state).toMatchObject({ saving: false, retried: false, dirty: true })
    expect(types(second.effects)).toEqual(['post', 'error'])
    const post = second.effects[0]
    expect(post.type === 'post' && post.frame.type === 'save-error' && post.frame.reason).toBe('conflict')
  })

  it('discard → reload from disk; cancel → keep editing', () => {
    const b = buf()
    const first = onPutResult(saving, b, { ok: false, status: 409, mtime: 3000 })
    expect(onConflictChoice(first.state, 'discard', b, 3000).effects).toEqual([{ type: 'load' }])
    expect(onConflictChoice(first.state, 'cancel', b, 3000).effects).toEqual([])
  })

  it('other failures → save-error io + error banner, saving cleared', () => {
    const step = onPutResult(saving, buf(), { ok: false, status: 500, message: 'disk full' })
    expect(step.state.saving).toBe(false)
    expect(step.state.dirty).toBe(true)
    const post = step.effects[0]
    expect(post.type === 'post' && post.frame.type === 'save-error' && post.frame.reason).toBe('io')
    expect(step.effects[1]).toEqual({ type: 'error', message: 'Save failed: disk full' })
  })
})

describe('load and file:changed', () => {
  it('onLoaded posts load with the buffer transferred and records the mtime', () => {
    const b = buf()
    const step = onLoaded(ready(['save'], null), b, 1500)
    expect(step.state.mtime).toBe(1500)
    expect(step.effects[0]).toEqual({ type: 'post', frame: { haloExt: 1, type: 'load', buffer: b, mtime: 1500 }, transfer: [b] })
  })

  it('onLoaded over a dirty document clears the tab dot', () => {
    const step = onLoaded({ ...ready(), dirty: true }, buf(), 1500)
    expect(step.state.dirty).toBe(false)
    expect(step.effects).toContainEqual({ type: 'set-modified', modified: false })
  })

  it('file:changed caused by our own save (mtime already known) is not a reload', () => {
    const saved = onPutResult({ ...ready(['save'], 1000), dirty: true, saving: true }, buf(), { ok: true, mtime: 2000 }).state
    expect(onFileChanged(saved, 2000).effects).toEqual([])
    expect(onFileChanged(saved, 1999).effects).toEqual([])
  })

  it('a newer external change reloads a clean document but never a dirty one', () => {
    expect(onFileChanged(ready(['save'], 1000), 2000).effects).toEqual([{ type: 'load' }])
    expect(onFileChanged({ ...ready(['save'], 1000), dirty: true }, 2000).effects).toEqual([])
  })

  it('a change before the first load completed (mtime unknown) reloads', () => {
    expect(onFileChanged(ready(['save'], null), 2000).effects).toEqual([{ type: 'load' }])
  })
})

describe('host registry', () => {
  it('is keyed by panel + path and only the registering handle can remove itself', () => {
    const a = { requestSave() {}, fileChanged() {} }
    const b = { requestSave() {}, fileChanged() {} }
    const unA = registerExtensionHost('/ws', 'x.echo', a)
    expect(getExtensionHost('/ws', 'x.echo')).toBe(a)
    expect(getExtensionHost('/other', 'x.echo')).toBeUndefined()
    const unB = registerExtensionHost('/ws', 'x.echo', b) // remount replaced it
    unA()                                                 // stale cleanup must not evict the new one
    expect(getExtensionHost('/ws', 'x.echo')).toBe(b)
    unB()
    expect(getExtensionHost('/ws', 'x.echo')).toBeUndefined()
  })
})
