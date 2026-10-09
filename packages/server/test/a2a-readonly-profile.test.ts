import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { isA2AReadOnlySession } from '../src/agents/session-agent-builder.js'
import { agentSessions } from '../src/db/schema.js'
import { createWorkspaceTools, READ_ONLY_TOOL_NAMES } from '../src/tools/workspace-tools.js'
import { initBwrapCheck, getSandboxBackend, setSandboxHiddenPaths, DEFAULT_HIDDEN_DIRS, DEFAULT_HIDDEN_FILES } from '../src/tools/sandbox.js'
import { sessionAccess } from '../src/channels/shared/accounts.js'
import { modelSupportsImage } from '../src/config.js'

/**
 * A2A read-only profile (plans/a2a.md §4 "Read-only tokens"): an inbound A2A
 * session (`a2a_` id) whose stored access level is `readonly` (readonly AND
 * observer tokens, via sessionAccess) gets the side-effect-free workspace
 * tools + continue_task (+ activate_skill when it has skills) — no write /
 * shell / fetch, no delegation tools and no roster — even when an OS sandbox
 * exists. Everything else keeps today's set. Drives the real builder via
 * getSessionContext (→ ensureSession restore path → buildAgentInstance).
 */

let ws: string

const ANTHROPIC_MODEL = ['model:', '  provider: anthropic', '  id: claude-opus-4-8', '  endpoint: https://api.anthropic.com']
const ALL_WS = ['file_read', 'view_image', 'file_write', 'file_edit', 'file_list', 'shell_exec', 'grep', 'glob', 'web_fetch']
// view_image is offered only when the model is vision-capable — derive, don't assume.
const VISION = modelSupportsImage('claude-opus-4-8')
const ALL_WS_FOR_MODEL = VISION ? ALL_WS : ALL_WS.filter((n) => n !== 'view_image')
const SESSION_TOOLS = ['start_session', 'session_list', 'query_session', 'interrupt_session', 'stop_session', 'archive_session', 'get_session_output', 'query_agent']

function writeAgent(agentId: string, yamlLines: string[], agentMd = 'x'): void {
  const dir = join(ws, '.halo', 'agents', agentId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.yaml'), yamlLines.join('\n'))
  writeFileSync(join(dir, 'AGENT.md'), agentMd)
}

function seed(sm: SessionManager, id: string, agentId: string, accessLevel: 'readonly' | 'workspace' | null): void {
  sm.getDb().insert(agentSessions).values({
    id, parentId: null, agentId, agentName: agentId, description: '', workingDir: null, accessLevel,
    createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
  }).run()
}

async function toolsOf(sm: SessionManager, id: string): Promise<string[]> {
  const ctx = await sm.getSessionContext(id)
  expect(ctx).not.toBeNull()
  return ctx!.meta.toolNames
}

beforeAll(async () => {
  // Real probe: on this Linux host bwrap works, so readonly NON-A2A sessions
  // get the full tool set (bwrap contains shell_exec) — the case the A2A
  // profile must still narrow.
  await initBwrapCheck()
})

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'halo-a2a-ro-')))
  writeAgent('mate', ['name: Mate', ...ANTHROPIC_MODEL, 'tools: [file_read]'])
  writeAgent('boss', ['name: Boss', ...ANTHROPIC_MODEL, `tools: [${ALL_WS.join(', ')}, relay_send, a2a_send]`, 'team: [mate]'], 'I delegate.')
})
afterEach(() => rmSync(ws, { recursive: true, force: true }))

