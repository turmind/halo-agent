import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import type { WebSocket } from 'ws'
import type * as headlessTypes from '@xterm/headless'
import { TerminalManager } from '../src/ws/terminal-manager.js'

/**
 * Contracts:
 *   - audit A-M3: terminal input/resize without a terminalId is rejected —
 *     never routed to "whatever PTY happens to be first" in the global
 *     registry (the old fallback wasn't scoped to the calling connection, so
 *     with two admin windows an id-less keystroke landed in the other one).
 *   - shared terminals: every connection of a workspace attaches to its PTYs
 *     (snapshot, then live), output / exit fan out to all, PTYs outlive every
 *     disconnect, PTY size follows the last typist.
 *
 * Real PTYs, not mocks: node-pty is loaded via createRequire (invisible to
 * vi.mock), and the observable contract — which SHELL saw the bytes, what a
 * page renders — is exactly what the bugs corrupt. Markers use shell
 * arithmetic (`echo M$((40+2))` prints `M42`) so the PTY's echo of the
 * command line can't satisfy a wait for the command's output.
 */

const requireHere = createRequire(import.meta.url)
const { Terminal } = requireHere('@xterm/headless') as typeof headlessTypes

interface Frame {
  type?: string
  terminalId?: string
  data?: string
  name?: string
  cols?: number
  rows?: number
  exitCode?: number
  terminals?: Array<{ id: string; name: string }>
}

function fakeWs(onFrame?: (f: Frame) => void): { ws: WebSocket; frames: Frame[] } {
  const frames: Frame[] = []
  const ws = {
    OPEN: 1,
    readyState: 1,
    send(payload: string) {
      const f = JSON.parse(payload) as Frame
      frames.push(f)
      onFrame?.(f)
    },
  }
  return { ws: ws as unknown as WebSocket, frames }
}

function outputFor(frames: Frame[], terminalId: string): string {
  return frames
    .filter((f) => f.type === 'terminal:output' && f.terminalId === terminalId)
    .map((f) => f.data ?? '')
    .join('')
}

function framesOf(frames: Frame[], type: string, terminalId?: string): Frame[] {
  return frames.filter((f) => f.type === type && (terminalId === undefined || f.terminalId === terminalId))
}

/** What a page shows: replay its snapshot + output frames, in arrival order,
 *  into an xterm (the snapshot at the size it was taken, as the admin does). */
async function render(frames: Frame[], terminalId: string): Promise<string[]> {
  const own = frames.filter((f) => f.terminalId === terminalId && (f.type === 'terminal:snapshot' || f.type === 'terminal:output'))
  const snap = own.find((f) => f.type === 'terminal:snapshot')
  const term = new Terminal({ cols: snap?.cols ?? 80, rows: snap?.rows ?? 24, scrollback: 10_000, allowProposedApi: true, logLevel: 'off' })
  for (const f of own) await new Promise<void>((r) => term.write(f.data ?? '', r))
  const buf = term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
  term.dispose()
  return lines
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try { fn() } catch { /* pty already gone */ }
  }
})

/** A manager per fake connection, detached (subscription dropped) after the test. */
function connect(onFrame?: (f: Frame) => void) {
  const c = fakeWs(onFrame)
  const mgr = new TerminalManager(c.ws)
  cleanups.push(() => mgr.detachAll())
  return { ...c, mgr }
}

/** Start a PTY on `conn` and wait for the shell's first output. */
async function startShell(conn: ReturnType<typeof connect>, terminalId: string, workspacePath: string, extra: { cols?: number; rows?: number; name?: string } = {}) {
  conn.mgr.start({ terminalId, cols: extra.cols ?? 80, rows: extra.rows ?? 24, workspacePath, name: extra.name })
  cleanups.push(() => conn.mgr.close(terminalId))
  await waitFor(() => outputFor(conn.frames, terminalId).length > 0, `${terminalId} prompt`)
}

/** Two connections, one PTY each — the multi-admin-window setup the A-M3 bug
 *  corrupted. Returns after both shells have produced their first output. */
async function spawnPair(idA: string, idB: string) {
  const a = connect()
  const b = connect()
  // A spawns FIRST → A's PTY is the global map's first entry, the one the
  // old fallback handed out to anyone.
  await startShell(a, idA, '/tmp/ws-a')
  await startShell(b, idB, '/tmp/ws-b')
  return { a, b, mgrA: a.mgr, mgrB: b.mgr }
}

