import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { WebSocket, WebSocketServer } from 'ws'
import { setBroadcastWss, setClientWorkspaceResolver } from '../src/ws/broadcast.js'
import { createSkillRoutes } from '../src/routes/skills.js'
import { SessionManager } from '../src/agents/session-manager.js'
import { dispatchCommand, type CommandContext } from '../src/channels/shared/commands.js'
import { WatcherPool } from '../src/ws/watcher-pool.js'
import { GLOBAL_SKILLS_DIR } from '../src/agents/skill-sources.js'

/**
 * Contract: every skill mutation pushes exactly one `skills:changed`, a no-op
 * pushes none. Before, only the Skills tab (while mounted) and
 * `extension:changed` bumped the admin's skill bus, so `/skill disable` in
 * chat, REST calls, an agent's file_write or a second tab never reached an
 * open chat's slash popup.
 *
 *   - REST create / delete / toggle and `/skill disable|enable` notify; a
 *     workspace change only reaches sockets bound to that workspace, a global
 *     skill reaches every socket.
 *   - The workspace watcher (WatcherPool) notifies for skill folders written
 *     on disk, only when the listed view (ids + frontmatter) moved — a body
 *     edit, or the echo of a mutation that already notified, stays silent.
 */

type FakeSocket = { readyState: number; OPEN: number; sent: string[]; send: (p: string) => void }

function socket(): FakeSocket {
  const s: FakeSocket = { OPEN: 1, readyState: 1, sent: [], send(p: string) { s.sent.push(p) } }
  return s
}

const skillFrames = (s: FakeSocket): number =>
  s.sent.filter((p) => (JSON.parse(p) as { type: string }).type === 'skills:changed').length

let ws: string
let other: string
let inWs: FakeSocket
let inOther: FakeSocket
const app = createSkillRoutes()

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-skills-changed-'))
  other = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-skills-changed-other-'))
  inWs = socket()
  inOther = socket()
  const bind = new Map<FakeSocket, string>([[inWs, ws], [inOther, other]])
  setBroadcastWss({ clients: new Set([inWs, inOther]) } as unknown as WebSocketServer)
  setClientWorkspaceResolver((s) => bind.get(s as unknown as FakeSocket) ?? null)
})

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true })
  fs.rmSync(other, { recursive: true, force: true })
  fs.rmSync(path.join(GLOBAL_SKILLS_DIR, 'shared-tool'), { recursive: true, force: true })
})

