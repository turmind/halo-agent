import { describe, it, expect, beforeEach } from 'vitest'
import { createEditorStore, type EditorBuffer } from '../src/shared/stores/editor-store'

/**
 * Contract: the pinned tab (the face toggle) lives in exactly one pane, first
 * in its strip; no close path removes it and no open path duplicates it —
 * only `unpinTab` drops it.
 */

const FACE = '.halo/canvas/self.html'
const face: EditorBuffer = { path: FACE, content: '', originalContent: '', language: '', preview: { downloadUrl: 'd', viewUrl: 'v' } }

let store: ReturnType<typeof createEditorStore>
beforeEach(() => {
  store = createEditorStore()
  store.getState().openFile('a.ts', 'a', 'typescript')
  store.getState().openFile('b.ts', 'b', 'typescript')
})

const tabsOf = (i = 0) => store.getState().groups[i].tabs

describe('pinned tab', () => {
  it('pins first in the active pane; activate controls focus', () => {
    store.getState().pinTab(face, false)
    expect(tabsOf()).toEqual([FACE, 'a.ts', 'b.ts'])
    expect(store.getState().activeTab).toBe('b.ts')
    store.getState().pinTab(face, true)
    expect(tabsOf()).toEqual([FACE, 'a.ts', 'b.ts'])
    expect(store.getState().activeTab).toBe(FACE)
  })

  it('no close path removes it', () => {
    store.getState().pinTab(face, true)
    store.getState().closeTab(FACE)
    store.getState().closeTabIn(0, FACE)
    expect(tabsOf()).toContain(FACE)
    store.getState().closeTabIn(0, 'a.ts')
    store.getState().closeTabIn(0, 'b.ts')
    expect(tabsOf()).toEqual([FACE])
  })

  it('opening the same file again jumps to it instead of a second copy', () => {
    store.getState().pinTab(face, false)
    store.getState().openFile(FACE, '<html>', 'html')
    expect(tabsOf().filter((p) => p === FACE)).toHaveLength(1)
    expect(store.getState().activeTab).toBe(FACE)
    expect(store.getState().buffers[FACE].preview).toBeTruthy()   // still the face buffer, not a text one
  })

  it('replaces a plain tab of the same file and stays in one pane on split', () => {
    store.getState().openFile(FACE, '<html>', 'html')
    store.getState().pinTab(face, true)
    expect(tabsOf().filter((p) => p === FACE)).toHaveLength(1)
    store.getState().splitToRight()          // active = face → seeds the new pane with another tab
    expect(store.getState().groups).toHaveLength(2)
    expect(tabsOf(1)).not.toContain(FACE)
    store.getState().openFileInGroup(1, FACE, '<html>', 'html')
    expect(tabsOf(1)).not.toContain(FACE)
    expect(store.getState().activeGroupIdx).toBe(0)
  })

  it('unpin drops it', () => {
    store.getState().pinTab(face, true)
    store.getState().unpinTab()
    expect(store.getState().pinnedTab).toBeNull()
    expect(tabsOf()).toEqual(['a.ts', 'b.ts'])
    expect(store.getState().buffers[FACE]).toBeUndefined()
  })
})
