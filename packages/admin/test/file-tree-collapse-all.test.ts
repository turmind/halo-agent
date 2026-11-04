import { describe, it, expect, vi } from 'vitest'
import { setPathExpanded, isPathExpanded, collapseAllPaths } from '../src/features/explorer/file-tree'

/**
 * Contract: the Explorer header's "Collapse All" empties the persisted
 * expanded-paths set — every folder reads as collapsed afterwards and the
 * cleared set is what gets written back to localStorage (so a reload doesn't
 * re-expand them).
 */
describe('collapseAllPaths', () => {
  it('collapses every expanded folder and persists the empty set', () => {
    vi.useFakeTimers()
    setPathExpanded('a', true)
    setPathExpanded('a/b', true)
    setPathExpanded('c', true)
    collapseAllPaths()
    expect(isPathExpanded('a')).toBe(false)
    expect(isPathExpanded('a/b')).toBe(false)
    expect(isPathExpanded('c')).toBe(false)
    vi.runAllTimers()
    expect(JSON.parse(localStorage.getItem('halo:file-tree:expanded') ?? 'null')).toEqual([])
    vi.useRealTimers()
  })
})
