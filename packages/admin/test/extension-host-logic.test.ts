import { describe, it, expect } from 'vitest'
import type { ExtensionCapability, ExtensionClientFrame, ExtensionTheme } from '@turmind/halo-core/protocol'
import {
  initialHostState, isClientFrame, onClientFrame, onLoaded, onPutResult, onConflictChoice,
  onFileChanged, onLangChange, onSaveRequest, onThemeChange, registerExtensionHost, getExtensionHost,
  onFsResult, isBundlePath, createKeyedQueue,
  type HostState, type HostEffect, type HostContext,
} from '../src/features/editor/previews/extension-host-logic'
import { readThemeVars, schemeFromRgb } from '../src/shared/theme/palette'

/**
 * Contract (design §6.4): the extension host is a pure state machine over
 * postMessage frames. Nothing is posted before `ready`; `dirty`/`save` are
 * refused without the `save` capability; a 409 asks once and errors the
 * second time; the host's own save echo is not a reload.
 */

const darkVars = { background: '#0a0a0a', foreground: '#ededed', primary: '#3b82f6' }
const ctx: HostContext = { file: { name: 'a.echo', path: 'dir/a.echo', size: 3, ext: 'echo' }, theme: 'dark' as ExtensionTheme, themeVars: darkVars, platform: 'web', lang: 'en' }
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
    expect(init.type === 'post' && init.frame.type === 'init' && init.frame.themeVars).toEqual(darkVars)
    const again = onClientFrame(step.state, frame({ type: 'ready', protocol: 1 }), ctx)
    expect(types(again.effects)).toEqual(['warn'])
  })

  it('nothing is posted before ready: theme change and save request are no-ops', () => {
    const s0 = initialHostState(['save'])
    expect(onThemeChange(s0, 'light', { background: '#ffffff' }).effects).toEqual([])
    expect(onLangChange(s0, 'zh').effects).toEqual([])
    expect(onSaveRequest({ ...s0, dirty: true }).effects).toEqual([])
    expect(onFileChanged(s0, 5000).effects).toEqual([])
  })

  it('after ready a language switch posts exactly one lang frame', () => {
    expect(onLangChange(ready(), 'zh').effects).toEqual([{ type: 'post', frame: { haloExt: 1, type: 'lang', lang: 'zh' } }])
  })

  it('after ready a theme switch posts exactly one theme frame carrying the palette', () => {
    const warm = { background: '#f6f1e7', foreground: '#3d3427' }
    expect(onThemeChange(ready(), 'light', warm).effects).toEqual([{ type: 'post', frame: { haloExt: 1, type: 'theme', theme: 'light', themeVars: warm } }])
  })
})