describe('isA2AReadOnlySession — derived from persistent id + access level', () => {
  it('true only for an a2a_ session at readonly (readonly + observer tokens)', () => {
    expect(sessionAccess('readonly')).toBe('readonly')
    expect(sessionAccess('observer')).toBe('readonly')
    expect(isA2AReadOnlySession('a2a_acc_x1', sessionAccess('readonly'))).toBe(true)
    expect(isA2AReadOnlySession('a2a_acc_x1', sessionAccess('observer'))).toBe(true)
    expect(isA2AReadOnlySession('a2a_acc_x1', 'workspace')).toBe(false)
    expect(isA2AReadOnlySession('a2a_acc_x1', null)).toBe(false)
    for (const id of ['tg_1_x', 'wx_1_x', 'web_1_x', 'slack_c_x', 'feishu_c_x', 'wecom_1_x', 'sid_x', 'a2ax_1']) {
      expect(isA2AReadOnlySession(id, 'readonly')).toBe(false)
    }
  })

  it('READ_ONLY_TOOL_NAMES is exactly the no-sandbox readonly set createWorkspaceTools returns', () => {
    expect([...READ_ONLY_TOOL_NAMES].sort()).toEqual(['file_list', 'file_read', 'glob', 'grep', 'view_image'])
    const ro = createWorkspaceTools(ws, { accessLevel: 'readonly', supportsVision: true }).map((t) => t.name)
    if (getSandboxBackend() === null) expect(ro.sort()).toEqual([...READ_ONLY_TOOL_NAMES].sort())
  })
})

describe('A2A read-only session: tools + prompt', () => {
  it('readonly a2a_ session: read tools + continue_task only; no write/shell/fetch, no delegation, no roster, no relay/a2a', async () => {
    const sm = new SessionManager(ws)
    seed(sm, 'a2a_acc_ro1', 'boss', 'readonly')
    const names = await toolsOf(sm, 'a2a_acc_ro1')
    const expected = ['continue_task', 'file_list', 'file_read', 'glob', 'grep', ...(VISION ? ['view_image'] : [])]
    expect(names.sort()).toEqual(expected.sort())
    const prompt = sm.getSessionSystemPrompt('a2a_acc_ro1') ?? ''
    expect(prompt).not.toContain('## Your Team')
    expect(prompt).not.toContain('Mate')
    expect(prompt).toContain(`Your available tools: file_read, ${VISION ? 'view_image, ' : ''}file_list, grep, glob, continue_task.`)
  })

  it('activate_skill survives (skills are read-only instructions)', async () => {
    const skillDir = join(ws, '.halo', 'skills', 'notes')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: Notes\ndescription: how to take notes\n---\nbody')
    writeAgent('skilled', ['name: Skilled', ...ANTHROPIC_MODEL, 'tools: [file_read, shell_exec]', 'skills: [notes]'])
    const sm = new SessionManager(ws)
    seed(sm, 'a2a_acc_ro2', 'skilled', 'readonly')
    const names = await toolsOf(sm, 'a2a_acc_ro2')
    expect(names).toContain('file_read')
    expect(names).not.toContain('shell_exec')
    // activate_skill rides in the runtime tool list, not meta.toolNames — check the agent itself
    const session = (sm as unknown as { sessions: Map<string, { agent: { tools?: Array<{ name: string }>; config?: { tools: Array<{ name: string }> } } }> }).sessions.get('a2a_acc_ro2')!
    const runtimeTools = (session.agent.config?.tools ?? session.agent.tools ?? []).map((t) => t.name)
    expect(runtimeTools).toContain('activate_skill')
    expect(runtimeTools).not.toContain('shell_exec')
  })

  it('holds across a fresh manager (restart → restore from the db row)', async () => {
    const sm = new SessionManager(ws)
    seed(sm, 'a2a_acc_ro3', 'boss', 'readonly')
    expect(await toolsOf(sm, 'a2a_acc_ro3')).not.toContain('shell_exec')
    // A restart = a new manager restoring from the db row.
    const sm2 = new SessionManager(ws)
    const names = await toolsOf(sm2, 'a2a_acc_ro3')
    expect(names).not.toContain('shell_exec')
    expect(names).not.toContain('start_session')
  })
})

