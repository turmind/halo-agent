import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  describeSandboxUnavailable,
  sandboxUnavailableWarning,
  noSandboxMessage,
} from '../src/tools/sandbox.js'

const BLOCKED = { kind: 'namespaces-blocked', detail: 'bwrap: setting up uid map: Permission denied' } as const
const APPARMOR_URL = 'https://github.com/turmind/halo-agent/blob/main/.halo/docs/dev/deploy.md#bubblewrap-on-ubuntu-2310-and-2404-apparmor'

describe('sandbox unavailable — message builders (injected reason)', () => {
  it('not installed → apt install hint', () => {
    expect(sandboxUnavailableWarning('Server', { kind: 'not-installed' })).toBe(
      '[Server] OS sandbox unavailable (bubblewrap not installed) — workspace/readonly sessions get no shell_exec. Fix: sudo apt install bubblewrap',
    )
  })

  it('namespaces blocked → the probe stderr line + AppArmor fix with the deploy.md anchor', () => {
    expect(sandboxUnavailableWarning('cli', BLOCKED)).toBe(
      `[cli] OS sandbox unavailable (bwrap cannot create namespaces: bwrap: setting up uid map: Permission denied) — workspace/readonly sessions get no shell_exec. Fix: AppArmor (Ubuntu 23.10+/24.04) blocks unprivileged user namespaces — allow bwrap: ${APPARMOR_URL}`,
    )
  })

  it('no known reason → nothing to print', () => {
    expect(describeSandboxUnavailable(null)).toBeNull()
    expect(sandboxUnavailableWarning('Server', null)).toBeNull()
  })

  it('tool error: namespaces blocked ends with the AppArmor fix, not the install hint', () => {
    const msg = noSandboxMessage(BLOCKED)
    expect(msg).toMatch(/^Access denied: shell_exec at workspace\/readonly access needs an OS sandbox/)
    expect(msg).toContain('Switch the session to Full')
    expect(msg).toContain('setting up uid map: Permission denied')
    expect(msg.endsWith(`${APPARMOR_URL}.`)).toBe(true)
    expect(msg).not.toContain('apt install')
  })

  it('tool error: not installed / unknown keeps the install hint', () => {
    for (const r of [{ kind: 'not-installed' } as const, null]) {
      expect(noSandboxMessage(r).endsWith('on Linux install bubblewrap (apt install bubblewrap).')).toBe(true)
    }
  })
})

// The probe itself, with bwrap's outcome injected through a mocked execFile:
// reason recorded + cached for ENOENT / namespace errors, nothing cached for a
// transient failure, and the probe never prints.
type ExecCb = (err: unknown, stdout?: string, stderr?: string) => void
const bwrapOutcome = vi.hoisted(() => ({ current: null as null | (() => unknown) }))
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>()
  return {
    ...real,
    execFile: (file: string, _args: string[], _opts: unknown, cb: ExecCb) => {
      if (file === 'git') { cb(null, '', ''); return }
      if (file === 'bwrap' && bwrapOutcome.current) {
        const err = bwrapOutcome.current()
        if (err) cb(err); else cb(null, '', '')
        return
      }
      return (real.execFile as unknown as (...a: unknown[]) => unknown)(file, _args, _opts, cb)
    },
  }
})

describe.skipIf(process.platform !== 'linux')('bwrap probe records why it is unavailable', () => {
  let warn: ReturnType<typeof vi.spyOn>
  let calls = 0
  beforeEach(() => {
    vi.resetModules()
    calls = 0
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    bwrapOutcome.current = null
    warn.mockRestore()
  })

  const load = () => import('../src/tools/sandbox.js')
  const outcome = (f: () => unknown) => { bwrapOutcome.current = () => { calls++; return f() } }

  it('ENOENT → not-installed, cached', async () => {
    outcome(() => Object.assign(new Error('spawn bwrap ENOENT'), { code: 'ENOENT' }))
    const sb = await load()
    expect(await sb.initBwrapCheck()).toBe(false)
    expect(sb.getSandboxUnavailableReason()).toEqual({ kind: 'not-installed' })
    expect(sb.getSandboxBackend()).toBeNull()
    await sb.initBwrapCheck()
    expect(calls).toBe(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('namespace error → namespaces-blocked with the first stderr line, cached', async () => {
    outcome(() => Object.assign(new Error('Command failed'), { code: 1, stderr: 'bwrap: setting up uid map: Permission denied\nmore\n' }))
    const sb = await load()
    expect(await sb.initBwrapCheck()).toBe(false)
    expect(sb.getSandboxUnavailableReason()).toEqual(BLOCKED)
    expect(sb.sandboxUnavailableWarning('Server')).toContain('Fix: AppArmor')
    expect(sb.noSandboxMessage()).toContain(APPARMOR_URL)
    await sb.initBwrapCheck()
    expect(calls).toBe(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('transient error → no reason, not cached (re-probes)', async () => {
    outcome(() => Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }))
    const sb = await load()
    expect(await sb.initBwrapCheck()).toBe(false)
    expect(sb.getSandboxUnavailableReason()).toBeNull()
    expect(sb.sandboxUnavailableWarning('Server')).toBeNull()
    await sb.initBwrapCheck()
    expect(calls).toBe(2)
  })

  it('working bwrap → backend bwrap, no reason', async () => {
    outcome(() => null)
    const sb = await load()
    expect(await sb.initBwrapCheck()).toBe(true)
    expect(sb.getSandboxBackend()).toBe('bwrap')
    expect(sb.getSandboxUnavailableReason()).toBeNull()
    expect(sb.sandboxUnavailableWarning('Server')).toBeNull()
  })
})
