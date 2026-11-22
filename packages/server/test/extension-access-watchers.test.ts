import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { EXTENSION_BACKENDS_ENV, type ExtensionBackendAccessMap } from '@turmind/halo-core/protocol'
import { ExtensionAccessWatchers } from '../src/extensions/session-access-watchers.js'

let home: string
let workspace: string
let broker: import('../src/extensions/session-access.js').ExtensionSessionAccess
let db: import('../src/db/index.js').HaloDb
let schema: typeof import('../src/db/schema.js')
let state: typeof import('../src/extensions/state.js')
const previousHome = process.env.HOME
const write = (file: string, content: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }
const skillBody = '---\nname: browser\ndescription: fixture\n---\nfixture'
let extDir: string
let agentFile: string
const agentYaml = 'name: default\ntools: [shell_exec]\nskills: [browser]\n'
beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-access-watch-')); process.env.HOME = home
  workspace = path.join(home, 'workspace'); fs.mkdirSync(workspace)
  const dbModule = await import('../src/db/index.js')
  db = dbModule.openHaloDb(path.join(workspace, '.halo'))
  schema = await import('../src/db/schema.js')
  state = await import('../src/extensions/state.js')
  extDir = path.join(home, '.halo/global/extensions/browser')
  write(path.join(extDir, 'index.html'), '')
  write(path.join(extDir, 'backend.mjs'), '')
  write(path.join(extDir, 'halo-extension.json'), JSON.stringify({ id: 'browser', name: 'Browser', version: '1.0.0', entry: 'index.html', extensions: ['.test'], backend: { entry: 'backend.mjs' } }))
  agentFile = path.join(workspace, '.halo/agents/default/agent.yaml')
  db.insert(schema.agentSessions).values({ id: 'root', agentId: 'default', accessLevel: null, createdAt: 1, updatedAt: 1 }).run()
  db.insert(schema.agentSessions).values({ id: 'root>child', parentId: 'root', agentId: 'default', accessLevel: null, createdAt: 1, updatedAt: 1 }).run()
})
beforeEach(async () => {
  fs.rmSync(path.join(workspace, '.halo/skills'), { recursive: true, force: true })
  fs.rmSync(path.join(home, '.halo/global/skills'), { recursive: true, force: true })
  write(agentFile, agentYaml)
  write(path.join(extDir, 'skills/browser/SKILL.md'), skillBody)
  state.setExtensionDisabled('browser', false); state.confirmExtensionBackend('browser')
  db.update(schema.agentSessions).set({ accessLevel: null }).run()
  db.delete(schema.disabledItems).run()
  broker = new (await import('../src/extensions/session-access.js')).ExtensionSessionAccess()
  broker.start({ baseUrl: 'http://127.0.0.1:19483' })
})
afterEach(() => broker.close())
afterAll(() => { process.env.HOME = previousHome; fs.rmSync(home, { recursive: true, force: true }) })
async function issue() {
  const ctx = await broker.shellContext(workspace, 'root>child')
  return ctx.env[EXTENSION_BACKENDS_ENV] ? (JSON.parse(ctx.env[EXTENSION_BACKENDS_ENV]) as ExtensionBackendAccessMap).browser : undefined
}