describe('terminal input/resize without terminalId (audit A-M3)', () => {
  it("id-less input is rejected — it must not land in another connection's PTY", async () => {
    const A = 'term-input-a'
    const B = 'term-input-b'
    const { a, b, mgrA, mgrB } = await spawnPair(A, B)

    // The bug: no id → the write went to the FIRST PTY in the global map,
    // which belongs to connection A. (PTY echo alone makes the marker visible
    // in A's output stream, so detection doesn't depend on command execution.)
    mgrB.writeInput(undefined, 'echo INTRUDER\r')

    // A proper id still works (guards against over-rejecting mutations).
    mgrB.writeInput(B, 'echo B-OWN\r')
    await waitFor(() => outputFor(b.frames, B).includes('B-OWN'), "B's own echo")

    // Complete a full round-trip through A AFTER the id-less write: a PTY
    // processes writes in order, so if INTRUDER had reached A's shell its
    // echo would be in the stream before this one.
    mgrA.writeInput(A, 'echo A-OWN\r')
    await waitFor(() => outputFor(a.frames, A).includes('A-OWN'), "A's own echo")

    expect(outputFor(a.frames, A)).not.toContain('INTRUDER')
    expect(outputFor(b.frames, B)).not.toContain('INTRUDER')
  }, 30_000)

  it("id-less resize is rejected — the first PTY keeps its size; an id'd resize still works", async () => {
    const A = 'term-resize-a'
    const B = 'term-resize-b'
    const { a, b, mgrA, mgrB } = await spawnPair(A, B)

    // Old fallback would have resized A's PTY (first in the map) to 33×11.
    mgrB.resize(undefined, 33, 11)
    // With an id, resize must still reach the right PTY.
    mgrB.resize(B, 100, 30)

    // `stty size` prints "rows cols" for the shell's OWN PTY — the ground
    // truth for which kernel terminal actually got resized.
    mgrA.writeInput(A, 'stty size\r')
    await waitFor(() => outputFor(a.frames, A).includes('24 80'), "A's stty size (unchanged)")
    expect(outputFor(a.frames, A)).not.toContain('11 33')

    mgrB.writeInput(B, 'stty size\r')
    await waitFor(() => outputFor(b.frames, B).includes('30 100'), "B's stty size (resized)")
  }, 30_000)
})

