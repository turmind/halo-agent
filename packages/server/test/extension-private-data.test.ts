import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
let home: string
let workspace: string
let secret: string
let sandbox: typeof import('../src/tools/sandbox.js')
const oldHome = process.env.HOME
beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-private-ext-')); process.env.HOME = home
  workspace = path.join(home, 'workspace'); fs.mkdirSync(workspace)
  secret = path.join(home, '.halo/global/extension-data/other/workspaces/fixture/profile.txt')
  fs.mkdirSync(path.dirname(secret), { recursive: true }); fs.writeFileSync(secret, 'manufactured-private-data')
  fs.symlinkSync(secret, path.join(workspace, 'linked-profile'))
  sandbox = await import('../src/tools/sandbox.js')
})
afterAll(() => { process.env.HOME = oldHome; fs.rmSync(home, { recursive: true, force: true }) })
describe('all extension private data is hidden', () => {
  it('adds the entire directory to both OS policies and in-process path checks', () => {
    const opts = { workspaceRoot: workspace, accessLevel: 'workspace' as const }
    expect(sandbox.DEFAULT_HIDDEN_DIRS).toContain('~/.halo/global/extension-data')
    expect(sandbox.buildBwrapArgs(opts)).toContain(path.join(home, '.halo/global/extension-data'))
    expect(sandbox.buildSeatbeltProfile(opts)).toContain(path.join(home, '.halo/global/extension-data'))
    expect(() => sandbox.assertPathAllowed(secret, opts)).toThrow()
    expect(() => sandbox.assertPathAllowed(path.join(workspace, 'linked-profile'), opts)).toThrow()
    expect(sandbox.assertPathAllowed(secret, { ...opts, accessLevel: 'full' })).toBe(secret)
  })
  it('does not read it through the workspace file helpers', async () => {
    const { createWorkspaceTools } = await import('../src/tools/workspace-tools.js')
    const tool = createWorkspaceTools(workspace, { accessLevel: 'workspace' }).find((t) => t.name === 'file_read')!
    await expect(tool.callback({ path: secret })).rejects.toThrow()
  })
  it('absolute Admin raw/stat/download routes refuse real and symlink paths', async () => {
    const { createFileRoutes } = await import('../src/routes/files.js')
    const app = createFileRoutes()
    for (const file of [secret, path.join(workspace, 'linked-profile')]) {
      for (const endpoint of ['/fs/raw', '/fs/stat', '/files/download']) {
        const res = await app.request(`${endpoint}?path=${encodeURIComponent(file)}&projectId=${encodeURIComponent(workspace)}`)
        expect(res.status, endpoint).toBe(404)
        expect(await res.text()).not.toContain('manufactured-private-data')
      }
    }
  })
})
