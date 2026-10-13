import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ExtensionClientFrame, ExtensionInfo } from '@turmind/halo-core/protocol'
import { api } from '../src/shared/api-client'
import { setExtensions, chatbarEntries } from '../src/features/editor/previews/registry'
import { resetExtensionTokenCache } from '../src/features/editor/previews/extension-token'
import { onClientFrame, initialHostState } from '../src/features/editor/previews/extension-host-logic'
import { activityCapabilities, onActivityFrame, type ActivityContext } from '../src/features/workspace/extension-activity-logic'
import { MAX_INSERT_TEXT, chatbarTitle, insertAtSelection, onChatbarFrame } from '../src/features/chat/extension-chatbar-logic'
import { MessageInput } from '../src/features/chat/message-input'
import { useChatStore } from '../src/features/chat/chat-store'
import { useProjectStore } from '../src/shared/stores/project-store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Contract: an extension's chat-input toolbar button (manifest `chatbar`).
 *  - `chatbarEntries()` = extensions with `chatbar` that run here, ordered by
 *    `chatbar.order` then id; none installed → no button (toolbar unchanged);
 *  - the panel speaks protocol v1's file-less subset like the activity page
 *    (`ready` → init `view: 'chatbar'`, re-sent per ready; `error` → banner;
 *    file-shaped frames warn) plus `insert-text`: a non-empty string ≤ 10 000
 *    chars is inserted verbatim at the draft's caret / over its selection,
 *    the caret lands after it, the textarea is NOT focused, and nothing is
 *    ever sent (also while a turn runs). `insert-text` anywhere else warns;
 *  - one panel at a time; its button / × / Esc closes it, an outside click
 *    does not; closed = iframe unmounted; uninstall closes it;
 *  - iframe grant = the activity page's (sandbox, media-only allow, no
 *    referrer), capabilities = manifest ∩ { media, transcribe, stt-local }.
 * Rendered without I18n / Theme providers: `t()` echoes keys, lang = 'en'.
 */

function ext(id: string, over: Partial<ExtensionInfo> = {}): ExtensionInfo {
  return {
    id, name: id.toUpperCase(), version: '1.0.0', extensions: [], entry: 'index.html',
    priority: 'default', capabilities: [], bundle: false, installedAt: 1, chatbar: { height: 160, order: 100 }, ...over,
  }
}

const ctx: ActivityContext = { capabilities: ['media', 'stt-local'], theme: 'dark', themeVars: { background: '#000' }, platform: 'web', lang: 'en' }
const frame = (f: Record<string, unknown>) => ({ haloExt: 1, ...f }) as ExtensionClientFrame

describe('chatbarEntries', () => {
  beforeEach(() => setExtensions({ extensions: [], errors: [] }))

  it('nothing installed / no chatbar field → no entries', () => {
    expect(chatbarEntries()).toEqual([])
    setExtensions({ extensions: [ext('glb', { chatbar: undefined, extensions: ['.glb'] })], errors: [{ id: 'bad', error: 'x' }] })
    expect(chatbarEntries()).toEqual([])
  })

  it('orders by chatbar.order, then id; skips extensions that do not run on this platform', () => {
    setExtensions({
      extensions: [
        ext('zeta', { chatbar: { height: 160, order: 5 } }),
        ext('beta'),
        ext('alpha'),
        ext('mac-only', { chatbar: { height: 160, order: 0 }, platforms: ['desktop-mac'] }), // jsdom UA = web
      ],
      errors: [],
    })
    expect(chatbarEntries().map((e) => e.id)).toEqual(['zeta', 'alpha', 'beta'])
  })
})