describe('unchanged: full / workspace A2A and every non-A2A readonly session', () => {
  it('full a2a_ session keeps everything incl. delegation + roster + relay/a2a opt-ins', async () => {
    const sm = new SessionManager(ws)
    seed(sm, 'a2a_acc_full', 'boss', null)
    const names = await toolsOf(sm, 'a2a_acc_full')
    for (const n of [...ALL_WS_FOR_MODEL, ...SESSION_TOOLS, 'relay_send', 'a2a_send', 'a2a_stop', 'a2a_read', 'a2a_list']) expect(names).toContain(n)
    expect(sm.getSessionSystemPrompt('a2a_acc_full') ?? '').toContain('## Your Team')
  })

  it('workspace a2a_ session keeps the workspace set + delegation + the a2a opt-in (relay stays full-only)', async () => {
    const sm = new SessionManager(ws)
    seed(sm, 'a2a_acc_ws', 'boss', 'workspace')
    const names = await toolsOf(sm, 'a2a_acc_ws')
    for (const n of [...ALL_WS_FOR_MODEL, ...SESSION_TOOLS, 'a2a_send', 'a2a_stop', 'a2a_read', 'a2a_list']) expect(names).toContain(n)
    expect(names).not.toContain('relay_send')
    expect(sm.getSessionSystemPrompt('a2a_acc_ws') ?? '').toContain('## Your Team')
  })

  it('readonly sessions of every other channel: sandbox-dependent set + delegation + roster + the a2a opt-in (no relay)', async () => {
    const sm = new SessionManager(ws)
    const expectedWs = createWorkspaceTools(ws, { accessLevel: 'readonly', supportsVision: VISION }).map((t) => t.name)
    for (const id of ['tg_1_ro', 'wx_1_ro', 'web_acc_ro', 'slack_c_ro', 'feishu_c_ro', 'wecom_1_ro', 'sid_ro']) {
      seed(sm, id, 'boss', 'readonly')
      const names = await toolsOf(sm, id)
      for (const n of expectedWs) expect(names, id).toContain(n)
      for (const n of [...SESSION_TOOLS, 'a2a_send', 'a2a_stop', 'a2a_read', 'a2a_list']) expect(names, id).toContain(n)
      expect(names, id).not.toContain('relay_send')
      expect(sm.getSessionSystemPrompt(id) ?? '', id).toContain('## Your Team')
    }
  })
})

// Workspace + hidden dir live under /var/tmp, not /tmp: bwrap mounts a fresh
// tmpfs over /tmp (and the scratch HOME from setup-home.ts sits there too), so
// a /tmp layout would make everything vanish inside the sandbox and prove nothing.
describe.skipIf(process.platform === 'win32')('hidden-path masking in the A2A read-only profile', () => {
  it('file_read / grep / glob / file_list refuse a hidden dir; workspace files stay readable', async () => {
    const root = realpathSync(mkdtempSync('/var/tmp/halo-a2a-ro-'))
    const roWs = join(root, 'ws')
    const secrets = join(root, 'secrets')
    mkdirSync(roWs, { recursive: true })
    mkdirSync(secrets, { recursive: true })
    writeFileSync(join(secrets, 'settings.yaml'), 'a2a:\n  secrets:\n    probe: s3cr3t-value\n')
    writeFileSync(join(roWs, 'INDEX.md'), 'hello index')
    setSandboxHiddenPaths([...DEFAULT_HIDDEN_DIRS, secrets], DEFAULT_HIDDEN_FILES)
    try {
      const tools = createWorkspaceTools(roWs, { accessLevel: 'readonly', supportsVision: false }).filter((t) => READ_ONLY_TOOL_NAMES.has(t.name))
      // A thrown error is a refusal too — the agent loop turns it into a tool error result.
      const call = async (name: string, input: unknown): Promise<string> => {
        try { return String(await (tools.find((t) => t.name === name)!.callback as (i: unknown) => Promise<unknown>)(input)) }
        catch (e) { return `ERROR: ${(e as Error).message}` }
      }
      // bwrap: tmpfs-masked → not found; no OS sandbox: assertPathAllowed → Access denied
      const read = await call('file_read', { path: join(secrets, 'settings.yaml') })
      expect(read).not.toContain('s3cr3t-value')
      expect(read).toMatch(/Access denied|No such file/)
      expect(await call('grep', { pattern: 's3cr3t', path: secrets })).not.toContain('s3cr3t-value')
      expect(await call('glob', { pattern: '**/*.yaml', path: secrets })).not.toContain('settings.yaml')
      expect(await call('file_list', { path: secrets })).not.toContain('settings.yaml')
      expect(await call('file_read', { path: join(roWs, 'INDEX.md') })).toContain('hello index')
      expect(await call('file_list', { path: roWs })).toContain('INDEX.md')
    } finally {
      setSandboxHiddenPaths(DEFAULT_HIDDEN_DIRS, DEFAULT_HIDDEN_FILES)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
