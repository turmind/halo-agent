import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXTENSION_BACKENDS_ENV, EXTENSION_NODE_ENV } from '@turmind/halo-core/protocol'
import { createWorkspaceTools } from '../src/tools/workspace-tools.js'
import { cleanChildEnv } from '../src/child-env.js'
import { sandboxExec } from '../src/tools/sandbox.js'
import { extensionSessionAccess } from '../src/extensions/session-access.js'

const key = 'manufactured-256-bit-access-key-not-a-real-key'
const context = { env: { [EXTENSION_BACKENDS_ENV]: JSON.stringify({ browser: { url: 'http://127.0.0.1:1', accessKey: key } }), [EXTENSION_NODE_ENV]: process.execPath }, secrets: [key] }
const run = (command: string, shellContext = vi.fn(async () => context)) => {
  const tool = createWorkspaceTools(process.cwd(), { shellContext }).find((t) => t.name === 'shell_exec')!
  return tool.callback({ command })
}
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })
describe('lazy shell extension context and hygiene', () => {
  it('schema-only workspace/node callers issue nothing', () => {
    const supplier = vi.fn(async () => context)
    const issue = vi.spyOn(extensionSessionAccess, 'shellContext')
    createWorkspaceTools('/tmp', { shellContext: supplier }).map((t) => t.inputSchema)
    createWorkspaceTools('/tmp').map((t) => t.inputSchema)
    expect(supplier).not.toHaveBeenCalled(); expect(issue).not.toHaveBeenCalled()
  })
  it('cleans inherited extension env from ordinary children', async () => {
    vi.stubEnv(EXTENSION_BACKENDS_ENV, key); vi.stubEnv(EXTENSION_NODE_ENV, '/not/node')
    expect(cleanChildEnv()[EXTENSION_BACKENDS_ENV]).toBeUndefined()
    expect(cleanChildEnv()[EXTENSION_NODE_ENV]).toBeUndefined()
    const output = await sandboxExec('env', { workspaceRoot: process.cwd(), accessLevel: 'full' })
    expect(output.stdout).not.toContain(key)
  })
  it('injects only at invocation and masks raw env stdout/stderr', async () => {
    const supplier = vi.fn(async () => context)
    const output = await run('env; env >&2', supplier)
    expect(supplier).toHaveBeenCalledTimes(1)
    expect(output).toContain(EXTENSION_BACKENDS_ENV)
    expect(output).toContain(process.execPath)
    expect(output).not.toContain(key)
    expect(output).toContain('***')
  })
  it('masks failed-command errors/output, including a failed HTTP request', async () => {
    const command = '"$HALO_EXT_NODE" -e \'const x=JSON.parse(process.env.HALO_EXT_BACKENDS).browser; console.error(x.accessKey); fetch(x.url,{headers:{Authorization:"Bearer "+x.accessKey}}).catch(()=>{throw Error(x.accessKey)})\''
    const output = await run(command)
    expect(output).toContain('Command failed')
    expect(output).not.toContain(key)
    expect(output).toContain('***')
    expect(command).not.toContain(key)
  })
  it('non-full shells drop extension env even if a supplier provides it', async () => {
    const supplier = vi.fn(async () => context)
    for (const accessLevel of ['readonly', 'workspace'] as const) {
      const tool = createWorkspaceTools(process.cwd(), { accessLevel, shellContext: supplier }).find((t) => t.name === 'shell_exec')
      const output = await tool?.callback({ command: 'env' })
      expect(output ?? '').not.toContain(EXTENSION_BACKENDS_ENV)
      expect(output ?? '').not.toContain(EXTENSION_NODE_ENV)
    }
  })
})