describe('chatbar logic', () => {
  it('title: zh title_zh → title → name; en never _zh', () => {
    const full = ext('v', { name: 'Voice pkg', chatbar: { height: 160, order: 1, title: 'Voice', title_zh: '语音输入' } })
    expect(chatbarTitle(full, 'zh')).toBe('语音输入')
    expect(chatbarTitle(full, 'en')).toBe('Voice')
    expect(chatbarTitle(ext('v', { name: 'Voice pkg', chatbar: { height: 160, order: 1, title: 'Voice' } }), 'zh')).toBe('Voice')
    expect(chatbarTitle(ext('v', { name: 'Voice pkg' }), 'zh')).toBe('Voice pkg')
  })

  it('ready → ready + init(view: chatbar) with the file-less fields; a second ready re-sends it', () => {
    const first = onChatbarFrame({ ready: false }, frame({ type: 'ready', protocol: 1 }), ctx)
    expect(first.state.ready).toBe(true)
    const init = { type: 'post', frame: { haloExt: 1, type: 'init', view: 'chatbar', protocol: 1, capabilities: ['media', 'stt-local'], theme: 'dark', themeVars: { background: '#000' }, platform: 'web', lang: 'en' } }
    expect(first.effects).toEqual([{ type: 'ready' }, init])
    expect(onChatbarFrame(first.state, frame({ type: 'ready', protocol: 1 }), ctx).effects).toEqual([{ type: 'ready' }, init])
    expect(onChatbarFrame({ ready: true }, frame({ type: 'error', message: 'no mic' }), ctx).effects).toEqual([{ type: 'error', message: 'no mic' }])
  })

  it('insert-text: a non-empty string ≤ 10 000 chars → insert, verbatim; anything else warns', () => {
    const r = { ready: true }
    for (const text of ['你好', ' leading and trailing ', 'x'.repeat(MAX_INSERT_TEXT), '\n']) {
      expect(onChatbarFrame(r, frame({ type: 'insert-text', text }), ctx).effects).toEqual([{ type: 'insert', text }])
    }
    for (const text of ['', 'x'.repeat(MAX_INSERT_TEXT + 1), 42, null, undefined, { t: 'a' }]) {
      const effects = onChatbarFrame(r, frame({ type: 'insert-text', text }), ctx).effects
      expect(effects).toHaveLength(1)
      expect(effects[0].type).toBe('warn')
    }
  })

  it('file-shaped frames warn and do nothing else; insert-text warns on the activity page and the file host', () => {
    for (const f of [
      { type: 'dirty', dirty: true }, { type: 'save', buffer: new ArrayBuffer(1) }, { type: 'fs', id: 1, op: 'read', path: 'a' },
      { type: 'pick', id: 1, accept: [] }, { type: 'export', name: 'a.png', buffer: new ArrayBuffer(1) },
    ]) {
      const step = onChatbarFrame({ ready: true }, frame(f), ctx)
      expect(step.effects).toEqual([{ type: 'warn', message: `${f.type} frame ignored on a chat-bar panel` }])
    }
    expect(onActivityFrame({ ready: true }, frame({ type: 'insert-text', text: 'a' }), ctx).effects).toEqual([{ type: 'warn', message: 'insert-text frame ignored on an activity page' }])
    const host = initialHostState([])
    expect(onClientFrame(host, frame({ type: 'insert-text', text: 'a' }), {} as never).effects.map((e) => e.type)).toEqual(['warn'])
  })

  it('capabilities: media / transcribe / stt-local only (shared with the activity page)', () => {
    expect(activityCapabilities(['save', 'media', 'transcribe', 'fs-read', 'stt-local'])).toEqual(['media', 'transcribe', 'stt-local'])
  })

  it('insertAtSelection replaces the selection, caret after; clamps a stale selection', () => {
    expect(insertAtSelection('hello world', 5, 5, ',')).toEqual({ value: 'hello, world', caret: 6 })
    expect(insertAtSelection('hello world', 6, 11, 'there')).toEqual({ value: 'hello there', caret: 11 })
    expect(insertAtSelection('', 0, 0, 'hi')).toEqual({ value: 'hi', caret: 2 })
    expect(insertAtSelection('abc', 99, 99, '!')).toEqual({ value: 'abc!', caret: 4 })
    expect(insertAtSelection('abc', 2, 1, '-')).toEqual({ value: 'ab-c', caret: 3 })
  })
})

