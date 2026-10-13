import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ExtensionClientFrame, ExtensionInfo } from '@turmind/halo-core/protocol'
import { api } from '../src/shared/api-client'
import { setExtensions, activityEntries } from '../src/features/editor/previews/registry'
import { resetExtensionTokenCache } from '../src/features/editor/previews/extension-token'
import {
  activityCapabilities, activityDescription, activityTabId, activityTitle, initialActivityState, isActivityTabId,
  onActivityFrame, onActivityLangChange, onActivityThemeChange, type ActivityContext,
} from '../src/features/workspace/extension-activity-logic'
import { ExtensionActivityIcon, ExtensionActivityPanel } from '../src/features/workspace/extension-activity-panel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Contract: an extension's activity-bar page (manifest `activity`).
 *  - `activityEntries()` = extensions with `activity` that run here, ordered
 *    by `activity.order` then id; none installed → none (no UI change);
 *  - title / description fall back activity `_zh` → activity → top level;
 *  - the page host speaks protocol v1's file-less subset: `ready` → init with
 *    `view: 'activity'` (no file / bundle / export / jupyter; re-sent on a
 *    second ready), `error` → banner, `theme` / `lang` only after ready,
 *    every file-shaped frame warns and is otherwise ignored;
 *  - the component accepts frames only from its own iframe, and offers Retry
 *    after 10 s without `ready`;
 *  - the bar icon is a CSS mask over the asset URL (puzzle until the token).
 * Rendered without I18n / Theme providers: `t()` echoes keys, lang = 'en'.
 */

function ext(id: string, over: Partial<ExtensionInfo> = {}): ExtensionInfo {
  return {
    id, name: id.toUpperCase(), version: '1.0.0', extensions: [], entry: 'index.html',
    priority: 'default', capabilities: [], bundle: false, installedAt: 1, activity: { order: 100 }, ...over,
  }
}

const ctx: ActivityContext = { capabilities: ['media'], theme: 'dark', themeVars: { background: '#000' }, platform: 'web', lang: 'en' }
const frame = (f: Record<string, unknown>) => ({ haloExt: 1, ...f }) as ExtensionClientFrame

describe('activityEntries', () => {
  beforeEach(() => setExtensions({ extensions: [], errors: [] }))

  it('nothing installed / no activity field → no entries', () => {
    expect(activityEntries()).toEqual([])
    setExtensions({ extensions: [ext('glb', { activity: undefined, extensions: ['.glb'] })], errors: [{ id: 'bad', error: 'x' }] })
    expect(activityEntries()).toEqual([])
  })

  it('orders by activity.order, then id; skips extensions that do not run on this platform', () => {
    setExtensions({
      extensions: [
        ext('zeta', { activity: { order: 5 } }),
        ext('beta', { activity: { order: 100 } }),
        ext('alpha', { activity: { order: 100 } }),
        ext('mac-only', { activity: { order: 0 }, platforms: ['desktop-mac'] }), // jsdom UA = web
      ],
      errors: [],
    })
    expect(activityEntries().map((e) => e.id)).toEqual(['zeta', 'alpha', 'beta'])
  })
})

describe('title / description fallbacks', () => {
  const full = ext('city', { name: 'Halo City', description: 'top', activity: { order: 1, title: 'City', title_zh: '城市', description: 'act', description_zh: '活动' } })
  const bare = ext('city', { name: 'Halo City', description: 'top' })

  it('zh: _zh → activity → top level', () => {
    expect(activityTitle(full, 'zh')).toBe('城市')
    expect(activityDescription(full, 'zh')).toBe('活动')
    expect(activityTitle(ext('c', { name: 'N', activity: { order: 1, title: 'T' } }), 'zh')).toBe('T')
    expect(activityDescription(ext('c', { description: 'D', activity: { order: 1, description: 'A' } }), 'zh')).toBe('A')
    expect(activityTitle(bare, 'zh')).toBe('Halo City')
    expect(activityDescription(bare, 'zh')).toBe('top')
  })

  it('en: never the _zh variants; empty description when nothing is set', () => {
    expect(activityTitle(full, 'en')).toBe('City')
    expect(activityDescription(full, 'en')).toBe('act')
    expect(activityTitle(ext('c', { name: 'N', activity: { order: 1, title_zh: '只有中文' } }), 'en')).toBe('N')
    expect(activityDescription(ext('c', { activity: { order: 1, description_zh: '只有中文' } }), 'en')).toBe('')
  })

  it('tab ids are ext:<id>', () => {
    expect(activityTabId('halo-city')).toBe('ext:halo-city')
    expect(isActivityTabId('ext:halo-city')).toBe(true)
    expect(isActivityTabId('explorer')).toBe(false)
  })
})

