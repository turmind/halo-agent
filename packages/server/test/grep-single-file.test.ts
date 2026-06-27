import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceTools } from '../src/tools/workspace-tools.js'
import type { ToolDef } from '../src/agents/agent-loop.js'

/**
 * Regression coverage for grep when `path` points at a SINGLE FILE, not a
 * directory. The bug: walkDir is built on fs.readdir, which throws on a file
 * path; the throw was swallowed (catch → return), so grep on a file silently
 * yielded zero matches even when the pattern clearly matched a line. The fix
 * (workspace-tools.ts) stats the target first and searches just that one file
 * when it's a regular file. These tests drive the real grep callback against a
 * tmpdir workspace ('full' access → plain fs, no bwrap, runs offline).
 */

let ws: string

function grepTool(): ToolDef {
  const tool = createWorkspaceTools(ws, 'full').find((t) => t.name === 'grep')
  if (!tool) throw new Error('grep tool not found')
  return tool
}

const run = (input: { pattern: string; path?: string; include?: string; max_results?: number }) =>
  Promise.resolve(grepTool().callback(input)) as Promise<string>

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-grep-'))
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

describe('grep — single-file path target', () => {
  it('matches lines when path is a single file (the core regression)', async () => {
    writeFileSync(join(ws, 'city.js'), 'const a = 1\nfunction floorY() {}\nconst stack = []\n')
    const out = await run({ pattern: 'floorY', path: 'city.js' })
    expect(out).toContain('city.js:2:function floorY() {}')
    expect(out).not.toMatch(/No matches/)
  })

  it('reports every matching line in the single file with correct line numbers', async () => {
    writeFileSync(join(ws, 'world.js'), 'a\nanchorFloor()\nb\nanchorFloor()\n')
    const out = await run({ pattern: 'anchorFloor', path: 'world.js' })
    expect(out.split('\n')).toEqual([
      'world.js:2:anchorFloor()',
      'world.js:4:anchorFloor()',
    ])
  })

  it('honours `include` for a single-file target — match when the filter passes', async () => {
    writeFileSync(join(ws, 'a.ts'), 'needle\n')
    const out = await run({ pattern: 'needle', path: 'a.ts', include: '*.ts' })
    expect(out).toContain('a.ts:1:needle')
  })

  it('honours `include` for a single-file target — no match when the filter excludes it', async () => {
    writeFileSync(join(ws, 'a.md'), 'needle\n')
    const out = await run({ pattern: 'needle', path: 'a.md', include: '*.ts' })
    expect(out).toMatch(/No matches/)
  })

  it('skips a single-file target that is binary (null bytes) and returns no matches', async () => {
    writeFileSync(join(ws, 'bin.dat'), Buffer.from([0x6e, 0x00, 0x65, 0x65, 0x64]))
    const out = await run({ pattern: 'n', path: 'bin.dat' })
    expect(out).toMatch(/No matches/)
  })

  it('returns an honest "no matches" when the single file has no matching line', async () => {
    writeFileSync(join(ws, 'a.ts'), 'hello world\n')
    const out = await run({ pattern: 'goodbye', path: 'a.ts' })
    expect(out).toMatch(/No matches found for pattern "goodbye"/)
  })
})

describe('grep — directory traversal still works (no regression)', () => {
  it('searches recursively when path is a directory', async () => {
    mkdirSync(join(ws, 'sub'))
    writeFileSync(join(ws, 'sub', 'a.ts'), 'token here\n')
    writeFileSync(join(ws, 'b.ts'), 'token there\n')
    const out = await run({ pattern: 'token', path: '.' })
    expect(out).toContain('b.ts:1:token there')
    expect(out).toContain('sub/a.ts:1:token here')
  })

  it('applies `include` while walking a directory', async () => {
    writeFileSync(join(ws, 'keep.ts'), 'match\n')
    writeFileSync(join(ws, 'skip.md'), 'match\n')
    const out = await run({ pattern: 'match', path: '.', include: '*.ts' })
    expect(out).toContain('keep.ts:1:match')
    expect(out).not.toContain('skip.md')
  })
})

describe('grep — missing path', () => {
  it('returns no matches (not an error) when the path does not exist', async () => {
    const out = await run({ pattern: 'x', path: 'nope-does-not-exist.ts' })
    expect(out).toMatch(/No matches found for pattern "x"/)
  })
})
