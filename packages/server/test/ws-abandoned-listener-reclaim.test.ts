import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { setupWebSocketHandler } from '../src/ws/handler.js'
import { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'
import { agentSessions } from '../src/db/schema.js'

/**
 * Contract: a connection whose peer's JS has stopped running loses its event
 * listener; a connection whose peer is still there keeps it — no matter what
 * any OTHER connection does.
 *
 * Root cause: the admin client's zombie detection (2 unanswered `__ping__`
 * round-trips → close + reconnect) abandons a socket whose TCP is still
 * healthy. No close frame reaches the server, `ws.on('close')` never fires, and
 * the ConnectedClient keeps its listener registered — so every event is also
 * serialized into a socket nobody reads (unbounded send-buffer growth) and the
 * reconnect adds another listener beside the dead one. Live forensics: 4
 * listeners on one session, 3 admin sockets all readyState=OPEN.
 *
 * Why liveness is measured as "inbound application traffic" and not socket
 * state: an abandoned-but-ESTAB socket is byte-for-byte indistinguishable from
 * a healthy viewer by readyState/destroyed (measured on production sockets), and
 * the server's own protocol ping only proves the peer's KERNEL is answering.
 * Only a running JS client sends `__ping__`.
 *
 * The half-dead socket can't be simulated with `close()` (that fires the
 * server's close handler and cleans up properly). `pause()` + dropping the
 * client handle reproduces it: the server side stays OPEN, as in production.
 */

let workspace: string
let http: Server
let wss: WebSocketServer
let registry: SessionManagerRegistry
let port: number
/** Every socket this test opened — torn down in afterEach so a failing
 *  assertion can't leave an abandoned socket holding the process open. */
let sockets: WebSocket[] = []

const SID = 'sess-reclaim'

/** Listener count for a root session, read out of the real store. */
function listenerCount(sessionId: string): number {
  const sm = registry.getOrCreate(workspace)
  // eventListeners is private; this test asserts on it deliberately — it IS
  // the leaked resource, and the probe scripts used on production read the
  // same map.
  const listeners = (sm as unknown as {
    uiStore: { eventListeners: Map<string, Set<unknown>> }
  }).uiStore.eventListeners
  return listeners.get(sessionId)?.size ?? 0
}

function seedSession(id: string): void {
  registry.getOrCreate(workspace).getDb().insert(agentSessions).values({
    id, parentId: null, agentId: 'default', agentName: 'Default',
    description: '', workingDir: null, accessLevel: null,
    createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
  }).run()
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    sockets.push(ws)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

/** Send `subscribe` and wait until the server has processed it (its
 *  state:snapshot for this session id comes back). */
function subscribe(ws: WebSocket, sessionId: string): Promise<void> {
  return new Promise((resolve) => {
    const onMsg = (raw: Buffer) => {
      const msg = JSON.parse(raw.toString('utf-8')) as { type?: string; snapshot?: { sessionId?: string } }
      if (msg.type === 'state:snapshot' && msg.snapshot?.sessionId === sessionId) {
        ws.off('message', onMsg)
        resolve()
      }
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ type: 'subscribe', sessionId, projectId: workspace }))
  })
}

/** One client liveness probe, exactly as ws-client.ts sends it. */
function clientPing(ws: WebSocket): void {
  ws.send(JSON.stringify({ type: '__ping__' }))
}

/**
 * Abandon a socket the way the browser's zombie path does: the page's JS gives
 * up on it (stops sending `__ping__`, stops dispatching inbound frames) while
 * the browser's network stack keeps answering protocol pings. No close frame is
 * sent, so the server's side stays OPEN and its `close` handler never runs —
 * the precondition for the leak.
 *
 * Do NOT `pause()` the socket here: pausing also suppresses ws's automatic pong
 * reply, so the server's pre-existing `missedPongs >= 2 → terminate()` would
 * clean the connection up and the test would pass without the reclaim ever
 * running (verified: with `pause()`, breaking the reclaim still passed). The
 * live process shows pongs continuing at exactly the 6-byte/frame floor, which
 * is precisely why the protocol keepalive can't see these sockets.
 */
function abandon(ws: WebSocket): void {
  ws.removeAllListeners('message')
}

