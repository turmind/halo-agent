import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { dispatchCommand, type CommandContext } from '../src/channels/shared/commands.js'

/**
 * End-to-end coverage for the `/agent` builtin object command: bare `/agent`
 * (help) must list verbs, and the listing must be filtered by access level.
 */
let ws: string

function writeAgentSkill(): void {
  const dir = join(ws, '.halo', 'skills', 'agent')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), [
    '---',
    'name: agent',
    'description: Manage agents',
    'command: /agent',
    'requiresAccess: full',
    'verbs:',
    '  - { name: list,   builtin: true,  desc: List usable agents }',
    '  - { name: switch, builtin: true,  desc: Start a session }',
    '  - { name: desc,   builtin: true,  desc: Show config }',
    '  - { name: delete, builtin: true,  desc: Delete an agent }',
    '  - { name: create, builtin: false, desc: Create a new agent }',
    '  - { name: update, builtin: false, desc: Modify an agent }',
    '---',
    '# agent body',
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

describe('/agent builtin object command', () => {
  it('bare /agent lists verbs for a full user', async () => {
    const sm = new SessionManager(ws)
    const res = await dispatchCommand(ctxFor(sm, 'full'), '/agent', '')
    expect(res?.text).toContain('/agent list')
    expect(res?.text).toContain('/agent create')
    expect(res?.text).toContain('/agent delete')
  })

  it('readonly user sees NO verbs (all gated above readonly)', async () => {
    const sm = new SessionManager(ws)
    const res = await dispatchCommand(ctxFor(sm, 'readonly'), '/agent', '')
    // list/switch/desc = workspace, delete/create/update = full → none for readonly
    expect(res?.text).toContain('no actions to list')
  })

  it('workspace user sees read verbs but not create/delete', async () => {
    const sm = new SessionManager(ws)
    const res = await dispatchCommand(ctxFor(sm, 'workspace'), '/agent', '')
    expect(res?.text).toContain('/agent list')
    expect(res?.text).not.toContain('/agent create')
    expect(res?.text).not.toContain('/agent delete')
  })
})
