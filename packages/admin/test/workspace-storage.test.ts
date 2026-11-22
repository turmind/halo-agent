import { afterEach, describe, expect, it, vi } from 'vitest'
import { migrateWorkspaceUiState } from '../src/features/workspace/workspace-storage'
import { canvasKey, PENDING_CANVAS_KEY, type CanvasView } from '../src/features/extensions/canvas-logic'

const source = '/workspace-link'
const canonical = '/workspace'
const entries = {
  'halo_tabs:': JSON.stringify({ groups: [{ tabs: [{ path: 'a.ts' }], activeTab: 'a.ts' }], activeGroupIdx: 0 }),
  'halo_chat_tabs_': JSON.stringify({ active: 'child' }),
  'halo_session_': 'legacy-session',
  'halo_face_on:': '1',
  'halo_selected_session_': 'selected-session',
  'halo_goal_dismissed_': 'goal-id',
}
const view: CanvasView = { kind: 'extension', extensionId: 'sample', viewId: 'live', projectId: source, sessionId: 'child', title: 'Review' }

afterEach(() => { localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks() })

describe('canonical workspace UI storage migration', () => {
  it('moves every workspace-path key when the canonical key is absent, once', () => {
    for (const [prefix, raw] of Object.entries(entries)) localStorage.setItem(prefix + source, raw)
    localStorage.setItem('halo_theme', 'warm')
    migrateWorkspaceUiState(source, canonical)
    for (const [prefix, raw] of Object.entries(entries)) {
      expect(localStorage.getItem(prefix + canonical)).toBe(raw)
      expect(localStorage.getItem(prefix + source)).toBeNull()
    }
    expect(localStorage.getItem('halo_theme')).toBe('warm')
    const set = vi.spyOn(Storage.prototype, 'setItem')
    const remove = vi.spyOn(Storage.prototype, 'removeItem')
    migrateWorkspaceUiState(source, canonical)
    expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled()
  })
  it('keeps existing canonical values, including an empty string, and removes old keys', () => {
    for (const [prefix, raw] of Object.entries(entries)) {
      localStorage.setItem(prefix + source, raw)
      localStorage.setItem(prefix + canonical, prefix === 'halo_session_' ? '' : 'canonical-state')
    }
    migrateWorkspaceUiState(source, canonical)
    for (const prefix of Object.keys(entries)) {
      expect(localStorage.getItem(prefix + canonical)).toBe(prefix === 'halo_session_' ? '' : 'canonical-state')
      expect(localStorage.getItem(prefix + source)).toBeNull()
    }
  })
  it('does no storage work when the resolved path is unchanged', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem')
    const set = vi.spyOn(Storage.prototype, 'setItem')
    const remove = vi.spyOn(Storage.prototype, 'removeItem')
    migrateWorkspaceUiState(canonical, canonical)
    expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled()
  })
  it('rewrites Canvas tuple IDs and active selections in both panes without changing file paths', () => {
    const foreign = { ...view, projectId: '/other' }
    const tab = { kind: 'extension', path: canvasKey(view), extensionView: view }
    localStorage.setItem('halo_tabs:' + source, JSON.stringify({ groups: [
      { tabs: [{ path: 'a.ts' }, tab], activeTab: tab.path },
      { tabs: [tab, { path: source + '/external.txt', readOnly: true }, { path: canvasKey(foreign), extensionView: foreign }], activeTab: tab.path },
    ], activeGroupIdx: 1 }))
    migrateWorkspaceUiState(source, canonical)
    const migrated = JSON.parse(localStorage.getItem('halo_tabs:' + canonical)!)
    const next = { ...view, projectId: canonical }
    expect(migrated.groups[0].tabs[1]).toEqual({ ...tab, path: canvasKey(next), extensionView: next })
    expect(migrated.groups[1].tabs[0]).toEqual(migrated.groups[0].tabs[1])
    expect(migrated.groups.map((g: { activeTab: string }) => g.activeTab)).toEqual([canvasKey(next), canvasKey(next)])
    expect(migrated.activeGroupIdx).toBe(1)
    expect(migrated.groups[0].tabs[0]).toEqual({ path: 'a.ts' })
    expect(migrated.groups[1].tabs[1].path).toBe(source + '/external.txt')
    expect(migrated.groups[1].tabs[2].extensionView).toEqual(foreign)
  })
  it('rewrites only matching one-use Canvas navigation metadata', () => {
    sessionStorage.setItem(PENDING_CANVAS_KEY, JSON.stringify({ view, chat: false }))
    migrateWorkspaceUiState(source, canonical)
    expect(JSON.parse(sessionStorage.getItem(PENDING_CANVAS_KEY)!)).toEqual({ view: { ...view, projectId: canonical }, chat: false })
    const raw = JSON.stringify({ view: { ...view, projectId: '/other' }, chat: true })
    sessionStorage.setItem(PENDING_CANVAS_KEY, raw)
    migrateWorkspaceUiState(source, canonical)
    expect(sessionStorage.getItem(PENDING_CANVAS_KEY)).toBe(raw)
  })
  it('keeps malformed layouts for restore to handle without blocking other state migration', () => {
    localStorage.setItem('halo_tabs:' + source, '{')
    localStorage.setItem('halo_face_on:' + source, '1')
    migrateWorkspaceUiState(source, canonical)
    expect(localStorage.getItem('halo_tabs:' + canonical)).toBe('{')
    expect(localStorage.getItem('halo_face_on:' + canonical)).toBe('1')
  })
})