/**
 * Advance time so the reclaim's 3min wall-clock threshold and the connection's
 * 10s keepalive tick both fire, without the test waiting for either. The
 * server's `lastClientPingAt` stamps and its `Date.now()` comparison live behind
 * a closure, so the clock is the only honest lever — and using it means the
 * real production code path does the work, not a copy of its logic.
 *
 * The fake clock is installed in `beforeEach` (before the server creates its
 * keepalive interval, or that interval would keep running on the real timer and
 * never be advanceable), with `shouldAdvanceTime` so socket I/O still progresses
 * on the real event loop in between.
 */
async function advanceServerClock(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  // Let the released-listener bookkeeping settle.
  await vi.advanceTimersByTimeAsync(50)
}

beforeEach(async () => {
  // Installed BEFORE setupWebSocketHandler so the per-connection keepalive
  // interval is created on the fake clock and `advanceServerClock` can drive it.
  vi.useFakeTimers({ shouldAdvanceTime: true, now: Date.now() })
  sockets = []
  workspace = mkdtempSync(join(tmpdir(), 'halo-ws-reclaim-'))
  registry = new SessionManagerRegistry()
  // Seed the session row directly (createSession would build a live model runtime).
  seedSession(SID)

  http = createServer()
  wss = new WebSocketServer({ server: http, path: '/ws' })
  setupWebSocketHandler({ wss, registry })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  port = (http.address() as { port: number }).port
})

afterEach(async () => {
  for (const ws of sockets) ws.terminate()
  wss.close()
  await new Promise<void>((resolve) => { http.close(() => resolve()) })
  vi.useRealTimers()
  rmSync(workspace, { recursive: true, force: true })
})

describe('two live connections on ONE session', () => {
  it('do not evict each other (localStorage makes a second tab resolve to the same session)', async () => {
    // The admin keys its current session in localStorage, which is shared
    // per-origin — opening the same workspace in a second tab naturally
    // subscribes to the SAME session id. A previous fix evicted the peer on
    // every subscribe, which made the two tabs' reconnects evict each other at
    // ~1Hz forever. Both listeners must simply coexist.
    const tabA = await connect()
    await subscribe(tabA, SID)
    const tabB = await connect()
    await subscribe(tabB, SID)

    expect(listenerCount(SID)).toBe(2)

    // Still both there after more subscribes (a project switch re-subscribes).
    await subscribe(tabA, SID)
    await subscribe(tabB, SID)
    expect(listenerCount(SID)).toBe(2)

    // And both sockets are still usable — neither was closed under the other.
    expect(tabA.readyState).toBe(WebSocket.OPEN)
    expect(tabB.readyState).toBe(WebSocket.OPEN)
  })

  it('a late subscribe from a dying connection cannot take down the live viewer', async () => {
    // ws@8's closeTimeout is 30s and inbound messages are still dispatched
    // while a socket sits in CLOSING, so a socket the browser already gave up
    // on can still deliver a `subscribe`. It must not affect anyone else.
    const live = await connect()
    await subscribe(live, SID)
    const dying = await connect()
    await subscribe(dying, SID)
    expect(listenerCount(SID)).toBe(2)

    // `dying` starts closing, then gets one more subscribe in.
    dying.close()
    try { dying.send(JSON.stringify({ type: 'subscribe', sessionId: SID, projectId: workspace })) } catch { /* may already be gone */ }
    await vi.advanceTimersByTimeAsync(100)

    // The live viewer keeps its listener and its socket.
    expect(live.readyState).toBe(WebSocket.OPEN)
    let streamed = 0
    live.on('message', (raw: Buffer) => {
      if ((JSON.parse(raw.toString('utf-8')) as { type?: string }).type === 'chat:stream') streamed++
    })
    const sm = registry.getOrCreate(workspace)
    ;(sm as unknown as { uiStore: { emitEvent: (s: string, e: unknown) => void } })
      .uiStore.emitEvent(SID, { type: 'stream', text: 'still here', agentName: 'default' })
    await vi.advanceTimersByTimeAsync(150)
    expect(streamed).toBe(1)
  })
})

