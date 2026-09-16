import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceTools } from '../src/tools/workspace-tools.js'
import type { ToolDef } from '../src/agents/agent-loop.js'

/**
 * Regression coverage for walkDir's `.halo` handling (shared by glob + grep).
 *
 * `.halo` used to sit in SKIP_DIRS wholesale, so a glob/grep from the
 * workspace root could never reach `.halo/memory`, `.halo/docs` or
 * `.halo/INSTRUCTIONS.md` — the agent's own knowledge base. Only the
 * machine-generated subtrees (sessions/ logs/ evo/ tmp/) should be skipped,
 * and only when their direct parent is `.halo`, so a user project's own
 * `logs/` directory is still walked.
 */

let ws: string

function globTool(): ToolDef {
  const tool = createWorkspaceTools(ws, 'full').find((t) => t.name === 'glob')
  if (!tool) throw new Error('glob tool not found')
  return tool
}

const run = (input: { pattern: string; path?: string }) =>
  Promise.resolve(globTool().callback(input)) as Promise<string>

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-skip-dirs-'))
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

describe('glob — .halo knowledge base is walked, runtime subtrees are not', () => {
  it('finds .halo/memory and src/logs but skips .halo/sessions', async () => {
    mkdirSync(join(ws, '.halo', 'memory'), { recursive: true })
    mkdirSync(join(ws, '.halo', 'sessions'), { recursive: true })
    mkdirSync(join(ws, '.halo', 'assets', 'web', 'inbound'), { recursive: true })
    mkdirSync(join(ws, 'src', 'logs'), { recursive: true })
    writeFileSync(join(ws, '.halo', 'memory', 'a.md'), '# a\n')
    writeFileSync(join(ws, '.halo', 'sessions', 'x.json'), '{}\n')
    writeFileSync(join(ws, '.halo', 'assets', 'web', 'inbound', 'img.png'), 'PNG')
    writeFileSync(join(ws, 'src', 'logs', 'b.ts'), 'export {}\n')

    const out = await run({ pattern: '**/*' })
    const files = out.split('\n')
    expect(files).toContain(join('.halo', 'memory', 'a.md'))
    expect(files).toContain(join('src', 'logs', 'b.ts'))
    expect(files).not.toContain(join('.halo', 'sessions', 'x.json'))
    expect(files).not.toContain(join('.halo', 'assets', 'web', 'inbound', 'img.png'))
  })
})