const post = (body: Record<string, unknown>) => app.request('/skills', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

describe('skills:changed — REST mutations', () => {
  it('workspace create / toggle / delete: one frame each, workspace-scoped; no-ops silent', async () => {
    expect((await post({ name: 'probe', scope: 'workspace', projectId: ws })).status).toBe(201)
    expect(skillFrames(inWs)).toBe(1)
    expect(skillFrames(inOther)).toBe(0)

    expect((await post({ name: 'probe', scope: 'workspace', projectId: ws })).status).toBe(409)
    expect(skillFrames(inWs)).toBe(1)

    const q = `scope=workspace&projectId=${encodeURIComponent(ws)}`
    const toggle = await app.request(`/skills/probe/toggle?${q}`, { method: 'PATCH' })
    expect(await toggle.json()).toEqual({ ok: true, disabled: true })
    expect(skillFrames(inWs)).toBe(2)

    // The refetch the frame triggers sees the new state (disabled lives in
    // the db, never in an mtime cache).
    const { skills } = await (await app.request(`/skills?projectId=${encodeURIComponent(ws)}`)).json() as { skills: Array<{ id: string; disabled?: boolean }> }
    expect(skills.find((s) => s.id === 'probe')?.disabled).toBe(true)

    expect((await app.request(`/skills/probe?${q}`, { method: 'DELETE' })).status).toBe(200)
    expect(skillFrames(inWs)).toBe(3)
    expect((await app.request(`/skills/probe?${q}`, { method: 'DELETE' })).status).toBe(404)
    expect(skillFrames(inWs)).toBe(3)
    expect(skillFrames(inOther)).toBe(0)
  })

  it('global create / delete reach every socket', async () => {
    expect((await post({ name: 'shared-tool', scope: 'global' })).status).toBe(201)
    expect([skillFrames(inWs), skillFrames(inOther)]).toEqual([1, 1])
    expect((await app.request('/skills/shared-tool', { method: 'DELETE' })).status).toBe(200)
    expect([skillFrames(inWs), skillFrames(inOther)]).toEqual([2, 2])
  })
})

describe('skills:changed — /skill verbs', () => {
  function ctxFor(sm: SessionManager): CommandContext {
    return {
      sm, userId: 'u1', sessionPrefix: 'web_', accessLevel: 'full',
      channelLabel: 'test', activeOverrides: new Map(), workspacePath: ws, lang: 'en',
    }
  }

  it('disable / enable / delete notify once; an already-disabled disable is silent', async () => {
    const dir = path.join(ws, '.halo', 'skills', 'foo')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: foo\ndescription: x\ncommand: /foo\n---\nbody\n')
    const sm = new SessionManager(ws)
    const ctx = ctxFor(sm)

    expect((await dispatchCommand(ctx, '/skill', 'disable foo'))?.text).toMatch(/disabled/)
    expect(skillFrames(inWs)).toBe(1)
    expect((await dispatchCommand(ctx, '/skill', 'disable foo'))?.text).toMatch(/already/)
    expect(skillFrames(inWs)).toBe(1)
    expect((await dispatchCommand(ctx, '/skill', 'enable foo'))?.text).toMatch(/enabled/)
    expect(skillFrames(inWs)).toBe(2)
    expect((await dispatchCommand(ctx, '/skill', 'delete foo'))?.text).toBeTruthy()
    expect(fs.existsSync(dir)).toBe(false)
    expect(skillFrames(inWs)).toBe(3)
    expect(skillFrames(inOther)).toBe(0)
  })
})

describe('skills:changed — workspace watcher', () => {
  // Real fs + the real @parcel/watcher subscription (same waits as
  // watcher-pool.test.ts): arm, then past the file watcher's 300ms flush
  // plus the pool's 300ms skills debounce.
  const ARM_WAIT = 800
  const SETTLE = 1300

  it('a skill folder written on disk notifies once; body edits and mutation echoes do not', async () => {
    // Opening a workspace (ensureWorkspaceHalo) creates .halo/skills/ before
    // any socket attaches; a dir created inside a brand-new parent is only
    // reported as the parent's addDir.
    fs.mkdirSync(path.join(ws, '.halo', 'skills'), { recursive: true })
    const pool = new WatcherPool()
    const watched = socket()
    pool.attach(watched as unknown as WebSocket, ws)
    try {
      await delay(ARM_WAIT)
      const md = path.join(ws, '.halo', 'skills', 'agent-made', 'SKILL.md')

      // An agent's file_write: dir + SKILL.md in one go.
      fs.mkdirSync(path.dirname(md), { recursive: true })
      fs.writeFileSync(md, '---\nname: agent-made\ndescription: one\n---\nbody\n')
      await delay(SETTLE)
      expect(skillFrames(watched)).toBe(1)

      // Body-only edit: nothing a list shows changed.
      fs.writeFileSync(md, '---\nname: agent-made\ndescription: one\n---\nnew body\n')
      await delay(SETTLE)
      expect(skillFrames(watched)).toBe(1)

      // Frontmatter edit: the popup's description moved.
      fs.writeFileSync(md, '---\nname: agent-made\ndescription: two\n---\nnew body\n')
      await delay(SETTLE)
      expect(skillFrames(watched)).toBe(2)

      // A REST create already notified (broadcast sockets) — the watcher
      // sees the same files and stays silent.
      expect((await post({ name: 'via-rest', scope: 'workspace', projectId: ws })).status).toBe(201)
      expect(skillFrames(inWs)).toBe(1)
      await delay(SETTLE)
      expect(skillFrames(watched)).toBe(2)
      expect(watched.sent.some((p) => p.includes('.halo/skills/via-rest'))).toBe(true) // the watcher did see it
    } finally {
      pool.detach(watched as unknown as WebSocket)
    }
  }, 15_000)
})
