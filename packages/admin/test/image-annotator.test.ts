import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  annotatedFileName, arrowGeometry, clientToImage, compositeAnnotated, keepStroke, strokesReducer, strokeWidthFor,
  COMPOSITE_MAX_EDGE, SCREEN_STROKE_WIDTH, type Stroke,
} from '../src/features/editor/previews/ui/annotate'
import { MediaPreview } from '../src/features/editor/previews/plugins/media-view'
import { ImageAnnotator } from '../src/features/editor/previews/ui/image-annotator'
import { MessageInput } from '../src/features/chat/message-input'
import { EditorStoreProvider, useEditorStore } from '../src/shared/stores/editor-store'
import { useProjectStore } from '../src/shared/stores/project-store'
import { useChatStore } from '../src/features/chat/chat-store'
import { api } from '../src/shared/api-client'

/**
 * Contract: the canvas image annotator keeps strokes in natural image pixels.
 * A pointer maps back through the board's on-screen box (layout fit + zoom +
 * pan), so a mark lands on the same image pixel at any view; a new stroke's
 * width shows as SCREEN_STROKE_WIDTH on screen; undo pops one, clear empties;
 * a shape too small / too flat to read is dropped. Send to chat composites
 * (long edge capped at COMPOSITE_MAX_EDGE, marks scaled with it) into
 * `<base>-annotated.png`, hands it over as `halo:attach-image` and closes the
 * board; an encode failure shows inline and attaches nothing. Every primary
 * press stays inside the board (a second finger never pans the preview).
 * Annotate is offered only for a decoded, non-svg image in the main editor.
 * The chat input attaches it only for a vision model, else shows a notice.
 *
 * No I18nProvider: the default `t` echoes keys, which the selectors match.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NAT_W = 4000, NAT_H = 3000

/** The on-screen box of a 4000×3000 image fitted to 800 px wide (k = 0.2), then
 *  zoomed by `scale` about the container origin and panned by (tx, ty). */
const boxAt = (scale: number, tx: number, ty: number, left = 50, top = 30) =>
  ({ left: left + tx, top: top + ty, width: 800 * scale, height: 600 * scale })

/** A 2D-context stand-in recording every call (name + args) and property set. */
function fakeCtx() {
  const calls: Array<{ fn: string; args: unknown[] }> = []
  const props: Record<string, unknown> = {}
  const ctx = new Proxy(props, {
    get: (t, k) => t[k as string] ?? ((...args: unknown[]) => { calls.push({ fn: String(k), args }) }),
    set: (t, k, v) => { t[k as string] = v; return true },
  })
  return { ctx, calls, props }
}

describe('clientToImage', () => {
  it('maps the fitted image back to natural pixels', () => {
    const r = boxAt(1, 0, 0)
    expect(clientToImage(50, 30, r, NAT_W, NAT_H)).toEqual({ x: 0, y: 0 })
    expect(clientToImage(450, 330, r, NAT_W, NAT_H)).toEqual({ x: 2000, y: 1500 })
    expect(clientToImage(850, 630, r, NAT_W, NAT_H)).toEqual({ x: 4000, y: 3000 })
  })

  it('a given image pixel is hit at the same place under zoom and pan', () => {
    for (const [scale, tx, ty] of [[1, 0, 0], [3, -400, -250], [8.5, -2600, -1200], [0.4, 120, 80]] as const) {
      const r = boxAt(scale, tx, ty)
      const k = r.width / NAT_W
      const p = clientToImage(r.left + 1234 * k, r.top + 567 * k, r, NAT_W, NAT_H)
      expect(p.x).toBeCloseTo(1234, 6)
      expect(p.y).toBeCloseTo(567, 6)
    }
  })

  it('clamps a pointer outside the image onto its edge', () => {
    const r = boxAt(2, -100, -100)
    expect(clientToImage(-500, 5000, r, NAT_W, NAT_H)).toEqual({ x: 0, y: NAT_H })
  })
})

