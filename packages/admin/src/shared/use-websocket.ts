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

export function useWebSocket() {
  const [connected, setConnected] = useState(false)
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
    //
    // Note: we removed the visibilitychange/focus probes. Inside an iframe
    // (code-server's preview window, embedded admin) those events fire
    // continuously as focus moves between editor and terminal, and each one
    // triggered a stale-check that tore down a perfectly healthy WS — the
    // user saw an endless reconnect loop. WsClient's own livenessTimer is
    // the authoritative health probe; user-driven events are noise.
    const onOnline = () => wsClient.reconnectIfStale(0)
    window.addEventListener('online', onOnline)

    return () => {
      unsubs.forEach((fn) => fn())
      window.removeEventListener('online', onOnline)
      wsClient.disconnect()
      mountedRef.current = false
    }
  }, [])

  const send = useCallback((message: object) => {
    wsClient.send(message)
  }, [])

  return { connected, send }
}