describe('onActivityFrame', () => {
  it('ready → ready + init(view: activity) without file-host fields; a second ready re-sends it', () => {
    const step = onActivityFrame(initialActivityState(), frame({ type: 'ready', protocol: 1 }), ctx)
    expect(step.state.ready).toBe(true)
    expect(step.effects.map((e) => e.type)).toEqual(['ready', 'post'])
    const init = step.effects[1]
    expect(init.type === 'post' && init.frame).toEqual({
      haloExt: 1, type: 'init', view: 'activity', protocol: 1, capabilities: ['media'], theme: 'dark', themeVars: { background: '#000' }, platform: 'web', lang: 'en',
    })
    const again = onActivityFrame(step.state, frame({ type: 'ready', protocol: 1 }), { ...ctx, lang: 'zh' })
    expect(again.effects[1].type === 'post' && again.effects[1].frame).toMatchObject({ type: 'init', view: 'activity', lang: 'zh' })
  })

  it('error → banner effect', () => {
    expect(onActivityFrame(initialActivityState(), frame({ type: 'error', message: 'boom' }), ctx).effects).toEqual([{ type: 'error', message: 'boom' }])
  })

  it('file-shaped frames are ignored with a warning', () => {
    const ready = { ready: true }
    for (const f of [
      { type: 'dirty', dirty: true }, { type: 'save', buffer: new ArrayBuffer(1) }, { type: 'fs', id: 1, op: 'read', path: 'a' },
      { type: 'pick', id: 1, accept: [] }, { type: 'export', name: 'x', buffer: new ArrayBuffer(1) },
    ]) {
      const step = onActivityFrame(ready, frame(f), ctx)
      expect(step.state).toBe(ready)
      expect(step.effects).toEqual([{ type: 'warn', message: `${f.type} frame ignored on an activity page` }])
    }
  })

  it('theme / lang are posted only after ready', () => {
    expect(onActivityThemeChange(initialActivityState(), 'light', {}).effects).toEqual([])
    expect(onActivityLangChange(initialActivityState(), 'zh').effects).toEqual([])
    expect(onActivityThemeChange({ ready: true }, 'light', { background: '#fff' }).effects).toEqual([
      { type: 'post', frame: { haloExt: 1, type: 'theme', theme: 'light', themeVars: { background: '#fff' } } },
    ])
    expect(onActivityLangChange({ ready: true }, 'zh').effects).toEqual([{ type: 'post', frame: { haloExt: 1, type: 'lang', lang: 'zh' } }])
  })

  it('grants only the capabilities a file-less page can use', () => {
    expect(activityCapabilities(['save', 'media', 'transcribe', 'fs-read'])).toEqual(['media', 'transcribe'])
  })
})

describe('<ExtensionActivityPanel> / <ExtensionActivityIcon>', () => {
  let container: HTMLDivElement
  let root: Root
  const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

  beforeEach(() => {
    resetExtensionTokenCache()
    vi.spyOn(api.extensions, 'token').mockResolvedValue({ token: 'tok', expiresAt: Date.now() + 24 * 3600_000 })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  /** Deliver a frame as if posted by `source`. */
  function deliver(source: Window | null, data: unknown) {
    act(() => { window.dispatchEvent(new MessageEvent('message', { data, source })) })
  }

  it('mounts the entry with the file host\'s sandbox grant and answers only its own iframe', async () => {
    act(() => root.render(createElement(ExtensionActivityPanel, { info: ext('city', { capabilities: ['media'], version: '2.0.0' }) })))
    await flush()
    const iframe = container.querySelector('iframe')!
    expect(iframe.getAttribute('src')).toBe('/api/extensions/city/2.0.0/tok/index.html')
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin')
    expect(iframe.getAttribute('allow')).toBe('microphone; display-capture; clipboard-write')
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer')

    const win = iframe.contentWindow!
    const posted = vi.spyOn(win, 'postMessage')
    deliver(window, { haloExt: 1, type: 'ready', protocol: 1 })          // not our iframe
    deliver(win, { type: 'ready', protocol: 1 })                         // no haloExt marker
    expect(posted).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Loading...')

    deliver(win, { haloExt: 1, type: 'ready', protocol: 1 })
    expect(posted).toHaveBeenCalledTimes(1)
    expect(posted.mock.calls[0][0]).toMatchObject({ type: 'init', view: 'activity', capabilities: ['media'], lang: 'en' })
    expect(container.textContent).not.toContain('Loading...')

    deliver(win, { haloExt: 1, type: 'error', message: 'world failed' })
    expect(container.textContent).toContain('world failed')
  })

  it('no ready within 10 s → unresponsive + Retry remounts the iframe', async () => {
    vi.useFakeTimers()
    act(() => root.render(createElement(ExtensionActivityPanel, { info: ext('city') })))
    await flush()
    expect(container.querySelector('iframe')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(container.textContent).toContain('editor.extension.unresponsive')
    expect(container.querySelector('iframe')).toBeNull()
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'editor.extension.retry')!
    act(() => retry.click())
    await flush()
    expect(container.querySelector('iframe')).toBeTruthy()
    expect(container.textContent).not.toContain('editor.extension.unresponsive')
  })

  it('icon: puzzle without activity.icon; CSS mask over the asset URL once the token is in', async () => {
    act(() => root.render(createElement(ExtensionActivityIcon, { info: ext('plain') })))
    await flush()
    expect(container.querySelector('svg.lucide-puzzle')).toBeTruthy()

    act(() => root.render(createElement(ExtensionActivityIcon, { info: ext('city', { activity: { order: 1, icon: 'assets/icon.svg' } }) })))
    expect(container.querySelector('svg.lucide-puzzle')).toBeTruthy() // before the token lands
    await flush()
    const span = container.querySelector('span[aria-hidden]') as HTMLSpanElement
    expect(span).toBeTruthy()
    expect(span.className).toContain('bg-current')
    expect(span.getAttribute('style')).toContain('/api/extensions/city/1.0.0/tok/assets/icon.svg')
    expect(container.querySelector('svg')).toBeNull()
  })
})
