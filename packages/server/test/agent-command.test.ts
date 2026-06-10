import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { dispatchCommand, type CommandContext } from '../src/channels/shared/commands.js'

/**
 * End-to-end coverage for the `/agent` builtin object command. Key invariants:
 *   - builtin verbs (list/switch/desc/delete) show in `/agent help` on EVERY
 *     agent, even one without the `agent` skill whitelisted.
 *   - skill verbs (create/update) show only when the skill is whitelisted.
 *   - the listing is filtered by access level.
 */
let ws: string

function writeAgentSkill(): void {
  const dir = join(ws, '.halo', 'skills', 'agent')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), [
    '---', 'name: agent', 'description: Manage agents', 'command: /agent',
    'verbs:',
    '  - { name: list,   builtin: true,  desc: List }',
    '  - { name: delete, builtin: true,  requiresAccess: full,      desc: Delete }',
    '  - { name: create, builtin: false, requiresAccess: full,      desc: Create a new agent }',
    '---', '# agent body',
  ].join('\n'))
}

/** Write the agent the session runs as, with an explicit skills whitelist. */
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

function ctxFor(sm: SessionManager, accessLevel: 'full' | 'workspace' | 'readonly'): CommandContext {
  return {
    sm, userId: 'u1', sessionPrefix: 'web_', accessLevel,
    channelLabel: 'web', activeOverrides: new Map(), workspacePath: ws, lang: 'en',
  }
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-agentcmd-'))
  writeAgentSkill()
})
afterEach(() => { rmSync(ws, { recursive: true, force: true }) })

describe('/agent help — skill whitelisted', () => {
  beforeEach(() => writeAgent('default', ['agent']))

  it('full user sees builtin AND skill verbs', async () => {
    const res = await dispatchCommand(ctxFor(new SessionManager(ws), 'full'), '/agent', '')
    expect(res?.text).toContain('/agent list')
    expect(res?.text).toContain('/agent delete')
    expect(res?.text).toContain('/agent create')
  })

  it('workspace user sees list but not delete/create (full-gated)', async () => {
    const res = await dispatchCommand(ctxFor(new SessionManager(ws), 'workspace'), '/agent', '')
    expect(res?.text).toContain('/agent list')
    expect(res?.text).not.toContain('/agent delete')
    expect(res?.text).not.toContain('/agent create')
  })

  it('readonly user sees the read verbs (list open to everyone) but nothing full-gated', async () => {
    const res = await dispatchCommand(ctxFor(new SessionManager(ws), 'readonly'), '/agent', '')
    expect(res?.text).toContain('/agent list')
    expect(res?.text).not.toContain('/agent delete')
    expect(res?.text).not.toContain('/agent create')
  })
})

describe('/agent help — skill NOT whitelisted', () => {
  beforeEach(() => writeAgent('default', [])) // no agent skill

  it('still lists builtin verbs (list/delete) — they do not depend on the skill', async () => {
    const res = await dispatchCommand(ctxFor(new SessionManager(ws), 'full'), '/agent', '')
    expect(res?.text).toContain('/agent list')
    expect(res?.text).toContain('/agent delete')
  })

  it('does NOT list skill verbs (create) when the skill is not whitelisted', async () => {
    const res = await dispatchCommand(ctxFor(new SessionManager(ws), 'full'), '/agent', '')
    expect(res?.text).not.toContain('/agent create')
  })
})
