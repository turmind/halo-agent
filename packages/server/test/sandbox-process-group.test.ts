import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { sandboxExec } from '../src/tools/sandbox.js'

/**
 * Contract: a hard abort (interrupt_session) of a `full`-access shell_exec must
 * kill the WHOLE process tree, not just the wrapping `/bin/sh`.
 *
 * The bug it guards: `execAsync(command, { signal })` wraps the command in
 * `/bin/sh -c "<command>"` and, on abort, only SIGTERMs that `sh`. A compound
 * command (`sleep … && touch SENTINEL`) has already forked the real worker
 * (`sleep`) as a CHILD of sh — the signal never reaches it, so it reparents to
 * init and runs to completion, eventually creating SENTINEL long after the
 * agent turn "interrupted". The fix spawns the command as a process-group
 * leader (detached) and kills the negative pid (the whole group) on abort.
 *
 * The test bites by side effect: if SENTINEL appears after we abort mid-sleep,
 * the worker survived the abort → the orphan bug is back. An assertion that
 * can't pass by encoding a wrong expected value. bwrap is NOT involved here —
 * `full` access takes the spawn path directly, so this runs anywhere bash does.
 */
describe('sandboxExec full-access abort kills the whole process group', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'halo-pgkill-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('aborting mid-command prevents the orphaned worker from running on', async () => {
    const sentinel = join(dir, 'SENTINEL')
    const ctrl = new AbortController()

    // Compound command: the `touch` only fires if `sleep` survives the abort.
    const command = `sleep 2 && touch "${sentinel}"`
    const run = sandboxExec(command, {
      workspaceRoot: dir,
      accessLevel: 'full',
      signal: ctrl.signal,
    })

    // Abort well before the 2s sleep would finish.
    await delay(300)
    ctrl.abort('interrupt')

    // The call itself must reject (aborted), not resolve as a success.
    await expect(run).rejects.toBeDefined()

    // Wait past the original sleep window: if the worker orphaned, SENTINEL
    // would appear around now. It must NOT.
    await delay(2200)
    expect(existsSync(sentinel)).toBe(false)
  })

  it('a normally-completing command still resolves with its output', async () => {
    const { stdout } = await sandboxExec('echo group-ok', {
      workspaceRoot: dir,
      accessLevel: 'full',
    })
    expect(stdout.trim()).toBe('group-ok')
  })

  it('a non-zero exit rejects with the captured code (exec contract preserved)', async () => {
    // Mirrors promisify(exec): failure throws an Error carrying `.code`.
    await expect(
      sandboxExec('echo to-stderr 1>&2; exit 3', { workspaceRoot: dir, accessLevel: 'full' }),
    ).rejects.toMatchObject({ code: 3 })
  })

  it('timeout kills the group too (no orphaned worker past the deadline)', async () => {
    const sentinel = join(dir, 'TIMEOUT_SENTINEL')
    const command = `sleep 2 && touch "${sentinel}"`
    await expect(
      sandboxExec(command, { workspaceRoot: dir, accessLevel: 'full', timeout: 300 }),
    ).rejects.toBeDefined()

    await delay(2200)
    expect(existsSync(sentinel)).toBe(false)
  })

  /**
   * Regression: a command that `setsid`s its worker into a NEW session escapes
   * the spawned group, so SIGTERM/SIGKILL to `-pid` never reach it AND the
   * wrapping sh stays blocked in wait() → `close` never fires. Before the fix
   * this hung the tool call (and the whole agent loop) forever — a real
   * 80-minute stuck shell_exec was traced to exactly this. The fix force-settles
   * the Promise after the SIGKILL grace window. The bite: the call must REJECT
   * within the deadline + grace (~2.3s here), not hang past the test timeout.
   */
  it('timeout on a setsid-escaped worker still rejects (no infinite hang)', async () => {
    const start = Date.now()
    await expect(
      sandboxExec('setsid -w sleep 600', { workspaceRoot: dir, accessLevel: 'full', timeout: 300 }),
    ).rejects.toMatchObject({ killed: true })
    // 300ms deadline + 2000ms SIGKILL grace + 200ms settle ≈ 2.5s ceiling.
    expect(Date.now() - start).toBeLessThan(4000)
  }, 8000)

  it('abort on a setsid-escaped worker still rejects (no infinite hang)', async () => {
    const ctrl = new AbortController()
    const start = Date.now()
    const run = sandboxExec('setsid -w sleep 600', {
      workspaceRoot: dir,
      accessLevel: 'full',
      signal: ctrl.signal,
    })
    setTimeout(() => ctrl.abort('interrupt'), 300)
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(Date.now() - start).toBeLessThan(4000)
  }, 8000)
})
