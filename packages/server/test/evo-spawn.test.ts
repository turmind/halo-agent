import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { spawnEvoWrapper } from '../src/evolution/spawn.js'
import { evoWrapperLogFile, evoApplyLogFile } from '../src/paths.js'

/**
 * spawnEvoWrapper: the detached wrapper's stderr lands in the run / apply log
 * (so a wrapper that can't even load — the npm-bundle `Cannot find module`
 * case — leaves a trace admin can read), and a non-zero exit logs one
 * `[EvoSpawn]` error. HOME is a scratch dir (test/setup-home.ts).
 */

const exited = (child: ChildProcess) =>
  new Promise<void>((resolve) => child.once('exit', () => resolve()))

afterEach(() => { vi.restoreAllMocks() })

describe('spawnEvoWrapper', () => {
  it('missing wrapper: startup error goes to the run log + [EvoSpawn] error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const missing = path.join(os.tmpdir(), `no-such-evo-wrapper-${process.pid}.js`)
    await exited(spawnEvoWrapper(missing, 'run', 'missing-1'))

    const log = fs.readFileSync(evoWrapperLogFile('missing-1'), 'utf-8')
    expect(log).toContain('Cannot find module')
    const lines = errSpy.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.startsWith('[EvoSpawn] run wrapper pid=') && l.includes('id=missing-1 exited code=1')
      && l.includes(evoWrapperLogFile('missing-1')))).toBe(true)
  })

  it('clean exit: stderr appended to the apply log, no error logged', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-spawn-'))
    const stub = path.join(dir, 'stub.mjs')
    fs.writeFileSync(stub, `process.stderr.write('stub stderr ' + process.argv.slice(2).join(' ') + '\\n')\n`)
    const logPath = evoApplyLogFile('ok-1')
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.writeFileSync(logPath, 'earlier line\n')

    await exited(spawnEvoWrapper(stub, 'apply', 'ok-1'))

    expect(fs.readFileSync(logPath, 'utf-8')).toBe('earlier line\nstub stderr --mode=apply --id=ok-1\n')
    expect(errSpy).not.toHaveBeenCalled()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
