import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { dispatchCommand, type CommandContext } from '../src/channels/shared/commands.js'
import { agentSessions } from '../src/db/schema.js'

/**
 * End-to-end coverage for the noun-verb command system across objects —
 * the stable surface after the object-command refactor:
 *   - builtin verbs run deterministically (no LLM) and respect their
 *     hardcoded access gates (SUBCOMMAND_ROUTES)
 *   - skill verbs are gated by the skill's verbs: declaration and fall
 *     through to execSkillCommand (whitelist + session required)
 *   - bare `/<obj>` lists only the verbs the caller can run
 *   - /evo is full-only; /session verbs are open to everyone
 *   - unknown commands return null (channels render "unknown command")
 */
let ws: string

function writeAgent(agentId: string, skills: string[]): void {
  const dir = join(ws, '.halo', 'agents', agentId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.yaml'), [
    `name: ${agentId}`,
    'model:', '  provider: anthropic', '  id: claude-opus-4-8', '  endpoint: https://api.anthropic.com',
    'tools: [file_read]',
    `skills: [${skills.join(', ')}]`,
  ].join('\n'))
}

function writeSkill(id: string, fm: string[], body = '# body'): void {
  const dir = join(ws, '.halo', 'skills', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), ['---', ...fm, '---', body].join('\n'))
}

function seedSession(sm: SessionManager, id: string, agentId = 'default', accessLevel: string | null = null): void {
  sm.getDb().insert(agentSessions).values({
    id, parentId: null, agentId, agentName: agentId,
    description: '', workingDir: null, accessLevel,
    createdAt: Date.now(), updatedAt: Date.now(), stoppedAt: null, archivedAt: null,
  }).run()
}

function ctxFor(sm: SessionManager, accessLevel: 'full' | 'workspace' | 'readonly'): CommandContext {
  return {
    sm, userId: 'u1', sessionPrefix: 'web_', accessLevel,
    channelLabel: 'test', activeOverrides: new Map(), workspacePath: ws, lang: 'en',
  }
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-cmdroute-'))
  writeAgent('default', ['skill', 'ws'])
})
afterEach(() => { rmSync(ws, { recursive: true, force: true }) })

// ── /session: builtin verbs, open to everyone ───────────────────────────────

describe('/session', () => {
  it('bare /session lists all verbs even for readonly', async () => {
    const res = await dispatchCommand(ctxFor(new SessionManager(ws), 'readonly'), '/session', '')
    for (const v of ['new', 'list', 'switch', 'stop', 'interrupt', 'compact', 'context']) {
      expect(res?.text).toContain(`/session ${v}`)
    }
  })

  it('/session list runs deterministically (no session needed, empty list message)', async () => {
    const res = await dispatchCommand(ctxFor(new SessionManager(ws), 'readonly'), '/session', 'list')
    expect(res?.text).toBeTruthy()
    expect(res?.startedTurn).toBeUndefined() // builtin verb — never kicks the LLM
  })

  it('/session new creates a session and returns switchTo', async () => {
    const sm = new SessionManager(ws)
    const res = await dispatchCommand(ctxFor(sm, 'full'), '/session', 'new')
    expect(res?.switchTo).toBeTruthy()
    expect(sm.getSessionById(res!.switchTo!)).toBeTruthy()
  })

  it('readonly cannot reach someone else session — foreign sessions are not even listed', async () => {
    const sm = new SessionManager(ws)
    seedSession(sm, 'other_abc', 'default', null) // foreign prefix
    const ctx = ctxFor(sm, 'readonly')
    // Visibility-layer defense: the readonly switch list is scoped to the
    // caller's own prefix, so the foreign session never gets an index at all.
    const res = await dispatchCommand(ctx, '/session', 'switch 1')
    expect(res?.text).toMatch(/No sessions to switch/)
    // And a full user CAN see + switch to it (cross-prefix).
    const full = await dispatchCommand(ctxFor(sm, 'full'), '/session', 'switch 1')
    expect(full?.switchTo).toBe('other_abc')
  })
})

// ── /skill: builtin verbs with per-verb gates + skill-verb fallback ─────────

