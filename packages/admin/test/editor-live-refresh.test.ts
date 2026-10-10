import { describe, it, expect, beforeEach } from 'vitest'
import { isContentChange, tabRefresh, versionedUrl } from '../src/features/editor/file-refresh'
import { createEditorStore } from '../src/shared/stores/editor-store'

/**
 * Contract: an open tab follows its file on disk. Both in-place writes
 * (`change`) and rename-over writes (`add`: `sed -i`, tmp + `os.replace`)
 * refresh. Dirty text tabs and the pinned face are never touched. Built-in
 * previews remount only when the disk mtime is strictly newer, so our own
 * save's echo and event bursts are no-ops.
 */

const preview = { downloadUrl: 'd', viewUrl: 'v' }
const off = { pinned: false, hasHost: false }

describe('isContentChange', () => {
  it('treats in-place and rename-over writes as content changes', () => {
    expect(isContentChange('change')).toBe(true)
    expect(isContentChange('add')).toBe(true)
  })
  it('ignores structural-only events', () => {
    for (const a of ['unlink', 'addDir', 'unlinkDir']) expect(isContentChange(a)).toBe(false)
  })
})

describe('tabRefresh', () => {
  it('refreshes a clean text tab, never a dirty one', () => {
    expect(tabRefresh({}, off)).toBe('text')
    expect(tabRefresh({ modified: true }, off)).toBe('none')
  })
  it('leaves the pinned face and unknown paths alone', () => {
    expect(tabRefresh({ preview }, { pinned: true, hasHost: false })).toBe('none')
    expect(tabRefresh(undefined, off)).toBe('none')
  })
  it('hands an extension preview to its host, otherwise remounts the built-in one', () => {
    expect(tabRefresh({ preview }, { pinned: false, hasHost: true })).toBe('host')
    expect(tabRefresh({ preview }, off)).toBe('preview')
  })
  it('skips a bundle directory with no host', () => {
    expect(tabRefresh({ preview: { ...preview, bundle: true } }, off)).toBe('none')
  })
})

describe('versionedUrl', () => {
  it('appends the mtime; leaves unknown mtime and empty (bundle) urls alone', () => {
    expect(versionedUrl('/api/files/download?path=a&inline=1', 42)).toBe('/api/files/download?path=a&inline=1&v=42')
    expect(versionedUrl('/x?a=1', undefined)).toBe('/x?a=1')
    expect(versionedUrl('', 42)).toBe('')
  })
})

describe('refreshPreview', () => {
  let store: ReturnType<typeof createEditorStore>
  beforeEach(() => {
    store = createEditorStore()
    store.getState().openPreview('a.pdf', 'd', 'v', { mtime: 100, size: 1 })
  })

  it('bumps mtime/size only when disk is newer', () => {
    const before = store.getState()
    store.getState().refreshPreview('a.pdf', 100, 9)
    expect(store.getState()).toBe(before) // echo / burst: no state change at all
    store.getState().refreshPreview('a.pdf', 50, 9)
    expect(store.getState()).toBe(before)
    store.getState().refreshPreview('a.pdf', 200, 9)
    expect(store.getState().buffers['a.pdf']).toMatchObject({ mtime: 200, size: 9 })
    expect(store.getState().tabs.find((t) => t.path === 'a.pdf')?.mtime).toBe(200)
  })

  it('a preview opened without a known mtime takes the first stat, then dedupes', () => {
    store.getState().openPreview('c.png', 'd', 'v')
    expect(store.getState().buffers['c.png'].mtime).toBeUndefined()
    store.getState().refreshPreview('c.png', 50, 9)
    expect(store.getState().buffers['c.png']).toMatchObject({ mtime: 50, size: 9 })
    const after = store.getState()
    store.getState().refreshPreview('c.png', 50, 9)
    expect(store.getState()).toBe(after)
  })

  it('ignores text buffers and unknown paths', () => {
    store.getState().openFile('b.md', 'x', 'markdown', 100)
    const before = store.getState()
    store.getState().refreshPreview('b.md', 200, 9)
    store.getState().refreshPreview('nope.pdf', 200, 9)
    expect(store.getState()).toBe(before)
  })
})
