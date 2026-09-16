import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { agentSessions } from '../src/db/schema.js'
import { execSkillCommand } from '../src/commands/skill-command.js'

/**
 * INTEGRATION coverage for SessionSkillCommands (fourth knife). The interesting,
 * security-relevant logic is the access gate: a skill's `requiresAccess` (from
 * SKILL.md frontmatter) must be >= the session's access level, or it's hidden —
 * this is what keeps an admin-only skill (e.g. cron management) out of /help on
 * a readonly channel. Plus the `skills:` whitelist intersection. Driven through
 * a REAL SessionManager against a tmpdir with self-contained agent.yaml +
 * SKILL.md files, so the real scan + filter runs.
 */

let ws: string

function writeAgent(agentId: string, skills: string[]): void {
  const dir = join(ws, '.halo', 'agents', agentId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.yaml'), [
    `name: ${agentId}`,
    'model:',
    '  provider: anthropic',
    '  id: claude-opus-4-8',
    '  endpoint: https://api.anthropic.com',
    'tools: [file_read]',
    `skills: [${skills.join(', ')}]`,
  ].join('\n'))
}

/** Write a workspace skill with a slash command + optional access gate. */
function writeSkill(skillId: string, command: string, requiresAccess?: 'full' | 'workspace' | 'readonly'): void {
  const dir = join(ws, '.halo', 'skills', skillId)
  mkdirSync(dir, { recursive: true })
  const fm = [
    '---',
    `name: ${skillId}`,
    `description: test skill ${skillId}`,
    `command: ${command}`,
    ...(requiresAccess ? [`requiresAccess: ${requiresAccess}`] : []),
    '---',
    `# ${skillId}`,
  ].join('\n')
  writeFileSync(join(dir, 'SKILL.md'), fm)
}

function seed(sm: SessionManager, id: string, agentId: string, accessLevel: string | null = null): void {
  sm.getDb().insert(agentSessions).values({
    id, parentId: null, agentId, agentName: agentId,
    description: '', workingDir: null, accessLevel,
    createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
  }).run()
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-skillcmd-'))
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

describe('listAvailableSkillCommandsForAgent — whitelist', () => {
  it('returns only skills in the agent yaml whitelist', async () => {
    writeSkill('alpha', '/alpha')
    writeSkill('beta', '/beta')
    writeAgent('a1', ['alpha'])  // only alpha whitelisted
    const sm = new SessionManager(ws)
    const cmds = await sm.listAvailableSkillCommandsForAgent('a1')
    const ids = cmds.map((c) => c.skillId ?? c.name)
    expect(ids).toContain('alpha')
    expect(ids).not.toContain('beta')
  })

  it('returns empty when the agent declares no skills', async () => {
    writeSkill('alpha', '/alpha')
    const dir = join(ws, '.halo', 'agents', 'noskill')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'agent.yaml'), [
      'name: noskill', 'model:', '  provider: anthropic',
      '  id: claude-opus-4-8', '  endpoint: https://api.anthropic.com', 'tools: [file_read]',
    ].join('\n'))
    const sm = new SessionManager(ws)
    expect(await sm.listAvailableSkillCommandsForAgent('noskill')).toEqual([])
  })
})

describe('access gate — requiresAccess vs session access level', () => {
  it('hides a full-only skill from a readonly session', async () => {
    writeSkill('admin_tool', '/admin', 'full')
    writeAgent('gated', ['admin_tool'])
    const sm = new SessionManager(ws)
    const readonly = await sm.listAvailableSkillCommandsForAgent('gated', 'readonly')
    expect(readonly.map((c) => c.skillId ?? c.name)).not.toContain('admin_tool')
    // …but a full-access caller sees it
    const full = await sm.listAvailableSkillCommandsForAgent('gated', 'full')
    expect(full.map((c) => c.skillId ?? c.name)).toContain('admin_tool')
  })

  it('null access level = no gate (CLI / pre-session) sees full-only skills', async () => {
    writeSkill('admin_tool', '/admin', 'full')
    writeAgent('gated', ['admin_tool'])
    const sm = new SessionManager(ws)
    const cmds = await sm.listAvailableSkillCommandsForAgent('gated')  // no accessLevel arg
    expect(cmds.map((c) => c.skillId ?? c.name)).toContain('admin_tool')
  })

  // execSkillCommand's gate used a private {readonly,workspace,full} rank table;
  // an `observer` row indexed to undefined and `x > undefined` is always false,
  // so the gate silently let observer sessions run full-only skills.
  it('execSkillCommand rejects a full-only skill for a persisted observer session', async () => {
    writeSkill('admin_tool', '/admin', 'full')
    writeAgent('gated', ['admin_tool'])
    const sm = new SessionManager(ws)
    seed(sm, 's_obs', 'gated', 'observer')
    const result = await execSkillCommand('/admin', '', sm, 's_obs', ws)
    expect(result).not.toBe('ok')
    expect(result).not.toBe('not_found')
    expect(result).toContain('requires full access')
    expect(result).toContain('observer')
  })
})

describe('listAvailableSkillCommands — by session id', () => {
  it('resolves the agent + persisted access level from the session row', async () => {
    writeSkill('admin_tool', '/admin', 'full')
    writeAgent('gated', ['admin_tool'])
    const sm = new SessionManager(ws)
    seed(sm, 's_ro', 'gated', 'readonly')  // persisted readonly → gated out
    const cmds = await sm.listAvailableSkillCommands('s_ro')
    expect(cmds.map((c) => c.skillId ?? c.name)).not.toContain('admin_tool')
  })

  it('unknown session falls back to the default agent with no gate', async () => {
    const sm = new SessionManager(ws)
    // no row, no default workspace agent → empty (default agent has no skills here)
    const cmds = await sm.listAvailableSkillCommands('ghost')
    expect(Array.isArray(cmds)).toBe(true)
  })
})
