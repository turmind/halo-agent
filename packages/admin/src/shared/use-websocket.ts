'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { wsClient } from '@/shared/ws-client'
import { useChatStore } from '@/features/chat/chat-store'
import { useProjectStore } from '@/shared/stores/project-store'
import { registerChatHandlers } from '@/shared/ws-handlers/chat-handlers'
import { registerAgentHandlers } from '@/shared/ws-handlers/agent-handlers'
import { registerTaskHandlers } from '@/shared/ws-handlers/task-handlers'
import { registerFileHandlers } from '@/shared/ws-handlers/file-handlers'
import { registerStateHandlers } from '@/shared/ws-handlers/state-handlers'

/** Connection indicator states. `connected` alone reported the LAST KNOWN
 *  state — a zombie-OPEN socket (peer gone, onclose never fired) kept the
 *  light green for the entire ~15min kernel-retry window while sends
 *  silently vanished (root cause: .halo/tmp/idle-reconnect-msg-loss.md).
 *  The tri-state adds an inbound-traffic freshness check on top:
 *   - fresh: socket OPEN and traffic seen recently (liveness pongs count)
 *   - stale: socket claims OPEN but nothing inbound for LINK_STALE_MS —
 *     the link is suspect, probes are in flight
 *   - down:  socket closed / reconnecting */
export type LinkState = 'fresh' | 'stale' | 'down'

/** 3× the liveness probe interval: a healthy foreground link sees a `__pong__`
 *  at least every ~15s, so 45s of silence means the round-trip is broken.
 *  (A background tab's throttled timers can stretch pong spacing to ~1min —
 *  the light may sit amber there, but it's not visible until the user comes
 *  back, at which point the un-throttled probe settles it within seconds.) */
const LINK_STALE_MS = 45_000

/** Tab must have been hidden at least this long before a visibility flip
 *  triggers a reconnect probe — see the visibilitychange note below. */
const VISIBILITY_PROBE_MIN_HIDDEN_MS = 5 * 60_000

export function useWebSocket() {
  const [connected, setConnected] = useState(false)
  const [linkState, setLinkState] = useState<LinkState>('down')
  const mountedRef = useRef(false)
  const activeProjectId = useProjectStore((s) => s.activeProject?.id)

  // Re-subscribe when the active project changes (user switched workspace).
  // Skip if not connected or if it's the initial connect (handled by _connected callback).
  const prevProjectRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!connected || !activeProjectId) return
    if (prevProjectRef.current === undefined) {
      prevProjectRef.current = activeProjectId
      return
    }
    if (prevProjectRef.current === activeProjectId) return
    prevProjectRef.current = activeProjectId
    const sessionId = useChatStore.getState().sessionId ?? ''
    wsClient.send({ type: 'subscribe', sessionId, projectId: activeProjectId })
  }, [connected, activeProjectId])

  useEffect(() => {
    if (mountedRef.current) return
    mountedRef.current = true

    wsClient.connect()

    const unsubs = [
      wsClient.on('_connected', () => {
        setConnected(true)
        // Edge-triggered so the light doesn't lag the reconnect by up to a
        // poll tick; the interval below handles the fresh↔stale drift.
        setLinkState('fresh')
        const sessionId = useChatStore.getState().sessionId
        const activeProject = useProjectStore.getState().activeProject
        // Always subscribe on connect — even without a sessionId the server
        // needs the projectId to start its file watcher for Explorer sync.
        if (activeProject?.id) {
          wsClient.send({ type: 'subscribe', sessionId: sessionId ?? '', projectId: activeProject.id })
        }
      }),
      wsClient.on('_disconnected', () => {
        setConnected(false)
        setLinkState('down')
      }),
      registerChatHandlers(wsClient),
      registerAgentHandlers(wsClient),
      registerTaskHandlers(wsClient),
      registerFileHandlers(wsClient),
      registerStateHandlers(wsClient),
    ]

    // Hard signal from the OS: NIC came back up. Pass `staleMs: 0` so we
    // always force a reconnect attempt — by the time `online` fires the
    // existing socket is almost certainly half-dead.
    const onOnline = () => wsClient.reconnectIfStale(0)
    window.addEventListener('online', onOnline)

    // Visibility probe, gated on hidden-duration. The ungated version was
    // removed once before: inside an iframe (code-server's preview window,
    // embedded admin) visibility/focus events fire continuously as focus
    // moves between editor and terminal, and each one triggered a stale-check
    // that tore down a perfectly healthy WS — an endless reconnect loop. The
    // ≥5min-hidden threshold keeps that fix (iframe flapping hides the tab
    // for milliseconds, never minutes) while restoring coverage for the case
    // the removal broke: waking from a long-idle tab / laptop sleep, where
    // the socket is a zombie but no `online` event ever fires (the NIC never
    // went down) — the user typed into a dead link with a green light
    // (root cause: .halo/tmp/idle-reconnect-msg-loss.md). Unlike `online`
    // (a hard NIC-was-down signal → threshold 0), a visibility flip proves
    // nothing about the link — a hidden tab keeps receiving WS traffic just
    // fine — so only tear down when inbound has actually gone silent past
    // the stale window; a healthy connection sails through untouched.
    let hiddenAt = 0
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now()
        return
      }
      if (hiddenAt > 0 && Date.now() - hiddenAt >= VISIBILITY_PROBE_MIN_HIDDEN_MS) {
        wsClient.reconnectIfStale(LINK_STALE_MS)
      }
      hiddenAt = 0
    }
    document.addEventListener('visibilitychange', onVisibility)

    // Drive the tri-state light: `connected` gives the hard edges (open /
    // closed) via the _connected/_disconnected events above; this interval
    // adds the freshness dimension in between. Staleness is the *absence* of
    // inbound traffic — there's no event to push when nothing arrives, so a
    // cheap local poll of `lastReceiveAgeMs` (no I/O) is the honest shape.
    const lightTimer = setInterval(() => {
      setLinkState(
        !wsClient.connected ? 'down'
          : wsClient.lastReceiveAgeMs > LINK_STALE_MS ? 'stale'
            : 'fresh',
      )
    }, 5_000)

    return () => {
      unsubs.forEach((fn) => fn())
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisibility)
      clearInterval(lightTimer)
      wsClient.disconnect()
      mountedRef.current = false
    }
  }, [])

  const send = useCallback((message: object) => {
    wsClient.send(message)
  }, [])

  return { connected, linkState, send }
}