describe('/skill verbs', () => {
  it('disable is workspace-gated: readonly rejected with access message', async () => {
    writeSkill('foo', ['name: foo', 'description: x'])
    const res = await dispatchCommand(ctxFor(new SessionManager(ws), 'readonly'), '/skill', 'disable foo')
    expect(res?.text).toMatch(/requires workspace/)
  })

  it('disable/enable toggle the workspace disabled flag with explicit no-op messages', async () => {
    writeSkill('foo', ['name: foo', 'description: x'])
    const sm = new SessionManager(ws)
    const ctx = ctxFor(sm, 'full')
    expect((await dispatchCommand(ctx, '/skill', 'disable foo'))?.text).toMatch(/disabled/)
    expect((await dispatchCommand(ctx, '/skill', 'disable foo'))?.text).toMatch(/already/)
    expect((await dispatchCommand(ctx, '/skill', 'enable foo'))?.text).toMatch(/enabled/)
  })

  it('delete is full-gated and removes the skill dir', async () => {
    writeSkill('doomed', ['name: doomed', 'description: x'])
    const sm = new SessionManager(ws)
    const denied = await dispatchCommand(ctxFor(sm, 'workspace'), '/skill', 'delete doomed')
    expect(denied?.text).toMatch(/requires full/)
    const ok = await dispatchCommand(ctxFor(sm, 'full'), '/skill', 'delete doomed')
    expect(ok?.text).toMatch(/Deleted|🗑/)
    expect(existsSync(join(ws, '.halo', 'skills', 'doomed'))).toBe(false)
  })

  it('list shows disabled/overridden flags', async () => {
    writeSkill('foo', ['name: foo', 'description: x'])
    const sm = new SessionManager(ws)
    await dispatchCommand(ctxFor(sm, 'full'), '/skill', 'disable foo')
    const res = await dispatchCommand(ctxFor(sm, 'full'), '/skill', 'list')
    expect(res?.text).toMatch(/foo.*disabled/)
  })
})

// ── skill-verb fallback: gate from verbs:, needs whitelist + session ────────

describe('skill verb fallback (create/update style)', () => {
  beforeEach(() => {
    // Object skill `ws` with a workspace-gated skill verb `setup`.
    writeSkill('ws', [
      'name: ws', 'description: workspace maintenance', 'command: /ws',
      'verbs:',
      '  - { name: info, builtin: true, desc: i }',
      '  - { name: setup, requiresAccess: workspace, desc: s }',
    ])
  })

  it('skill verb below gate is rejected at the router (before any session lookup)', async () => {
    const res = await dispatchCommand(ctxFor(new SessionManager(ws), 'readonly'), '/ws', 'setup')
    expect(res?.text).toMatch(/requires workspace/)
  })

  it('skill verb with access + active session activates the skill (startedTurn)', async () => {
    const sm = new SessionManager(ws)
    seedSession(sm, 'web_s1')
    const res = await dispatchCommand(ctxFor(sm, 'full'), '/ws', 'setup')
    expect(res?.startedTurn).toBe(true)
    expect(res?.sessionId).toBe('web_s1')
  })

  it('skill verb without whitelist is refused by execSkillCommand', async () => {
    writeAgent('default', []) // ws not whitelisted
    const sm = new SessionManager(ws)
    seedSession(sm, 'web_s2')
    const res = await dispatchCommand(ctxFor(sm, 'full'), '/ws', 'setup')
    expect(res?.text).toMatch(/not available/)
  })
})

// ── flat commands + unknowns ────────────────────────────────────────────────

describe('flat commands & unknowns', () => {
  it('/evo is full-only', async () => {
    const res = await dispatchCommand(ctxFor(new SessionManager(ws), 'workspace'), '/evo', '')
    expect(res?.text).toMatch(/full/)
  })

  it('unknown command returns null (channel renders unknown-command text)', async () => {
    const res = await dispatchCommand(ctxFor(new SessionManager(ws), 'full'), '/nonexistent', '')
    expect(res).toBeNull()
  })

  it('/help hides /evo below full and shows runnable verbs inline', async () => {
    const res = await dispatchCommand(ctxFor(new SessionManager(ws), 'workspace'), '/help', '')
    expect(res?.text).not.toContain('/evo')
    expect(res?.text).toMatch(/\/session <verb>/)
  })
})