describe('reclaiming abandoned connections', () => {
  it('releases the listener of a connection that has gone silent past the threshold', async () => {
    const ws = await connect()
    await subscribe(ws, SID)
    expect(listenerCount(SID)).toBe(1)

    // The browser gives up but TCP stays alive — no close frame, so the
    // server's close handler never runs and the listener would leak forever.
    abandon(ws)
    expect(listenerCount(SID)).toBe(1)

    // Age it past the 3min silence limit; the keepalive tick does the reclaim.
    await advanceServerClock(4 * 60_000)

    expect(listenerCount(SID)).toBe(0)
  }, 20_000)

  it('reclaims a CLOSED connection that still holds a listener, with no threshold wait', async () => {
    // Seen on the live process: sockets with destroyed=true still registered.
    // CLOSED + a listener is unambiguous, so it must not wait out 3min.
    const ws = await connect()
    await subscribe(ws, SID)
    expect(listenerCount(SID)).toBe(1)

    // Kill the socket without letting the server's close handler clean up.
    const serverSock = [...(wss.clients as Set<WebSocket>)][0]!
    // @ts-expect-error — drop the underlying transport, leaving readyState CLOSED.
    serverSock._socket.destroy()
    serverSock.removeAllListeners('close')
    await vi.advanceTimersByTimeAsync(50)

    // Only one keepalive tick — well inside the 3min limit, so the silence
    // threshold cannot be what reclaims this one.
    await advanceServerClock(11_000)

    expect(listenerCount(SID)).toBe(0)
  }, 20_000)

  it('keeps the listener of a throttled background tab (one probe per minute)', async () => {
    // Chrome throttles a hidden tab's timers to ~1/min, so the 15s nominal
    // probe interval stretches. A 40s threshold would kill this tab's listener
    // while the user is just looking at another tab; 3min tolerates it.
    const ws = await connect()
    await subscribe(ws, SID)

    // Six throttled minutes — deliberately past 2x the 3min threshold. Running
    // only ~3min would pass even if inbound frames did NOT refresh the stamp
    // (total elapsed would just graze the limit), so the test would assert
    // nothing; at 6min the listener survives only because each probe resets it.
    for (let minute = 0; minute < 6; minute++) {
      await advanceServerClock(60_000)
      expect(listenerCount(SID)).toBe(1)
      clientPing(ws)
      await vi.advanceTimersByTimeAsync(50)
    }
    expect(listenerCount(SID)).toBe(1)
  }, 30_000)

  it('a normal close still releases its listener (no regression in the happy path)', async () => {
    const ws = await connect()
    await subscribe(ws, SID)
    expect(listenerCount(SID)).toBe(1)
    await new Promise<void>((resolve) => { ws.once('close', () => resolve()); ws.close() })
    // Give the server's close handler a tick.
    await vi.advanceTimersByTimeAsync(50)
    expect(listenerCount(SID)).toBe(0)
  })
})