describe('strokeWidthFor', () => {
  it('scales with the display so a line looks the same on screen', () => {
    expect(strokeWidthFor(800, NAT_W, NAT_H)).toBe(SCREEN_STROKE_WIDTH * 5)
    expect(strokeWidthFor(1600, NAT_W, NAT_H)).toBe(SCREEN_STROKE_WIDTH * 2.5)
  })
  it('never goes below the floor that survives the chat downscale', () => {
    expect(strokeWidthFor(64000, NAT_W, NAT_H)).toBe(5)
  })
})

describe('strokesReducer', () => {
  const s = (n: number): Stroke => ({ tool: 'pen', color: '#ef4444', width: 4, points: [{ x: n, y: n }] })

  it('add appends, undo pops the last one, clear empties', () => {
    let st = strokesReducer([], { type: 'add', stroke: s(1) })
    st = strokesReducer(st, { type: 'add', stroke: s(2) })
    st = strokesReducer(st, { type: 'add', stroke: s(3) })
    expect(st.map((x) => x.points[0].x)).toEqual([1, 2, 3])
    st = strokesReducer(st, { type: 'undo' })
    expect(st.map((x) => x.points[0].x)).toEqual([1, 2])
    st = strokesReducer(st, { type: 'clear' })
    expect(st).toEqual([])
  })
  it('undo / clear on nothing stay empty (same state, no re-render)', () => {
    const empty: Stroke[] = []
    expect(strokesReducer(empty, { type: 'undo' })).toEqual([])
    expect(strokesReducer(empty, { type: 'clear' })).toBe(empty)
  })
})

describe('keepStroke', () => {
  const mk = (tool: Stroke['tool'], dx: number, dy: number): Stroke =>
    ({ tool, color: '#ef4444', width: 10, points: [{ x: 100, y: 100 }, { x: 100 + dx, y: 100 + dy }] })

  it('a pen press is a dot; a shape needs to travel a stroke width', () => {
    expect(keepStroke(mk('pen', 0, 0))).toBe(true)
    expect(keepStroke(mk('arrow', 6, 6))).toBe(false)
    expect(keepStroke(mk('arrow', 10, 0))).toBe(true)
  })
  it('a rectangle flatter than a stroke width on either side is dropped', () => {
    expect(keepStroke(mk('rect', 400, 9))).toBe(false)
    expect(keepStroke(mk('rect', -9, -400))).toBe(false)
    expect(keepStroke(mk('rect', 400, 10))).toBe(true)
  })
})

describe('arrowGeometry', () => {
  it('head tip at the end, shaft stops at the head base', () => {
    const g = arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 5)
    expect(g.head[0]).toEqual({ x: 100, y: 0 })
    expect(g.shaftEnd).toEqual({ x: 80, y: 0 })
    expect(g.head[1].x).toBeCloseTo(80)
    expect(Math.abs(g.head[1].y)).toBeCloseTo(10)
  })
})

