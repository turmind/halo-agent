import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

// HOME must change before importing config: the internal switch is a startup
// snapshot, unlike the ordinary mtime-watched settings getters.
let home: string
let workspace: string
let settingsPath: string

function writeSetting(enabled: boolean): void {
  fs.writeFileSync(settingsPath, `general:\n  goal_mode_enabled: ${enabled}\n`)
}

beforeEach(() => {
  vi.resetModules()
  home = fs.mkdtempSync(join(tmpdir(), 'halo-goal-config-'))
  workspace = join(home, 'workspace')
  fs.mkdirSync(join(home, '.halo', 'secrets'), { recursive: true })
  fs.mkdirSync(join(workspace, '.halo'), { recursive: true })
  settingsPath = join(home, '.halo', 'secrets', 'settings.yaml')
  vi.stubEnv('HOME', home)
  vi.stubEnv('HALO_PASSWORD', 'goal-test-password')
  vi.stubEnv('HALO_JWT_SECRET', randomBytes(32).toString('base64'))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('internal goal-mode startup setting', () => {
  it.each([undefined, false, true])('global setting %s resolves to a plain cached boolean', async (enabled) => {
    if (enabled !== undefined) writeSetting(enabled)
    const { config } = await import('../src/config.js')
    expect(config.goalModeEnabled).toBe(enabled === true)
    expect(Object.getOwnPropertyDescriptor(config, 'goalModeEnabled')?.get).toBeUndefined()
  })

  it.each([undefined, false, true])('workspace settings cannot override global %s', async (enabled) => {
    if (enabled !== undefined) writeSetting(enabled)
    fs.writeFileSync(join(workspace, '.halo', 'settings.yaml'), `general:\n  goal_mode_enabled: ${enabled !== true}\n`)
    const { config } = await import('../src/config.js')
    const { loadSettingsSchema } = await import('../src/settings-schema.js')
    expect(config.goalModeEnabled).toBe(enabled === true)
    const general = loadSettingsSchema(workspace).find((s) => s.namespaceId === 'general')!
    expect(general.fields.some((f) => f.key === 'goal_mode_enabled')).toBe(false)
  })

  it('does no per-read stat/read and requires a new module instance to pick up edits', async () => {
    writeSetting(false)
    const { config } = await import('../src/config.js')
    writeSetting(true)
    const stat = vi.spyOn(fs, 'statSync')
    const read = vi.spyOn(fs, 'readFileSync')
    for (let i = 0; i < 1000; i++) expect(config.goalModeEnabled).toBe(false)
    expect(stat).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    vi.restoreAllMocks()
    vi.resetModules()
    expect((await import('../src/config.js')).config.goalModeEnabled).toBe(true)
  })

  it.each([false, true])('auth bootstrap and command discovery agree with enabled=%s', async (enabled) => {
    writeSetting(enabled)
    const { commandRegistry, builtinCommandNames } = await import('../src/commands/index.js')
    expect(builtinCommandNames().includes('goal')).toBe(enabled)
    const { createCommandRoutes } = await import('../src/routes/commands.js')
    const commands = await (await createCommandRoutes(commandRegistry).request('/commands')).json()
    expect(commands.commands.some((c: { slashName: string }) => c.slashName === '/goal')).toBe(enabled)

    const { createAuthRoutes } = await import('../src/middleware/auth.js')
    const app = createAuthRoutes()
    const anonymous = await app.request('/auth/check')
    expect(anonymous.status).toBe(401)
    expect(await anonymous.json()).not.toHaveProperty('goalModeEnabled')
    const login = await app.request('/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'goal-test-password' }),
    })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]
    // The same bootstrap is used immediately after login/reload and when an
    // already-authenticated tab is opened directly.
    for (let i = 0; i < 2; i++) {
      const check = await app.request('/auth/check', { headers: { Cookie: cookie } })
      expect(check.status).toBe(200)
      expect(await check.json()).toMatchObject({ authenticated: true, goalModeEnabled: enabled })
    }
  })

  it('true restores the agent-scaffold and legacy session-save entry points', async () => {
    writeSetting(true)
    const { createAgentConfigRoutes } = await import('../src/routes/agent-configs.js')
    const app = createAgentConfigRoutes()
    const scaffold = await app.request('/agent-configs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Goal', scope: 'workspace', projectId: workspace }),
    })
    expect(scaffold.status).toBe(201)
    const save = await app.request('/agent-configs/goal/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'goal_new', projectId: workspace, messages: [] }),
    })
    expect(save.status).toBe(200)
    expect(fs.existsSync(join(workspace, '.halo', 'sessions', 'goal', 'goal_new.json'))).toBe(true)
  })
})
