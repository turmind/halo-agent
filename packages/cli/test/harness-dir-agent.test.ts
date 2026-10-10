import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Harness } from '../src/harness.js'
import { agentSessions } from '@turmind/halo-server/db/schema'

/**
 * `halo cli` / `halo tui` session binding rules (harness bindWorkspace):
 *   - `-s <existing>` with an explicit, different `-a` is refused before
 *     anything is touched — a session's agent never changes;
 *   - the fallback resume (no -s / -n) with a different explicit `-a`
 *     starts a new session instead of resuming the latest one;
 *   - `--dir` re-points a resumed session in place; `--dir .` resets it to
 *     the workspace root (null); omitting it keeps the stored value.
 * No turn runs — createSession only builds the agent from workspace yamls.
 *
 * Building the agent resolves its provider from the models registry under
 * os.homedir() → temp HOME seeded with the bundled anthropic.yaml, set
 * before the dynamic imports (CI runners have no ~/.halo).
 */

let ws: string
let tmpHome: string
let realHome: string | undefined
let createHarness: typeof import('../src/harness.js')['createHarness']
let SessionManager: typeof import('@turmind/halo-server/agents/session-manager')['SessionManager']
const harnesses: Harness[] = []

beforeAll(async () => {
  realHome = process.env.HOME
  tmpHome = mkdtempSync(join(tmpdir(), 'halo-cli-dir-home-'))
  process.env.HOME = tmpHome
  const modelsDir = join(tmpHome, '.halo', 'global', 'models')
  mkdirSync(modelsDir, { recursive: true })
  copyFileSync(resolve(import.meta.dirname, '..', '..', 'server', 'templates', 'models', 'anthropic.yaml'), join(modelsDir, 'anthropic.yaml'))
  createHarness = (await import('../src/harness.js')).createHarness
  SessionManager = (await import('@turmind/halo-server/agents/session-manager')).SessionManager
})

afterAll(() => {
  process.env.HOME = realHome
  rmSync(tmpHome, { recursive: true, force: true })
})

function writeAgent(id: string): void {
  const dir = join(ws, '.halo', 'agents', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.yaml'), [
    `name: ${id}`, 'model:', '  provider: anthropic', '  id: claude-opus-4-8', '  endpoint: https://api.anthropic.com', 'tools: [file_read]',
  ].join('\n'))
}

/** Read the workspace db through a separate manager (the harness's own registry is private). */
function rows(): Array<{ id: string; agentId: string; workingDir: string | null }> {
  return new SessionManager(ws).getDb().select({ id: agentSessions.id, agentId: agentSessions.agentId, workingDir: agentSessions.workingDir })
    .from(agentSessions).all().sort((a, b) => a.id.localeCompare(b.id))
}

async function bind(opts: Parameters<typeof createHarness>[0]): Promise<Harness> {
  const h = await createHarness(opts)
  harnesses.push(h)
  return h
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-cli-dir-'))
  mkdirSync(join(ws, 'sub'), { recursive: true })
  writeAgent('alpha')
  writeAgent('beta')
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  for (const h of harnesses.splice(0)) h.destroy()
  vi.restoreAllMocks()
  rmSync(ws, { recursive: true, force: true })
})

describe('halo cli -a on an existing session', () => {
  it('-s <existing> with a different explicit -a is refused and leaves the session untouched', async () => {
    const first = await bind({ workspace: ws, agentId: 'alpha', newSession: true, dir: 'sub' })
    const before = rows()
    const files = readdirSync(join(ws, '.halo', 'sessions'), { recursive: true }).sort()
    await expect(createHarness({ workspace: ws, sessionId: first.sessionId, agentId: 'beta', dir: '.' }))
      .rejects.toThrow(`session ${first.sessionId} runs agent alpha; omit -a to resume it, or use -n for a new session with beta`)
    expect(rows()).toEqual(before)
    expect(readdirSync(join(ws, '.halo', 'sessions'), { recursive: true }).sort()).toEqual(files)
    // Same agent, or no -a at all, resumes it.
    expect((await bind({ workspace: ws, sessionId: first.sessionId, agentId: 'alpha' })).sessionId).toBe(first.sessionId)
    expect((await bind({ workspace: ws, sessionId: first.sessionId })).agentId).toBe('alpha')
  })

  it('a fallback resume with a different explicit -a creates a new session; the same agent resumes', async () => {
    const first = await bind({ workspace: ws, agentId: 'alpha', newSession: true })
    const other = await bind({ workspace: ws, agentId: 'beta' })
    expect(other.sessionId).not.toBe(first.sessionId)
    expect(other.agentId).toBe('beta')
    expect(rows().map((r) => r.agentId).sort()).toEqual(['alpha', 'beta'])
    expect((await bind({ workspace: ws, agentId: 'beta' })).sessionId).toBe(other.sessionId)
  })
})

describe('halo cli --dir', () => {
  it('sets the folder on create, re-points on resume, keeps it when omitted, and --dir . resets to null', async () => {
    const h = await bind({ workspace: ws, agentId: 'alpha', newSession: true, dir: 'sub' })
    const dirOf = () => rows().find((r) => r.id === h.sessionId)!.workingDir
    expect(dirOf()).toBe('sub')
    await bind({ workspace: ws, sessionId: h.sessionId })
    expect(dirOf()).toBe('sub')
    await bind({ workspace: ws, sessionId: h.sessionId, dir: '.' })
    expect(dirOf()).toBeNull()
    await bind({ workspace: ws, sessionId: h.sessionId, dir: join(ws, 'sub') })
    expect(dirOf()).toBe('sub')
  })

  it('rejects a folder outside the workspace or missing, before creating anything', async () => {
    await expect(createHarness({ workspace: ws, agentId: 'alpha', newSession: true, dir: '..' })).rejects.toThrow(/outside the workspace/)
    await expect(createHarness({ workspace: ws, agentId: 'alpha', newSession: true, dir: 'nope' })).rejects.toThrow(/does not exist/)
    expect(rows()).toEqual([])
  })
})
