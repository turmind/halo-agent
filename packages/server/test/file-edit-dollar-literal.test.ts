import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceTools } from '../src/tools/workspace-tools.js'
import type { ToolDef } from '../src/agents/agent-loop.js'

/**
 * Regression coverage for file_edit's single-replacement branch.
 *
 * It used to call `content.replace(old, new_string)` with a bare string, so
 * JS expanded `$&` / `` $` `` / `$'` / `$1` inside new_string — a literal
 * `` $` `` in a replacement spliced the whole file head into the edit.
 * new_string must always land verbatim.
 */

let ws: string

function editTool(): ToolDef {
  const tool = createWorkspaceTools(ws, 'full').find((t) => t.name === 'file_edit')
  if (!tool) throw new Error('file_edit tool not found')
  return tool
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-file-edit-'))
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

describe('file_edit — `$` in new_string is literal', () => {
  it('does not expand replace patterns in the single-replacement branch', async () => {
    const file = join(ws, 'a.md')
    writeFileSync(file, 'HEAD\nTARGET\nTAIL\n')
    const replacement = "const s = `$` + `$&` + `$'` + $1 + $$"

    const out = await editTool().callback({ path: 'a.md', old_string: 'TARGET', new_string: replacement })

    expect(out).toBe('File edited: a.md')
    expect(readFileSync(file, 'utf8')).toBe(`HEAD\n${replacement}\nTAIL\n`)
  })
})
