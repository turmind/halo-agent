import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * An unknown command (here the removed `halo node`, with its old flags) is
 * reported as such in every install state — not as "run halo setup" before
 * setup, nor as the harness parser's "Unknown option '--server'" after it.
 * Runs src/index.ts in a child process: main() is the unit under test.
 */

const CLI_ROOT = path.resolve(import.meta.dirname, '..')
let home: string

function runHalo(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', 'src/index.ts', ...args],
      { cwd: CLI_ROOT, timeout: 20_000, env: { ...process.env, HOME: home, USERPROFILE: home } },
      (err, _stdout, stderr) => resolve({ code: err ? Number((err as { code?: unknown }).code ?? 1) : 0, stderr }))
  })
}

beforeAll(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-cli-unknown-')) })
afterAll(() => { fs.rmSync(home, { recursive: true, force: true }) })

describe('unknown command', () => {
  const args = ['node', '--server', 'http://127.0.0.1:9527', '--root', '/tmp']

  it('before setup: Unknown command, exit 1', async () => {
    const r = await runHalo(args)
    expect(r.stderr.split('\n')[0]).toBe('Unknown command: node')
    expect(r.code).toBe(1)
  })

  it('after setup: Unknown command, exit 1', async () => {
    fs.mkdirSync(path.join(home, '.halo', 'global'), { recursive: true })
    fs.writeFileSync(path.join(home, '.halo', 'global', '.template-version'), '1')
    const r = await runHalo(args)
    expect(r.stderr.split('\n')[0]).toBe('Unknown command: node')
    expect(r.code).toBe(1)
  })

  it('--help after an unknown command is still Unknown command', async () => {
    const r = await runHalo(['node', '--help'])
    expect(r.stderr.split('\n')[0]).toBe('Unknown command: node')
    expect(r.code).toBe(1)
  })
})