describe('<MessageInput> chat-bar buttons and panel', () => {
  let container: HTMLDivElement
  let root: Root
  const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

  beforeEach(() => {
    resetExtensionTokenCache()
    vi.spyOn(api.extensions, 'token').mockResolvedValue({ token: 'tok', expiresAt: Date.now() + 24 * 3600_000 })
    useProjectStore.setState({ activeProject: null, folderPath: '', projects: [] })
    useChatStore.setState({ sessionId: 's1', sandboxAvailable: false, isStreaming: false, usableAgentCount: 1 })
    setExtensions({ extensions: [], errors: [] })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    setExtensions({ extensions: [], errors: [] })
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  const textarea = () => container.querySelector('textarea')!
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  const iframe = () => container.querySelector('iframe')
  function deliver(source: Window | null, data: unknown) {
    act(() => { window.dispatchEvent(new MessageEvent('message', { data, source })) })
  }
  function type(value: string, start: number, end = start) {
    const el = textarea()
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    el.setSelectionRange(start, end)
  }
  async function renderInput(props: Partial<Parameters<typeof MessageInput>[0]> = {}) {
    const onSend = vi.fn()
    act(() => root.render(createElement(MessageInput, { onSend, ...props })))
    await flush()
    return onSend
  }

  it('no chatbar extension → no extra toolbar button', async () => {
    await renderInput()
    const before = container.querySelectorAll('button').length
    act(() => setExtensions({ extensions: [ext('glb', { chatbar: undefined, extensions: ['.glb'] })], errors: [] }))
    expect(container.querySelectorAll('button').length).toBe(before)
    act(() => setExtensions({ extensions: [ext('voice', { chatbar: { height: 200, order: 1, title: 'Voice' } })], errors: [] }))
    expect(container.querySelectorAll('button').length).toBe(before + 1)
    expect(button('Voice')!.className).toContain('h-8 w-8')
    expect(button('Voice')!.getAttribute('title')).toBe('Voice')
    expect(button('Voice')!.querySelector('svg.lucide-mic')).toBeTruthy() // no icon → Mic
  })

  it('opens the panel above the input with the activity grant; toggles, ×, Esc close; outside click does not', async () => {
    act(() => setExtensions({ extensions: [ext('voice', { capabilities: ['media', 'stt-local', 'save'], version: '2.0.0', chatbar: { height: 200, order: 1, title: 'Voice' } })], errors: [] }))
    await renderInput()
    expect(iframe()).toBeNull()
    act(() => button('Voice')!.click())
    await flush()
    const panel = container.querySelector('[role="dialog"]') as HTMLElement
    expect(panel.className).toContain('bottom-full')
    expect(panel.className).toContain('w-[min(420px,calc(100%-1.5rem))]')
    expect((panel.querySelector('[style*="height"]') as HTMLElement).style.height).toBe('200px')
    const el = iframe()!
    expect(el.getAttribute('src')).toBe('/api/extensions/voice/2.0.0/tok/index.html')
    expect(el.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin')
    expect(el.getAttribute('allow')).toBe('microphone; display-capture; clipboard-write')
    expect(el.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(button('Voice')!.getAttribute('aria-pressed')).toBe('true')

    const posted = vi.spyOn(el.contentWindow!, 'postMessage')
    deliver(window, { haloExt: 1, type: 'ready', protocol: 1 }) // not our iframe
    expect(posted).not.toHaveBeenCalled()
    deliver(el.contentWindow, { haloExt: 1, type: 'ready', protocol: 1 })
    expect(posted.mock.calls[0][0]).toMatchObject({ type: 'init', view: 'chatbar', capabilities: ['media', 'stt-local'] })

    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(iframe()).toBeTruthy()                                   // outside click keeps it
    act(() => button('Voice')!.click())
    expect(iframe()).toBeNull()                                     // same button closes
    act(() => button('Voice')!.click())
    await flush()
    act(() => button('chat.chatbar.close')!.click())
    expect(iframe()).toBeNull()                                     // ×
    act(() => button('Voice')!.click())
    await flush()
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(iframe()).toBeNull()                                     // Esc on the host page
  })

  it('one panel at a time; the textarea Esc closes it instead of interrupting the turn', async () => {
    act(() => setExtensions({ extensions: [ext('a', { chatbar: { height: 160, order: 1, title: 'A' } }), ext('b', { chatbar: { height: 160, order: 2, title: 'B' } })], errors: [] }))
    const onInterrupt = vi.fn()
    await renderInput({ isStreaming: true, onInterrupt })
    act(() => button('A')!.click())
    await flush()
    act(() => button('B')!.click())
    await flush()
    expect(container.querySelectorAll('iframe')).toHaveLength(1)
    expect(iframe()!.getAttribute('src')).toContain('/api/extensions/b/')
    act(() => { textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(iframe()).toBeNull()
    expect(onInterrupt).not.toHaveBeenCalled()
  })

  it('insert-text lands at the caret / over the selection, verbatim, never focuses or sends — also mid-turn', async () => {
    act(() => setExtensions({ extensions: [ext('voice', { chatbar: { height: 160, order: 1, title: 'Voice' } })], errors: [] }))
    const onSend = await renderInput({ isStreaming: true })
    type('hello world', 5)
    act(() => button('Voice')!.click())
    await flush()
    const win = iframe()!.contentWindow!
    deliver(win, { haloExt: 1, type: 'ready', protocol: 1 })
    ;(document.activeElement as HTMLElement | null)?.blur()

    deliver(win, { haloExt: 1, type: 'insert-text', text: ', dear' })
    expect(textarea().value).toBe('hello, dear world')
    expect(textarea().selectionStart).toBe(11)
    expect(textarea().selectionEnd).toBe(11)
    deliver(win, { haloExt: 1, type: 'insert-text', text: '!' })           // back-to-back: reads the new caret
    expect(textarea().value).toBe('hello, dear! world')

    textarea().setSelectionRange(13, 18)                                    // select "world"
    deliver(win, { haloExt: 1, type: 'insert-text', text: 'there\n' })
    expect(textarea().value).toBe('hello, dear! there\n')
    expect(textarea().selectionStart).toBe(19)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    deliver(win, { haloExt: 1, type: 'insert-text', text: '' })
    deliver(win, { haloExt: 1, type: 'insert-text', text: 'x'.repeat(MAX_INSERT_TEXT + 1) })
    deliver(win, { haloExt: 1, type: 'insert-text', text: 7 })
    deliver(win, { haloExt: 1, type: 'send', text: 'go' })                  // no such frame — ignored
    deliver(window, { haloExt: 1, type: 'insert-text', text: 'spoof' })     // not our iframe
    expect(textarea().value).toBe('hello, dear! there\n')
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual(expect.arrayContaining([expect.stringMatching(/^\[ExtensionChatbar\] voice: /)]))
    expect(warn).toHaveBeenCalledTimes(4)

    expect(document.activeElement).not.toBe(textarea())
    expect(onSend).not.toHaveBeenCalled()
  })

  it('uninstalling the open extension closes its panel', async () => {
    act(() => setExtensions({ extensions: [ext('voice', { chatbar: { height: 160, order: 1, title: 'Voice' } })], errors: [] }))
    await renderInput()
    act(() => button('Voice')!.click())
    await flush()
    expect(iframe()).toBeTruthy()
    act(() => setExtensions({ extensions: [], errors: [] }))
    expect(iframe()).toBeNull()
    expect(button('Voice')).toBeNull()
    act(() => setExtensions({ extensions: [ext('voice', { chatbar: { height: 160, order: 1, title: 'Voice' } })], errors: [] }))
    expect(iframe()).toBeNull() // reinstall does not reopen
  })

  it('no ready within 10 s → unresponsive + Retry inside the panel', async () => {
    act(() => setExtensions({ extensions: [ext('voice', { chatbar: { height: 160, order: 1, title: 'Voice' } })], errors: [] }))
    await renderInput()
    vi.useFakeTimers()
    act(() => button('Voice')!.click())
    await flush()
    expect(iframe()).toBeTruthy()
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(container.textContent).toContain('editor.extension.unresponsive')
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'editor.extension.retry')!
    act(() => retry.click())
    await flush()
    expect(iframe()).toBeTruthy()
  })
})
