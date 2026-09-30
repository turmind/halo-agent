import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandContext } from '../src/channels/shared/commands.js'

let home: string
let workspace: string
let sm: import('../src/agents/session-manager.js').SessionManager
let SessionManager: typeof import('../src/agents/session-manager.js')['SessionManager']
let agentSessions: typeof import('../src/db/schema.js')['agentSessions']
let commands: typeof import('../src/channels/shared/commands.js')
let registry: typeof import('../src/commands/index.js')
let goals: typeof import('../src/agents/goal-mode.js')
let agentApp: ReturnType<typeof import('../src/routes/agent-configs.js')['createAgentConfigRoutes']>

function writeAgent(id: string, internal = false, skills: string[] = []): void {
  const dir = join(workspace, '.halo', 'agents', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(join(dir, 'agent.yaml'), [
    `name: ${id}`, `internal: ${internal}`,
    'model:', '  provider: anthropic', '  id: claude-opus-4-8', '  endpoint: https://api.anthropic.com',
    'tools: [file_read]', `skills: [${skills.join(', ')}]`,
  ].join('\n'))
}

function seedSession(id: string, agentId = 'default'): void {
  sm.getDb().insert(agentSessions).values({
    id, agentId, agentName: agentId, parentId: null, description: 'kept history',
    createdAt: 1000, updatedAt: 1000,
  }).run()
}

function ctx(accessLevel: CommandContext['accessLevel'] = 'full'): CommandContext {
  return {
    sm, userId: 'user', sessionPrefix: 'web_', accessLevel, channelLabel: 'test',
    activeOverrides: new Map(), workspacePath: workspace, lang: 'en',
  }
}

function post(url: string, body: Record<string, unknown>) {
  return agentApp.request(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

beforeAll(async () => {
  home = fs.mkdtempSync(join(tmpdir(), 'halo-goal-off-home-'))
  vi.stubEnv('HOME', home)
  fs.mkdirSync(join(home, '.halo', 'global'), { recursive: true })
  fs.writeFileSync(join(home, '.halo', 'global', 'aliases.yaml'), 'top:\n  /g: /goal\n  /gc: /goal create\nverb:\n  c: create\n')
  ;({ SessionManager } = await import('../src/agents/session-manager.js'))
  ;({ agentSessions } = await import('../src/db/schema.js'))
  commands = await import('../src/channels/shared/commands.js')
  registry = await import('../src/commands/index.js')
  goals = await import('../src/agents/goal-mode.js')
  agentApp = (await import('../src/routes/agent-configs.js')).createAgentConfigRoutes()
  expect((await import('../src/config.js')).config.goalModeEnabled).toBe(false)
})

beforeEach(() => {
  workspace = fs.mkdtempSync(join(tmpdir(), 'halo-goal-off-ws-'))
  sm = new SessionManager(workspace)
  writeAgent('default')
})

afterEach(() => {
  // Flush context-event persistence before removing this test's workspace.
  for (const row of sm.getDb().select().from(agentSessions).all()) sm.emitEvent(row.id, { type: 'complete' })
  vi.restoreAllMocks()
  fs.rmSync(workspace, { recursive: true, force: true })
})

afterAll(() => {
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('goal entry points default off', () => {
  it.each(['ws', 'web', 'telegram', 'wechat', 'slack', 'feishu', 'wecom', 'cli', 'tui'])('%s dispatch rejects bare/help/every verb without session or filesystem writes', async (channelName) => {
    const before = sm.getDb().select().from(agentSessions).all()
    const create = vi.spyOn(sm, 'createSession')
    const send = vi.spyOn(sm, 'sendUserMessage')
    for (const accessLevel of ['full', 'workspace', 'readonly'] as const) {
      for (const arg of ['', 'help', 'create test', 'status', 'pause', 'resume', 'clear', 'unknown']) {
        expect(await commands.dispatchCommand(ctx(accessLevel), '/goal', arg, { channelName }))
          .toEqual({ text: 'Goal mode is disabled.' })
      }
    }
    expect(create).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(sm.getDb().select().from(agentSessions).all()).toEqual(before)
    expect(fs.existsSync(join(workspace, '.halo', 'goal'))).toBe(false)
    expect(fs.existsSync(join(workspace, '.halo', 'sessions', 'goal'))).toBe(false)
  })

  it('aliases and Chinese replies reach the same disabled branch', async () => {
    for (const [command, arg] of [['/g', 'c test'], ['/gc', 'test']]) {
      expect(await commands.dispatchCommand(ctx(), command, arg)).toEqual({ text: 'Goal mode is disabled.' })
    }
    const response = await commands.dispatchCommand({ ...ctx(), lang: 'zh' }, '/goal', 'create')
    expect(response?.text).toBe('Goal 模式已下线。')
  })

  it('help and all REST discovery paths hide goal, including a colliding skill', async () => {
    writeAgent('default', false, ['old-goal-skill'])
    const dir = join(workspace, '.halo', 'skills', 'old-goal-skill')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(join(dir, 'SKILL.md'), '---\nname: old-goal-skill\ndescription: Old command\ncommand: /goal\n---\nOld body')
    seedSession('web_seed')
    expect((await commands.dispatchCommand(ctx(), '/help', ''))?.text).not.toContain('/goal')
    expect(registry.builtinCommandNames()).not.toContain('goal')
    const { createCommandRoutes } = await import('../src/routes/commands.js')
    const app = createCommandRoutes(registry.commandRegistry, { getOrCreate: () => sm } as never)
    for (const query of ['', `?projectId=${encodeURIComponent(workspace)}&agentId=default`, `?projectId=${encodeURIComponent(workspace)}&sessionId=web_seed`]) {
      const body = await (await app.request(`/commands${query}`)).json()
      expect(body.commands.some((d: { slashName: string }) => d.slashName === '/goal')).toBe(false)
      expect(body.commands.some((d: { slashName: string }) => d.slashName === '/session')).toBe(true)
    }
  })

  it('passes the exact server startup dispatch check with hidden goal still registered', () => {
    expect(registry.commandRegistry.listDescriptors().some((d) => d.name === 'goal')).toBe(false)
    expect(registry.commandRegistry.listDescriptors({ includeHidden: true }).some((d) => d.name === 'goal')).toBe(true)
    expect(() => registry.commandRegistry.assertDispatchCommands(commands.DISPATCH_COMMANDS)).not.toThrow()
    // The startup guard still catches real drift in either direction.
    expect(() => registry.commandRegistry.assertDispatchCommands(commands.DISPATCH_COMMANDS.filter((c) => c !== '/goal')))
      .toThrow('Command descriptors without a dispatch case: /goal')
    expect(() => registry.commandRegistry.assertDispatchCommands([...commands.DISPATCH_COMMANDS, '/missing']))
      .toThrow('Dispatch cases without a descriptor: /missing')
  })

  it('the shared creator refuses root and delegated goal sessions before agent build or writes; normal creation works', async () => {
    // No goal yaml exists: the disabled error must win before agent loading.
    for (const parentId of [null, 'parent']) {
      await expect(sm.createSession('goal', parentId, 'test', undefined, 'goal_new', undefined, null, 'Goal'))
        .rejects.toThrow('Goal mode is disabled.')
    }
    expect(sm.getDb().select().from(agentSessions).all()).toEqual([])
    expect(fs.existsSync(join(workspace, '.halo', 'sessions', 'goal'))).toBe(false)
    const id = await sm.createSession('default', null, 'normal')
    expect(sm.getSessionById(id)?.agentId).toBe('default')
  })

  it('start_session still rejects the internal goal agent and cannot create a non-internal goal override either', async () => {
    const start = sm.createSessionTools('parent').find((tool) => tool.name === 'start_session')!
    writeAgent('goal', true)
    const denied = JSON.parse(await start.callback({ agent_id: 'goal', message: 'test' }) as string)
    expect(denied.code).toBe(1)
    writeAgent('goal', false)
    await expect(start.callback({ agent_id: 'goal', message: 'test' })).rejects.toThrow('Goal mode is disabled.')
    expect(sm.getDb().select().from(agentSessions).all()).toEqual([])
  })

  it('agent scaffolding rejects normalized goal ids globally and per workspace, leaving normal agents alone', async () => {
    for (const scope of ['global', 'workspace']) {
      const response = await post('/agent-configs', { name: ' Goal ', scope, projectId: workspace })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'Goal mode is disabled.' })
    }
    expect(fs.existsSync(join(home, '.halo', 'global', 'agents', 'goal'))).toBe(false)
    expect(fs.existsSync(join(workspace, '.halo', 'agents', 'goal'))).toBe(false)
    expect((await post('/agent-configs', { name: 'Helper', scope: 'workspace', projectId: workspace })).status).toBe(201)
  })

  it('legacy save blocks only new goal files; existing transcripts remain readable and writable', async () => {
    const dir = join(workspace, '.halo', 'sessions', 'goal')
    expect((await post('/agent-configs/goal/sessions', { id: 'new', projectId: workspace })).status).toBe(403)
    expect(fs.existsSync(dir)).toBe(false)
    fs.mkdirSync(dir, { recursive: true })
    const history = { id: 'old', agentId: 'goal', title: '🎯 Goal', messages: [{ content: 'kept' }] }
    fs.writeFileSync(join(dir, 'old.json'), JSON.stringify(history))
    const query = `?projectId=${encodeURIComponent(workspace)}`
    const read = await agentApp.request(`/agent-configs/goal/sessions/old${query}`)
    expect(await read.json()).toEqual({ session: history })
    const list = await agentApp.request(`/agent-configs/goal/sessions${query}`)
    expect((await list.json()).sessions[0].title).toBe('🎯 Goal')
    expect((await post('/agent-configs/goal/sessions', { ...history, projectId: workspace })).status).toBe(200)
    expect(JSON.parse(fs.readFileSync(join(dir, 'old.json'), 'utf8')).messages).toEqual(history.messages)
    expect((await post('/agent-configs/default/sessions', { id: 'normal', projectId: workspace })).status).toBe(200)
  })
})

describe('disabled entry points do not disable stored goal mechanisms', () => {
  beforeEach(() => {
    writeAgent('goal', true)
    seedSession('worker')
    seedSession('goal_old', 'goal')
    goals.writeGoalState(sm.getDb(), 'goal_old', goals.initialGoalState('goal_old', 'worker'))
    goals.setWorkerBackptr(sm.getDb(), 'worker', 'goal_old')
  })

  it('restores an existing goal agent and keeps its tools, transcript and read-only seed endpoint', async () => {
    sm.appendUserMessage('goal_old', 'retained goal history')
    sm.emitEvent('goal_old', { type: 'complete' })
    const restored = new SessionManager(workspace)
    const context = await restored.getSessionContext('goal_old')
    expect(context?.meta.toolNames).toEqual(expect.arrayContaining(['goal_context', 'goal_attach', 'goal_finish']))
    expect((await restored.getSessionView('goal_old'))?.messages.some((m) => m.content === 'retained goal history')).toBe(true)
    restored.emitEvent('goal_old', { type: 'complete' })
    const { createSessionRoutes } = await import('../src/routes/sessions.js')
    const response = await createSessionRoutes().request(`/sessions/goal?projectId=${encodeURIComponent(workspace)}`)
    expect((await response.json()).goal).toMatchObject({ goalSessionId: 'goal_old', status: 'intake' })
  })

  it('keeps attach, routing, round reports, restart sweep and finish working', async () => {
    fs.mkdirSync(goals.goalDir(workspace, 'goal_old'), { recursive: true })
    fs.writeFileSync(goals.goalSpecPath(workspace, 'goal_old'), '# Goal\nShip the tests.\n')
    const host = {
      workspaceRoot: workspace, getDb: () => sm.getDb(),
      querySession: vi.fn(async () => 'ok'), getSessionOutput: () => 'worker output',
      sendUserMessage: vi.fn(async () => 'queued' as const), appendUserMessage: vi.fn(),
    }
    const tools = goals.buildGoalTools(host, 'goal_old')
    const attach = tools.find((tool) => tool.name === 'goal_attach')!
    expect(JSON.parse(await attach.callback({ kickoff: 'run tests' }) as string).code).toBe(0)
    expect(goals.resolveGoalRoute(sm.getDb(), 'worker')).toBe('goal_old')
    await goals.deliverGoalRound(host, {
      id: 'worker', parentId: null, messageQueue: [], finalOutput: 'tests passed', output: '', turnError: null,
    })
    expect(goals.readGoalState(sm.getDb(), 'goal_old')?.round).toBe(1)
    expect(host.querySession).toHaveBeenLastCalledWith('goal_old', 'worker', expect.stringContaining('tests passed'))
    goals.sweepActiveGoals(host)
    expect(host.appendUserMessage).toHaveBeenCalledWith('goal_old', expect.stringContaining('server restarted'))
    expect(host.sendUserMessage).toHaveBeenCalledOnce()
    const finish = tools.find((tool) => tool.name === 'goal_finish')!
    expect(JSON.parse(await finish.callback({ summary: 'accepted' }) as string).code).toBe(0)
    expect(goals.readGoalState(sm.getDb(), 'goal_old')?.status).toBe('done')
    expect(goals.resolveGoalRoute(sm.getDb(), 'worker')).toBe('worker')
  })
})