describe('effective provenance and external invalidation', () => {
  it('loads the persisted child identity and the real effective model-enabled extension skill', async () => {
    const entry = (await issue())!
    expect(broker.bindSession('browser', 'g', `Bearer ${entry.accessKey}`).caller).toMatchObject({ projectId: workspace, sessionId: 'root>child', rootSessionId: 'root', agentId: 'default' })
    expect(await broker.shellContext(workspace, 'missing')).toEqual({ env: {}, secrets: [] })
  })
  it.each(['workspace', 'global'])('%s source override never inherits credentials', async (scope) => {
    const root = scope === 'workspace' ? path.join(workspace, '.halo') : path.join(home, '.halo/global')
    write(path.join(root, 'skills/browser/SKILL.md'), skillBody)
    expect(await issue()).toBeUndefined()
  })
  it('a shipped skill symlink outside the extension has no provenance grant', async () => {
    const file = path.join(extDir, 'skills/browser/SKILL.md')
    write(path.join(home, 'external-skill.md'), skillBody)
    fs.unlinkSync(file); fs.symlinkSync(path.join(home, 'external-skill.md'), file)
    expect(await issue()).toBeUndefined()
    fs.unlinkSync(file); write(file, skillBody)
  })
  it.each(['readonly', 'workspace'])('persisted %s access has no grant', async (accessLevel) => {
    db.update(schema.agentSessions).set({ accessLevel }).where(eq(schema.agentSessions.id, 'root>child')).run()
    expect(await issue()).toBeUndefined()
  })
  it.each(['tool', 'model-disabled', 'skill-disabled', 'agent-disabled', 'off', 'unconfirmed'])('rejects %s entitlement', async (reason) => {
    if (reason === 'tool') write(agentFile, 'name: default\ntools: [file_read]\nskills: [browser]')
    if (reason === 'model-disabled') write(path.join(extDir, 'skills/browser/SKILL.md'), '---\ndisable-model-invocation: true\n---\nfixture')
    if (reason === 'skill-disabled' || reason === 'agent-disabled') db.insert(schema.disabledItems).values({ itemType: reason === 'skill-disabled' ? 'skill' : 'agent', itemId: reason === 'skill-disabled' ? 'browser' : 'default', scope: 'workspace', disabledAt: 1 }).run()
    if (reason === 'off') state.setExtensionDisabled('browser', true)
    if (reason === 'unconfirmed') state.dropBackendConfirmations(['browser'])
    expect(await issue()).toBeUndefined()
  })
  it.each(['agent', 'workspace-override', 'global-override', 'shipped-skill'])('revokes on external %s edits without Admin watchers', async (what) => {
    const entry = (await issue())!
    if (what === 'agent') write(agentFile, agentYaml.replace('shell_exec', 'file_read'))
    if (what === 'workspace-override') write(path.join(workspace, '.halo/skills/browser/SKILL.md'), skillBody)
    if (what === 'global-override') write(path.join(home, '.halo/global/skills/browser/SKILL.md'), skillBody)
    if (what === 'shipped-skill') write(path.join(extDir, 'skills/browser/SKILL.md'), '---\ndisable-model-invocation: true\n---\nfixture')
    await vi.waitFor(() => expect(() => broker.validate('browser', `Bearer ${entry.accessKey}`)).toThrow(), { timeout: 3000 })
    expect(await issue()).toBeUndefined()
  })
  it('normal auto-report stoppedAt is not an explicit Stop; lifecycle emitters revoke offline rows', async () => {
    const { SessionManager } = await import('../src/agents/session-manager.js')
    const { extensionSessionAccess } = await import('../src/extensions/session-access.js')
    const sm = new SessionManager(workspace, { reconcileOrphansOnBoot: false })
    const revoke = vi.spyOn(extensionSessionAccess, 'revokeSession')
    const entry = (await issue())!
    db.update(schema.agentSessions).set({ stoppedAt: 123 }).run()
    expect((await issue())!.accessKey).toBe(entry.accessKey)
    await sm.stopSession('root')
    expect(revoke).toHaveBeenCalledWith(workspace, 'root>child', 'session-stopped')
    expect(revoke).toHaveBeenCalledWith(workspace, 'root', 'session-stopped')
    await sm.deleteSession('root')
    expect(revoke).toHaveBeenCalledWith(workspace, 'root>child', 'session-deleted')
    expect(revoke).toHaveBeenCalledWith(workspace, 'root', 'session-deleted')
    db.insert(schema.agentSessions).values({ id: 'root', agentId: 'default', accessLevel: null, createdAt: 1, updatedAt: 1 }).run()
    db.insert(schema.agentSessions).values({ id: 'root>child', parentId: 'root', agentId: 'default', accessLevel: null, createdAt: 1, updatedAt: 1 }).run()
    revoke.mockRestore()
    extensionSessionAccess.close()
  })
  it.each(['off', 'unconfirmed', 'update'])('extension %s rescan revokes both bearer and retained routing', async (change) => {
    const { extensionSessionAccess } = await import('../src/extensions/session-access.js')
    extensionSessionAccess.start({ baseUrl: 'http://127.0.0.1:19483' })
    const ctx = await extensionSessionAccess.shellContext(workspace, 'root>child')
    const key = (JSON.parse(ctx.env[EXTENSION_BACKENDS_ENV]) as ExtensionBackendAccessMap).browser.accessKey
    const { caller } = extensionSessionAccess.bindSession('browser', 'g1', `Bearer ${key}`)
    const { scanExtensions } = await import('../src/extensions/registry.js')
    scanExtensions()
    if (change === 'off') state.setExtensionDisabled('browser', true)
    if (change === 'unconfirmed') state.dropBackendConfirmations(['browser'])
    if (change === 'update') {
      const manifest = path.join(extDir, 'halo-extension.json')
      const data = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Record<string, unknown>
      data.version = '1.0.1'; write(manifest, JSON.stringify(data))
    }
    const { rescanAndBroadcast } = await import('../src/extensions/watcher.js')
    rescanAndBroadcast()
    expect(() => extensionSessionAccess.validate('browser', `Bearer ${key}`)).toThrow()
    expect(extensionSessionAccess.getBinding('browser', 'g1', caller.bindingId)).toBeNull()
    extensionSessionAccess.close()
  })
  it('watch re-arming coalesces and ignores unrelated sibling logs/data', async () => {
    const changed = vi.fn()
    const watchers = new ExtensionAccessWatchers(changed)
    const root = path.join(home, 'watch-fixture/skills')
    fs.mkdirSync(root, { recursive: true })
    watchers.watch(root, workspace)
    write(path.join(home, 'watch-fixture/log.txt'), 'unrelated')
    await new Promise((r) => setTimeout(r, 150))
    expect(changed).not.toHaveBeenCalled()
    write(path.join(root, 'SKILL.md'), skillBody)
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(workspace))
    await new Promise((r) => setTimeout(r, 150))
    changed.mockClear()
    fs.renameSync(root, root + '-old')
    fs.mkdirSync(root)
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(workspace))
    await new Promise((r) => setTimeout(r, 150))
    changed.mockClear()
    write(path.join(root, 'SKILL.md'), skillBody)
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(workspace))
    watchers.close()
  })
})
