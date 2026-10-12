import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * `halo cli` / `tui` warn about a missing OS sandbox only for a non-full
 * session (the only one that loses shell_exec), at most once per process.
 * The probe result is injected: sandboxUnavailableWarning is stubbed to
 * report an unavailable sandbox. Temp HOME + agent setup as in
 * harness-dir-agent.test.ts (building the agent resolves its provider).
 */

const WARNING = '[cli] OS sandbox unavailable (stub) — workspace/readonly sessions get no shell_exec. Fix: stub'
const sandboxWarning = vi.hoisted(() => vi.fn<(tag: string) => string | null>())
vi.mock('@turmind/halo-server/tools/sandbox', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sandboxUnavailableWarning: sandboxWarning,
}))

let ws: string
let tmpHome: string
let realHome: string | undefined
let createHarness: typeof import('../src/harness.js')['createHarness']

beforeAll(async () => {
  realHome = process.env.HOME
  tmpHome = mkdtempSync(join(tmpdir(), 'halo-cli-sbx-home-'))
  process.env.HOME = tmpHome
  const modelsDir = join(tmpHome, '.halo', 'global', 'models')
  mkdirSync(modelsDir, { recursive: true })
  copyFileSync(resolve(import.meta.dirname, '..', '..', 'server', 'templates', 'models', 'anthropic.yaml'), join(modelsDir, 'anthropic.yaml'))
  ws = mkdtempSync(join(tmpdir(), 'halo-cli-sbx-'))
  const dir = join(ws, '.halo', 'agents', 'alpha')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.yaml'), [
    'name: alpha', 'model:', '  provider: anthropic', '  id: claude-opus-4-8', '  endpoint: https://api.anthropic.com', 'tools: [file_read]',
  ].join('\n'))
  sandboxWarning.mockReturnValue(WARNING)
  createHarness = (await import('../src/harness.js')).createHarness
})

afterAll(() => {
  process.env.HOME = realHome
  rmSync(ws, { recursive: true, force: true })
  rmSync(tmpHome, { recursive: true, force: true })
})

afterEach(() => { vi.restoreAllMocks() })

async function warningsFor(accessLevel?: 'full' | 'workspace' | 'readonly'): Promise<string[]> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const h = await createHarness({ workspace: ws, agentId: 'alpha', newSession: true, accessLevel })
  h.destroy()
  return warn.mock.calls.map((c) => String(c[0]))
}

// Order matters: the once-per-process flag lives in the harness module.
describe('cli harness — OS sandbox warning', () => {
  it('full access (default or explicit) says nothing', async () => {
    expect(await warningsFor()).toEqual([])
    expect(await warningsFor('full')).toEqual([])
    expect(sandboxWarning).not.toHaveBeenCalled()
  })

  it('workspace access prints the warning', async () => {
    expect(await warningsFor('workspace')).toEqual([WARNING])
    expect(sandboxWarning).toHaveBeenCalledWith('cli')
  })

  it('only once per process', async () => {
    expect(await warningsFor('readonly')).toEqual([])
    expect(sandboxWarning).toHaveBeenCalledTimes(1)
  })
})