describe('theme palette', () => {
  const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]

  it('light / dark comes from the background luminance, not the theme name', () => {
    expect(schemeFromRgb(hex('#0a0a0a'))).toBe('dark') // dark
    expect(schemeFromRgb(hex('#f6f1e7'))).toBe('light') // warm
    expect(schemeFromRgb(hex('#0b1220'))).toBe('dark') // midnight
    expect(schemeFromRgb(hex('#ffffff'))).toBe('light') // light
  })

  it('reads every --<token> trimmed and leaves out empty ones', () => {
    const css: Record<string, string> = { '--background': ' #f6f1e7', '--foreground': '#3d3427 ', '--ring': '  ' }
    const vars = readThemeVars({ getPropertyValue: (p: string) => css[p] ?? '' })
    expect(vars).toEqual({ background: '#f6f1e7', foreground: '#3d3427' })
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

/**
 * Contract (htrans protocol §2–§4): init always carries bundle / platform /
 * lang; a bundle gets init and NO load; `fs` is bundle-only, path-validated
 * before any I/O, answered exactly once with the request id; a bundle's
 * `dirty` (= busy) is honoured without `save`, and Ctrl+S on it is a no-op.
 */
describe('bundle extensions', () => {
  const bundleCtx: HostContext = { file: { name: 'm.htrans', path: 'notes/m.htrans', size: 0, ext: 'htrans' }, theme: 'light', themeVars: { background: '#f6f1e7' }, platform: 'desktop-mac', lang: 'zh' }
  const readyBundle = (): HostState => ({ ...initialHostState(['media'], true), ready: true })
  const fsFrame = (op: string, path: unknown, extra: Record<string, unknown> = {}) =>
    ({ haloExt: 1, type: 'fs', id: 7, op, path, ...extra } as unknown as ExtensionClientFrame)
  const fsReply = (effects: HostEffect[]) => {
    const e = effects.find((x) => x.type === 'post')
    return e?.type === 'post' && e.frame.type === 'fs-result' ? e.frame : null
  }

  it('init carries bundle / platform / lang; a bundle gets no load frame', () => {
    const step = onClientFrame(initialHostState(['media'], true), frame({ type: 'ready', protocol: 1 }), bundleCtx)
    expect(types(step.effects)).toEqual(['post'])
    const init = step.effects[0]
    expect(init.type === 'post' && init.frame).toMatchObject({
      type: 'init', protocol: 1, bundle: true, platform: 'desktop-mac', lang: 'zh', theme: 'light', themeVars: { background: '#f6f1e7' },
      capabilities: ['media'], file: { name: 'm.htrans', path: 'notes/m.htrans' },
    })
  })

  it('a non-bundle init says bundle:false and still loads', () => {
    const step = onClientFrame(initialHostState(['save']), frame({ type: 'ready', protocol: 1 }), ctx)
    expect(types(step.effects)).toEqual(['post', 'load'])
    const init = step.effects[0]
    expect(init.type === 'post' && init.frame).toMatchObject({ type: 'init', bundle: false, platform: 'web', lang: 'en' })
  })

  it('dirty (busy) is honoured without save; Ctrl+S on a busy bundle forwards nothing', () => {
    const busy = onClientFrame(readyBundle(), frame({ type: 'dirty', dirty: true }), bundleCtx)
    expect(busy.state.dirty).toBe(true)
    expect(busy.effects).toEqual([{ type: 'set-modified', modified: true }])
    expect(onSaveRequest(busy.state).effects).toEqual([])
    const idle = onClientFrame(busy.state, frame({ type: 'dirty', dirty: false }), bundleCtx)
    expect(idle.effects).toEqual([{ type: 'set-modified', modified: false }])
  })

  it('file:changed never reloads a bundle', () => {
    expect(onFileChanged(readyBundle(), 9999).effects).toEqual([])
  })

  it('fs from a non-bundle extension → denied + console warn, no I/O', () => {
    const step = onClientFrame(ready(['save']), fsFrame('read', 'a.txt'), ctx)
    expect(types(step.effects)).toEqual(['post', 'warn'])
    expect(fsReply(step.effects)).toMatchObject({ id: 7, ok: false, code: 'denied' })
  })

  it('valid requests become one fs effect each, with the id and bundle-relative path', () => {
    const b = buf()
    expect(onClientFrame(readyBundle(), fsFrame('read', 'audio/001.webm'), bundleCtx).effects)
      .toEqual([{ type: 'fs', id: 7, op: 'read', path: 'audio/001.webm' }])
    expect(onClientFrame(readyBundle(), fsFrame('list', ''), bundleCtx).effects)
      .toEqual([{ type: 'fs', id: 7, op: 'list', path: '' }])
    expect(onClientFrame(readyBundle(), fsFrame('append', 'transcript.md', { buffer: b }), bundleCtx).effects)
      .toEqual([{ type: 'fs', id: 7, op: 'append', path: 'transcript.md', buffer: b }])
  })

  it('invalid paths are refused before any request', () => {
    for (const p of ['/abs', 'a\\b', 'a//b', './a', 'a/./b', '../x', 'a/..', 'a/', 'nul\0', 3, undefined]) {
      const step = onClientFrame(readyBundle(), fsFrame('read', p), bundleCtx)
      expect(types(step.effects)).toEqual(['post'])
      expect(fsReply(step.effects)).toMatchObject({ id: 7, ok: false, code: 'invalid-path' })
    }
    // '' is the root: list only
    expect(fsReply(onClientFrame(readyBundle(), fsFrame('stat', ''), bundleCtx).effects)).toMatchObject({ code: 'invalid-path' })
    expect(isBundlePath('', true)).toBe(true)
    expect(isBundlePath('shots/000750.jpg', false)).toBe(true)
  })

  it('write / append without an ArrayBuffer, or an unknown op, are refused', () => {
    expect(fsReply(onClientFrame(readyBundle(), fsFrame('write', 'a'), bundleCtx).effects)).toMatchObject({ ok: false, code: 'io' })
    expect(fsReply(onClientFrame(readyBundle(), fsFrame('append', 'a', { buffer: 'x' }), bundleCtx).effects)).toMatchObject({ ok: false, code: 'io' })
    expect(fsReply(onClientFrame(readyBundle(), fsFrame('delete', 'a'), bundleCtx).effects)).toMatchObject({ ok: false, code: 'denied' })
  })

  it('results map to fs-result: buffer transferred, 404 → not-found, 403 → denied, else io', () => {
    const b = buf()
    const okStep = onFsResult(readyBundle(), 3, { ok: true, buffer: b })
    expect(okStep.effects).toEqual([{ type: 'post', frame: { haloExt: 1, type: 'fs-result', id: 3, ok: true, buffer: b }, transfer: [b] }])
    expect(onFsResult(readyBundle(), 4, { ok: true, size: 5, mtime: 6 }).effects)
      .toEqual([{ type: 'post', frame: { haloExt: 1, type: 'fs-result', id: 4, ok: true, size: 5, mtime: 6 } }])
    expect(fsReply(onFsResult(readyBundle(), 5, { ok: false, status: 404, message: 'File not found' }).effects)).toMatchObject({ id: 5, code: 'not-found', error: 'File not found' })
    expect(fsReply(onFsResult(readyBundle(), 5, { ok: false, status: 403, message: 'x' }).effects)).toMatchObject({ code: 'denied' })
    expect(fsReply(onFsResult(readyBundle(), 5, { ok: false, status: 0, message: 'net' }).effects)).toMatchObject({ code: 'io' })
  })
})

/**
 * Contract (export): init.export says whether `export` frames are accepted —
 * save-capable non-bundle only. A valid export becomes one `export` effect;
 * anything else is answered with exactly one export-error, no I/O.
 */
describe('export', () => {
  const exportFrame = (name: unknown, buffer: unknown = buf()) =>
    ({ haloExt: 1, type: 'export', name, buffer } as unknown as ExtensionClientFrame)
  const exportReply = (effects: HostEffect[]) => {
    const e = effects.find((x) => x.type === 'post')
    return e?.type === 'post' && e.frame.type === 'export-error' ? e.frame : null
  }
  const initExport = (s: HostState) => {
    const init = onClientFrame(s, frame({ type: 'ready', protocol: 1 }), ctx).effects[0]
    return init.type === 'post' && init.frame.type === 'init' ? init.frame.export : undefined
  }

  it('init.export is true only for a save-capable non-bundle extension', () => {
    expect(initExport(initialHostState(['save']))).toBe(true)
    expect(initExport(initialHostState([]))).toBe(false)
    expect(initExport(initialHostState(['save'], true))).toBe(false)
    expect(initExport(initialHostState(['media'], true))).toBe(false)
  })

  it('a valid export becomes one export effect with the name and buffer', () => {
    const b = buf()
    const step = onClientFrame(ready(), exportFrame('a.png', b), ctx)
    expect(step.effects).toEqual([{ type: 'export', name: 'a.png', buffer: b }])
  })

  it('export before ready only warns', () => {
    expect(types(onClientFrame(initialHostState(['save']), exportFrame('a.png'), ctx).effects)).toEqual(['warn'])
  })

  it('without save, or from a bundle → export-error denied, no export effect', () => {
    for (const s of [ready([]), { ...initialHostState(['save'], true), ready: true }]) {
      const step = onClientFrame(s, exportFrame('a.png'), ctx)
      expect(types(step.effects)).toEqual(['post', 'warn'])
      expect(exportReply(step.effects)).toMatchObject({ reason: 'denied' })
    }
  })

  it('names that are not a plain file name, or the open file itself, are invalid', () => {
    for (const n of ['../x.png', 'a/b.png', 'a\\b.png', '/x.png', '.', '..', '', 'nul\0.png', 3, undefined, 'a.echo']) {
      const step = onClientFrame(ready(), exportFrame(n), ctx)
      expect(types(step.effects)).toEqual(['post'])
      expect(exportReply(step.effects)).toMatchObject({ reason: 'invalid' })
    }
  })

  it('a non-ArrayBuffer buffer is invalid', () => {
    for (const b of ['png bytes', new Uint8Array(4), null]) {
      expect(exportReply(onClientFrame(ready(), exportFrame('a.png', b), ctx).effects)).toMatchObject({ reason: 'invalid' })
    }
  })
})

describe('createKeyedQueue (per-path append ordering)', () => {
  it('runs tasks for one key in request order even when earlier ones are slower; other keys run concurrently', async () => {
    const q = createKeyedQueue()
    const log: string[] = []
    const task = (name: string, ms: number, fail = false) => () =>
      new Promise<string>((resolve, reject) => setTimeout(() => { log.push(name); if (fail) reject(new Error(name)); else resolve(name) }, ms))
    const a1 = q.run('t.md', task('a1', 30))
    const a2 = q.run('t.md', task('a2', 1, true))  // a failure must not stall the queue
    const a3 = q.run('t.md', task('a3', 1))
    const other = q.run('o.webm', task('o1', 5))
    await expect(a2).rejects.toThrow('a2')
    await Promise.all([a1, a3, other])
    expect(log).toEqual(['o1', 'a1', 'a2', 'a3'])
  })
})