describe('compositeAnnotated', () => {
  const canvasWith = (ctx: unknown) => ({ width: 0, height: 0, getContext: () => ctx }) as unknown as HTMLCanvasElement
  const img = {} as CanvasImageSource

  it('is the natural size under the cap; image first, then rect / arrow / pen strokes', () => {
    const { ctx, calls, props } = fakeCtx()
    const strokes: Stroke[] = [
      { tool: 'rect', color: '#ef4444', width: 8, points: [{ x: 10, y: 10 }, { x: 200, y: 100 }] },
      { tool: 'arrow', color: '#3b82f6', width: 8, points: [{ x: 0, y: 0 }, { x: 300, y: 300 }] },
      { tool: 'pen', color: '#facc15', width: 6, points: [{ x: 5, y: 5 }, { x: 50, y: 60 }, { x: 90, y: 20 }] },
    ]
    const out = compositeAnnotated(img, NAT_W, NAT_H, strokes, canvasWith(ctx))
    expect([out.width, out.height]).toEqual([NAT_W, NAT_H])
    expect(calls[0]).toEqual({ fn: 'scale', args: [1, 1] })
    expect(calls[1]).toEqual({ fn: 'drawImage', args: [img, 0, 0, NAT_W, NAT_H] })
    expect(calls.find((c) => c.fn === 'strokeRect')!.args).toEqual([10, 10, 190, 90])
    expect(calls.filter((c) => c.fn === 'fill')).toHaveLength(1) // the arrow head
    // The pen: moveTo its first point, lineTo every following one, then stroke.
    const penFrom = calls.findIndex((c) => c.fn === 'moveTo' && c.args[0] === 5)
    expect(calls.slice(penFrom, penFrom + 4)).toEqual([
      { fn: 'moveTo', args: [5, 5] }, { fn: 'lineTo', args: [50, 60] }, { fn: 'lineTo', args: [90, 20] }, { fn: 'stroke', args: [] },
    ])
    expect(props.strokeStyle).toBe('#facc15')
    expect(props.lineWidth).toBe(6)
    expect(props.lineCap).toBe('round')
  })

  it('a large image is capped at COMPOSITE_MAX_EDGE with the marks scaled alike', () => {
    const { ctx, calls } = fakeCtx()
    const out = compositeAnnotated(img, 8000, 6000, [
      { tool: 'rect', color: '#ef4444', width: 20, points: [{ x: 1000, y: 1000 }, { x: 3000, y: 2000 }] },
    ], canvasWith(ctx))
    expect([out.width, out.height]).toEqual([COMPOSITE_MAX_EDGE, 3072])
    // One transform for everything: image drawn at its natural size, rect at
    // natural coordinates and width — all under scale(0.512).
    expect(calls[0]).toEqual({ fn: 'scale', args: [0.512, 0.512] })
    expect(calls[1].args.slice(1)).toEqual([0, 0, 8000, 6000])
    expect(calls.find((c) => c.fn === 'strokeRect')!.args).toEqual([1000, 1000, 2000, 1000])
  })

  it('no 2D context throws (the board turns it into an inline error)', () => {
    expect(() => compositeAnnotated(img, 10, 10, [], canvasWith(null))).toThrow()
  })
})

describe('annotatedFileName', () => {
  it('replaces the extension with -annotated.png', () => {
    expect(annotatedFileName('shot.jpg')).toBe('shot-annotated.png')
    expect(annotatedFileName('a.b.png')).toBe('a.b-annotated.png')
    expect(annotatedFileName('README')).toBe('README-annotated.png')
  })
})

// ── mounted ─────────────────────────────────────────────────────────────────

let host: HTMLDivElement
let root: Root
const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector(sel) as T | null
const byTitle = (title: string) => q<HTMLButtonElement>(`button[title="${title}"]`)
const sendBtn = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'editor.annotate.send')!
const loadImg = (img: HTMLImageElement, w = NAT_W, h = NAT_H) => act(() => {
  Object.defineProperty(img, 'naturalWidth', { value: w, configurable: true })
  Object.defineProperty(img, 'naturalHeight', { value: h, configurable: true })
  img.dispatchEvent(new Event('load'))
})
const pointer = (el: Element, type: string, x: number, y: number, pointerId = 1) => act(() => {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId, pointerType: 'touch' }))
})
const key = (k: string, mods: KeyboardEventInit = {}) => act(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods }))
})
/** Real canvases in jsdom have no 2D context / encoder: stub both. `blob`
 *  decides what toBlob hands back; `deferred` holds it until released. */