describe('one connection, several subscribed sessions (admin chat tabs)', () => {
  const SID_B = 'sess-reclaim-b'

  /** Send `unsubscribe` (no reply frame) and wait until the server has
   *  processed it: frames are handled in order per connection, so a
   *  re-subscribe of `fence` answering means the unsubscribe ran first. */
  async function unsubscribe(ws: WebSocket, sessionId: string, fence: string): Promise<void> {
    ws.send(JSON.stringify({ type: 'unsubscribe', sessionId }))
    await subscribe(ws, fence)
  }

  /** Emit one root stream event for `sessionId`, as a running turn would. */
  function emitStream(sessionId: string, text: string): void {
    const sm = registry.getOrCreate(workspace)
    ;(sm as unknown as { uiStore: { emitEvent: (s: string, e: unknown) => void } })
      .uiStore.emitEvent(sessionId, { type: 'stream', text, agentName: 'default' })
  }

  /** Collect every frame of `type` arriving on `ws` from now on. */
  function record(ws: WebSocket, type: string): Array<Record<string, unknown>> {
    const frames: Array<Record<string, unknown>> = []
    ws.on('message', (raw: Buffer) => {
      const f = JSON.parse(raw.toString('utf-8')) as Record<string, unknown>
      if (f.type === type) frames.push(f)
    })
    return frames
  }

  beforeEach(() => { seedSession(SID_B) })

  it('each subscribed session streams into the connection stamped with its own sessionId', async () => {
    const ws = await connect()
    await subscribe(ws, SID)
    await subscribe(ws, SID_B)
    // Re-subscribing an id already in the set only re-sends its snapshot.
    await subscribe(ws, SID)
    expect(listenerCount(SID)).toBe(1)
    expect(listenerCount(SID_B)).toBe(1)

    const streams = record(ws, 'chat:stream')
    emitStream(SID, 'from A')
    emitStream(SID_B, 'from B')
    await vi.waitFor(() => expect(streams).toHaveLength(2))
    expect(streams.map((f) => [f.sessionId, f.text])).toEqual([[SID, 'from A'], [SID_B, 'from B']])
  })

  it('unsubscribe releases only that session — the other keeps streaming', async () => {
    const ws = await connect()
    await subscribe(ws, SID)
    await subscribe(ws, SID_B)

    await unsubscribe(ws, SID, SID_B)
    expect(listenerCount(SID)).toBe(0)
    expect(listenerCount(SID_B)).toBe(1)

    const streams = record(ws, 'chat:stream')
    emitStream(SID, 'closed tab')
    emitStream(SID_B, 'open tab')
    await vi.waitFor(() => expect(streams).toHaveLength(1))
    expect(streams[0]!.sessionId).toBe(SID_B)
  })

  it('repeated open→close cycles never accumulate listeners (audit A-H1)', async () => {
    // Closing a tab used to be `session:clear`, whose old handler re-registered
    // a bgHandler and threw away its unsubscribe — each "New session" click
    // leaked one listener (3 on one session in production probes). A closed
    // tab's session needs NO listener: SessionUIStore folds + persists a
    // running session's events with zero listeners, and a re-open subscribes
    // fresh from the snapshot.
    const ws = await connect()
    await subscribe(ws, SID_B)
    for (let i = 0; i < 3; i++) {
      await subscribe(ws, SID)
      expect(listenerCount(SID)).toBe(1)
      await unsubscribe(ws, SID, SID_B)
      expect(listenerCount(SID)).toBe(0)
    }
    expect(listenerCount(SID_B)).toBe(1)
  })

  it('a stop with no sessionId acts on the sole subscription — with two it has no target', async () => {
    const ws = await connect()
    await subscribe(ws, SID)
    const stopped = record(ws, 'chat:stopped')
    ws.send(JSON.stringify({ type: 'chat:stop' }))
    await vi.waitFor(() => expect(stopped).toHaveLength(1))
    expect(stopped[0]!.sessionId).toBe(SID)

    await subscribe(ws, SID_B)
    ws.send(JSON.stringify({ type: 'chat:stop' }))
    await subscribe(ws, SID) // fence: frames are handled in order
    expect(stopped).toHaveLength(1)
  })

  it('a reclaim releases every subscription and sends one listener:released per session', async () => {
    const ws = await connect()
    await subscribe(ws, SID)
    await subscribe(ws, SID_B)
    const released = record(ws, 'listener:released')

    await advanceServerClock(4 * 60_000)
    expect(listenerCount(SID)).toBe(0)
    expect(listenerCount(SID_B)).toBe(0)
    await vi.waitFor(() => expect(released).toHaveLength(2))
    expect(released.map((f) => f.sessionId).sort()).toEqual([SID, SID_B].sort())
  }, 20_000)
})

describe('error-path cleanup (audit A-M1)', () => {
  // ws normally follows 'error' with 'close', but nothing guarantees it. The
  // old error handler only stopped the watchers — an error that never produced
  // a close leaked the keepalive interval, the event listener, unflushed
  // background saves and attached PTYs. Both handlers now share one idempotent
  // cleanup; these tests emit 'error' WITHOUT a close (a bare EventEmitter
  // emit closes nothing) to pin the error path on its own.

  it("an 'error' without a 'close' runs the full cleanup (listener released, keepalive stopped)", async () => {
    const ws = await connect()
    await subscribe(ws, SID)
    expect(listenerCount(SID)).toBe(1)

    // The keepalive interval is observable from the client: it pings every
    // 10s. Prove it's alive first so the zero-after assertion means "cleared",
    // not "never ran". Small real waits let the pong round-trip settle so
    // missedPongs can't hit the terminate threshold mid-test.
    let pings = 0
    ws.on('ping', () => { pings++ })
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(10_000)
      await new Promise((r) => setTimeout(r, 30))
    }
    expect(pings).toBeGreaterThan(0)

    const serverSock = [...(wss.clients as Set<WebSocket>)][0]!
    serverSock.emit('error', new Error('boom'))
    await vi.advanceTimersByTimeAsync(50)

    // Listener gone — the old handler left it registered.
    expect(listenerCount(SID)).toBe(0)

    // Keepalive interval gone — the old handler leaked it (it kept pinging a
    // connection it had already forgotten about).
    pings = 0
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(10_000)
      await new Promise((r) => setTimeout(r, 30))
    }
    expect(pings).toBe(0)
  }, 20_000)

  it("the usual error→close double-fire runs the cleanup exactly once (no double detach)", async () => {
    // Unique session id: the detach below parks an entry in the module-level
    // detachedSessions map, which outlives this test's workspace/registry —
    // reusing SID would hand a later test's subscribe a stale reattach.
    const ERR_SID = 'sess-err-detach'
    seedSession(ERR_SID)
    const ws = await connect()
    await subscribe(ws, ERR_SID)
    expect(listenerCount(ERR_SID)).toBe(1)

    // Mark the session running so cleanup takes the detach branch — the one
    // that REGISTERS a bgHandler. A second pass through the body would
    // register a second one; the clients.delete gate must prevent that.
    const sm = registry.getOrCreate(workspace)
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions
      .set(ERR_SID, { promise: Promise.resolve(), isCompacting: false, messageQueue: [] })

    const serverSock = [...(wss.clients as Set<WebSocket>)][0]!
    serverSock.emit('error', new Error('boom'))
    await vi.advanceTimersByTimeAsync(50)

    // Detached: the client listener was swapped for exactly one bgHandler.
    expect(listenerCount(ERR_SID)).toBe(1)

    // The real close lands afterwards (the normal ws sequence).
    await new Promise<void>((resolve) => { ws.once('close', () => resolve()); ws.close() })
    await vi.advanceTimersByTimeAsync(50)

    // Still exactly one — a non-idempotent cleanup would have registered a
    // second bgHandler and overwritten the detachedSessions entry.
    expect(listenerCount(ERR_SID)).toBe(1)
  }, 20_000)
})