describe('shared terminals (per workspace, snapshot + live)', () => {
  it('two connections attached to one PTY both receive its output, and both can type into it', async () => {
    const W = '/tmp/ws-shared-io'
    const T = 'term-shared-io'
    const a = connect()
    const b = connect()
    await startShell(a, T, W)
    b.mgr.reattachAll(W)
    await waitFor(() => framesOf(b.frames, 'terminal:snapshot', T).length === 1, "B's snapshot")
    expect(framesOf(b.frames, 'terminal:reattached')[0].terminals).toEqual([{ id: T, name: expect.any(String) }])

    a.mgr.writeInput(T, 'echo FROM-A$((40+2))\r')
    await waitFor(() => outputFor(a.frames, T).includes('FROM-A42') && outputFor(b.frames, T).includes('FROM-A42'), "A's output on both")
    b.mgr.writeInput(T, 'echo FROM-B$((40+3))\r')
    await waitFor(() => outputFor(a.frames, T).includes('FROM-B43') && outputFor(b.frames, T).includes('FROM-B43'), "B's output on both")
  }, 30_000)

  it('a late attach gets a snapshot of earlier output, and snapshot + live output join with nothing lost or repeated', async () => {
    const W = '/tmp/ws-shared-seam'
    const T = 'term-shared-seam'
    const N = 4000
    // A fresh connection attaches every time A sees another 100 lines, from
    // inside A's output delivery while a dense stream runs. Whether PTY
    // chunks arrive while a given snapshot is pending is up to the event
    // loop (often none — the snapshot callback tends to run first), so one
    // attach rarely exercises the queue; ~40 of them across the stream do.
    const late: Array<ReturnType<typeof connect>> = []
    let streamed = ''
    let nextMark = 100
    const a = connect((f) => {
      if (f.type !== 'terminal:output' || nextMark >= N) return
      streamed += f.data ?? ''
      while (nextMark < N && new RegExp(`\\bL${nextMark}\\r?\\n`).test(streamed)) {
        nextMark += 100
        const c = connect()
        late.push(c)
        c.mgr.reattachAll(W)
      }
    })
    await startShell(a, T, W)
    a.mgr.writeInput(T, `for i in $(seq 1 ${N}); do echo L$i; done; echo END$((1+1))\r`)
    await waitFor(() => outputFor(a.frames, T).includes('END2') && late.every((c) => framesOf(c.frames, 'terminal:snapshot', T).length === 1), 'stream end', 30_000)
    await new Promise((r) => setTimeout(r, 200)) // queued tails
    expect(late.length).toBeGreaterThan(10)

    const first = framesOf(late[0].frames, 'terminal:snapshot', T)
    expect(first).toHaveLength(1)
    expect(first[0].data).toContain('L100')
    expect(first[0].data).not.toContain(`L${N}`)

    const numbered = (lines: string[]) => lines.filter((l) => /^L\d+$/.test(l)).map((l) => Number(l.slice(1)))
    const expected = Array.from({ length: N }, (_, i) => i + 1)
    expect(numbered(await render(a.frames, T))).toEqual(expected)
    for (const c of late) expect(numbered(await render(c.frames, T))).toEqual(expected)
  }, 60_000)

  it('a PTY survives every connection leaving; a later attach gets its full screen, including output made while nobody was attached', async () => {
    const W = '/tmp/ws-shared-survive'
    const T = 'term-shared-survive'
    const a = connect()
    const b = connect()
    await startShell(a, T, W)
    b.mgr.reattachAll(W)
    a.mgr.writeInput(T, 'echo BEFORE$((1+1)); sleep 1; echo WHILE-AWAY$((2+2))\r')
    await waitFor(() => outputFor(a.frames, T).includes('BEFORE2'), 'output before leaving')
    a.mgr.detachAll()
    b.mgr.detachAll()
    await new Promise((r) => setTimeout(r, 1500))
    expect(outputFor(a.frames, T)).not.toContain('WHILE-AWAY4')
    expect(framesOf(a.frames, 'terminal:exit')).toHaveLength(0)

    const c = connect()
    c.mgr.reattachAll(W)
    await waitFor(() => framesOf(c.frames, 'terminal:snapshot', T).length === 1, "C's snapshot")
    const snap = framesOf(c.frames, 'terminal:snapshot', T)[0].data ?? ''
    expect(snap).toContain('BEFORE2')
    expect(snap).toContain('WHILE-AWAY4')
    // Still a live shell.
    c.mgr.writeInput(T, 'echo BACK$((3+3))\r')
    await waitFor(() => outputFor(c.frames, T).includes('BACK6'), "C's echo")
  }, 30_000)

  it('the snapshot restores a full-screen program: alt buffer, bracketed paste, hidden cursor, SGR mouse', async () => {
    const W = '/tmp/ws-shared-alt'
    const T = 'term-shared-alt'
    const a = connect()
    const b = connect()
    await startShell(a, T, W)
    // What vim / htop emit on start, then a marker drawn on the alt screen.
    a.mgr.writeInput(T, "printf '\\033[?1049h\\033[?2004h\\033[?25l\\033[?1000h\\033[?1006h\\033[HALT-%s' $((5+5)); sleep 30\r")
    await waitFor(() => outputFor(a.frames, T).includes('ALT-10'), 'alt screen drawn')
    b.mgr.reattachAll(W)
    await waitFor(() => framesOf(b.frames, 'terminal:snapshot', T).length === 1, "B's snapshot")
    const snap = framesOf(b.frames, 'terminal:snapshot', T)[0].data ?? ''
    const alt = snap.indexOf('\x1b[?1049h')
    expect(alt).toBeGreaterThanOrEqual(0)
    expect(snap.indexOf('ALT-10')).toBeGreaterThan(alt)
    for (const mode of ['\x1b[?2004h', '\x1b[?25l', '\x1b[?1000h', '\x1b[?1006h']) expect(snap).toContain(mode)
  }, 30_000)

  it('closing from one connection ends the PTY for every attached connection', async () => {
    const W = '/tmp/ws-shared-close'
    const T = 'term-shared-close'
    const a = connect()
    const b = connect()
    await startShell(a, T, W)
    b.mgr.reattachAll(W)
    await waitFor(() => framesOf(b.frames, 'terminal:snapshot', T).length === 1, "B's snapshot")
    b.mgr.close(T)
    expect(framesOf(a.frames, 'terminal:exit', T)).toHaveLength(1)
    expect(framesOf(b.frames, 'terminal:exit', T)).toHaveLength(1)
    // The PTY's own onExit fires afterwards — no second exit frame.
    await new Promise((r) => setTimeout(r, 300))
    expect(framesOf(a.frames, 'terminal:exit', T)).toHaveLength(1)
    const c = connect()
    c.mgr.reattachAll(W)
    expect(framesOf(c.frames, 'terminal:reattached')[0].terminals).toEqual([])
  }, 30_000)

  it('the shell exiting on its own reaches every attached connection', async () => {
    const W = '/tmp/ws-shared-shell-exit'
    const T = 'term-shared-shell-exit'
    const a = connect()
    const b = connect()
    await startShell(a, T, W)
    b.mgr.reattachAll(W)
    a.mgr.writeInput(T, 'exit 3\r')
    await waitFor(() => framesOf(a.frames, 'terminal:exit', T).length === 1 && framesOf(b.frames, 'terminal:exit', T).length === 1, 'exit on both')
    expect(framesOf(b.frames, 'terminal:exit', T)[0].exitCode).toBe(3)
  }, 30_000)

  it('workspaces are isolated: no snapshot, output or new-terminal push crosses them', async () => {
    const a = connect()
    const b = connect()
    await startShell(a, 'term-iso-a1', '/tmp/ws-iso-a')
    b.mgr.reattachAll('/tmp/ws-iso-b')
    expect(framesOf(b.frames, 'terminal:reattached')[0].terminals).toEqual([])
    await startShell(a, 'term-iso-a2', '/tmp/ws-iso-a')
    a.mgr.writeInput('term-iso-a1', 'echo ISO$((1+1))\r')
    await waitFor(() => outputFor(a.frames, 'term-iso-a1').includes('ISO2'), "A's echo")
    expect(b.frames.filter((f) => f.terminalId?.startsWith('term-iso-a'))).toEqual([])

    const c = connect()
    c.mgr.reattachAll('/tmp/ws-iso-a')
    expect(framesOf(c.frames, 'terminal:reattached')[0].terminals?.map((t) => t.id).sort()).toEqual(['term-iso-a1', 'term-iso-a2'])
  }, 30_000)

  it('a PTY another page starts is pushed to the workspace\'s subscribers (opened + snapshot + live), with the creator\'s name', async () => {
    const W = '/tmp/ws-shared-push'
    const T = 'term-shared-push'
    const a = connect()
    const b = connect()
    a.mgr.reattachAll(W)
    b.mgr.reattachAll(W)
    await startShell(a, T, W, { name: 'bash (7)' })
    expect(framesOf(a.frames, 'terminal:opened')).toHaveLength(0)
    expect(framesOf(b.frames, 'terminal:opened', T)).toEqual([{ type: 'terminal:opened', terminalId: T, name: 'bash (7)' }])
    await waitFor(() => framesOf(b.frames, 'terminal:snapshot', T).length === 1, "B's snapshot")
    a.mgr.writeInput(T, 'echo PUSHED$((2+5))\r')
    await waitFor(() => outputFor(b.frames, T).includes('PUSHED7'), 'live output on B')

    const c = connect()
    c.mgr.reattachAll(W)
    expect(framesOf(c.frames, 'terminal:reattached')[0].terminals).toEqual([{ id: T, name: 'bash (7)' }])
  }, 30_000)

  it('PTY size follows the last connection to type; a non-driver resize only records', async () => {
    const W = '/tmp/ws-shared-size'
    const T = 'term-shared-size'
    const a = connect()
    const b = connect()
    await startShell(a, T, W)
    b.mgr.reattachAll(W)
    await waitFor(() => framesOf(b.frames, 'terminal:snapshot', T).length === 1, "B's snapshot")
    expect(framesOf(b.frames, 'terminal:snapshot', T)[0]).toMatchObject({ cols: 80, rows: 24 })

    // A (creator) drives; B's resize is only recorded.
    b.mgr.resize(T, 100, 30)
    a.mgr.writeInput(T, 'stty size\r')
    await waitFor(() => outputFor(a.frames, T).includes('24 80'), 'still A size')

    // B types → B's size.
    b.mgr.writeInput(T, 'stty size\r')
    await waitFor(() => outputFor(b.frames, T).includes('30 100'), 'B size after B typed')

    // A types again → back to A's size.
    const before = outputFor(a.frames, T).split('24 80').length
    a.mgr.writeInput(T, 'stty size\r')
    await waitFor(() => outputFor(a.frames, T).split('24 80').length > before, 'A size after A typed')

    // Driver A leaves → B's resize applies at once.
    a.mgr.detachAll()
    b.mgr.resize(T, 90, 20)
    const seen = outputFor(b.frames, T).length
    b.mgr.writeInput(T, 'stty size\r')
    await waitFor(() => outputFor(b.frames, T).slice(seen).includes('20 90'), 'B resize applied without a driver')
  }, 30_000)
})
