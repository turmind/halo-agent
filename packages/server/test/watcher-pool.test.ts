import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { WebSocket } from 'ws'
import { WatcherPool } from '../src/ws/watcher-pool.js'

/**
 * Contract: WatcherPool keeps ONE WorkspaceWatcher + GitDirWatcher per
 * workspace root and fans each event out to every socket attached to that
 * root. Before the pool, handler.ts created both watchers per WS connection,
 * so N admin tabs on one workspace meant N recursive @parcel/watcher native
 * subscriptions and N identical `file:changed` frames per disk event. The pool
 * makes that one native subscription per root; per-socket fan-out is the only
 * per-connection cost. The watchers stop when the last socket on a root
 * detaches, and a socket lives in at most one root (attaching elsewhere moves
 * it).
 *
 * These are real-fs tests: a real tmp dir and the real @parcel/watcher native
 * subscription, so we write actual files and wait past the 300ms coalesce.
 * `attach` fires the async subscribe with `void`, so each test settles long
 * enough for the native watch to arm before the first mutation.
 */

// parcel's subscribe is async and attach() doesn't await it — give the native
// watch time to arm before the first filesystem mutation.
const ARM_WAIT = 800
// Past WorkspaceWatcher's 300ms debounce — generous to keep the test non-flaky
// on a loaded CI box.
const DEBOUNCE_WAIT = 700

type FakeWs = WebSocket & { send: ReturnType<typeof vi.fn> }

// Satisfies sendJson's `readyState === ws.OPEN` guard so frames are recorded.
const fakeWs = (): FakeWs => ({ readyState: 1, OPEN: 1, send: vi.fn() }) as unknown as FakeWs

const framesFor = (ws: FakeWs): Array<Record<string, unknown>> =>
  ws.send.mock.calls.map(([p]) => JSON.parse(p as string))

describe('WatcherPool', () => {
  let root: string
  let pool: WatcherPool
  let attached: FakeWs[]

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-watchpool-'))
    pool = new WatcherPool()
    attached = []
  })
  afterEach(() => {
    // Release every native subscription the test opened before the dir goes.
    for (const ws of attached) pool.detach(ws)
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('two sockets on one root share one watcher and both receive the same frames', async () => {
    const a = fakeWs()
    const b = fakeWs()
    attached.push(a, b)
    pool.attach(a, root)
    pool.attach(b, root)
    expect(pool.size).toBe(1)
    await delay(ARM_WAIT)

    fs.writeFileSync(path.join(root, 'x.txt'), 'hello')
    await delay(DEBOUNCE_WAIT)

    const fa = framesFor(a)
    const fb = framesFor(b)
    expect(fa.some((f) => f.type === 'file:changed' && f.path === 'x.txt')).toBe(true)
    expect(fb.some((f) => f.type === 'file:changed' && f.path === 'x.txt')).toBe(true)
    expect(fa).toEqual(fb)
  })

  it('detach stops delivery per socket; the last detach stops the watcher', async () => {
    const a = fakeWs()
    const b = fakeWs()
    attached.push(a, b)
    pool.attach(a, root)
    pool.attach(b, root)
    await delay(ARM_WAIT)

    // Drop a: only b keeps receiving, the shared watcher stays up.
    pool.detach(a)
    const aCalls = a.send.mock.calls.length
    fs.writeFileSync(path.join(root, 'y.txt'), 'hi')
    await delay(DEBOUNCE_WAIT)
    expect(framesFor(b).some((f) => f.type === 'file:changed' && f.path === 'y.txt')).toBe(true)
    expect(a.send.mock.calls.length).toBe(aCalls)
    expect(pool.size).toBe(1)

    // Drop b (the last socket): the watcher stops and nothing else arrives.
    pool.detach(b)
    expect(pool.size).toBe(0)
    const bCalls = b.send.mock.calls.length
    fs.writeFileSync(path.join(root, 'z.txt'), 'bye')
    await delay(DEBOUNCE_WAIT)
    expect(a.send.mock.calls.length).toBe(aCalls)
    expect(b.send.mock.calls.length).toBe(bCalls)
  })

  it('attaching a socket to a second root moves it off the first', async () => {
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-watchpool2-'))
    try {
      const a = fakeWs()
      attached.push(a)
      pool.attach(a, root)
      pool.attach(a, root2)
      expect(pool.size).toBe(1)
      // Re-attaching to the current root is a no-op.
      pool.attach(a, root2)
      expect(pool.size).toBe(1)
      await delay(ARM_WAIT)

      // The abandoned root must be silent.
      fs.writeFileSync(path.join(root, 'old.txt'), 'x')
      await delay(DEBOUNCE_WAIT)
      expect(framesFor(a).some((f) => f.path === 'old.txt')).toBe(false)

      // The current root must deliver.
      fs.writeFileSync(path.join(root2, 'new.txt'), 'y')
      await delay(DEBOUNCE_WAIT)
      expect(framesFor(a).some((f) => f.type === 'file:changed' && f.path === 'new.txt')).toBe(true)
    } finally {
      for (const ws of attached) pool.detach(ws)
      attached = []
      fs.rmSync(root2, { recursive: true, force: true })
    }
  })

  it('detach of an unknown socket is a no-op', () => {
    const a = fakeWs()
    attached.push(a)
    pool.attach(a, root)
    expect(pool.size).toBe(1)

    expect(() => pool.detach(fakeWs())).not.toThrow()
    expect(pool.size).toBe(1)
  })
})