function stubCanvas(opts: { blob?: Blob | null; deferred?: boolean } = {}) {
  const { ctx } = fakeCtx()
  let release: () => void = () => {}
  const made: HTMLCanvasElement[] = []
  const realCreate = document.createElement.bind(document)
  const spy = vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const el = realCreate(tag)
    if (tag === 'canvas') {
      made.push(el as HTMLCanvasElement)
      Object.assign(el, {
        getContext: () => ctx,
        toBlob: (cb: (b: Blob | null) => void) => {
          const out = opts.blob === undefined ? new Blob(['png'], { type: 'image/png' }) : opts.blob
          if (opts.deferred) release = () => cb(out)
          else cb(out)
        },
      })
    }
    return el
  }) as typeof document.createElement)
  return { made, spy, release: () => release() }
}
function captureAttach() {
  const files: File[] = []
  const on = (e: Event) => files.push((e as CustomEvent<{ file: File }>).detail.file)
  window.addEventListener('halo:attach-image', on)
  return { files, stop: () => window.removeEventListener('halo:attach-image', on) }
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  // jsdom has no pointer capture.
  Element.prototype.setPointerCapture = () => {}
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('MediaPreview: Annotate button', () => {
  const props = { name: 'shot.png', path: 'pics/shot.png', viewUrl: '/api/files/raw?path=pics/shot.png', downloadUrl: '/dl' }
  beforeEach(() => {
    const s = useEditorStore.getState()
    useEditorStore.setState({ groups: [{ ...s.groups[0], tabs: [props.path], activeTab: props.path }] })
  })
  const mountLoaded = (p = props) => {
    act(() => { root.render(createElement(MediaPreview, p)) })
    loadImg(q<HTMLImageElement>('img')!)
  }

  it('shows only once the image decoded, never after an error', () => {
    act(() => { root.render(createElement(MediaPreview, props)) })
    expect(byTitle('editor.annotate.hint')).toBeNull()
    act(() => { q('img')!.dispatchEvent(new Event('error')) })
    expect(byTitle('editor.annotate.hint')).toBeNull()

    act(() => { root.render(createElement(MediaPreview, { ...props, viewUrl: `${props.viewUrl}&v=2` })) })
    loadImg(q<HTMLImageElement>('img')!)
    expect(byTitle('editor.annotate.hint')).not.toBeNull()
  })

  it('is not offered on an svg', () => {
    mountLoaded({ ...props, name: 'flow.SVG', path: 'pics/flow.SVG' })
    expect(byTitle('editor.zoomIn')).not.toBeNull()
    expect(byTitle('editor.annotate.hint')).toBeNull()
  })

  it('is not offered under a scoped editor store (Skills / Agents tabs)', () => {
    act(() => { root.render(createElement(EditorStoreProvider, null, createElement(MediaPreview, props))) })
    loadImg(q<HTMLImageElement>('img')!)
    expect(byTitle('editor.zoomIn')).not.toBeNull()
    expect(byTitle('editor.annotate.hint')).toBeNull()
  })

  it('switching the pane to another tab leaves annotate mode', () => {
    mountLoaded()
    act(() => { byTitle('editor.annotate.hint')!.click() })
    expect(host.textContent).toContain('editor.annotate.send')
    act(() => {
      const s = useEditorStore.getState()
      useEditorStore.setState({ groups: [{ ...s.groups[0], tabs: [props.path, 'b.ts'], activeTab: 'b.ts' }] })
    })
    expect(host.textContent).not.toContain('editor.annotate.send')
  })

  it('a second finger while drawing neither pans the image nor starts a stroke', () => {
    mountLoaded()
    act(() => { byTitle('editor.annotate.hint')!.click() })
    const board = q<HTMLImageElement>('div.touch-none img')!
    loadImg(board)
    const container = q('div.bg-\\[\\#1a1a1a\\]')!
    const transform = () => board.parentElement!.style.transform
    const before = transform()
    const surface = board.parentElement!.parentElement!

    pointer(surface, 'pointerdown', 100, 100, 1)         // finger 1 draws
    pointer(surface, 'pointerdown', 300, 300, 2)         // finger 2 / palm lands
    pointer(container, 'pointermove', 600, 500, 2)
    pointer(surface, 'pointermove', 200, 150, 1)
    pointer(container, 'pointerup', 600, 500, 2)
    pointer(surface, 'pointerup', 200, 150, 1)
    expect(transform()).toBe(before)
    expect(container.style.cursor).toBe('grab')
    expect((board.nextElementSibling as SVGSVGElement).children).toHaveLength(1)
  })

  it('Esc leaves annotate mode before the canvas sees it', () => {
    mountLoaded()
    act(() => { byTitle('editor.annotate.hint')!.click() })
    const later = vi.fn()
    window.addEventListener('keydown', later)
    key('Escape')
    window.removeEventListener('keydown', later)
    expect(host.textContent).not.toContain('editor.annotate.send')
    expect(later).not.toHaveBeenCalled()
  })
})

describe('ImageAnnotator', () => {
  function mount(name = 'shot.jpg') {
    const onClose = vi.fn()
    act(() => { root.render(createElement(ImageAnnotator, { src: '/x.png', name, viewStyle: {}, onClose })) })
    const img = q<HTMLImageElement>('img')!
    loadImg(img)
    const board = img.parentElement!
    // The board's on-screen box: 4000×3000 shown at 0.2 × zoom 2, panned.
    board.getBoundingClientRect = () => ({ ...boxAt(2, -300, -100), right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    const r = board.getBoundingClientRect()
    const k = r.width / NAT_W
    /** Image pixel → client coordinates. */
    const at = (x: number, y: number) => [r.left + x * k, r.top + y * k] as const
    return { board, surface: board.parentElement!, onClose, at }
  }
  const marks = () => q('img')!.nextElementSibling as SVGSVGElement
  const strokeCount = () => marks().children.length
  const draw = (surface: Element, from: readonly [number, number], to: readonly [number, number], id = 1) => {
    pointer(surface, 'pointerdown', ...from, id)
    pointer(surface, 'pointermove', ...to, id)
    pointer(surface, 'pointerup', ...to, id)
  }

  it('a touch drag draws in image pixels; undo and clear edit the list', () => {
    const { surface, at } = mount()
    pointer(surface, 'pointerdown', ...at(100, 200))
    pointer(surface, 'pointermove', ...at(150, 260))
    pointer(surface, 'pointermove', ...at(300, 400))
    pointer(surface, 'pointerup', ...at(300, 400))
    const line = marks().querySelector('polyline')!
    const pts = line.getAttribute('points')!.split(' ').map((p) => p.split(',').map(Number))
    expect(pts[0][0]).toBeCloseTo(100); expect(pts[0][1]).toBeCloseTo(200)
    expect(pts.at(-1)![0]).toBeCloseTo(300); expect(pts.at(-1)![1]).toBeCloseTo(400)
    // 4 screen px at 0.4 screen px per image px.
    expect(Number(line.getAttribute('stroke-width'))).toBeCloseTo(10)

    act(() => { byTitle('editor.annotate.rect')!.click() })
    draw(surface, at(1000, 1000), at(1800, 1400))
    const rect = marks().querySelector('rect')!
    expect([rect.getAttribute('x'), rect.getAttribute('y'), rect.getAttribute('width'), rect.getAttribute('height')].map((v) => Math.round(Number(v))))
      .toEqual([1000, 1000, 800, 400])
    expect(strokeCount()).toBe(2)

    act(() => { byTitle('editor.annotate.undo')!.click() })
    expect(strokeCount()).toBe(1)
    act(() => { byTitle('editor.annotate.clear')!.click() })
    expect(strokeCount()).toBe(0)
    expect(byTitle('editor.annotate.undo')!.disabled).toBe(true)
  })

  it('a shape press without travel and a flat rectangle add nothing; a second pointer is ignored', () => {
    const { surface, at } = mount()
    act(() => { byTitle('editor.annotate.arrow')!.click() })
    draw(surface, at(400, 300), at(400, 300))
    expect(strokeCount()).toBe(0)

    act(() => { byTitle('editor.annotate.rect')!.click() })
    draw(surface, at(400, 300), at(1400, 305)) // 1000 × 5 image px, width 10
    expect(strokeCount()).toBe(0)

    act(() => { byTitle('editor.annotate.arrow')!.click() })
    pointer(surface, 'pointerdown', ...at(400, 300), 1)
    pointer(surface, 'pointerdown', ...at(10, 10), 2)
    pointer(surface, 'pointermove', ...at(10, 10), 2)
    pointer(surface, 'pointerup', ...at(10, 10), 2)
    pointer(surface, 'pointermove', ...at(1400, 900), 1)
    pointer(surface, 'pointerup', ...at(1400, 900), 1)
    expect(marks().querySelectorAll('polygon')).toHaveLength(1)
  })

  it('Ctrl/Cmd+Z undoes — not while focus is in a text field', () => {
    const { surface, at } = mount()
    draw(surface, at(100, 100), at(300, 300))
    draw(surface, at(500, 500), at(700, 700))
    expect(strokeCount()).toBe(2)
    key('z', { ctrlKey: true })
    expect(strokeCount()).toBe(1)

    const field = document.createElement('textarea')
    document.body.appendChild(field)
    field.focus()
    key('z', { metaKey: true })
    expect(strokeCount()).toBe(1)
    field.remove()
    key('z', { metaKey: true })
    expect(strokeCount()).toBe(0)
  })

  it('Esc closes the board', () => {
    const { onClose } = mount()
    key('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Send to chat attaches <base>-annotated.png at the natural size, frees the canvas and closes', async () => {
    const { surface, onClose, at } = mount()
    draw(surface, at(100, 100), at(300, 300))
    const { made } = stubCanvas()
    const got = captureAttach()
    await act(async () => { sendBtn().click() })
    got.stop()
    expect(got.files).toHaveLength(1)
    expect(got.files[0].name).toBe('shot-annotated.png')
    expect(got.files[0].type).toBe('image/png')
    expect(made).toHaveLength(1)
    expect([made[0].width, made[0].height]).toEqual([0, 0]) // released after encoding
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('toBlob returning null shows an inline error and attaches nothing', async () => {
    const { surface, onClose, at } = mount()
    draw(surface, at(100, 100), at(300, 300))
    stubCanvas({ blob: null })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const got = captureAttach()
    await act(async () => { sendBtn().click() })
    got.stop()
    expect(got.files).toHaveLength(0)
    expect(q('[role="alert"]')!.textContent).toBe('editor.annotate.failed')
    expect(onClose).not.toHaveBeenCalled()
    expect(sendBtn().disabled).toBe(false) // can retry
  })

  it('closing while the encode is in flight attaches nothing', async () => {
    const { surface, at } = mount()
    draw(surface, at(100, 100), at(300, 300))
    const canvas = stubCanvas({ deferred: true })
    const got = captureAttach()
    await act(async () => { sendBtn().click() })
    act(() => root.unmount())
    await act(async () => { canvas.release() })
    got.stop()
    expect(got.files).toHaveLength(0)
    root = createRoot(host) // afterEach unmounts
  })
})

describe('MessageInput: halo:attach-image listener', () => {
  const file = () => new File(['png'], 'shot-annotated.png', { type: 'image/png' })

  async function mountInput(imageCapable: boolean) {
    useProjectStore.setState({ activeProject: { id: '/ws/annot', name: 'annot', path: '/ws/annot', createdAt: 0 } })
    useChatStore.setState({ selectedAgentId: 'default', usableAgentCount: 1 })
    useEditorStore.setState({ bottomTab: 'terminal' })
    // Model id unique per case: the image-capability map is cached per models-bus version.
    const model = `annot-model-${imageCapable}`
    vi.spyOn(api.agentConfigs, 'list').mockResolvedValue({ agents: [{ id: 'default', name: 'Default', description: '', model, path: '', scope: 'global', priority: 1 }] })
    vi.spyOn(api.agentConfigs, 'models').mockResolvedValue({ providers: [{ models: [{ id: 'annot-model-true', capabilities: { image: true } }, { id: 'annot-model-false', capabilities: { image: false } }] }] } as unknown as Awaited<ReturnType<typeof api.agentConfigs.models>>)
    URL.createObjectURL = () => 'blob:chip'
    await act(async () => { root.render(createElement(MessageInput, { onSend: vi.fn() })) })
    await act(async () => { await Promise.resolve() })
  }
  const dispatchAttach = async () => {
    await act(async () => { window.dispatchEvent(new CustomEvent('halo:attach-image', { detail: { file: file() } })) })
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))) })
  }

  it('a vision model gets the chip; the chat tab comes forward and the input is focused', async () => {
    await mountInput(true)
    await dispatchAttach()
    expect(q('img[alt="shot-annotated.png"]')).not.toBeNull()
    expect(host.textContent).not.toContain('chat.attachNoVision')
    expect(useEditorStore.getState().bottomTab).toBe('chat')
    expect(document.activeElement).toBe(q('textarea'))
  })

  it('a text-only model gets the notice and no attachment', async () => {
    await mountInput(false)
    await dispatchAttach()
    expect(q('img[alt="shot-annotated.png"]')).toBeNull()
    expect(host.textContent).toContain('chat.attachNoVision')
  })
})
