import { describe, it, expect } from 'vitest'
import { parseDragPaths } from '../src/features/explorer/file-tree'

/**
 * Contract: an in-tree drag carries a JSON array of paths (handleDragStart),
 * and every drop target — folder rows AND the root — must decode it. The
 * root drop used to pass the raw `["dir/a.md"]` string straight to the rename
 * API, so dragging a file to the workspace root failed with ENOENT.
 */
describe('parseDragPaths', () => {
  it('decodes the JSON array written by handleDragStart', () => {
    expect(parseDragPaths(JSON.stringify(['dir/a.md']))).toEqual(['dir/a.md'])
    expect(parseDragPaths(JSON.stringify(['a', 'b/c']))).toEqual(['a', 'b/c'])
  })

  it('treats a non-JSON string as a legacy single path', () => {
    expect(parseDragPaths('dir/a.md')).toEqual(['dir/a.md'])
  })

  it('treats valid non-array JSON as a single path', () => {
    expect(parseDragPaths('123')).toEqual(['123'])
  })
})