describe('self-heal after reclaim', () => {
  // A reclaimed-but-alive connection (renderer frozen >3min, network process
  // still answering pings) has NO path back on its own: the server keeps
  // answering `__pong__`, so the client's staleness clock stays fresh and its
  // zombie detection / visibility probe never fire. Both recovery signals
  // below exist so a resumed tab doesn't sit silently dead until F5.

  it('emits listener:released on the reclaimed connection (the resume-time recovery signal)', async () => {
    const ws = await connect()
    await subscribe(ws, SID)
    const frames: Array<Record<string, unknown>> = []
    ws.on('message', (raw: Buffer) => { frames.push(JSON.parse(raw.toString('utf-8')) as Record<string, unknown>) })

    // Silent past the threshold → reclaim. A frozen tab wouldn't read the
    // frame until resume; the recorder standing in for "resume" changes
    // nothing server-side (receiving refreshes no server state).
    await advanceServerClock(4 * 60_000)
    expect(listenerCount(SID)).toBe(0)

    const released = frames.filter((f) => f.type === 'listener:released')
    expect(released).toHaveLength(1)
    expect(released[0]!.sessionId).toBe(SID)
  }, 20_000)

  it('a chat after reclaim re-registers the listener (no blind agent run)', async () => {
    const ws = await connect()
    await subscribe(ws, SID)
    await advanceServerClock(4 * 60_000)
    expect(listenerCount(SID)).toBe(0)

    // The freeze window overlapped a long compact — realistic, and it keeps
    // handleChat on the enqueue path so no model runtime is built in tests.
    const sm = registry.getOrCreate(workspace)
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions
      .set(SID, { isCompacting: true, messageQueue: [] })

    // Frame waits are promise-based (same as `subscribe()` above): a chat is a
    // real client→server→client round trip, and advancing the FAKE clock does
    // not push bytes through real sockets — asserting after a fake-time wait
    // raced the TCP hop and flaked.
    const frames: Array<Record<string, unknown>> = []
    const arrived = new Map<string, () => void>()
    ws.on('message', (raw: Buffer) => {
      const f = JSON.parse(raw.toString('utf-8')) as Record<string, unknown>
      frames.push(f)
      arrived.get(f.type as string)?.()
    })
    const frame = (type: string) => new Promise<void>((r) => arrived.set(type, r))

    // Resume: the user types into the tab before its re-subscribe. The reclaim
    // emptied the connection's subscription set, so the chat's bind must
    // re-register — once it didn't, and the agent ran while this connection
    // received nothing.
    const queued = frame('chat:queued')
    ws.send(JSON.stringify({ type: 'chat', sessionId: SID, projectId: workspace, message: 'still there?' }))
    await queued

    expect(listenerCount(SID)).toBe(1)

    // And the re-registered listener actually feeds this connection.
    const streamed = frame('chat:stream')
    ;(sm as unknown as { uiStore: { emitEvent: (s: string, e: unknown) => void } })
      .uiStore.emitEvent(SID, { type: 'stream', text: 'welcome back', agentName: 'default' })
    await streamed
    expect(frames.filter((f) => f.type === 'chat:stream')).toHaveLength(1)
  }, 20_000)
})
