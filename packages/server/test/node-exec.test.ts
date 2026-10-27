import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createWorkspaceTools } from '../src/tools/workspace-tools.js'
import { createNodeExecutor, SHELL_DISABLED, type NodeScope } from '../src/nodes/node-exec.js'
import { NODE_RESULT_MAX_CHARS } from '../src/nodes/protocol.js'

/**
 * node-exec — the machine side runs each request through the LOCAL tools, so a
 * node tool's output is byte-for-byte the local tool's (design/node.md
 * "Executor"). Folder mode confines paths and node_run's cwd to the root;
 * whole-machine mode resolves relative paths against the start dir only.
 */

let tmp: string
let root: string
const signal = () => new AbortController().signal

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'halo-node-exec-')))
  root = path.join(tmp, 'root')
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(root, 'hello.txt'), 'hello-from-node\nsecond line\n')
  fs.writeFileSync(path.join(root, 'sub', 'b.ts'), 'export const b = 1\n')
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function folder(allowShell = false): NodeScope { return { root, base: root, allowShell } }

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { process.kill(pid, 0) } catch { return true }
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

describe('node-exec — parity with the local tools', () => {
  it('read / write / edit / list / grep / glob print exactly what the local tool prints', async () => {
    const exec = createNodeExecutor(folder(), () => {})
    const local = new Map(createWorkspaceTools(root, { accessLevel: 'full', allowedNamespaces: new Set(), supportsVision: false }).map((t) => [t.name, t]))
    const same = async (op: Parameters<typeof exec>[0], tool: string, args: Record<string, unknown>) => {
      const viaNode = await exec(op, args, signal())
      const direct = await local.get(tool)!.callback(args)
      expect(viaNode).toBe(direct)
    }
    await same('read', 'file_read', { path: 'hello.txt' })
    await same('read', 'file_read', { path: 'hello.txt', offset: 2, limit: 1 })
    await same('list', 'file_list', { path: '.' })
    await same('list', 'file_list', { recursive: true })
    await same('grep', 'grep', { pattern: 'hello' })
    await same('glob', 'glob', { pattern: '**/*.ts' })
    expect(await exec('write', { path: 'sub/new.txt', content: 'alpha-beta' }, signal())).toBe('File written: sub/new.txt')
    expect(await exec('edit', { path: 'sub/new.txt', old_string: 'alpha', new_string: 'gamma' }, signal())).toBe('File edited: sub/new.txt')
    expect(fs.readFileSync(path.join(root, 'sub', 'new.txt'), 'utf-8')).toBe('gamma-beta')
  })

  it('logs one line per request, and a `refused` line for a path outside the root', async () => {
    const lines: string[] = []
    const exec = createNodeExecutor(folder(), (l) => lines.push(l))
    await exec('read', { path: 'hello.txt' }, signal())
    await expect(exec('write', { path: '../x.txt', content: 'x' }, signal())).rejects.toThrow(`"../x.txt" is outside this machine's shared folder (${root}) — node tools can only reach paths inside it`)
    expect(lines).toEqual(['[Node] read hello.txt', '[Node] refused write ../x.txt: outside root'])
    expect(fs.existsSync(path.join(tmp, 'x.txt'))).toBe(false)
  })

  it('truncates an oversized result with a marker', async () => {
    fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(NODE_RESULT_MAX_CHARS + 500))
    const exec = createNodeExecutor(folder(), () => {})
    const out = await exec('read', { path: 'big.txt' }, signal())
    expect(out.length).toBeLessThan(NODE_RESULT_MAX_CHARS + 200)
    expect(out).toMatch(/\[Content truncated on the machine: \d+ chars total\]$/)
  })
})

describe('node-exec — node_run', () => {
  it('without --allow-shell: refused, and no process was started', async () => {
    const exec = createNodeExecutor(folder(false), () => {})
    await expect(exec('run', { command: `echo $$ > ${path.join(root, 'pidfile')}` }, signal())).rejects.toThrow(SHELL_DISABLED)
    expect(fs.existsSync(path.join(root, 'pidfile'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('with --allow-shell: cwd is the root, or a dir inside it; outside / non-dir cwd refused', async () => {
    const exec = createNodeExecutor(folder(true), () => {})
    expect(await exec('run', { command: 'pwd' }, signal())).toBe(root)
    expect(await exec('run', { command: 'pwd', cwd: 'sub' }, signal())).toBe(path.join(root, 'sub'))
    await expect(exec('run', { command: 'pwd', cwd: '..' }, signal())).rejects.toThrow(/outside this machine's shared folder/)
    await expect(exec('run', { command: 'pwd', cwd: 'hello.txt' }, signal())).rejects.toThrow(/not a directory/)
  })

  it.skipIf(process.platform === 'win32')('an abort kills the command\'s process group', async () => {
    const exec = createNodeExecutor(folder(true), () => {})
    const ctrl = new AbortController()
    const p = exec('run', { command: 'echo $$ > pid; sleep 30; touch marker' }, ctrl.signal)
    const pidFile = path.join(root, 'pid')
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 30))
    const pid = Number(fs.readFileSync(pidFile, 'utf-8').trim())
    ctrl.abort()
    await p.catch(() => {})
    expect(await waitGone(pid, 3000)).toBe(true)
    expect(fs.existsSync(path.join(root, 'marker'))).toBe(false)
  })
})

describe('node-exec — whole-machine mode', () => {
  it('reads and writes absolute paths outside the start dir; relative paths resolve against it', async () => {
    const base = path.join(tmp, 'start')
    fs.mkdirSync(base)
    fs.writeFileSync(path.join(base, 'rel.txt'), 'relative')
    fs.writeFileSync(path.join(tmp, 'outside.txt'), 'outside')
    const exec = createNodeExecutor({ root: null, base, allowShell: false }, () => {})
    expect(await exec('read', { path: path.join(tmp, 'outside.txt') }, signal())).toBe('1\toutside')
    expect(await exec('read', { path: 'rel.txt' }, signal())).toBe('1\trelative')
    expect(await exec('read', { path: '../outside.txt' }, signal())).toBe('1\toutside')
    await exec('write', { path: path.join(tmp, 'w', 'new.txt'), content: 'w' }, signal())
    expect(fs.readFileSync(path.join(tmp, 'w', 'new.txt'), 'utf-8')).toBe('w')
  })

  it.skipIf(process.platform === 'win32')('node_run defaults to the start dir and accepts any cwd', async () => {
    const base = path.join(tmp, 'start')
    fs.mkdirSync(base)
    const exec = createNodeExecutor({ root: null, base, allowShell: true }, () => {})
    expect(await exec('run', { command: 'pwd' }, signal())).toBe(base)
    expect(await exec('run', { command: 'pwd', cwd: '..' }, signal())).toBe(tmp)
  })
})
